/**
 * Configuração lida das variáveis de ambiente uma única vez, no boot.
 * Falha cedo quando falta algo obrigatório, em vez de quebrar no meio de uma requisição.
 */
export class AppConfig {
  private constructor(
    readonly port: number,
    readonly databaseUrl: string,
    readonly databasePoolMax: number,
    /** Espera máxima pelo lock de uma wallet antes de responder LOCK_TIMEOUT (503). */
    readonly databaseLockTimeoutMs: number,
    readonly aws: {
      readonly region: string;
      readonly endpoint: string | undefined;
      readonly accessKeyId: string | undefined;
      readonly secretAccessKey: string | undefined;
    },
    readonly sqs: {
      readonly queueName: string;
      readonly dlqName: string;
      /** Fila onde a outbox publica os eventos de integração. */
      readonly eventsQueueName: string;
      readonly waitTimeSeconds: number;
      /** Entregas de uma mensagem antes de ela ir para a DLQ (igual ao maxReceiveCount da fila). */
      readonly maxReceiveCount: number;
    },
    readonly workers: {
      /** Liga consumidor SQS, publicador da outbox e worker de referências pendentes. */
      readonly enabled: boolean;
      /** Pausa entre ciclos quando não há trabalho. */
      readonly idleDelayMs: number;
      readonly outboxBatchSize: number;
      readonly referenceRetryMaxAttempts: number;
      readonly referenceRetryBaseDelayMs: number;
    },
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): AppConfig {
    return new AppConfig(
      integer(env, 'PORT', 3000),
      required(env, 'DATABASE_URL'),
      integer(env, 'DATABASE_POOL_MAX', 10),
      integer(env, 'DATABASE_LOCK_TIMEOUT_MS', 5_000),
      {
        region: env.AWS_REGION ?? 'us-east-1',
        endpoint: env.AWS_ENDPOINT_URL,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
      {
        queueName: env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
        dlqName: env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
        eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? 'wagering-events.fifo',
        waitTimeSeconds: integer(env, 'SQS_WAIT_TIME_SECONDS', 10),
        maxReceiveCount: integer(env, 'SQS_MAX_RECEIVE_COUNT', 5),
      },
      {
        enabled: boolean(env, 'WORKERS_ENABLED', true),
        idleDelayMs: integer(env, 'WORKER_IDLE_DELAY_MS', 1_000),
        outboxBatchSize: integer(env, 'OUTBOX_BATCH_SIZE', 50),
        referenceRetryMaxAttempts: integer(env, 'REFERENCE_RETRY_MAX_ATTEMPTS', 10),
        referenceRetryBaseDelayMs: integer(env, 'REFERENCE_RETRY_BASE_DELAY_MS', 1_000),
      },
    );
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function boolean(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new Error(`Environment variable ${name} must be true or false, got "${env[name]}"`);
}
