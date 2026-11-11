import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';

/** Campos de negócio de uma transação, no formato do contrato (HTTP e SQS). */
export interface WagerTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * JSON canônico: chaves de objeto em ordem lexicográfica (por code unit UTF-16, igual a
 * Array.prototype.sort), sem espaços, propriedades `undefined` omitidas, arrays na ordem
 * original. Dois payloads com os mesmos dados sempre geram a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson does not accept NaN or Infinity');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson does not accept ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Ficam de fora: Idempotency-Key, messageId, occurredAt e qualquer metadado de transporte,
 * então a mesma transação tem o mesmo hash vinda por HTTP ou pela fila.
 */
export function hashWagerPayload(payload: WagerTransactionPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount: payload.money.amount, currency: payload.money.currency },
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }),
  );
}
