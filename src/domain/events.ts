import type { FailureCode } from './failure-code';
import { newId } from './id';
import type { MoneyProps } from './money';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface EventContext {
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope dos eventos publicados. `eventType` e `version` ficam no tipo concreto,
 * nunca numa string solta no call site. `data` só carrega JSON estável (MoneyProps, não Money).
 *
 * O aggregateId é sempre a wallet: é a unidade de consistência, e vira o MessageGroupId
 * na fila FIFO, então os eventos de uma mesma wallet saem na ordem em que aconteceram.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  protected static props<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
    return { eventId: newId(), aggregateId, ...ctx, data };
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  };
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.processedAt || !tx.observedBalance) {
      throw new Error(`Transaction ${tx.id} is not processed`);
    }
    return new WagerTransactionProcessed(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionData(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.observedBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

/** Rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.observedBalance) {
      throw new Error(`Transaction ${tx.id} is not rejected`);
    }
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionData(tx),
        failureCode: tx.failureCode,
        balance: tx.observedBalance.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  nextAttemptAt: string;
}

/** A referência ainda não chegou; a transação foi aceita e será reavaliada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.nextReferenceAttemptAt) {
      throw new Error(`Transaction ${tx.id} is not pending a reference`);
    }
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionData(tx),
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda (há lançamento no ledger). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
