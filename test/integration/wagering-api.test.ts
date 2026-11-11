import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startApp, type RunningApp } from '../support/app';
import { TestDatabase } from '../support/database';
import { createWallet, expectWalletConsistent, request, submitWager, wagerBody } from '../support/http';

let db: TestDatabase;
let sql: SQL;
let api: RunningApp;
let url: string;

beforeAll(async () => {
  db = await TestDatabase.create();
  sql = db.sql;
  // Lock timeout curto para o teste de wallet travada não demorar.
  api = await startApp(db, { DATABASE_LOCK_TIMEOUT_MS: '500' });
  url = api.baseUrl;
});

// Invariante final: saldo == ledger para todas as wallets do banco, depois de cada teste.
afterEach(() => db.expectLedgerInvariant());

afterAll(async () => {
  await api?.close();
  await db?.drop();
});

const outboxTypes = async (walletId: string) =>
  (await sql`select event_type from outbox_messages where aggregate_id = ${walletId} order by occurred_at, event_type`).map(
    (row: { event_type: string }) => row.event_type,
  );

describe('POST /wallets', () => {
  test('creates the wallet with an OPENING credit, ledger entry and event in one transaction', async () => {
    const playerId = crypto.randomUUID();
    const created = await request(url, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const [opening] = await sql`select kind, status, amount::text from wager_transactions where wallet_id = ${created.body.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    expect(await outboxTypes(created.body.id)).toEqual(['WalletBalanceChanged']);
    expect(await expectWalletConsistent(sql, created.body.id)).toEqual({ balance: '1000.00', entries: 1 });
  });

  test('zero initial balance creates no ledger entry', async () => {
    const wallet = await createWallet(url, '0.00');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '0.00', entries: 0 });
  });

  test('duplicate wallet for the same player and currency is a conflict', async () => {
    const wallet = await createWallet(url);
    const duplicate = await request(url, 'POST', '/wallets', {
      body: { playerId: wallet.playerId, initialBalance: { amount: '5.00', currency: 'BRL' } },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');

    const otherCurrency = await request(url, 'POST', '/wallets', {
      body: { playerId: wallet.playerId, initialBalance: { amount: '5.00', currency: 'USD' } },
    });
    expect(otherCurrency.status).toBe(201);
  });

  test('concurrent creations for the same player: exactly one wins', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(url, 'POST', '/wallets', { body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  test.each([
    ['invalid amount scale', { amount: '10.5', currency: 'BRL' }, 'INVALID_MONEY'],
    ['negative amount', { amount: '-10.00', currency: 'BRL' }, 'INVALID_MONEY'],
    ['amount as number', { amount: 10, currency: 'BRL' }, 'INVALID_REQUEST'],
  ])('rejects %s with 400', async (_label, initialBalance, code) => {
    const result = await request(url, 'POST', '/wallets', { body: { playerId: crypto.randomUUID(), initialBalance } });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(code);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET is processed, ledger and events written together', async () => {
    const wallet = await createWallet(url, '1000.00');
    const result = await submitWager(url, wallet, { kind: 'BET', amount: '25.00' });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await outboxTypes(wallet.id)).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '975.00', entries: 2 });
  });

  test('identical request is replayed with the original result and balance', async () => {
    const wallet = await createWallet(url, '100.00');
    const input = { kind: 'BET', amount: '10.00', externalTransactionId: 'replay-1' };
    const first = await submitWager(url, wallet, input);
    await submitWager(url, wallet, { kind: 'BET', amount: '50.00' });
    const second = await submitWager(url, wallet, input);

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
    // saldo observado na época (90), não o atual (40)
    expect(second.body.balance.amount).toBe('90.00');
  });

  test('same key with different payload is a conflict, not a replay', async () => {
    const wallet = await createWallet(url, '100.00');
    await submitWager(url, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'conflict-1' });
    const conflict = await submitWager(url, wallet, { kind: 'BET', amount: '11.00', externalTransactionId: 'conflict-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('same external id under another idempotency key is a conflict', async () => {
    const wallet = await createWallet(url, '100.00');
    await submitWager(url, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'ext-1' });
    const duplicate = await submitWager(url, wallet, {
      kind: 'BET',
      amount: '10.00',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'another-key',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_EXTERNAL_TRANSACTION');
  });

  test('business rejection is 422 with a failureCode and keeps no ledger entry', async () => {
    const wallet = await createWallet(url, '10.00');
    const result = await submitWager(url, wallet, { kind: 'BET', amount: '10.01' });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await outboxTypes(wallet.id)).toEqual(['WalletBalanceChanged', 'WagerTransactionRejected']);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '10.00', entries: 1 });
  });

  test('currency different from the wallet is rejected', async () => {
    const wallet = await createWallet(url, '10.00');
    const result = await submitWager(url, wallet, { kind: 'BET', amount: '1.00', currency: 'USD' });
    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('LOSS is processed without ledger and without WalletBalanceChanged', async () => {
    const wallet = await createWallet(url, '10.00');
    const result = await submitWager(url, wallet, { kind: 'LOSS', amount: '0.00' });
    expect(result.status).toBe(200);
    expect(await outboxTypes(wallet.id)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '10.00', entries: 1 });
  });

  test('REFUND before its BET is accepted as PENDING_REFERENCE (202)', async () => {
    const wallet = await createWallet(url, '100.00');
    const refund = await submitWager(url, wallet, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: 'bet-not-yet',
    });
    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
    expect(await outboxTypes(wallet.id)).toEqual(['WalletBalanceChanged', 'WagerTransactionPendingReference']);

    const replay = await submitWager(url, wallet, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: 'bet-not-yet',
      externalTransactionId: (await sql`select external_transaction_id from wager_transactions where id = ${refund.body.transactionId}`)[0]
        .external_transaction_id,
    });
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('ROLLBACK of a WIN that would overdraw is rejected with its own failure code', async () => {
    const wallet = await createWallet(url, '0.00');
    await submitWager(url, wallet, { kind: 'WIN', amount: '50.00', externalTransactionId: 'win-1' });
    await submitWager(url, wallet, { kind: 'BET', amount: '45.00' });
    const rollback = await submitWager(url, wallet, { kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: 'win-1' });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '5.00', entries: 2 });
  });

  test('REFUND reverses a BET only once', async () => {
    const wallet = await createWallet(url, '100.00');
    await submitWager(url, wallet, { kind: 'BET', amount: '30.00', externalTransactionId: 'bet-r' });
    const refund = await submitWager(url, wallet, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-r' });
    const rollback = await submitWager(url, wallet, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: 'bet-r' });
    expect(refund.status).toBe(200);
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '100.00', entries: 3 });
  });

  test.each([
    ['missing Idempotency-Key', {}, (w: any) => wagerBody(w, { kind: 'BET', amount: '1.00' }), 'INVALID_REQUEST'],
    ['OPENING kind', undefined, (w: any) => wagerBody(w, { kind: 'OPENING', amount: '1.00' }), 'INTERNAL_KIND_NOT_ALLOWED'],
    ['REFUND without reference', undefined, (w: any) => wagerBody(w, { kind: 'REFUND', amount: '1.00' }), 'REFERENCE_REQUIRED'],
    ['bad amount', undefined, (w: any) => wagerBody(w, { kind: 'BET', amount: '1e2' }), 'INVALID_MONEY'],
    ['bad walletId', undefined, (w: any) => ({ ...wagerBody(w, { kind: 'BET', amount: '1.00' }), walletId: 'x' }), 'INVALID_REQUEST'],
  ])('invalid payload (%s) is 400 and changes nothing', async (_label, headers, buildBody, code) => {
    const wallet = await createWallet(url, '10.00');
    const result = await request(url, 'POST', '/wagering/transactions', {
      body: buildBody(wallet),
      headers: headers ?? { 'Idempotency-Key': `k-${crypto.randomUUID()}` },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(code);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '10.00', entries: 1 });
  });

  test('unknown wallet is 404', async () => {
    const wallet = { id: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const result = await submitWager(url, wallet, { kind: 'BET', amount: '1.00' });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('lock contention', () => {
  test('a wallet locked for longer than the lock timeout answers 503 LOCK_TIMEOUT, and the retry succeeds', async () => {
    const wallet = await createWallet(url, '100.00');
    let blocked: Awaited<ReturnType<typeof submitWager>> | undefined;

    // Outra sessão segura o lock da wallet por mais tempo que o lock_timeout (500 ms).
    await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      blocked = await submitWager(url, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'locked-1' });
    });

    expect(blocked!.status).toBe(503);
    expect(blocked!.body.error.code).toBe('LOCK_TIMEOUT');
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('wagering_lock_conflicts_total 1');

    // Nada foi gravado; reenviar a mesma requisição é seguro e agora passa.
    const retried = await submitWager(url, wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'locked-1' });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotentReplay).toBe(false);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 2 });
  });
});

describe('atomicity', () => {
  test('if the outbox insert fails, nothing of the transaction is committed', async () => {
    const wallet = await createWallet(url, '100.00');
    await sql.unsafe(`
      create function fail_outbox_insert() returns trigger language plpgsql as $$
      begin raise exception 'simulated outbox failure'; end; $$;
      create trigger trg_fail_outbox before insert on outbox_messages
        for each row execute function fail_outbox_insert();
    `);
    try {
      const result = await submitWager(url, wallet, { kind: 'BET', amount: '40.00', externalTransactionId: 'atomic-1' });
      expect(result.status).toBe(500);
    } finally {
      await sql.unsafe('drop trigger trg_fail_outbox on outbox_messages; drop function fail_outbox_insert();');
    }

    const [count] = await sql`select count(*)::int as n from wager_transactions where external_transaction_id = 'atomic-1'`;
    expect(count.n).toBe(0);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '100.00', entries: 1 });

    // A mesma requisição reenviada depois funciona normalmente.
    const retried = await submitWager(url, wallet, { kind: 'BET', amount: '40.00', externalTransactionId: 'atomic-1' });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotentReplay).toBe(false);
  });
});

describe('queries', () => {
  test('ledger pages with a stable opaque cursor', async () => {
    const wallet = await createWallet(url, '100.00');
    for (let i = 0; i < 5; i++) {
      await submitWager(url, wallet, { kind: 'BET', amount: '1.00' });
    }
    const first = await request(url, 'GET', `/wallets/${wallet.id}/ledger?limit=4`);
    // nova entrada entre as páginas não desloca a próxima página
    await submitWager(url, wallet, { kind: 'WIN', amount: '3.00' });
    const second = await request(url, 'GET', `/wallets/${wallet.id}/ledger?limit=4&cursor=${first.body.nextCursor}`);

    expect(first.body.entries.map((e: any) => e.walletVersion)).toEqual([6, 5, 4, 3]);
    expect(second.body.entries.map((e: any) => e.walletVersion)).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();

    const bad = await request(url, 'GET', `/wallets/${wallet.id}/ledger?cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
  });

  test('transaction lookup by id and by provider external id', async () => {
    const wallet = await createWallet(url, '100.00');
    const submitted = await submitWager(url, wallet, { kind: 'BET', amount: '7.00', externalTransactionId: 'lookup-1' });
    const byId = await request(url, 'GET', `/wagering/transactions/${submitted.body.transactionId}`);
    const byExternal = await request(url, 'GET', '/providers/provider-a/wagering/transactions/lookup-1');
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '7.00' }, observedBalance: { amount: '93.00' } });
    expect((await request(url, 'GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('reconciliation reports a consistent wallet', async () => {
    const wallet = await createWallet(url, '100.00');
    await submitWager(url, wallet, { kind: 'BET', amount: '25.00' });
    const result = await request(url, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('reconciliation flags a divergence instead of fixing it', async () => {
    const wallet = await createWallet(url, '100.00');
    // Corrompe a wallet contornando os triggers (só um superusuário consegue; a aplicação não).
    db.markCorrupted(wallet.id);
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = 150 where id = ${wallet.id}`;
    });
    const result = await request(url, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(result.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '150.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '50.00' },
    });
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('wagering_reconciliation_mismatches_total 1');
    const [row] = await sql`select balance::text from wallets where id = ${wallet.id}`;
    expect(row.balance).toBe('150.00');
  });
});
