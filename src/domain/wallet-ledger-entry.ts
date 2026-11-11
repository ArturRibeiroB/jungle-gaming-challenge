import { LedgerInvariantError } from './errors';
import { newId } from './id';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet depois deste lançamento. Única por wallet: forma uma cadeia sem buracos. */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'id'>;

/**
 * Lançamento imutável do ledger. Só tem campos readonly e nenhum método que altere estado;
 * no banco, um trigger bloqueia UPDATE, DELETE e TRUNCATE.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {}

  /** Valida a aritmética: um lançamento que não fecha é bug, não regra de negócio. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate({ id: newId(), ...props });
    if (!entry.money.isPositive()) {
      throw new LedgerInvariantError(`Ledger amount must be positive, got ${entry.money.toString()}`);
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new LedgerInvariantError('Ledger balances must never be negative');
    }
    if (!Number.isSafeInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new LedgerInvariantError(`Invalid wallet version ${entry.walletVersion}`);
    }
    // isBalanced também compara as moedas (lança CurrencyMismatchError se forem diferentes).
    if (!entry.isBalanced()) {
      throw new LedgerInvariantError(
        `Unbalanced ledger entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito do lançamento no saldo: positivo para crédito, negativo para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
