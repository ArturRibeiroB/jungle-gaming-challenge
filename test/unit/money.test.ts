import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money, type MoneyProps } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test.each(['0.00', '0.01', '25.00', '1000.50', '999999999999999999.99'])('accepts %s', (amount) => {
    expect(brl(amount).toString()).toBe(amount);
  });

  test.each([
    ['empty string', ''],
    ['no decimals', '25'],
    ['one decimal', '25.5'],
    ['three decimals', '25.000'],
    ['negative', '-1.00'],
    ['explicit plus sign', '+1.00'],
    ['scientific notation', '1e3'],
    ['scientific notation with decimals', '1.00e2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['leading zero', '01.00'],
    ['comma separator', '1,00'],
    ['whitespace', ' 1.00'],
    ['missing integer part', '.50'],
    ['more than 18 integer digits', '1000000000000000000.00'],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects amount that is not a string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', '123'])('rejects currency "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('round-trips through toJSON', () => {
    const props: MoneyProps = { amount: '25.00', currency: 'BRL' };
    expect(Money.from(props).toJSON()).toEqual(props);
  });
});

describe('Money arithmetic', () => {
  test('add and subtract are exact (no floating point drift)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  test('handles values beyond Number.MAX_SAFE_INTEGER without losing precision', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).toString()).toBe('1000000000000000000.00');
  });

  test('is immutable: operations return new instances', () => {
    const original = brl('10.00');
    original.add(brl('5.00'));
    original.subtract(brl('5.00'));
    original.negate();
    expect(original.toString()).toBe('10.00');
  });

  test('subtract can go negative internally; negate flips the sign', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.toString()).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
    expect(result.negate().toString()).toBe('60.00');
    expect(brl('0.05').negate().toString()).toBe('-0.05');
  });

  test('predicates', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
  });

  test('equals compares value and currency', () => {
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('fromMinorUnits rebuilds the same value', () => {
    expect(Money.fromMinorUnits(2500n, 'BRL').equals(brl('25.00'))).toBe(true);
    expect(Money.fromMinorUnits(-5n, 'BRL').toString()).toBe('-0.05');
  });
});

describe('Money currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test.each([
    ['add', (m: Money) => m.add(usd)],
    ['subtract', (m: Money) => m.subtract(usd)],
    ['isLessThan', (m: Money) => m.isLessThan(usd)],
  ] as const)('%s with a different currency throws', (_name, operation) => {
    expect(() => operation(brl('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('error carries a stable code', () => {
    try {
      brl('1.00').add(usd);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});
