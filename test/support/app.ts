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

/** Sobe a aplicação Nest neste processo, apontando para o banco descartável. */
export async function startApp(db: TestDatabase): Promise<RunningApp & { app: INestApplication }> {
  // A porta configurada é ignorada: listen(0) escolhe uma porta livre.
  const config = AppConfig.fromEnv({ ...process.env, DATABASE_URL: db.url });
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

/**
 * Sobe uma instância da aplicação em outro processo (`bun src/main.ts`), como em produção.
 * Usado para provar a correção com várias instâncias disputando o mesmo banco.
 */
export async function spawnInstance(db: TestDatabase, port: number): Promise<RunningApp> {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: db.url, PORT: String(port), LOG_LEVEL: 'error' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
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
