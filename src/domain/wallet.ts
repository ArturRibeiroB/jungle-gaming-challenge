import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação OPENING que justifica o saldo inicial no ledger. */
  openingTransactionId: string;
  at: Date;
}

/**
 * Aggregate root da carteira.
 *
 * A única forma de mudar o saldo é `debit`/`credit`, e as duas devolvem o lançamento
 * do ledger correspondente: saldo e ledger nunca andam separados.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com version 1. Saldo inicial positivo gera o lançamento CREDIT
   * da transação OPENING; saldo zero não gera lançamento.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance cannot be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError se o débito deixaria o saldo negativo. */
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(
        `Wallet ${this.id} has ${this._balance.toString()}, cannot debit ${money.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvalidMoneyError(`Wallet movements must be positive, got ${money.toString()}`);
    }
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    // Cria o lançamento antes de mudar o estado: se a validação falhar, a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
