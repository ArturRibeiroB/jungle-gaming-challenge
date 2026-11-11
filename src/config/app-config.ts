/**
 * Configuração lida das variáveis de ambiente uma única vez, no boot.
 * Falha cedo quando falta algo obrigatório, em vez de quebrar no meio de uma requisição.
 */
export class AppConfig {
  private constructor(
    readonly port: number,
    readonly databaseUrl: string,
    readonly databasePoolMax: number,
    readonly aws: {
      readonly region: string;
      readonly endpoint: string | undefined;
      readonly accessKeyId: string | undefined;
      readonly secretAccessKey: string | undefined;
    },
    readonly sqs: {
      readonly queueName: string;
      readonly dlqName: string;
    },
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): AppConfig {
    return new AppConfig(
      integer(env, 'PORT', 3000),
      required(env, 'DATABASE_URL'),
      integer(env, 'DATABASE_POOL_MAX', 10),
      {
        region: env.AWS_REGION ?? 'us-east-1',
        endpoint: env.AWS_ENDPOINT_URL,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
      {
        queueName: env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
        dlqName: env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
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
