import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { WageringStore } from '../../application/ports';
import { AppConfig } from '../../config/app-config';
import type { OutboxMessage } from '../../domain/outbox-message';
import { Logger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { PollingLoop } from '../workers/polling-loop';
import { SqsQueues } from './sqs.module';

const SQS_BATCH_LIMIT = 10;

export interface PublishHooks {
  /** Chamado depois do envio ao SQS e antes do commit. Usado pelos testes de crash. */
  afterSend?: () => Promise<void> | void;
}

/**
 * Publica os eventos da outbox na fila wagering-events.fifo.
 *
 * Cada ciclo, numa transação: trava um lote com FOR UPDATE SKIP LOCKED, envia ao SQS e marca
 * como publicado. Vários publishers (em várias instâncias) dividem o trabalho sem se bloquear.
 *
 * Se o processo morrer depois de enviar e antes do commit, o lote volta a ficar pendente e é
 * reenviado por outra instância: entrega at-least-once. A duplicata é segura porque o
 * MessageDeduplicationId é o eventId (o SQS FIFO descarta repetições por 5 min) e, depois
 * disso, o consumidor deduplica pelo mesmo eventId.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private loop: PollingLoop | undefined;

  constructor(
    private readonly store: WageringStore,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly config: AppConfig,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.enabled) {
      this.loop = new PollingLoop('OutboxPublisherLoop', () => this.runOnce(), this.config.workers.idleDelayMs);
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }

  /** Publica um lote e atualiza as métricas de lag. Devolve `true` se havia algo a publicar. */
  async runOnce(): Promise<boolean> {
    const published = await this.publishBatch();
    await this.refreshLag();
    return published > 0;
  }

  async publishBatch(hooks: PublishHooks = {}): Promise<number> {
    const queueUrl = await this.queues.eventsQueueUrl();
    return this.store.transaction(async (uow) => {
      const now = new Date();
      const messages = await uow.outbox.claimDue(now, this.config.workers.outboxBatchSize);
      if (messages.length === 0) {
        return 0;
      }

      const failures = new Map<string, string>();
      for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
        const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
        try {
          const result = await this.sqs.send(
            new SendMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: chunk.map((message) => ({
                Id: message.id,
                MessageBody: JSON.stringify(message.payload),
                MessageGroupId: message.aggregateId,
                MessageDeduplicationId: message.id,
                MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
              })),
            }),
          );
          for (const failed of result.Failed ?? []) {
            failures.set(failed.Id ?? '', `${failed.Code}: ${failed.Message ?? ''}`);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          chunk.forEach((message) => failures.set(message.id, reason));
        }
      }

      await hooks.afterSend?.();

      let published = 0;
      for (const message of messages) {
        const failure = failures.get(message.id);
        if (failure === undefined) {
          message.markPublished(now);
          uow.outbox.save(message);
          published += 1;
        } else {
          message.scheduleRetry(now);
          uow.outbox.save(message, failure);
        }
      }
      this.record(messages, published, failures);
      return published;
    });
  }

  private record(messages: OutboxMessage[], published: number, failures: Map<string, string>): void {
    this.metrics.increment('outbox_published_total', {}, published);
    if (failures.size > 0) {
      this.metrics.increment('outbox_publish_failures_total', {}, failures.size);
      this.logger.warn('Some outbox messages failed to publish', {
        failed: failures.size,
        claimed: messages.length,
        firstError: [...failures.values()][0]?.slice(0, 200),
      });
    }
  }

  private async refreshLag(): Promise<void> {
    const stats = await this.store.read((uow) => uow.outbox.stats());
    this.metrics.set('outbox_pending_messages', stats.pending);
    this.metrics.set('outbox_lag_seconds', stats.oldestPendingAt ? (Date.now() - stats.oldestPendingAt.getTime()) / 1000 : 0);
  }
}
