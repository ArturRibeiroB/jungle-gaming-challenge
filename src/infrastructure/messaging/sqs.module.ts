import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppConfig } from '../../config/app-config';

/** Resolve e memoriza as URLs das filas configuradas. */
@Injectable()
export class SqsQueues implements OnApplicationShutdown {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(
    @Inject(SQSClient) readonly client: SQSClient,
    private readonly config: AppConfig,
  ) {}

  mainQueueUrl(signal?: AbortSignal): Promise<string> {
    return this.urlFor(this.config.sqs.queueName, signal);
  }

  deadLetterQueueUrl(signal?: AbortSignal): Promise<string> {
    return this.urlFor(this.config.sqs.dlqName, signal);
  }

  eventsQueueUrl(signal?: AbortSignal): Promise<string> {
    return this.urlFor(this.config.sqs.eventsQueueName, signal);
  }

  /** Chamada real ao SQS para cada fila (as URLs ficam em cache, então só resolvê-las não prova nada). */
  async ping(signal?: AbortSignal): Promise<void> {
    const urls = await Promise.all([this.mainQueueUrl(signal), this.deadLetterQueueUrl(signal), this.eventsQueueUrl(signal)]);
    await Promise.all(
      urls.map((url) =>
        this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }), { abortSignal: signal }),
      ),
    );
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private urlFor(queueName: string, signal?: AbortSignal): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) {
      return cached;
    }
    const pending = this.client
      .send(new GetQueueUrlCommand({ QueueName: queueName }), { abortSignal: signal })
      .then((output) => {
        if (!output.QueueUrl) {
          throw new Error(`Queue ${queueName} has no URL`);
        }
        return output.QueueUrl;
      });
    // Não memoriza falhas: a próxima chamada tenta de novo.
    pending.catch(() => this.urls.delete(queueName));
    this.urls.set(queueName, pending);
    return pending;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.aws.region,
          endpoint: config.aws.endpoint,
          credentials:
            config.aws.accessKeyId && config.aws.secretAccessKey
              ? { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey }
              : undefined,
        }),
    },
    SqsQueues,
  ],
  exports: [SQSClient, SqsQueues],
})
export class SqsModule {}
