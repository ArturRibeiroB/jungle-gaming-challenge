import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { newId } from '../../src/domain/id';
import { TestDatabase, expectSqlError } from '../support/database';

/**
 * Prova que as invariantes da seção 6 valem no próprio banco, mesmo para quem
 * escrever SQL direto e ignorar o código da aplicação.
 */

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const RESTRICT = '23001';
const HASH = 'a'.repeat(64);

let db: TestDatabase;
let sql: SQL;

beforeAll(async () => {
  db = await TestDatabase.create();
  sql = db.sql;
});

afterAll(async () => {
  await db?.drop();
});

interface SeededWallet {
  walletId: string;
  playerId: string;
}

async function seedWallet(balance = '100.00'): Promise<SeededWallet> {
  const walletId = newId();
  const playerId = newId();
  await sql.begin(async (tx) => {
    await tx`
      insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (${walletId}, ${playerId}, 'BRL', ${balance}, 1, now(), now())`;
    if (balance !== '0.00') {
      const openingId = newId();
      await insertTransaction(tx, { id: openingId, walletId, playerId, kind: 'OPENING', amount: balance, observedBalance: balance });
      await tx`
        insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
        values (${newId()}, ${walletId}, ${openingId}, 'CREDIT', ${balance}, 'BRL', 0, ${balance}, 1, now())`;
    }
  });
  return { walletId, playerId };
}

interface TransactionRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalId?: string;
  idempotencyKey?: string;
  status?: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceExternalId?: string | null;
  referenceId?: string | null;
}

async function insertTransaction(tx: SQL, row: TransactionRow): Promise<string> {
  const id = row.id ?? newId();
  const opening = row.kind === 'OPENING';
  const externalId = row.externalId ?? (opening ? `opening:${row.walletId}` : `ext-${id}`);
  const status = row.status ?? 'PROCESSED';
  await tx`
    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, observed_balance, created_at, processed_at, updated_at
    ) values (
      ${id}, ${opening ? 'internal' : 'provider-a'}, ${externalId}, ${row.idempotencyKey ?? externalId}, ${HASH},
      ${row.walletId}, ${row.playerId}, ${opening ? null : 'round-1'}, ${opening ? null : 'game-1'},
      ${row.kind}, ${row.amount}, 'BRL', ${row.referenceExternalId ?? null}, ${row.referenceId ?? null},
      ${status}, ${row.failureCode ?? null}, ${row.observedBalance ?? (status === 'PROCESSED' ? '0.00' : null)},
      now(), ${status === 'PROCESSED' ? new Date() : null}, now()
    )`;
  return id;
}

/** Aplica um movimento do jeito certo: transação + ledger + wallet, numa única transação SQL. */
async function applyMovement(
  wallet: SeededWallet,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
  extra: Partial<TransactionRow> = {},
): Promise<string> {
  return sql.begin(async (tx) => {
    const [current] = await tx`select balance, version from wallets where id = ${wallet.walletId} for update`;
    const after = (Number(current.balance) + (direction === 'CREDIT' ? 1 : -1) * Number(amount)).toFixed(2);
    const txId = await insertTransaction(tx, {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: direction === 'DEBIT' ? 'BET' : 'WIN',
      amount,
      observedBalance: after,
      ...extra,
    });
    await tx`
      insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
      values (${newId()}, ${wallet.walletId}, ${txId}, ${direction}, ${amount}, 'BRL', ${current.balance}, ${after},
              ${current.version + 1}, now())`;
    await tx`update wallets set balance = ${after}, version = version + 1, updated_at = now() where id = ${wallet.walletId}`;
    return txId;
  });
}

describe('migrations', () => {
  test('are reversible: down removes everything, up recreates it', async () => {
    const scratch = await TestDatabase.create();
    try {
      const countObjects = async () => {
        const [row] = await scratch.sql`
          select
            (select count(*) from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations')::int as tables,
            (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')::int as functions`;
        return row as { tables: number; functions: number };
      };

      expect(await countObjects()).toEqual({ tables: 5, functions: 7 });
      expect(await scratch.migrate('down')).toEqual(['Migration20261111000000InitialSchema']);
      expect(await countObjects()).toEqual({ tables: 0, functions: 0 });
      expect(await scratch.migrate('up')).toEqual(['Migration20261111000000InitialSchema']);
      expect(await countObjects()).toEqual({ tables: 5, functions: 7 });
    } finally {
      await scratch.drop();
    }
  });
});

describe('wallets', () => {
  test('a consistent wallet with opening entry is accepted', async () => {
    const wallet = await seedWallet('100.00');
    await applyMovement(wallet, 'DEBIT', '80.00');
    const [row] = await sql`select balance, version from wallets where id = ${wallet.walletId}`;
    expect(row).toEqual({ balance: '20.00', version: 2 });
  });

  test('only one wallet per player and currency', async () => {
    const wallet = await seedWallet('0.00');
    await expectSqlError(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${newId()}, ${wallet.playerId}, 'BRL', 0, 1, now(), now())`,
      UNIQUE,
    );
  });

  test('balance can never be negative', async () => {
    const wallet = await seedWallet('10.00');
    await expectSqlError(
      sql`update wallets set balance = -0.01, version = version + 1 where id = ${wallet.walletId}`,
      CHECK,
    );
  });

  test('balance cannot change without a matching ledger entry (checked on commit)', async () => {
    const wallet = await seedWallet('10.00');
    await expectSqlError(
      sql`update wallets set balance = 1000, version = version + 1 where id = ${wallet.walletId}`,
      CHECK,
    );
  });

  test('wallet cannot be created with balance but no ledger', async () => {
    await expectSqlError(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${newId()}, ${newId()}, 'BRL', 50, 1, now(), now())`,
      CHECK,
    );
  });

  test('version must move with the balance, by exactly one', async () => {
    const wallet = await seedWallet('10.00');
    await expectSqlError(sql`update wallets set version = version + 1 where id = ${wallet.walletId}`, CHECK);
  });

  test('identity columns are immutable and wallets cannot be deleted', async () => {
    const wallet = await seedWallet('0.00');
    await expectSqlError(sql`update wallets set currency = 'USD' where id = ${wallet.walletId}`, RESTRICT);
    await expectSqlError(sql`update wallets set player_id = ${newId()} where id = ${wallet.walletId}`, RESTRICT);
    await expectSqlError(sql`delete from wallets where id = ${wallet.walletId}`, RESTRICT);
  });
});

describe('ledger', () => {
  test('is append-only: update, delete and truncate are blocked', async () => {
    const wallet = await seedWallet('10.00');
    await expectSqlError(sql`update wallet_ledger_entries set amount = 1 where wallet_id = ${wallet.walletId}`, RESTRICT);
    await expectSqlError(sql`delete from wallet_ledger_entries where wallet_id = ${wallet.walletId}`, RESTRICT);
    await expectSqlError(sql`truncate wallet_ledger_entries cascade`, RESTRICT);
  });

  test('arithmetic must add up', async () => {
    const wallet = await seedWallet('10.00');
    const txId = await insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'WIN', amount: '5.00' });
    await expectSqlError(
      sql`insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${newId()}, ${wallet.walletId}, ${txId}, 'CREDIT', 5, 'BRL', 10, 16, 2, now())`,
      CHECK,
    );
  });

  test('entries must chain from the previous balance', async () => {
    const wallet = await seedWallet('10.00');
    const txId = await insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'WIN', amount: '5.00' });
    await expectSqlError(
      sql`insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${newId()}, ${wallet.walletId}, ${txId}, 'CREDIT', 5, 'BRL', 95, 100, 2, now())`,
      CHECK,
    );
  });

  test('two writers racing without a lock cannot both write the same wallet version', async () => {
    const wallet = await seedWallet('10.00');
    // Os dois leem o mesmo estado (v1, saldo 10) e tentam gravar a v2 ao mesmo tempo,
    // sem SELECT ... FOR UPDATE: é o lost update clássico. O índice único barra o segundo.
    const racer = (amount: string, after: string) =>
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'WIN', amount, observedBalance: after });
        await tx`insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
            values (${newId()}, ${wallet.walletId}, ${txId}, 'CREDIT', ${amount}, 'BRL', 10, ${after}, 2, now())`;
        await tx`select pg_sleep(0.2)`;
        await tx`update wallets set balance = ${after}, version = 2 where id = ${wallet.walletId}`;
      });

    const results = await Promise.allSettled([racer('5.00', '15.00'), racer('7.00', '17.00')]);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    await expectSqlError(Promise.reject((failures[0] as PromiseRejectedResult).reason), UNIQUE);

    const entries = await sql`select wallet_version from wallet_ledger_entries where wallet_id = ${wallet.walletId}`;
    expect(entries).toHaveLength(2);
  });

  test('at most one entry per transaction and wallet', async () => {
    const wallet = await seedWallet('10.00');
    const txId = await applyMovement(wallet, 'CREDIT', '5.00');
    await expectSqlError(
      sql.begin(async (tx) => {
        await tx`insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
            values (${newId()}, ${wallet.walletId}, ${txId}, 'CREDIT', 5, 'BRL', 15, 20, 3, now())`;
        await tx`update wallets set balance = 20, version = 3 where id = ${wallet.walletId}`;
      }),
      UNIQUE,
    );
  });

  test('balances in the ledger cannot be negative', async () => {
    const wallet = await seedWallet('10.00');
    const txId = await insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'BET', amount: '15.00' });
    await expectSqlError(
      sql`insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${newId()}, ${wallet.walletId}, ${txId}, 'DEBIT', 15, 'BRL', 10, -5, 2, now())`,
      CHECK,
    );
  });

  test('entry currency must be the wallet currency', async () => {
    const wallet = await seedWallet('10.00');
    const txId = await insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'WIN', amount: '5.00' });
    await expectSqlError(
      sql`insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${newId()}, ${wallet.walletId}, ${txId}, 'CREDIT', 5, 'USD', 10, 15, 2, now())`,
      FOREIGN_KEY,
    );
  });

  test('entry must belong to a transaction of the same wallet', async () => {
    const wallet = await seedWallet('10.00');
    const other = await seedWallet('10.00');
    const otherTx = await insertTransaction(sql, { walletId: other.walletId, playerId: other.playerId, kind: 'WIN', amount: '5.00' });
    await expectSqlError(
      sql`insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
          values (${newId()}, ${wallet.walletId}, ${otherTx}, 'CREDIT', 5, 'BRL', 10, 15, 2, now())`,
      FOREIGN_KEY,
    );
  });
});

describe('wager transactions', () => {
  test('idempotency key and external id are unique per provider', async () => {
    const wallet = await seedWallet('10.00');
    await insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'LOSS', amount: '0.00', externalId: 'tx-1', idempotencyKey: 'k-1' });
    await expectSqlError(
      insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'LOSS', amount: '0.00', externalId: 'tx-2', idempotencyKey: 'k-1' }),
      UNIQUE,
    );
    await expectSqlError(
      insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'LOSS', amount: '0.00', externalId: 'tx-1', idempotencyKey: 'k-2' }),
      UNIQUE,
    );
  });

  test('REFUND and ROLLBACK require a reference', async () => {
    const wallet = await seedWallet('10.00');
    await expectSqlError(
      insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'REFUND', amount: '1.00', status: 'PENDING', observedBalance: null }),
      CHECK,
    );
  });

  test('a reference can only be reversed once, but rejected reversals do not count', async () => {
    const wallet = await seedWallet('100.00');
    const betId = await applyMovement(wallet, 'DEBIT', '10.00', { externalId: 'bet-once' });

    await insertTransaction(sql, {
      walletId: wallet.walletId, playerId: wallet.playerId, kind: 'REFUND', amount: '10.00',
      referenceExternalId: 'bet-once', referenceId: betId, status: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH', observedBalance: '90.00',
    });
    await applyMovement(wallet, 'CREDIT', '10.00', { kind: 'REFUND', referenceExternalId: 'bet-once', referenceId: betId });
    await expectSqlError(
      applyMovement(wallet, 'CREDIT', '10.00', { kind: 'ROLLBACK', referenceExternalId: 'bet-once', referenceId: betId }),
      UNIQUE,
    );
    const [row] = await sql`select balance from wallets where id = ${wallet.walletId}`;
    expect(row.balance).toBe('100.00');
  });

  test('reference must be on the same wallet', async () => {
    const wallet = await seedWallet('100.00');
    const other = await seedWallet('100.00');
    const otherBet = await applyMovement(other, 'DEBIT', '10.00');
    await expectSqlError(
      insertTransaction(sql, {
        walletId: wallet.walletId, playerId: wallet.playerId, kind: 'REFUND', amount: '10.00',
        referenceExternalId: 'x', referenceId: otherBet, status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH', observedBalance: '100.00',
      }),
      FOREIGN_KEY,
    );
  });

  test('terminal status is frozen and business fields are immutable', async () => {
    const wallet = await seedWallet('100.00');
    const betId = await applyMovement(wallet, 'DEBIT', '10.00');
    await expectSqlError(sql`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ${betId}`, RESTRICT);
    await expectSqlError(sql`update wager_transactions set amount = 1 where id = ${betId}`, RESTRICT);
    await expectSqlError(sql`delete from wager_transactions where id = ${betId}`, RESTRICT);
  });

  test('pending reference can move to processed', async () => {
    const wallet = await seedWallet('100.00');
    const id = await insertTransaction(sql, {
      walletId: wallet.walletId, playerId: wallet.playerId, kind: 'LOSS', amount: '0.00',
      referenceExternalId: 'bet-later', status: 'PENDING', observedBalance: null,
    });
    await sql`update wager_transactions set status = 'PENDING_REFERENCE', next_reference_attempt_at = now() where id = ${id}`;
    await sql`update wager_transactions
              set status = 'PROCESSED', next_reference_attempt_at = null, processed_at = now(), observed_balance = 100
              where id = ${id}`;
    const [row] = await sql`select status from wager_transactions where id = ${id}`;
    expect(row.status).toBe('PROCESSED');
  });

  test('status-dependent columns must be consistent', async () => {
    const wallet = await seedWallet('10.00');
    // REJECTED sem failure_code
    await expectSqlError(
      insertTransaction(sql, { walletId: wallet.walletId, playerId: wallet.playerId, kind: 'BET', amount: '1.00', status: 'REJECTED', observedBalance: '10.00' }),
      CHECK,
    );
    // PENDING_REFERENCE sem agendamento
    await expectSqlError(
      insertTransaction(sql, {
        walletId: wallet.walletId, playerId: wallet.playerId, kind: 'REFUND', amount: '1.00',
        referenceExternalId: 'x', status: 'PENDING_REFERENCE', observedBalance: null,
      }),
      CHECK,
    );
  });
});
