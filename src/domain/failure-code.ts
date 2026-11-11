/**
 * Motivo de uma transação terminar em REJECTED ou FAILED.
 * Os valores são contrato público: não renomear, só acrescentar.
 */
export enum FailureCode {
  /** BET maior que o saldo. O provedor pode tentar de novo se o saldo mudar. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reverter um crédito (WIN/REFUND) deixaria o saldo negativo: precisa de ação operacional. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O playerId enviado não é o dono da wallet. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** A referência não apareceu dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas é de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência terminou REJECTED ou FAILED: não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida antes. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Erro permanente de infraestrutura (status FAILED). */
  ProcessingFailed = 'PROCESSING_FAILED',
}
