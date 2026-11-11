import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config/app-config';
import { migrationsList } from './migrations';
import { entitySchemas } from './records';

interface PgConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
}

export function createOrmConfig(config: AppConfig): Options {
  return defineConfig({
    clientUrl: config.databaseUrl,
    pool: {
      min: 1,
      max: config.databasePoolMax,
      /**
       * Quanto uma transação espera pelo lock de uma wallet ocupada antes de desistir.
       * Uma operação normal segura o lock por poucos ms; esperar mais que isso indica wallet
       * muito disputada ou banco degradado, e é melhor devolver erro transitório (503, retry
       * seguro) do que segurar conexões do pool. Configurado uma vez por conexão, e não com
       * SET LOCAL em cada transação, para economizar uma ida e volta ao banco por operação.
       */
      afterCreate: (connection: PgConnection, done: (error: Error | null, connection: PgConnection) => void) => {
        connection.query(`set lock_timeout = ${config.databaseLockTimeoutMs}`, (error) => done(error, connection));
      },
    },
    entities: entitySchemas,
    extensions: [Migrator],
    migrations: {
      // Lista explícita em vez de glob: funciona igual rodando TS direto no Bun ou empacotado.
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    // Toda operação de escrita roda dentro de em.transactional() explícito.
    allowGlobalContext: false,
  });
}
