import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

/** Mesmo limite usado pela aplicação nos testes: 3 entregas antes da DLQ. */
export const TEST_MAX_RECEIVE_COUNT = 3;

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

/**
 * Filas FIFO reais (LocalStack) exclusivas de um arquivo de teste: principal + DLQ com
 * redrive policy + fila de eventos. Nada é compartilhado com a app do docker compose.
 */
export class TestQueues {
  private constructor(
    readonly sqs: SQSClient,
    readonly names: { main: string; dlq: string; events: string },
    readonly urls: { main: string; dlq: string; events: string },
  ) {}

  static async create(): Promise<TestQueues> {
    const sqs = testSqsClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const names = {
      main: `test-wager-${suffix}.fifo`,
      dlq: `test-wager-dlq-${suffix}.fifo`,
      events: `test-events-${suffix}.fifo`,
    };
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true' } }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
    const main = await sqs.send(
      new CreateQueueCommand({
        QueueName: names.main,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: '30',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: String(TEST_MAX_RECEIVE_COUNT) }),
        },
      }),
    );
    const events = await sqs.send(new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true' } }));
    return new TestQueues(sqs, names, { main: main.QueueUrl!, dlq: dlq.QueueUrl!, events: events.QueueUrl! });
  }

  /** Variáveis de ambiente para a aplicação usar estas filas. */
  env(): Record<string, string> {
    return {
      SQS_QUEUE_NAME: this.names.main,
      SQS_DLQ_NAME: this.names.dlq,
      SQS_EVENTS_QUEUE_NAME: this.names.events,
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_MAX_RECEIVE_COUNT: String(TEST_MAX_RECEIVE_COUNT),
    };
  }

  async send(body: unknown, options: { groupId: string; deduplicationId?: string }): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urls.main,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId ?? crypto.randomUUID(),
      }),
    );
  }

  /** Lê (e apaga) tudo o que estiver disponível numa fila até ela ficar vazia. */
  async drain(queue: 'events' | 'dlq' | 'main'): Promise<Message[]> {
    const collected: Message[] = [];
    for (let emptyPolls = 0; emptyPolls < 2; ) {
      const { Messages = [] } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.urls[queue],
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      if (Messages.length === 0) {
        emptyPolls += 1;
        continue;
      }
      emptyPolls = 0;
      for (const message of Messages) {
        collected.push(message);
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urls[queue], ReceiptHandle: message.ReceiptHandle }));
      }
    }
    return collected;
  }

  async approximateCount(queue: 'events' | 'dlq' | 'main'): Promise<number> {
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.urls[queue],
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(Object.values(this.urls).map((url) => this.sqs.send(new DeleteQueueCommand({ QueueUrl: url }))));
    this.sqs.destroy();
  }
}

/** Mensagem WagerTransactionRequested no formato do contrato (seção 10). */
export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}` },
  };
}

/** Espera uma condição assíncrona ficar verdadeira (polling), com timeout. */
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${String(last)}` : ''}`);
}
