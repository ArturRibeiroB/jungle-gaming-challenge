import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { NestJsonLogger } from './observability/logger';

async function bootstrap(): Promise<void> {
  const config = AppConfig.fromEnv();
  const app = await NestFactory.create(AppModule.register(config), { logger: new NestJsonLogger() });
  // Repassa SIGTERM/SIGINT para os hooks de shutdown (workers e conexões).
  app.enableShutdownHooks();
  await app.listen(config.port);
}

await bootstrap();
