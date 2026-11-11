import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { newId } from '../../src/domain/id';
import { ReferenceRetryPolicy } from '../../src/domain/reference-retry-policy';
import { WagerSettlement } from '../../src/domain/wager-settlement';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransaction } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { T0, openWallet, usd, wager } from '../support/builders';

const settlement = new WagerSettlement(new ReferenceRetryPolicy(2, 1_000, 60_000));

function settle(wallet: Wallet, transaction: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  return settlement.settle({ transaction, wallet, reference, referenceAlreadyReversed, now: T0 });
}

/** Cria e processa uma transação, para servir de referência. */
function processed(wallet: Wallet, kind: Kind, amount: string, overrides: Parameters<typeof wager>[3] = {}, ref?: WagerTransaction) {
  const tx = wager(wallet, kind, amount, overrides);
  settle(wallet, tx, ref);
  expect(tx.status).toBe(Status.Processed);
  return tx;
}

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, Kind.Bet, '25.00');
    const { ledgerEntry } = settle(wallet, bet);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(ledgerEntry?.transactionId).toBe(bet.id);
  });

  test('two bets of 80 on 100: one processed, one rejected with INSUFFICIENT_FUNDS', () => {
    const wallet = openWallet('100.00');
    const first = wager(wallet, Kind.Bet, '80.00');
    const second = wager(wallet, Kind.Bet, '80.00');

    const entries = [settle(wallet, first).ledgerEntry, settle(wallet, second).ledgerEntry].filter(Boolean);

    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.observedBalance?.toString()).toBe('20.00');
    expect(wallet.balance.toString()).toBe('20.00');
    expect(entries).toHaveLength(1);
  });
});

describe('WIN', () => {
  test('credits the wallet', () => {
    const wallet = openWallet('100.00');
    const win = wager(wallet, Kind.Win, '50.00');
    const { ledgerEntry } = settle(wallet, win);
    expect(win.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe('150.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('may reference the BET of the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    const win = wager(wallet, Kind.Win, '30.00', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, win, bet);
    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('cannot reference another WIN', () => {
    const wallet = openWallet('100.00');
    const firstWin = processed(wallet, Kind.Win, '10.00', { externalTransactionId: 'win-1' });
    const win = wager(wallet, Kind.Win, '30.00', { referenceExternalTransactionId: 'win-1' });
    settle(wallet, win, firstWin);
    expect(win.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });
});

describe('LOSS', () => {
  test('is processed without moving balance or creating ledger', () => {
    const wallet = openWallet('100.00');
    const loss = wager(wallet, Kind.Loss, '0.00');
    const { ledgerEntry } = settle(wallet, loss);
    expect(loss.status).toBe(Status.Processed);
    expect(loss.observedBalance?.toString()).toBe('100.00');
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits back a processed BET once', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    const { ledgerEntry } = settle(wallet, refund, bet);

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('second reversal of the same BET is rejected', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund, bet, true);
    expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.toString()).toBe('60.00');
  });

  test('only BET can be refunded', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, Kind.Win, '40.00', { externalTransactionId: 'win-1' });
    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'win-1' });
    settle(wallet, refund, win);
    expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('amount must equal the reference (no partial refunds)', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    const refund = wager(wallet, Kind.Refund, '39.99', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('reference must be PROCESSED', () => {
    const wallet = openWallet('10.00');
    const bet = wager(wallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    settle(wallet, bet);
    expect(bet.status).toBe(Status.Rejected);

    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  test.each([
    ['round', { roundId: 'other-round' }],
    ['provider', { providerId: 'provider-b' }],
  ] as const)('reference from another %s is rejected', (_label, override) => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1', ...override });
    settle(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('reference from another wallet/player is rejected', () => {
    const otherWallet = openWallet('100.00');
    const bet = processed(otherWallet, Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });

    const wallet = openWallet('100.00');
    const refund = wager(wallet, Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '30.00', { externalTransactionId: 'bet-1' });
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'bet-1' });
    const { ledgerEntry } = settle(wallet, rollback, bet);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('of a WIN debits it back', () => {
    const wallet = openWallet('100.00');
    const win = processed(wallet, Kind.Win, '30.00', { externalTransactionId: 'win-1' });
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    const { ledgerEntry } = settle(wallet, rollback, win);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('of a REFUND debits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '30.00', { externalTransactionId: 'bet-1' });
    const refund = processed(wallet, Kind.Refund, '30.00', { externalTransactionId: 'ref-1', referenceExternalTransactionId: 'bet-1' }, bet);
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'ref-1' });
    settle(wallet, rollback, refund);
    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe('70.00');
  });

  test('cannot reverse a LOSS', () => {
    const wallet = openWallet('100.00');
    const loss = processed(wallet, Kind.Loss, '0.00', { externalTransactionId: 'loss-1' });
    const rollback = wager(wallet, Kind.Rollback, '1.00', { referenceExternalTransactionId: 'loss-1' });
    settle(wallet, rollback, loss);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('that would make the balance negative is rejected with REVERSAL_WOULD_OVERDRAW', () => {
    const wallet = openWallet('0.00');
    const win = processed(wallet, Kind.Win, '50.00', { externalTransactionId: 'win-1' });
    processed(wallet, Kind.Bet, '40.00');
    const rollback = wager(wallet, Kind.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    const { ledgerEntry } = settle(wallet, rollback, win);

    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.balance.toString()).toBe('10.00');
  });
});

describe('out-of-order references', () => {
  test('missing reference parks the transaction as PENDING_REFERENCE without touching the wallet', () => {
    const wallet = openWallet('100.00');
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'bet-later' });
    const { ledgerEntry } = settle(wallet, rollback);
    expect(rollback.status).toBe(Status.PendingReference);
    expect(ledgerEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('is processed when the reference arrives later', () => {
    const wallet = openWallet('100.00');
    const refund = wager(wallet, Kind.Refund, '30.00', { referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund);
    expect(refund.status).toBe(Status.PendingReference);

    const bet = processed(wallet, Kind.Bet, '30.00', { externalTransactionId: 'bet-1' });
    settle(wallet, refund, bet);
    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('keeps waiting while the reference itself is still pending', () => {
    const wallet = openWallet('100.00');
    const refund = wager(wallet, Kind.Refund, '30.00', { externalTransactionId: 'ref-1', referenceExternalTransactionId: 'bet-1' });
    settle(wallet, refund);
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'ref-1' });
    settle(wallet, rollback, refund);
    expect(rollback.status).toBe(Status.PendingReference);
  });

  test('is rejected with REFERENCE_NOT_FOUND after the retry limit', () => {
    const wallet = openWallet('100.00');
    const rollback = wager(wallet, Kind.Rollback, '30.00', { referenceExternalTransactionId: 'never' });
    settle(wallet, rollback); // PENDING -> PENDING_REFERENCE
    settle(wallet, rollback); // tentativa 1 de 2
    expect(rollback.status).toBe(Status.PendingReference);
    settle(wallet, rollback); // tentativa 2 de 2: esgotou
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});

describe('wallet checks', () => {
  test('currency different from the wallet is rejected', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, Kind.Bet, '1.00', { money: usd('1.00') });
    settle(wallet, bet);
    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('player that does not own the wallet is rejected', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, Kind.Bet, '1.00', { playerId: newId() });
    settle(wallet, bet);
    expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test('settling a terminal transaction is a programming error', () => {
    const wallet = openWallet('100.00');
    const bet = processed(wallet, Kind.Bet, '1.00');
    expect(() => settle(wallet, bet)).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.toString()).toBe('99.00');
  });

  test('settling against the wrong wallet is a programming error', () => {
    const bet = wager(openWallet('100.00'), Kind.Bet, '1.00');
    expect(() => settle(openWallet('100.00'), bet)).toThrow(InvalidTransactionStateError);
  });
});
