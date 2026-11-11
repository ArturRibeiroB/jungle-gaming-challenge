import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const NUMERIC_PATTERN = /^(-)?(\d+)\.(\d{2})$/;

/**
 * NUMERIC(…, 2) do Postgres -> Money, sem passar por number.
 * Aceita sinal porque somas de reconciliação podem dar negativo se algo estiver corrompido.
 */
export function moneyFromNumeric(value: string, currency: string): Money {
  const match = NUMERIC_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Unexpected numeric value from database: "${value}"`);
  }
  const [, sign, units, cents] = match;
  const minor = BigInt(units!) * 100n + BigInt(cents!);
  return Money.fromMinorUnits(sign ? -minor : minor, currency.trim());
}

const toNullable = <T>(value: T | undefined): T | null => (value === undefined ? null : value);
const fromNullable = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency.trim(),
    balance: moneyFromNumeric(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet, target: Partial<WalletRecord> = {}): WalletRecord {
  return Object.assign(target, {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  const currency = record.currency.trim();
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: fromNullable(record.roundId),
    gameId: fromNullable(record.gameId),
    kind: record.kind as WagerTransactionKind,
    money: moneyFromNumeric(record.amount, currency),
    referenceExternalTransactionId: fromNullable(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: fromNullable(record.referenceTransactionId),
    failureCode: fromNullable(record.failureCode) as FailureCode | undefined,
    processedAt: fromNullable(record.processedAt),
    observedBalance: record.observedBalance === null ? undefined : moneyFromNumeric(record.observedBalance, currency),
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: fromNullable(record.nextReferenceAttemptAt),
  });
}

/** Copia o estado do domínio para a linha. Campos de negócio só mudam no INSERT (trigger garante). */
export function transactionToRecord(
  tx: WagerTransaction,
  updatedAt: Date,
  target: Partial<WagerTransactionRecord> = {},
): WagerTransactionRecord {
  return Object.assign(target, {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: toNullable(tx.roundId),
    gameId: toNullable(tx.gameId),
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: toNullable(tx.referenceExternalTransactionId),
    referenceTransactionId: toNullable(tx.referenceTransactionId),
    status: tx.status,
    failureCode: toNullable(tx.failureCode),
    observedBalance: tx.observedBalance ? tx.observedBalance.toString() : null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: toNullable(tx.nextReferenceAttemptAt),
    createdAt: tx.createdAt,
    processedAt: toNullable(tx.processedAt),
    updatedAt,
  });
}

export function ledgerEntryFromRecord(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: moneyFromNumeric(record.amount, record.currency),
    balanceBefore: moneyFromNumeric(record.balanceBefore, record.currency),
    balanceAfter: moneyFromNumeric(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function inboxFromRecord(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: fromNullable(record.processedAt),
  });
}

export function inboxToRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: toNullable(message.processedAt),
  };
}

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    publishedAt: toNullable(message.publishedAt),
    lastError: null,
  };
}
