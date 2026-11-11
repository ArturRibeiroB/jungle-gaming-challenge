import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261111000000InitialSchema } from './Migration20261111000000InitialSchema';

/** Ordem de aplicação das migrations. Novas migrations entram no final. */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261111000000InitialSchema', class: Migration20261111000000InitialSchema },
];
