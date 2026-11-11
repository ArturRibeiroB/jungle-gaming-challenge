import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from '../../config/app-config';
import { createOrmConfig } from './mikro-orm.config';

/**
 * Uso: bun src/infrastructure/database/migrate.ts up|down
 * `down` desfaz apenas a última migration aplicada.
 */
async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Unknown direction "${direction}", expected "up" or "down"`);
  }

  const orm = await MikroORM.init(createOrmConfig(AppConfig.fromEnv()));
  try {
    const migrator = orm.getMigrator();
    const applied = direction === 'up' ? await migrator.up() : await migrator.down();
    const names = applied.map((migration) => migration.name);
    console.log(`Migrations ${direction}: ${names.length > 0 ? names.join(', ') : 'nothing to do'}`);
  } finally {
    await orm.close(true);
  }
}

await main();
