import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { SQL } from 'bun';
import { Money } from '../../src/domain/money';
import { spawnInstance, type RunningApp } from '../support/app';
import { TestDatabase } from '../support/database';
import { createWallet, expectWalletConsistent, submitWager, type HttpResult, type TestWallet } from '../support/http';

/**
 * Paralelismo real: três processos `bun src/main.ts` independentes, cada um com seu pool
 * de conexões, disputando as mesmas wallets no mesmo PostgreSQL. As requisições são
 * distribuídas em round-robin entre as instâncias.
 */

const INSTANCES = 3;

let db: TestDatabase;
let sql: SQL;
let instances: RunningApp[] = [];

const instanceUrl = (index: number) => instances[index % instances.length]!.baseUrl;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  db = await TestDatabase.create();
  sql = db.sql;
  const ports = await Promise.all(Array.from({ length: INSTANCES }, freePort));
  instances = await Promise.all(ports.map((port) => spawnInstance(db, port)));
}, 60_000);

// Invariante final: saldo == ledger para todas as wallets do banco, depois de cada teste.
afterEach(() => db.expectLedgerInvariant());

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.close()));
  await db?.drop();
});

async function debitEntries(walletId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row.n;
}

const statuses = (results: HttpResult[]) => results.map((result) => result.status);

describe(`concurrency across ${INSTANCES} instances`, () => {
  test('the same BET sent 50 times in parallel debits exactly once', async () => {
    const wallet = await createWallet(instanceUrl(0), '100.00');
    const input = { kind: 'BET', amount: '10.00', externalTransactionId: 'same-bet' };

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitWager(instanceUrl(i), wallet, input)));

    expect(new Set(statuses(results))).toEqual(new Set([200]));
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('two simultaneous bets of 80.00 on 100.00: one processed, one rejected, balance 20.00', async () => {
    const wallet = await createWallet(instanceUrl(0), '100.00');

    const results = await Promise.all([
      submitWager(instanceUrl(1), wallet, { kind: 'BET', amount: '80.00' }),
      submitWager(instanceUrl(2), wallet, { kind: 'BET', amount: '80.00' }),
    ]);

    expect(statuses(results).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await debitEntries(wallet.id)).toBe(1);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '20.00', entries: 2 });

    // Reenviar as duas (retry do provedor) não duplica nada.
    const [first, second] = results;
    const retries = await Promise.all(
      [first!, second!].map((result) =>
        sql`select external_transaction_id from wager_transactions where id = ${result.body.transactionId}`.then(([row]) =>
          submitWager(instanceUrl(0), wallet, { kind: 'BET', amount: '80.00', externalTransactionId: row.external_transaction_id }),
        ),
      ),
    );
    expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
    expect(await debitEntries(wallet.id)).toBe(1);
  });

  test('hot wallet: 30 bets of 10.00 on 100.00 -> exactly 10 processed, never negative', async () => {
    const wallet = await createWallet(instanceUrl(0), '100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => submitWager(instanceUrl(i), wallet, { kind: 'BET', amount: '10.00' })),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(20);
    expect(await debitEntries(wallet.id)).toBe(10);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '0.00', entries: 11 });
  });

  test('mixed concurrent credits and debits on one wallet keep balance == ledger', async () => {
    const wallet = await createWallet(instanceUrl(0), '50.00');
    const operations = Array.from({ length: 40 }, (_, i) =>
      submitWager(instanceUrl(i), wallet, i % 2 === 0 ? { kind: 'WIN', amount: '2.50' } : { kind: 'BET', amount: '3.00' }),
    );
    const results = await Promise.all(operations);

    // Saldo esperado a partir do que foi aceito, calculado com Money (nunca number).
    let expected = Money.from({ amount: '50.00', currency: 'BRL' });
    results.forEach((result, i) => {
      if (result.status === 200) {
        const amount = Money.from({ amount: i % 2 === 0 ? '2.50' : '3.00', currency: 'BRL' });
        expected = i % 2 === 0 ? expected.add(amount) : expected.subtract(amount);
      }
    });
    expect(results.filter((r, i) => i % 2 === 0 && r.status === 200)).toHaveLength(20);
    const { balance } = await expectWalletConsistent(sql, wallet.id);
    expect(balance).toBe(expected.toString());
  });

  test('different wallets are processed in parallel and independently', async () => {
    const wallets: TestWallet[] = await Promise.all(Array.from({ length: 10 }, (_, i) => createWallet(instanceUrl(i), '100.00')));

    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap((wallet, w) =>
        Array.from({ length: 10 }, (_, i) => submitWager(instanceUrl(w + i), wallet, { kind: 'BET', amount: '1.00' })),
      ),
    );
    const elapsedMs = performance.now() - started;

    expect(new Set(statuses(results))).toEqual(new Set([200]));
    for (const wallet of wallets) {
      expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 11 });
    }
    // Sanidade: 100 operações não podem ter sido serializadas por um lock global.
    expect(elapsedMs).toBeLessThan(15_000);
  });
});
