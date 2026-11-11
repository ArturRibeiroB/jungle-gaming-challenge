/**
 * Erros da camada de aplicação. `kind` diz ao adaptador de entrada (HTTP, SQS) o que fazer:
 *
 * - INVALID: payload nunca vai ser aceito como está; corrigir antes de reenviar.
 * - NOT_FOUND: o recurso não existe.
 * - CONFLICT: colide com algo já registrado (idempotência, unicidade).
 * - TRANSIENT: falha temporária de infraestrutura; reenviar a mesma requisição é seguro.
 */
export type ApplicationErrorKind = 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'TRANSIENT';

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly kind: ApplicationErrorKind;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';
  readonly kind = 'INVALID';

  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly kind = 'NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly kind = 'NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly kind = 'CONFLICT';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma Idempotency-Key com payload diferente: conflito, nunca replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly kind = 'CONFLICT';

  constructor(providerId: string, idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" of provider ${providerId} was already used with a different payload`);
  }
}

/** Mesmo (providerId, externalTransactionId) enviado com outra Idempotency-Key. */
export class DuplicateExternalTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_EXTERNAL_TRANSACTION';
  readonly kind = 'CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(`Transaction ${externalTransactionId} of provider ${providerId} was already submitted with another idempotency key`);
  }
}

/** Mesmo messageId da fila com conteúdo diferente: mensagem corrompida, vai para a DLQ. */
export class InboxPayloadConflictError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';
  readonly kind = 'CONFLICT';

  constructor(consumerName: string, messageId: string) {
    super(`Message ${messageId} was already consumed by ${consumerName} with a different payload`);
  }
}

/** Violação de unicidade vinda do banco. Normalmente uma corrida que se resolve tentando de novo. */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';
  readonly kind = 'CONFLICT';

  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Unique constraint violated${constraint ? `: ${constraint}` : ''}`, options);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code: 'TRANSIENT_FAILURE' | 'LOCK_TIMEOUT';
  readonly kind = 'TRANSIENT';

  constructor(code: 'TRANSIENT_FAILURE' | 'LOCK_TIMEOUT', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
