import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError, LedgerInvariantError } from '../../src/domain/errors';
import { newId } from '../../src/domain/id';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { T0, brl, openWallet, usd } from '../support/builders';

const later = new Date(T0.getTime() + 1_000);

describe('Wallet.open', () => {
  test('positive initial balance creates version 1 and an OPENING credit entry', () => {
    const openingTransactionId = newId();
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('1000.00'),
      openingTransactionId,
      at: T0,
    });

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.transactionId).toBe(openingTransactionId);
    expect(openingEntry!.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry!.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry!.walletVersion).toBe(1);
  });

  test('zero initial balance creates version 1 without ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: Money.zero('BRL'),
      openingTransactionId: newId(),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('negative initial balance is rejected', () => {
    expect(() =>
      Wallet.open({
        id: newId(),
        playerId: newId(),
        initialBalance: Money.fromMinorUnits(-1n, 'BRL'),
        openingTransactionId: newId(),
        at: T0,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe('Wallet movements', () => {
  test('debit lowers the balance, bumps version and returns a balanced DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('80.00'), newId(), later);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit raises the balance and bumps version', () => {
    const wallet = openWallet('10.00');
    const entry = wallet.credit(brl('5.50'), newId(), later);
    expect(wallet.balance.toString()).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('debit of the whole balance leaves exactly zero', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('100.00'), newId(), later);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('debit beyond the balance throws and leaves the wallet untouched', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), newId(), later)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('second concurrent-style debit of 80 on 100 fails: balance never negative', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), newId(), later);
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(brl('80.00'), newId(), later)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('zero movements are rejected and do not bump version', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(Money.zero('BRL'), newId(), later)).toThrow(InvalidMoneyError);
    expect(() => wallet.debit(Money.zero('BRL'), newId(), later)).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test('operations in another currency are rejected', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(usd('1.00'), newId(), later)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd('1.00'), newId(), later)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('replaying the ledger rebuilds the wallet balance', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('50.00'),
      openingTransactionId: newId(),
      at: T0,
    });
    const entries = [
      openingEntry!,
      wallet.debit(brl('20.00'), newId(), later),
      wallet.credit(brl('35.25'), newId(), later),
      wallet.debit(brl('0.25'), newId(), later),
    ];
    const rebuilt = entries.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });

  test('rehydrate restores state without revalidating', () => {
    const wallet = Wallet.rehydrate({
      id: newId(),
      playerId: newId(),
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: later,
    });
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry.create', () => {
  const base = {
    walletId: newId(),
    transactionId: newId(),
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('30.00'),
    balanceAfter: brl('20.00'),
    walletVersion: 2,
    createdAt: T0,
  };

  test('accepts a balanced entry', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test('rejects arithmetic that does not add up', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('21.00') })).toThrow(LedgerInvariantError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(LedgerInvariantError);
  });

  test('rejects negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: Money.fromMinorUnits(-500n, 'BRL') }),
    ).toThrow(LedgerInvariantError);
  });

  test('rejects zero amount and invalid version', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: Money.zero('BRL'), balanceAfter: brl('30.00') }),
    ).toThrow(LedgerInvariantError);
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(LedgerInvariantError);
  });

  test('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('10.00') })).toThrow(CurrencyMismatchError);
  });

  test('exposes no state-changing methods', () => {
    const entry = WalletLedgerEntry.create(base);
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== 'constructor');
    expect(prototypeMethods.sort()).toEqual(['isBalanced', 'signedAmount']);
  });
});
