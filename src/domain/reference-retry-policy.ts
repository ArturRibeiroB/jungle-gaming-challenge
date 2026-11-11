/**
 * Quanto esperar por uma referência que ainda não chegou (ex.: ROLLBACK antes do BET).
 *
 * Padrão: 10 novas verificações com backoff exponencial de 1s até 5min. A soma dá ~17min,
 * bem acima do atraso normal de redelivery do SQS (segundos), mas curto o bastante para
 * o provedor receber uma resposta definitiva ainda na mesma sessão de jogo.
 */
export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts = 10,
    readonly baseDelayMs = 1_000,
    readonly maxDelayMs = 5 * 60_000,
  ) {}

  /** Atraso antes da verificação de número `attempt` (começando em 0). */
  delayMs(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayMs(attempt));
  }
}
