import { Injectable } from '@nestjs/common';
import { newId } from '../domain/id';
import { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerSettlement } from '../domain/wager-settlement';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from './errors';
import { hashWagerPayload, type WagerTransactionPayload } from './payload-hash';
import { WageringStore, type WageringUnitOfWork } from './ports';
import { eventsForSettlement } from './transaction-events';
import { toTransactionView, type TransactionOutcome, type TransactionView } from './views';

/** Presente quando a entrada veio da fila: deduplica por (consumerName, messageId). */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash da mensagem inteira, para detectar o mesmo messageId com conteúdo diferente. */
  payloadHash: string;
}

export interface SubmitWagerTransactionCommand {
  /** Fonte da verdade da idempotência (header HTTP ou campo da mensagem). */
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  correlationId: string;
  inbox?: InboxContext | undefined;
}

/**
 * Quantas vezes repetir a unidade de trabalho quando o banco acusa violação de unicidade.
 * Acontece quando duas requisições com a mesma chave chegam juntas por wallets diferentes:
 * na nova tentativa, a busca por idempotência encontra a transação já gravada e devolve replay.
 */
const MAX_ATTEMPTS = 3;

interface AttemptResult {
  outcome: TransactionOutcome;
  kind: WagerTransactionKind;
}

/**
 * Caso de uso único de submissão, usado tanto pela API HTTP quanto pelo consumidor SQS.
 */
@Injectable()
export class WagerTransactionService {
  private readonly logger = new Logger(WagerTransactionService.name);

  constructor(
    private readonly store: WageringStore,
    private readonly settlement: WagerSettlement,
    private readonly metrics: Metrics,
  ) {}

  async submit(command: SubmitWagerTransactionCommand): Promise<TransactionOutcome> {
    const { payload } = command;
    const payloadHash = hashWagerPayload(payload);
    const money = Money.from(payload.money);
    const build = () =>
      WagerTransaction.create({
        id: newId(),
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
        createdAt: new Date(),
      });
    // Valida o payload antes de abrir transação e travar a wallet.
    build();

    const source = command.inbox ? 'sqs' : 'http';
    const fields = {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      walletId: payload.walletId,
      providerId: payload.providerId,
    };

    return this.metrics.time('wagering_processing_duration_seconds', { source }, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const { outcome, kind } = await this.store.transaction((uow) =>
            this.submitInTransaction(uow, command, payloadHash, build),
          );
          this.recordOutcome(outcome, kind, source, { ...fields, transactionId: outcome.transactionId });
          return outcome;
        } catch (error) {
          if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
            this.metrics.increment('wagering_retries_total', { reason: 'unique_violation' });
            this.logger.info('Concurrent duplicate detected, retrying', { ...fields, constraint: error.constraint, attempt });
            continue;
          }
          if (error instanceof TransientInfrastructureError && error.code === 'LOCK_TIMEOUT') {
            this.metrics.increment('wagering_lock_conflicts_total');
          }
          if (error instanceof IdempotencyConflictError) {
            this.metrics.increment('wagering_idempotency_conflicts_total', { source });
          }
          throw error;
        }
      }
    });
  }

  async getById(transactionId: string): Promise<TransactionView> {
    const tx = await this.store.read((uow) => uow.transactions.findById(transactionId));
    if (!tx) {
      throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    }
    return toTransactionView(tx);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.store.read((uow) => uow.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) {
      throw new TransactionNotFoundError(`Transaction ${externalTransactionId} of provider ${providerId} not found`);
    }
    return toTransactionView(tx);
  }

  private async submitInTransaction(
    uow: WageringUnitOfWork,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    build: () => WagerTransaction,
  ): Promise<AttemptResult> {
    const { payload, idempotencyKey } = command;

    // 1. Trava a wallet primeiro. Todas as operações da mesma wallet passam a ser serializadas
    //    aqui, então as buscas de idempotência abaixo enxergam o que a anterior commitou.
    const wallet = await uow.wallets.lockById(payload.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(payload.walletId);
    }
    const now = new Date();

    // 2. Inbox: a mesma mensagem da fila entregue de novo vira replay do resultado original.
    if (command.inbox) {
      const { consumerName, messageId } = command.inbox;
      const seen = await uow.inbox.find(consumerName, messageId);
      if (seen) {
        if (!seen.matchesPayload(command.inbox.payloadHash)) {
          throw new InboxPayloadConflictError(consumerName, messageId);
        }
        const original = await uow.transactions.findByIdempotencyKey(payload.providerId, idempotencyKey);
        if (!original) {
          // Inbox e transação são gravados juntos; uma sem a outra indica dado corrompido.
          throw new Error(`Inbox ${consumerName}/${messageId} has no matching transaction`);
        }
        return replay(original, wallet);
      }
      const inbox = InboxMessage.receive({ consumerName, messageId, payloadHash: command.inbox.payloadHash, receivedAt: now });
      inbox.markProcessed(now);
      uow.inbox.add(inbox);
    }

    // 3. Idempotência persistente: mesma chave + mesmo payload = replay; payload diferente = conflito.
    const existing = await uow.transactions.findByIdempotencyKey(payload.providerId, idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(payload.providerId, idempotencyKey);
      }
      return replay(existing, wallet);
    }
    if (await uow.transactions.findByExternalId(payload.providerId, payload.externalTransactionId)) {
      throw new DuplicateExternalTransactionError(payload.providerId, payload.externalTransactionId);
    }

    // 4. Regras de negócio.
    const tx = build();
    const reference = tx.referenceExternalTransactionId
      ? await uow.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && tx.isReversal() ? await uow.transactions.hasProcessedReversal(reference.id) : false;
    const { ledgerEntry } = this.settlement.settle({ transaction: tx, wallet, reference, referenceAlreadyReversed, now });

    // 5. Tudo abaixo é gravado no mesmo COMMIT: transação, ledger, saldo, inbox (acima) e outbox.
    uow.transactions.add(tx);
    if (ledgerEntry) {
      uow.ledger.append(ledgerEntry);
      uow.wallets.save(wallet);
    }
    const ctx = { correlationId: command.correlationId, causationId: command.inbox?.messageId ?? idempotencyKey, occurredAt: now };
    for (const event of eventsForSettlement(tx, wallet, ledgerEntry, ctx, true)) {
      uow.outbox.add(OutboxMessage.enqueue(event));
    }
    return { outcome: toOutcome(tx, wallet, false), kind: tx.kind };
  }

  private recordOutcome(
    outcome: TransactionOutcome,
    kind: WagerTransactionKind,
    source: string,
    fields: Record<string, string | undefined>,
  ): void {
    if (outcome.idempotentReplay) {
      this.metrics.increment('wagering_duplicates_total', { source });
      this.logger.info('Idempotent replay', { ...fields, status: outcome.status });
      return;
    }
    this.metrics.increment('wagering_transactions_total', { status: outcome.status, kind });
    this.logger.info('Transaction settled', { ...fields, status: outcome.status, kind, failureCode: outcome.failureCode });
  }
}

function replay(tx: WagerTransaction, wallet: Wallet): AttemptResult {
  return { outcome: toOutcome(tx, wallet, true), kind: tx.kind };
}

/** O saldo devolvido é o observado quando a transação terminou, inclusive no replay. */
function toOutcome(tx: WagerTransaction, wallet: Wallet, idempotentReplay: boolean): TransactionOutcome {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: (tx.observedBalance ?? wallet.balance).toJSON(),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    idempotentReplay,
  };
}
