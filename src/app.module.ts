import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WageringStore } from './application/ports';
import { WagerTransactionService } from './application/wager-transaction.service';
import { WalletService } from './application/wallet.service';
import { AppConfig } from './config/app-config';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WagerSettlement } from './domain/wager-settlement';
import { MikroOrmWageringStore } from './infrastructure/database/mikro-orm-wagering-store';
import { createOrmConfig } from './infrastructure/database/mikro-orm.config';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { WagerTransactionConsumer } from './interfaces/messaging/wager-transaction.consumer';
import { ConfigModule } from './config/config.module';
import { HttpExceptionFilter } from './interfaces/http/exception.filter';
import { HealthController } from './interfaces/http/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { Metrics } from './observability/metrics';

@Module({})
export class AppModule {
  /** A configuração entra por parâmetro para os testes subirem a app contra um banco descartável. */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        MikroOrmModule.forRootAsync({
          driver: PostgreSqlDriver,
          inject: [AppConfig],
          useFactory: (appConfig: AppConfig) => ({ ...createOrmConfig(appConfig), registerRequestContext: false }),
        }),
        SqsModule,
      ],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        Metrics,
        ProviderAuthGuard,
        { provide: WageringStore, useClass: MikroOrmWageringStore },
        {
          provide: WagerSettlement,
          inject: [AppConfig],
          useFactory: (appConfig: AppConfig) =>
            new WagerSettlement(
              new ReferenceRetryPolicy(appConfig.workers.referenceRetryMaxAttempts, appConfig.workers.referenceRetryBaseDelayMs),
            ),
        },
        WalletService,
        WagerTransactionService,
        WagerTransactionConsumer,
        OutboxPublisher,
        PendingReferenceWorker,
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    };
  }
}
