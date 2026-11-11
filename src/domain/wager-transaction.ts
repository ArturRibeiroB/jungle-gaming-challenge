import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import type { Money } from './money';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não pode vir da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/**
 * Transições válidas. Qualquer outra é erro de programação.
 *
 *   PENDING ──────────┬──> PROCESSED
 *      │              ├──> REJECTED
 *      │              └──> FAILED
 *      └──> PENDING_REFERENCE ──(nova tentativa)──> PENDING_REFERENCE
 *                     ├──> PROCESSED
 *                     ├──> REJECTED   (inclusive REFERENCE_NOT_FOUND ao esgotar tentativas)
 *                     └──> FAILED
 */
const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Que tipos cada operação pode referenciar. Ausente = não aceita referência. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const OPENING_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  /** Só é ausente na transação interna OPENING. */
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Saldo da wallet no momento em que a transação terminou; devolvido igual no replay. */
  observedBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id no provedor — não o id interno */
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /** Transação vinda de um provedor. Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('INTERNAL_KIND_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('INVALID_FIELD', `Unknown kind "${String(props.kind)}"`);
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'roundId', 'gameId'] as const) {
      if (typeof props[field] !== 'string' || props[field].trim() === '') {
        throw new InvalidWagerTransactionError('INVALID_FIELD', `${field} must be a non-empty string`);
      }
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError('INVALID_AMOUNT', `${props.kind} amount must be greater than zero`);
    }

    const reference = props.referenceExternalTransactionId;
    const acceptsReference = ALLOWED_REFERENCE_KINDS[props.kind] !== undefined;
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !reference) {
      throw new InvalidWagerTransactionError('REFERENCE_REQUIRED', `${props.kind} requires referenceExternalTransactionId`);
    }
    if (!acceptsReference && reference !== undefined) {
      throw new InvalidWagerTransactionError('REFERENCE_NOT_ALLOWED', `${props.kind} cannot reference another transaction`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('INVALID_FIELD', 'A transaction cannot reference itself');
    }

    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: reference || undefined,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  /** Crédito de abertura da wallet. Já nasce PROCESSED, na mesma transação SQL da wallet. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; payloadHash: string; at: Date }): WagerTransaction {
    const key = `opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: props.at,
      observedBalance: props.money,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = balanceAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Primeira vez que a referência não foi encontrada: agenda a próxima verificação. */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference requires PENDING, transaction ${this.id} is ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = policy.nextAttemptAt(now, 0);
  }

  /**
   * Mais uma verificação sem a referência. Devolve `false` quando as tentativas acabaram;
   * quem chamou decide rejeitar com REFERENCE_NOT_FOUND.
   */
  scheduleReferenceRetry(now: Date, policy: ReferenceRetryPolicy): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry requires PENDING_REFERENCE, transaction ${this.id} is ${this._status}`);
    }
    this._referenceAttempts += 1;
    if (this._referenceAttempts >= policy.maxAttempts) {
      return false;
    }
    this._nextReferenceAttemptAt = policy.nextAttemptAt(now, this._referenceAttempts);
    return true;
  }

  reject(code: FailureCode, observedBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da referência; os demais têm direção fixa. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK needs its reference to decide the ledger direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${operation}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
