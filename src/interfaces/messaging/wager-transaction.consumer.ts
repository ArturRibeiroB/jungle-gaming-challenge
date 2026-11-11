import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { ApplicationError, InvalidRequestError } from '../../application/errors';
import { canonicalJson, sha256Hex } from '../../application/payload-hash';
import { WagerTransactionService } from '../../application/wager-transaction.service';
import { AppConfig } from '../../config/app-config';
import { DomainError } from '../../domain/errors';
import { SqsQueues } from '../../infrastructure/messaging/sqs.module';
import { PollingLoop } from '../../infrastructure/workers/polling-loop';
import { Logger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { parseIdempotencyKey, parseWagerTransactionPayload } from '../http/request-parsing';

export const CONSUMER_NAME = 'wager-transactions-consumer';
const MESSAGE_TYPE = 'WagerTransactionRequested';
const MAX_BATCH = 10;
const MAX_RETRY_DELAY_SECONDS = 60;

/** O que fazer com a mensagem depois de processada. */
export type Decision =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number; reason: string }
  | { action: 'dead-letter'; reason: string };

/**
 * Consumidor da fila wager-transactions.fifo. Usa o mesmo caso de uso da API HTTP.
 *
 * - negócio (PROCESSED, REJECTED, PENDING_REFERENCE): ack.
 * - permanente (mensagem inválida, conflito, wallet inexistente): vai direto para a DLQ.
 * - transitório (banco fora, lock ocupado): não dá ack; adia a mensagem com backoff
 *   exponencial via visibility timeout. Na entrega número `maxReceiveCount`, vai para a DLQ.
 *   A redrive policy da fila (mesmo limite) é a rede de segurança se o processo morrer em loop.
 *
 * O ack (DeleteMessage) só acontece depois do commit. Se o processo morrer entre um e outro,
 * o SQS entrega de novo e a inbox transforma a nova entrega em replay, sem efeito duplicado.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly transactions: WagerTransactionService,
    private readonly config: AppConfig,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.enabled) {
      this.loop = new PollingLoop('WagerTransactionConsumerLoop', (signal) => this.pollOnce(signal), this.config.workers.idleDelayMs);
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }

  /** Um ciclo de long polling. Devolve `true` se recebeu alguma mensagem. */
  async pollOnce(signal: AbortSignal): Promise<boolean> {
    const queueUrl = await this.queues.mainQueueUrl(signal);
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: MAX_BATCH,
        WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );

    // Ordem preservada dentro de cada MessageGroupId (a wallet); grupos diferentes em paralelo.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (signal.aborted) {
            // Desligando: devolve o que ainda não começou, para outra instância pegar já.
            await this.returnToQueue(queueUrl, message);
            continue;
          }
          await this.handle(queueUrl, message);
        }
      }),
    );
    return messages.length > 0;
  }

  async handle(queueUrl: string, message: Message): Promise<Decision> {
    const decision = await this.process(message);
    await this.settle(queueUrl, message, decision);
    return decision;
  }

  /** Executa o caso de uso e decide o destino da mensagem. Não faz ack. */
  async process(message: Message): Promise<Decision> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let fields: Record<string, string | undefined> = { sqsMessageId: message.MessageId };
    try {
      const parsed = parseMessage(message.Body ?? '');
      fields = {
        ...fields,
        messageId: parsed.messageId,
        correlationId: parsed.messageId,
        walletId: parsed.payload.walletId,
        providerId: parsed.payload.providerId,
      };
      const outcome = await this.transactions.submit({
        idempotencyKey: parsed.idempotencyKey,
        payload: parsed.payload,
        correlationId: parsed.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash: parsed.hash },
      });
      this.metrics.increment('sqs_messages_total', { result: outcome.idempotentReplay ? 'duplicate' : 'processed' });
      return { action: 'ack' };
    } catch (error) {
      const decision = this.decide(error, receiveCount);
      this.metrics.increment('sqs_messages_total', { result: decision.action });
      const log = decision.action === 'retry' ? this.logger.warn.bind(this.logger) : this.logger.error.bind(this.logger);
      log('Message not processed', { ...fields, action: decision.action, reason: decision.reason, receiveCount }, error);
      return decision;
    }
  }

  private decide(error: unknown, receiveCount: number): Exclude<Decision, { action: 'ack' }> {
    const permanent =
      error instanceof DomainError ||
      (error instanceof ApplicationError && error.kind !== 'TRANSIENT' && error.code !== 'UNIQUE_VIOLATION');
    if (permanent) {
      return { action: 'dead-letter', reason: (error as DomainError | ApplicationError).code };
    }
    const reason = error instanceof ApplicationError ? error.code : 'UNEXPECTED_ERROR';
    if (receiveCount >= this.config.sqs.maxReceiveCount) {
      return { action: 'dead-letter', reason: `RETRIES_EXHAUSTED:${reason}` };
    }
    return { action: 'retry', delaySeconds: Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS), reason };
  }

  private async settle(queueUrl: string, message: Message, decision: Decision): Promise<void> {
    try {
      switch (decision.action) {
        case 'ack':
          await this.delete(queueUrl, message);
          return;
        case 'retry':
          this.metrics.increment('wagering_retries_total', { reason: 'sqs_transient' });
          await this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: decision.delaySeconds,
            }),
          );
          return;
        case 'dead-letter':
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: await this.queues.deadLetterQueueUrl(),
              MessageBody: message.Body ?? '',
              MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
              MessageDeduplicationId: message.MessageId,
              MessageAttributes: {
                failureReason: { DataType: 'String', StringValue: decision.reason },
                sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
              },
            }),
          );
          // Só apaga da fila principal depois que a cópia na DLQ foi aceita.
          await this.delete(queueUrl, message);
          this.metrics.increment('sqs_dlq_messages_total', { reason: decision.reason.split(':')[0]! });
          return;
      }
    } catch (error) {
      // Sem ack, a mensagem volta após o visibility timeout e a inbox cuida da duplicata.
      this.logger.warn('Could not settle message', { sqsMessageId: message.MessageId, action: decision.action }, error);
    }
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async returnToQueue(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    } catch (error) {
      this.logger.warn('Could not return message to the queue', { sqsMessageId: message.MessageId }, error);
    }
  }
}

interface ParsedMessage {
  messageId: string;
  idempotencyKey: string;
  payload: ReturnType<typeof parseWagerTransactionPayload>;
  /** Hash da mensagem inteira (envelope + data), gravado na inbox. */
  hash: string;
}

/** Valida o envelope `WagerTransactionRequested`. Qualquer problema é permanente (DLQ). */
export function parseMessage(body: string): ParsedMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InvalidRequestError('Message body is not valid JSON');
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new InvalidRequestError('Message body must be a JSON object');
  }
  const { messageId, type, data } = envelope as Record<string, unknown>;
  if (typeof messageId !== 'string' || messageId.trim() === '' || messageId.length > 200) {
    throw new InvalidRequestError('messageId must be a non-empty string');
  }
  if (type !== MESSAGE_TYPE) {
    throw new InvalidRequestError(`Unsupported message type "${String(type)}"`);
  }
  const idempotencyKey = (data as Record<string, unknown> | null)?.idempotencyKey;
  return {
    messageId,
    idempotencyKey: parseIdempotencyKey(typeof idempotencyKey === 'string' ? idempotencyKey : undefined),
    payload: parseWagerTransactionPayload(data),
    hash: sha256Hex(canonicalJson(envelope)),
  };
}
