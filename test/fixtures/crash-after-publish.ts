/**
 * Simula um publisher que morre DEPOIS de enviar os eventos ao SQS e ANTES de commitar
 * o published_at: os eventos chegam à fila, mas continuam pendentes na outbox.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';

const app = await NestFactory.createApplicationContext(AppModule.register(AppConfig.fromEnv()), { logger: false });

await app.get(OutboxPublisher).publishBatch({
  afterSend: () => {
    console.log(JSON.stringify({ sent: true }));
    process.exit(137);
  },
});
console.log(JSON.stringify({ sent: false }));
process.exit(2);
