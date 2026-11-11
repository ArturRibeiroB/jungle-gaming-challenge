import { Logger } from '../../observability/logger';

/**
 * Executa `iteration` em loop até `stop()`. Quando a iteração não encontra trabalho,
 * espera `idleDelayMs` antes da próxima; quando falha, espera o dobro (até 30s) para não
 * martelar uma dependência fora do ar.
 *
 * `stop()` aborta a espera e o long polling em andamento (via AbortSignal) e aguarda a
 * iteração atual terminar: trabalho já começado é concluído, nunca cortado no meio.
 */
export class PollingLoop {
  private readonly abort = new AbortController();
  private readonly logger: Logger;
  private running: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly iteration: (signal: AbortSignal) => Promise<boolean>,
    private readonly idleDelayMs: number,
  ) {
    this.logger = new Logger(name);
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    const started = performance.now();
    this.abort.abort();
    await this.running;
    this.logger.info('Stopped', { waitedMs: Math.round(performance.now() - started) });
  }

  private async run(): Promise<void> {
    let failureDelay = this.idleDelayMs;
    while (!this.abort.signal.aborted) {
      try {
        const didWork = await this.iteration(this.abort.signal);
        failureDelay = this.idleDelayMs;
        if (!didWork) {
          await sleep(this.idleDelayMs, this.abort.signal);
        }
      } catch (error) {
        if (this.abort.signal.aborted) {
          break;
        }
        this.logger.warn('Iteration failed, backing off', { delayMs: failureDelay }, error);
        await sleep(failureDelay, this.abort.signal);
        failureDelay = Math.min(failureDelay * 2, 30_000);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
