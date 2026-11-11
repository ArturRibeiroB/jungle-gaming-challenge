import type { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/**
 * Portas de persistência. A aplicação só conhece estas interfaces; a implementação
 * com MikroORM fica em infrastructure/database.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Busca e trava a linha da wallet até o fim da transação (SELECT ... FOR UPDATE).
   * Só a wallet envolvida é travada: wallets diferentes seguem em paralelo.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND ou ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Transações PENDING_REFERENCE cuja próxima verificação já venceu. */
  findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Versão do último item da página; ausente quando não há mais itens. */
  nextBeforeVersion: number | undefined;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  /** Mais recentes primeiro. `beforeVersion` é exclusivo. */
  page(walletId: string, options: { beforeVersion: number | undefined; limit: number }): Promise<LedgerPage>;
  /** Saldo gravado e saldo recalculado pelo ledger, lidos no mesmo snapshot. */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): void;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAt: Date | undefined;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /**
   * Trava e devolve até `limit` eventos pendentes e vencidos, do mais antigo para o mais novo.
   * Linhas já travadas por outro publisher são puladas (SKIP LOCKED), então publishers
   * concorrentes nunca pegam o mesmo evento ao mesmo tempo.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage, lastError?: string): void;
  stats(): Promise<OutboxStats>;
}

export interface WageringUnitOfWork {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export abstract class WageringStore {
  /**
   * Executa `work` numa única transação SQL. Tudo o que for adicionado ou salvo nos
   * repositórios é gravado junto no commit, ou nada é gravado.
   */
  abstract transaction<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;
  /** Somente leitura, sem transação explícita. */
  abstract read<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;
}
