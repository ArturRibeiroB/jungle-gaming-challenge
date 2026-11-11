import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type InvalidWagerTransactionCode,
} from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { newId } from '../../src/domain/id';
import { ReferenceRetryPolicy } from '../../src/domain/reference-retry-policy';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { HASH, T0, brl, openWallet, wager } from '../support/builders';

const policy = new ReferenceRetryPolicy(3, 1_000, 60_000);

function expectInvalid(fn: () => unknown, code: InvalidWagerTransactionCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect((error as InvalidWagerTransactionError).code).toBe(code);
    return;
  }
  throw new Error(`expected InvalidWagerTransactionError ${code}`);
}

describe('WagerTransaction.create', () => {
  const wallet = openWallet();

  test('starts PENDING with no outcome yet', () => {
    const tx = wager(wallet, Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('OPENING cannot be submitted from outside', () => {
    expectInvalid(() => wager(wallet, Kind.Opening, '10.00'), 'INTERNAL_KIND_NOT_ALLOWED');
  });

  test('unknown kind is invalid', () => {
    expectInvalid(() => wager(wallet, 'JACKPOT' as Kind, '10.00'), 'INVALID_FIELD');
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expectInvalid(() => wager(wallet, kind, '10.00'), 'REFERENCE_REQUIRED');
  });

  test('BET cannot carry a reference', () => {
    expectInvalid(() => wager(wallet, Kind.Bet, '10.00', { referenceExternalTransactionId: 'bet-0' }), 'REFERENCE_NOT_ALLOWED');
  });

  test('WIN and LOSS may optionally reference a BET', () => {
    expect(wager(wallet, Kind.Win, '10.00').referenceExternalTransactionId).toBeUndefined();
    expect(wager(wallet, Kind.Loss, '0.00', { referenceExternalTransactionId: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
  });

  test('a transaction cannot reference itself', () => {
    expectInvalid(
      () => wager(wallet, Kind.Rollback, '10.00', { externalTransactionId: 'tx-1', referenceExternalTransactionId: 'tx-1' }),
      'INVALID_FIELD',
    );
  });

  test.each([Kind.Bet, Kind.Win])('%s with zero amount is invalid', (kind) => {
    expectInvalid(() => wager(wallet, kind, '0.00'), 'INVALID_AMOUNT');
  });

  test('LOSS accepts zero amount', () => {
    expect(wager(wallet, Kind.Loss, '0.00').money.isZero()).toBe(true);
  });

  test.each(['providerId', 'roundId', 'gameId', 'externalTransactionId'] as const)('empty %s is invalid', (field) => {
    expectInvalid(() => wager(wallet, Kind.Bet, '1.00', { [field]: '  ' }), 'INVALID_FIELD');
  });
});

describe('WagerTransaction transitions', () => {
  const wallet = openWallet();

  test('PENDING -> PROCESSED records reference, time and observed balance', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    tx.markProcessed(undefined, T0, brl('90.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T0);
    expect(tx.observedBalance?.toString()).toBe('90.00');
  });

  test('PENDING -> REJECTED keeps the failure code', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, brl('5.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING -> FAILED', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    tx.fail(FailureCode.ProcessingFailed);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, T0, brl('1.00'))],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, brl('1.00'))],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed)],
  ] as const)('terminal %s cannot transition again', (_status, toTerminal) => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    toTerminal(tx);
    expect(() => tx.markProcessed(undefined, T0, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(T0, policy)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE schedules retries with exponential backoff until the limit', () => {
    const tx = wager(wallet, Kind.Rollback, '10.00', { referenceExternalTransactionId: 'missing' });
    tx.markPendingReference(T0, policy);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 1_000);

    expect(tx.scheduleReferenceRetry(T0, policy)).toBe(true);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 2_000);
    expect(tx.scheduleReferenceRetry(T0, policy)).toBe(true);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 4_000);
    expect(tx.scheduleReferenceRetry(T0, policy)).toBe(false);
    expect(tx.referenceAttempts).toBe(3);
  });

  test('markPendingReference only from PENDING', () => {
    const tx = wager(wallet, Kind.Rollback, '10.00', { referenceExternalTransactionId: 'missing' });
    tx.markPendingReference(T0, policy);
    expect(() => tx.markPendingReference(T0, policy)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE can still end PROCESSED or REJECTED', () => {
    const processed = wager(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'b' });
    processed.markPendingReference(T0, policy);
    processed.markProcessed(newId(), T0, brl('110.00'));
    expect(processed.status).toBe(Status.Processed);
    expect(processed.nextReferenceAttemptAt).toBeUndefined();

    const rejected = wager(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'b' });
    rejected.markPendingReference(T0, policy);
    rejected.reject(FailureCode.ReferenceNotFound, brl('100.00'));
    expect(rejected.status).toBe(Status.Rejected);
  });
});

describe('WagerTransaction queries', () => {
  const wallet = openWallet();

  test('LOSS does not affect balance, the rest does', () => {
    expect(wager(wallet, Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wager(wallet, Kind.Bet, '1.00').affectsBalance()).toBe(true);
    expect(wager(wallet, Kind.Win, '1.00').affectsBalance()).toBe(true);
  });

  test('ledger direction by kind; ROLLBACK inverts its reference', () => {
    const bet = wager(wallet, Kind.Bet, '10.00');
    const win = wager(wallet, Kind.Win, '10.00');
    const refund = wager(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'x' });
    const rollback = wager(wallet, Kind.Rollback, '10.00', { referenceExternalTransactionId: 'x' });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => wager(wallet, Kind.Loss, '0.00').ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('same idempotency key with a different payload hash does not match', () => {
    const tx = wager(wallet, Kind.Bet, '10.00');
    expect(tx.matchesPayload(HASH)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('opening transaction is internal and born PROCESSED', () => {
    const tx = WagerTransaction.opening({
      id: newId(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      payloadHash: HASH,
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.status).toBe(Status.Processed);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
