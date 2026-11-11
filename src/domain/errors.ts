/**
 * Erro de regra de domínio. `code` é estável e legível por máquina:
 * é ele que vai para o provedor decidir se reenvia, corrige o payload ou desiste.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export type InvalidWagerTransactionCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_FIELD'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_ALLOWED'
  | 'INTERNAL_KIND_NOT_ALLOWED';

/** Payload que nunca poderia ser aceito: corrigir antes de reenviar. */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: InvalidWagerTransactionCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Erro de programação, não de negócio: alguém tentou transicionar uma transação
 * terminal ou montar um lançamento que não fecha. Não estende DomainError de propósito.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
  }
}
