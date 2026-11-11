import { InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Já travada pelo chamador (SELECT ... FOR UPDATE) dentro da transação SQL. */
  wallet: Wallet;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); undefined se não existe ainda. */
  reference: WagerTransaction | undefined;
  /** Se a referência já tem uma reversão PROCESSED (REFUND ou ROLLBACK). */
  referenceAlreadyReversed: boolean;
  now: Date;
}

export interface SettlementResult {
  /** Lançamento a persistir; ausente quando o saldo não mudou. */
  ledgerEntry: WalletLedgerEntry | undefined;
}

/**
 * Serviço de domínio que aplica as regras de negócio da seção 7 a uma transação
 * ainda não terminal. Não faz I/O: recebe tudo já carregado e só muda o estado
 * da transação e da wallet. Quem chama persiste o resultado na mesma transação SQL.
 */
export class WagerSettlement {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  settle(input: SettlementInput): SettlementResult {
    const { transaction: tx, wallet, now } = input;
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(`Transaction ${tx.id} is already ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(`Transaction ${tx.id} belongs to wallet ${tx.walletId}, got ${wallet.id}`);
    }

    if (tx.playerId !== wallet.playerId) {
      return this.reject(input, FailureCode.WalletPlayerMismatch);
    }
    if (tx.money.currency !== wallet.currency) {
      return this.reject(input, FailureCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const resolution = this.resolveReference(input);
      if (resolution !== 'ok') {
        return resolution;
      }
      reference = input.reference;
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { ledgerEntry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // Aposta sem saldo e reversão que estouraria o saldo são situações operacionais
      // diferentes, por isso códigos diferentes.
      const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
      return this.reject(input, code);
    }

    const ledgerEntry =
      direction === LedgerDirection.Debit ? wallet.debit(tx.money, tx.id, now) : wallet.credit(tx.money, tx.id, now);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { ledgerEntry };
  }

  /** 'ok' quando a referência é válida; senão o resultado (pendente ou rejeitado) já aplicado. */
  private resolveReference(input: SettlementInput): 'ok' | SettlementResult {
    const { transaction: tx, reference } = input;

    // Referência ainda não chegou, ou chegou mas também está esperando: aguarda.
    if (!reference || !reference.isTerminal()) {
      return this.waitForReference(input);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(input, FailureCode.ReferenceNotProcessed);
    }
    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) {
      return this.reject(input, FailureCode.ReferenceMismatch);
    }
    if (!tx.canReference(reference.kind)) {
      return this.reject(input, FailureCode.ReferenceKindNotAllowed);
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return this.reject(input, FailureCode.ReferenceAmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return this.reject(input, FailureCode.AlreadyReversed);
      }
    }
    return 'ok';
  }

  private waitForReference(input: SettlementInput): SettlementResult {
    const { transaction: tx, now } = input;
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(now, this.retryPolicy);
      return { ledgerEntry: undefined };
    }
    const scheduled = tx.scheduleReferenceRetry(now, this.retryPolicy);
    return scheduled ? { ledgerEntry: undefined } : this.reject(input, FailureCode.ReferenceNotFound);
  }

  private reject(input: SettlementInput, code: FailureCode): SettlementResult {
    input.transaction.reject(code, input.wallet.balance);
    return { ledgerEntry: undefined };
  }
}
