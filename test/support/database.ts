import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../src/config/app-config';
import { createOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';

/**
 * Banco PostgreSQL real e descartável por arquivo de teste: cria `wagering_test_<id>`,
 * aplica as migrations e apaga no final. Os testes não compartilham estado.
 */
export class TestDatabase {
  private constructor(
    readonly name: string,
    readonly url: string,
    readonly sql: SQL,
    private readonly admin: SQL,
  ) {}

  static async create(): Promise<TestDatabase> {
    const baseUrl = AppConfig.fromEnv().databaseUrl;
    const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new SQL(baseUrl);
    await admin.unsafe(`create database ${name}`);

    const url = withDatabase(baseUrl, name);
    const database = new TestDatabase(name, url, new SQL(url), admin);
    await database.migrate('up');
    return database;
  }

  async migrate(direction: 'up' | 'down'): Promise<string[]> {
    const config = AppConfig.fromEnv({ ...process.env, DATABASE_URL: this.url });
    const orm = await MikroORM.init(createOrmConfig(config));
    try {
      const migrator = orm.getMigrator();
      const applied = direction === 'up' ? await migrator.up() : await migrator.down();
      return applied.map((migration) => migration.name);
    } finally {
      await orm.close(true);
    }
  }

  async drop(): Promise<void> {
    await this.sql.close();
    await this.admin.unsafe(`drop database if exists ${this.name} with (force)`);
    await this.admin.close();
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** SQLSTATE de um erro do Postgres lançado pelo cliente SQL do Bun. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  if (typeof errno === 'string') {
    return errno;
  }
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export async function expectSqlError(operation: Promise<unknown>, expectedState: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const state = sqlState(error);
    if (state !== expectedState) {
      throw new Error(`Expected SQLSTATE ${expectedState}, got ${state}: ${(error as Error).message}`);
    }
    return;
  }
  throw new Error(`Expected SQLSTATE ${expectedState}, but the statement succeeded`);
}
