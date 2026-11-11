import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { SqsQueues } from '../../infrastructure/messaging/sqs.module';

const DEPENDENCY_TIMEOUT_MS = 2_000;

type CheckResult = { status: 'up' } | { status: 'down'; reason: string };

/** Endpoints abertos (sem autenticação), usados pelo orquestrador. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly queues: SqsQueues,
  ) {}

  /** Processo vivo. Não consulta dependências para não reiniciar a app quando o banco cai. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Pronto para receber tráfego: PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const ready = postgres.status === 'up' && sqs.status === 'up';
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  private async checkPostgres(): Promise<CheckResult> {
    const result = await withTimeout(this.orm.checkConnection(), DEPENDENCY_TIMEOUT_MS);
    return result.ok ? { status: 'up' } : { status: 'down', reason: result.reason ?? 'unknown' };
  }

  private async checkSqs(): Promise<CheckResult> {
    try {
      const signal = AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS);
      await this.queues.ping(signal);
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function withTimeout(
  check: Promise<{ ok: boolean; reason?: string }>,
  ms: number,
): Promise<{ ok: boolean; reason?: string }> {
  let timer: Timer | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `timeout after ${ms}ms` }), ms);
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
