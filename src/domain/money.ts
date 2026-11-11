import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Formato do contrato externo (HTTP, SQS, eventos). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 10n ** BigInt(SCALE);

/**
 * Inteiro sem zeros à esquerda, ponto e exatamente duas casas.
 * Rejeita por construção: sinal, notação científica, NaN, Infinity, vírgula e espaços.
 * Até 18 dígitos inteiros, para caber em NUMERIC(20, 2) no banco.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável.
 *
 * Internamente guarda centavos (unidades menores) em `bigint`, então soma e subtração
 * são exatas e nunca há arredondamento. Como a escala é fixa em 2 casas e entradas com
 * mais casas são rejeitadas, nenhuma operação do domínio precisa arredondar.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    readonly currency: string,
  ) {}

  /** Entrada de contrato externo: string decimal com 2 casas, nunca negativa. */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props?.currency);
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount "${props.amount}": expected a non-negative decimal string with exactly ${SCALE} decimal places`,
      );
    }
    const [, units, cents] = match;
    return new Money(BigInt(units!) * MINOR_UNITS_PER_UNIT + BigInt(cents!), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  /** Reconstrução a partir de centavos (persistência). Aceita negativos, que são estado interno válido. */
  static fromMinorUnits(minor: bigint, currency: string): Money {
    return new Money(minor, Money.parseCurrency(currency));
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Só o valor decimal, ex.: "25.00" ou "-3.50". */
  toString(): string {
    const sign = this.minor < 0n ? '-' : '';
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const units = abs / MINOR_UNITS_PER_UNIT;
    const cents = (abs % MINOR_UNITS_PER_UNIT).toString().padStart(SCALE, '0');
    return `${sign}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected an ISO-4217 code like "BRL"`);
    }
    return currency;
  }
}
