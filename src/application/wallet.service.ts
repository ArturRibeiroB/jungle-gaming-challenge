import { Injectable } from '@nestjs/common';
import { WalletBalanceChanged } from '../domain/events';
import { newId } from '../domain/id';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { InvalidRequestError, UniqueViolationError, WalletAlreadyExistsError, WalletNotFoundError } from './errors';
import { canonicalJson, sha256Hex } from './payload-hash';
import { WageringStore } from './ports';
import { toLedgerEntryView, toWalletView, type LedgerPageView, type ReconciliationView, type WalletView } from './views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly store: WageringStore,
    private readonly metrics: Metrics,
  ) {}

  /**
   * Cria a wallet e, se o saldo inicial for positivo, a transação OPENING com o CREDIT
   * no ledger e o evento WalletBalanceChanged — tudo na mesma transação SQL.
   */
  async open(command: OpenWalletCommand): Promise<WalletView> {
    const { playerId, initialBalance } = command;
    try {
      return await this.store.transaction(async (uow) => {
        if (await uow.wallets.findByPlayerAndCurrency(playerId, initialBalance.currency)) {
          throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
        }

        const now = new Date();
        const walletId = newId();
        const openingTransactionId = newId();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance,
          openingTransactionId,
          at: now,
        });
        uow.wallets.add(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId,
            money: initialBalance,
            payloadHash: sha256Hex(canonicalJson({ walletId, playerId, money: initialBalance.toJSON() })),
            at: now,
          });
          uow.transactions.add(opening);
          uow.ledger.append(openingEntry);
          uow.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, { correlationId: command.correlationId, occurredAt: now }),
            ),
          );
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      // Duas criações simultâneas para o mesmo player: a segunda bate na unique do banco.
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError(playerId, initialBalance.currency);
      }
      throw error;
    }
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = await this.store.read((uow) => uow.wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  /** Ledger do mais recente para o mais antigo, paginado por cursor estável (a versão da wallet). */
  async ledger(walletId: string, options: { cursor?: string | undefined; limit?: number | undefined }): Promise<LedgerPageView> {
    const limit = options.limit ?? LEDGER_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX_LIMIT) {
      throw new InvalidRequestError(`limit must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`);
    }
    const beforeVersion = options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor);

    return this.store.read(async (uow) => {
      if (!(await uow.wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      const page = await uow.ledger.page(walletId, { beforeVersion, limit });
      return {
        walletId,
        entries: page.entries.map(toLedgerEntryView),
        nextCursor: page.nextBeforeVersion === undefined ? null : encodeLedgerCursor(page.nextBeforeVersion),
      };
    });
  }

  /**
   * Compara o saldo gravado com o saldo reconstruído pelo ledger.
   * Divergência nunca é corrigida aqui: é logada, contada em métrica e devolvida na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const snapshot = await this.store.read((uow) => uow.ledger.reconciliationSnapshot(walletId));
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }
    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.increment('wagering_reconciliation_mismatches_total');
      this.logger.error('Wallet balance diverges from ledger', {
        walletId,
        checkedEntries: snapshot.checkedEntries,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}

/**
 * Cursor opaco: base64url de {"v": <walletVersion>}. Estável porque o ledger é append-only
 * e a versão é única por wallet: novas entradas nunca deslocam as páginas já lidas.
 */
export function encodeLedgerCursor(beforeVersion: number): string {
  return Buffer.from(JSON.stringify({ v: beforeVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isSafeInteger(parsed.v) && parsed.v >= 1) {
      return parsed.v;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError('Invalid ledger cursor');
}
