import type { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/** Formatos de saída dos casos de uso: só JSON estável, nada de Money ou Date. */

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export const toLedgerEntryView = (entry: WalletLedgerEntry): LedgerEntryView => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  walletVersion: entry.walletVersion,
  createdAt: entry.createdAt.toISOString(),
});

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  /** Cursor opaco para a próxima página; null quando acabou. */
  nextCursor: string | null;
}

/** Resposta de uma submissão (nova ou replay). */
export interface TransactionOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  observedBalance: MoneyProps | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const toTransactionView = (tx: WagerTransaction): TransactionView => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId ?? null,
  gameId: tx.gameId ?? null,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  observedBalance: tx.observedBalance?.toJSON() ?? null,
  referenceAttempts: tx.referenceAttempts,
  nextReferenceAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
