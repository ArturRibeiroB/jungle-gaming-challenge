import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/**
 * Eventos que uma liquidação gera, gravados na outbox na mesma transação SQL.
 * `pendingIsNew` evita repetir WagerTransactionPendingReference a cada nova tentativa do worker.
 */
export function eventsForSettlement(
  tx: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  ctx: EventContext,
  pendingIsNew: boolean,
): IntegrationEvent<unknown>[] {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return ledgerEntry
        ? [WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, ledgerEntry, ctx)]
        : [WagerTransactionProcessed.from(tx, ctx)];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, ctx)];
    case WagerTransactionStatus.PendingReference:
      return pendingIsNew ? [WagerTransactionPendingReference.from(tx, ctx)] : [];
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      return [];
  }
}
