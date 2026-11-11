import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashWagerPayload, type WagerTransactionPayload } from '../../src/application/payload-hash';

const payload: WagerTransactionPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
  });

  test('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(TypeError);
  });
});

describe('hashWagerPayload', () => {
  test('is a stable SHA-256 hex digest', () => {
    const hash = hashWagerPayload(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWagerPayload({ ...payload })).toBe(hash);
  });

  test('ignores field order and transport metadata', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerTransactionPayload;
    const withTransport = { ...payload, idempotencyKey: 'other', messageId: 'm-1' } as WagerTransactionPayload;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
    expect(hashWagerPayload(withTransport)).toBe(hashWagerPayload(payload));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['round', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'bet-1' }],
  ])('changes when the %s changes (same key + different payload = conflict)', (_field, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });
});
