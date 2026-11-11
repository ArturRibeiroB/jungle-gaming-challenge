import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config/app-config';
import { migrationsList } from './migrations';
import { entitySchemas } from './records';

export function createOrmConfig(config: AppConfig): Options {
  return defineConfig({
    clientUrl: config.databaseUrl,
    pool: { min: 1, max: config.databasePoolMax },
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
