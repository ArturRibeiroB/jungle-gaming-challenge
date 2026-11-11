/**
 * UUIDv7: ordenado pelo tempo, então os índices B-tree crescem no final
 * e a paginação do ledger por id segue a ordem de criação.
 */
export function newId(): string {
  return Bun.randomUUIDv7();
}
