import { Injectable } from '@nestjs/common';
import {
  ConnectionException,
  DeadlockException,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError, UniqueViolationError, ApplicationError } from '../../application/errors';
import {
  WageringStore,
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type OutboxStats,
  type ReconciliationSnapshot,
  type WagerTransactionRepository,
  type WageringUnitOfWork,
  type WalletRepository,
} from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  inboxFromRecord,
  inboxToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  moneyFromNumeric,
  outboxFromRecord,
  outboxToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/** SQLSTATEs de falha transitória: conexão (classe 08), shutdown, serialização, deadlock, lock. */
const TRANSIENT_SQL_STATES = new Set(['40001', '40P01', '55P03', '57P01', '57P02', '57P03', '53300']);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

@Injectable()
export class MikroOrmWageringStore extends WageringStore {
  constructor(private readonly em: EntityManager) {
    super();
  }

  override async transaction<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      // fork(): cada operação tem seu próprio Unit of Work / Identity Map, inclusive fora de requisições HTTP.
      // O lock_timeout já vem configurado em cada conexão do pool (mikro-orm.config.ts).
      return await this.em.fork().transactional((em) => work(new MikroOrmUnitOfWork(em)));
    } catch (error) {
      throw translateError(error);
    }
  }

  override async read<T>(work: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await work(new MikroOrmUnitOfWork(this.em.fork()));
    } catch (error) {
      throw translateError(error);
    }
  }
}

class MikroOrmUnitOfWork implements WageringUnitOfWork {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}

class MikroOrmWalletRepository implements WalletRepository {
  /** Linhas carregadas nesta unidade de trabalho, para o save() alterar a entidade gerenciada. */
  private readonly records = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }));
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true }));
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecord, { playerId, currency }));
  }

  add(wallet: Wallet): void {
    const record = this.em.create(WalletRecord, walletToRecord(wallet));
    this.records.set(wallet.id, record);
    this.em.persist(record);
  }

  save(wallet: Wallet): void {
    const record = this.records.get(wallet.id);
    if (!record) {
      throw new Error(`Wallet ${wallet.id} was not loaded in this unit of work`);
    }
    walletToRecord(wallet, record);
  }

  private track(record: WalletRecord | null): Wallet | undefined {
    if (!record) {
      return undefined;
    }
    this.records.set(record.id, record);
    return walletFromRecord(record);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly records = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async findDuplicates(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<{ byIdempotencyKey: WagerTransaction | undefined; byExternalId: WagerTransaction | undefined }> {
    // Cada condição usa sua unique (provider_id, ...): no máximo duas linhas.
    const records = await this.em.find(WagerTransactionRecord, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId }],
    });
    const byKey = records.find((record) => record.idempotencyKey === idempotencyKey);
    const byExternal = records.find((record) => record.externalTransactionId === externalTransactionId);
    return { byIdempotencyKey: this.track(byKey ?? null), byExternalId: this.track(byExternal ?? null) };
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  add(transaction: WagerTransaction): void {
    const record = this.em.create(WagerTransactionRecord, transactionToRecord(transaction, transaction.createdAt));
    this.records.set(transaction.id, record);
    this.em.persist(record);
  }

  save(transaction: WagerTransaction): void {
    const record = this.records.get(transaction.id);
    if (!record) {
      throw new Error(`Transaction ${transaction.id} was not loaded in this unit of work`);
    }
    transactionToRecord(transaction, new Date(), record);
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) {
      return undefined;
    }
    this.records.set(record.id, record);
    return transactionFromRecord(record);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerEntryToRecord(entry)));
  }

  async page(walletId: string, options: { beforeVersion: number | undefined; limit: number }): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      options.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: options.beforeVersion } },
      { orderBy: { walletVersion: 'desc' }, limit: options.limit + 1 },
    );
    const hasMore = records.length > options.limit;
    const entries = records.slice(0, options.limit).map(ledgerEntryFromRecord);
    return { entries, nextBeforeVersion: hasMore ? entries.at(-1)?.walletVersion : undefined };
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // Uma única instrução = um único snapshot: saldo e ledger lidos no mesmo instante.
    const rows = await this.em.execute<
      { currency: string; stored: string; calculated: string; entries: number }[]
    >(
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(30, 2)::text
                as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      storedBalance: moneyFromNumeric(row.stored, row.currency),
      calculatedBalance: moneyFromNumeric(row.calculated, row.currency),
      checkedEntries: row.entries,
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? inboxFromRecord(record) : undefined;
  }

  add(message: InboxMessage): void {
    this.em.persist(this.em.create(InboxMessageRecord, inboxToRecord(message)));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  private readonly records = new Map<string, OutboxMessageRecord>();

  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(this.em.create(OutboxMessageRecord, outboxToRecord(message)));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((record) => {
      this.records.set(record.id, record);
      return outboxFromRecord(record);
    });
  }

  save(message: OutboxMessage, lastError?: string): void {
    const record = this.records.get(message.id);
    if (!record) {
      throw new Error(`Outbox message ${message.id} was not claimed in this unit of work`);
    }
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? record.nextAttemptAt;
    record.publishedAt = message.publishedAt ?? null;
    record.lastError = lastError === undefined ? record.lastError : lastError.slice(0, 1000);
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<{ pending: number; oldest: Date | null }[]>(
      'select count(*)::int as pending, min(occurred_at) as oldest from outbox_messages where published_at is null',
    );
    return { pending: row?.pending ?? 0, oldestPendingAt: row?.oldest ? new Date(row.oldest) : undefined };
  }
}

/** Converte exceções do driver em erros que a aplicação entende, sem vazar tipos do ORM. */
export function translateError(error: unknown): unknown {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as { constraint?: string }).constraint;
    return new UniqueViolationError(constraint, { cause: error });
  }
  if (error instanceof LockWaitTimeoutException || sqlStateOf(error) === '55P03') {
    return new TransientInfrastructureError('LOCK_TIMEOUT', 'Timed out waiting for the wallet lock', { cause: error });
  }
  if (error instanceof ConnectionException || error instanceof DeadlockException || isTransient(error)) {
    return new TransientInfrastructureError('TRANSIENT_FAILURE', 'Database temporarily unavailable', { cause: error });
  }
  return error;
}

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = sqlStateOf(error);
  if (code && (TRANSIENT_SQL_STATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK_CODES.has(code))) {
    return true;
  }
  // Pool sem conexão livre ou banco fora do ar.
  if (error.name === 'KnexTimeoutError' || /Timeout acquiring a connection|Connection terminated/i.test(error.message)) {
    return true;
  }
  return error.cause !== undefined && isTransient(error.cause);
}
