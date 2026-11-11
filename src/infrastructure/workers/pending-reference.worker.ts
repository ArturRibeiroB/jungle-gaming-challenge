import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { WageringStore } from '../../application/ports';
import { WagerTransactionService } from '../../application/wager-transaction.service';
import { AppConfig } from '../../config/app-config';
import { Logger } from '../../observability/logger';
import { PollingLoop } from './polling-loop';

const BATCH_SIZE = 50;

/**
 * Worker agendado que reavalia transações PENDING_REFERENCE vencidas (seção 7.1).
 * O backoff e o limite de tentativas vêm da ReferenceRetryPolicy do domínio; esgotado
 * o limite, a transação é rejeitada com REFERENCE_NOT_FOUND e o evento é publicado.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private loop: PollingLoop | undefined;

  constructor(
    private readonly store: WageringStore,
    private readonly transactions: WagerTransactionService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.enabled) {
      this.loop = new PollingLoop('PendingReferenceWorkerLoop', (signal) => this.runOnce(signal), this.config.workers.idleDelayMs);
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }

  /** Processa um lote. Devolve `true` se havia transações vencidas. */
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const due = await this.store.read((uow) => uow.transactions.findDuePendingReferences(new Date(), BATCH_SIZE));
    for (const { id, walletId } of due) {
      if (signal?.aborted) {
        break;
      }
      try {
        await this.transactions.retryPendingReference(id, walletId);
      } catch (error) {
        // Uma transação problemática não pode travar as demais; ela volta no próximo ciclo.
        this.logger.warn('Failed to retry pending reference', { transactionId: id, walletId }, error);
      }
    }
    return due.length > 0;
  }
}
