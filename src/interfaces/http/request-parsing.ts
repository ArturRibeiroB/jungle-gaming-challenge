import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { InvalidRequestError } from '../../application/errors';
import type { WagerTransactionPayload } from '../../application/payload-hash';
import type { MoneyProps } from '../../domain/money';

/**
 * Validação de formato dos contratos de entrada (tipos, obrigatoriedade, tamanhos).
 * Regras de valor (escala do Money, kind permitido, referência obrigatória...) ficam no domínio.
 * Todos os problemas encontrados voltam juntos em `details`.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

type Json = Record<string, unknown>;

class Fields {
  readonly errors: string[] = [];

  constructor(private readonly body: Json) {}

  string(field: string, maxLength: number): string {
    const value = this.body[field];
    if (typeof value !== 'string' || value.trim() === '') {
      this.errors.push(`${field} must be a non-empty string`);
      return '';
    }
    if (value.length > maxLength) {
      this.errors.push(`${field} must have at most ${maxLength} characters`);
    }
    return value;
  }

  optionalString(field: string, maxLength: number): string | undefined {
    return this.body[field] === undefined || this.body[field] === null ? undefined : this.string(field, maxLength);
  }

  uuid(field: string): string {
    const value = this.string(field, 36);
    if (value && !UUID_PATTERN.test(value)) {
      this.errors.push(`${field} must be a UUID`);
    }
    return value.toLowerCase();
  }

  money(field: string): MoneyProps {
    const value = this.body[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.errors.push(`${field} must be an object like {"amount": "25.00", "currency": "BRL"}`);
      return { amount: '', currency: '' };
    }
    const { amount, currency } = value as Json;
    if (typeof amount !== 'string') {
      this.errors.push(`${field}.amount must be a decimal string`);
    }
    if (typeof currency !== 'string') {
      this.errors.push(`${field}.currency must be a string`);
    }
    return { amount: String(amount), currency: String(currency) };
  }

  done<T>(value: T): T {
    if (this.errors.length > 0) {
      throw new InvalidRequestError('Invalid request payload', this.errors);
    }
    return value;
  }
}

function asObject(body: unknown): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestError('Request body must be a JSON object');
  }
  return body as Json;
}

export function parseOpenWallet(body: unknown): { playerId: string; initialBalance: MoneyProps } {
  const fields = new Fields(asObject(body));
  return fields.done({ playerId: fields.uuid('playerId'), initialBalance: fields.money('initialBalance') });
}

/** Mesmo formato de `data` na mensagem SQS, sem o idempotencyKey (que no HTTP vem no header). */
export function parseWagerTransactionPayload(body: unknown): WagerTransactionPayload {
  const fields = new Fields(asObject(body));
  return fields.done({
    providerId: fields.string('providerId', 100),
    externalTransactionId: fields.string('externalTransactionId', 200),
    playerId: fields.uuid('playerId'),
    walletId: fields.uuid('walletId'),
    roundId: fields.string('roundId', 200),
    gameId: fields.string('gameId', 200),
    kind: fields.string('kind', 16),
    money: fields.money('money'),
    referenceExternalTransactionId: fields.optionalString('referenceExternalTransactionId', 200),
  });
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length > 300 || !PRINTABLE_ASCII.test(key)) {
    throw new InvalidRequestError('Idempotency-Key header is required (1-300 printable ASCII characters)');
  }
  return key;
}

export function parseUuidParam(name: string, value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d{1,4}$/.test(value)) {
    throw new InvalidRequestError('limit must be a positive integer');
  }
  return Number(value);
}

/** Propaga o X-Correlation-Id do chamador ou gera um novo. */
export function correlationIdOf(request: Request): string {
  const header = request.header('x-correlation-id');
  return header && header.length <= 200 && PRINTABLE_ASCII.test(header) ? header : randomUUID();
}
