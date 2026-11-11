/**
 * Simula um worker que morre DEPOIS do commit e ANTES do ack:
 * recebe uma mensagem, processa (commita no banco) e encerra o processo sem DeleteMessage.
 * A mensagem volta a ficar visível após o visibility timeout curto usado aqui.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs.module';
import { WagerTransactionConsumer } from '../../src/interfaces/messaging/wager-transaction.consumer';

const app = await NestFactory.createApplicationContext(AppModule.register(AppConfig.fromEnv()), { logger: false });
const sqs = app.get(SQSClient);
const queueUrl = await app.get(SqsQueues).mainQueueUrl();

const { Messages = [] } = await sqs.send(
  new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
    VisibilityTimeout: 2,
    MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
  }),
);
if (Messages.length === 0) {
  console.log(JSON.stringify({ received: 0 }));
  process.exit(2);
}

const decision = await app.get(WagerTransactionConsumer).process(Messages[0]!);
console.log(JSON.stringify({ received: 1, decision }));
// Morte abrupta: sem ack, sem hooks de shutdown, sem fechar conexões.
process.exit(137);
