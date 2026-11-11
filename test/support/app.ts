import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import type { TestDatabase } from './database';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface RunningApp {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Ambiente de uma instância de teste. Workers ficam desligados por padrão para os testes
 * que não envolvem fila; os de mensageria ligam e passam filas próprias (TestQueues.env()).
 */
export function testEnv(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    DATABASE_URL: db.url,
    WORKERS_ENABLED: 'false',
    WORKER_IDLE_DELAY_MS: '100',
    REFERENCE_RETRY_BASE_DELAY_MS: '100',
    REFERENCE_RETRY_MAX_ATTEMPTS: '3',
    ...overrides,
  };
}

/** Sobe a aplicação Nest neste processo, apontando para o banco descartável. */
export async function startApp(
  db: TestDatabase,
  overrides: Record<string, string> = {},
): Promise<RunningApp & { app: INestApplication }> {
  // A porta configurada é ignorada: listen(0) escolhe uma porta livre.
  const config = AppConfig.fromEnv(testEnv(db, overrides));
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

/** Executa um script em outro processo com o ambiente de teste. */
export function spawnScript(script: string, db: TestDatabase, overrides: Record<string, string> = {}) {
  return Bun.spawn(['bun', script], {
    cwd: ROOT,
    env: testEnv(db, { LOG_LEVEL: 'error', ...overrides }),
    stdout: 'pipe',
    stderr: 'inherit',
  });
}

/**
 * Sobe uma instância da aplicação em outro processo (`bun src/main.ts`), como em produção.
 * Usado para provar a correção com várias instâncias disputando o mesmo banco.
 */
export async function spawnInstance(
  db: TestDatabase,
  port: number,
  overrides: Record<string, string> = {},
): Promise<RunningApp & { kill(): Promise<void> }> {
  const child = spawnScript('src/main.ts', db, { PORT: String(port), ...overrides });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Instance on port ${port} exited with code ${child.exitCode}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) {
        return {
          baseUrl,
          close: async () => {
            child.kill('SIGTERM');
            await child.exited;
          },
          // Morte abrupta: nenhum hook de shutdown roda.
          kill: async () => {
            child.kill('SIGKILL');
            await child.exited;
          },
        };
      }
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error(`Instance on port ${port} did not become live in time`);
}
