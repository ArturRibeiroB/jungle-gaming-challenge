import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { startApp, type RunningApp } from '../support/app';
import { TestDatabase } from '../support/database';
import { createWallet, expectWalletConsistent, request, wagerBody, type TestWallet } from '../support/http';
import { TEST_MAX_RECEIVE_COUNT, TestQueues, waitFor, wagerMessage } from '../support/queues';

/**
 * Consumidor SQS, publicador da outbox e worker de referências pendentes rodando de verdade,
 * contra LocalStack e PostgreSQL reais, com filas exclusivas deste arquivo.
 */

let db: TestDatabase;
let sql: SQL;
let queues: TestQueues;
let api: RunningApp;
let url: string;

beforeAll(async () => {
  db = await TestDatabase.create();
  sql = db.sql;
  queues = await TestQueues.create();
  api = await startApp(db, { ...queues.env(), WORKERS_ENABLED: 'true' });
  url = api.baseUrl;
}, 30_000);

afterAll(async () => {
  await api?.close();
  await queues?.destroy();
  await db?.drop();
});

const transactionByExternalId = (externalId: string) =>
  sql`select id, status, failure_code from wager_transactions where external_transaction_id = ${externalId}`.then(
    (rows) => rows[0] as { id: string; status: string; failure_code: string | null } | undefined,
  );

const debits = (walletId: string) =>
  sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`.then(
    ([row]) => row.n as number,
  );

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  return text
    .split('\n')
    .filter((line) => line.startsWith(name))
    .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

function sendWager(wallet: TestWallet, input: Parameters<typeof wagerBody>[1], messageId?: string) {
  const message = wagerMessage(wagerBody(wallet, input), messageId);
  return queues.send(message, { groupId: wallet.id }).then(() => message);
}

describe('SQS consumer', () => {
  test('processes a message, acks it, records the inbox and publishes the events', async () => {
    const wallet = await createWallet(url, '100.00');
    const message = await sendWager(wallet, { kind: 'BET', amount: '25.00', externalTransactionId: 'sqs-bet-1' });

    const tx = await waitFor('transaction', () => transactionByExternalId('sqs-bet-1'));
    expect(tx.status).toBe('PROCESSED');
    const [inbox] = await sql`select consumer_name, processed_at from inbox_messages where message_id = ${message.messageId}`;
    expect(inbox.consumer_name).toBe('wager-transactions-consumer');
    expect(inbox.processed_at).not.toBeNull();
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '75.00', entries: 2 });

    await waitFor('message acked', async () => (await queues.approximateCount('main')) === 0);
    await waitFor('outbox drained', async () => {
      const [row] = await sql`select count(*)::int as n from outbox_messages where aggregate_id = ${wallet.id} and published_at is null`;
      return row.n === 0;
    });
  });

  test('redelivery of the same message (same messageId) does not duplicate the debit', async () => {
    const wallet = await createWallet(url, '100.00');
    const duplicatesBefore = await metric('wagering_duplicates_total');
    const message = wagerMessage(wagerBody(wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'sqs-dup-1' }));

    // Deduplication ids diferentes: o SQS entrega as três; só a inbox protege.
    for (let i = 0; i < 3; i++) {
      await queues.send(message, { groupId: wallet.id });
    }

    await waitFor('three deliveries handled', async () => (await metric('wagering_duplicates_total')) - duplicatesBefore >= 2);
    expect(await debits(wallet.id)).toBe(1);
    const [inbox] = await sql`select count(*)::int as n from inbox_messages where message_id = ${message.messageId}`;
    expect(inbox.n).toBe(1);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('HTTP and SQS share the same use case and idempotency', async () => {
    const wallet = await createWallet(url, '100.00');
    const body = wagerBody(wallet, { kind: 'BET', amount: '30.00', externalTransactionId: 'both-channels' });
    const http = await request(url, 'POST', '/wagering/transactions', {
      body,
      headers: { 'Idempotency-Key': 'provider-a:both-channels' },
    });
    expect(http.status).toBe(200);

    await queues.send(wagerMessage(body), { groupId: wallet.id });
    await waitFor('queue drained', async () => (await queues.approximateCount('main')) === 0);
    expect(await debits(wallet.id)).toBe(1);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '70.00', entries: 2 });
  });

  test('business rejection is acked (not retried, not dead-lettered)', async () => {
    const wallet = await createWallet(url, '5.00');
    await sendWager(wallet, { kind: 'BET', amount: '50.00', externalTransactionId: 'sqs-rejected' });
    const tx = await waitFor('rejection', () => transactionByExternalId('sqs-rejected'));
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    await waitFor('message acked', async () => (await queues.approximateCount('main')) === 0);
  });

  test('invalid messages go straight to the DLQ with a reason', async () => {
    const wallet = await createWallet(url, '100.00');
    await queues.send('{not json', { groupId: wallet.id });
    await queues.send(wagerMessage(wagerBody(wallet, { kind: 'BET', amount: '1.5' })), { groupId: wallet.id });
    await queues.send(wagerMessage(wagerBody(wallet, { kind: 'OPENING', amount: '1.00' })), { groupId: wallet.id });

    const dead = await waitFor('3 dead letters', async () => {
      const count = await queues.approximateCount('dlq');
      return count >= 3 ? queues.drain('dlq') : undefined;
    });
    const reasons = dead.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(['INTERNAL_KIND_NOT_ALLOWED', 'INVALID_MONEY', 'INVALID_REQUEST']);
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '100.00', entries: 1 });
  });

  test('idempotency conflict through the queue is dead-lettered', async () => {
    const wallet = await createWallet(url, '100.00');
    await sendWager(wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'sqs-conflict' });
    await waitFor('first processed', () => transactionByExternalId('sqs-conflict'));
    await sendWager(wallet, { kind: 'BET', amount: '99.00', externalTransactionId: 'sqs-conflict' });

    const [dead] = await waitFor('dead letter', async () => {
      const messages = await queues.drain('dlq');
      return messages.length > 0 ? messages : undefined;
    });
    expect(dead!.MessageAttributes?.failureReason?.StringValue).toBe('IDEMPOTENCY_CONFLICT');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '90.00', entries: 2 });
  });

  test('transient failure is retried with backoff and succeeds when the database recovers', async () => {
    const wallet = await createWallet(url, '100.00');
    await installTransientFailure('sqs-transient-ok', 1);
    try {
      await sendWager(wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'sqs-transient-ok' });
      const tx = await waitFor('processed after retry', () => transactionByExternalId('sqs-transient-ok'), 30_000);
      expect(tx.status).toBe('PROCESSED');
    } finally {
      await removeTransientFailure();
    }
    expect(await debits(wallet.id)).toBe(1);
  }, 40_000);

  test(`transient failure that never recovers goes to the DLQ after ${TEST_MAX_RECEIVE_COUNT} deliveries`, async () => {
    const wallet = await createWallet(url, '100.00');
    const dlqBefore = await metric('sqs_dlq_messages_total');
    await installTransientFailure('sqs-transient-dead', 1_000);
    try {
      await sendWager(wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'sqs-transient-dead' });
      const [dead] = await waitFor(
        'dead letter',
        async () => {
          const messages = await queues.drain('dlq');
          return messages.length > 0 ? messages : undefined;
        },
        30_000,
      );
      expect(dead!.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED:TRANSIENT_FAILURE');
      expect(await metric('sqs_dlq_messages_total')).toBe(dlqBefore + 1);
    } finally {
      await removeTransientFailure();
    }
    expect(await transactionByExternalId('sqs-transient-dead')).toBeUndefined();
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '100.00', entries: 1 });
  }, 40_000);
});

describe('out-of-order references through the queue', () => {
  test('ROLLBACK delivered before its BET is resolved by the scheduled worker', async () => {
    const wallet = await createWallet(url, '100.00');
    await sendWager(wallet, { kind: 'ROLLBACK', amount: '40.00', externalTransactionId: 'rb-1', referenceExternalTransactionId: 'bet-late' });
    const pending = await waitFor('pending reference', () => transactionByExternalId('rb-1'));
    expect(pending.status).toBe('PENDING_REFERENCE');

    await sendWager(wallet, { kind: 'BET', amount: '40.00', externalTransactionId: 'bet-late' });
    await waitFor('rollback processed', async () => (await transactionByExternalId('rb-1'))?.status === 'PROCESSED');
    expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '100.00', entries: 3 });

    const events = await sql`select event_type from outbox_messages where aggregate_id = ${wallet.id} order by occurred_at, id`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toContain('WagerTransactionPendingReference');
  });

  test('reference that never arrives is rejected with REFERENCE_NOT_FOUND and an event', async () => {
    const wallet = await createWallet(url, '100.00');
    await sendWager(wallet, { kind: 'REFUND', amount: '5.00', externalTransactionId: 'rf-never', referenceExternalTransactionId: 'ghost' });
    const tx = await waitFor('rejected', async () => {
      const row = await transactionByExternalId('rf-never');
      return row?.status === 'REJECTED' ? row : undefined;
    });
    expect(tx.failure_code).toBe('REFERENCE_NOT_FOUND');
    const [event] = await sql`select payload from outbox_messages where aggregate_id = ${wallet.id} and event_type = 'WagerTransactionRejected'`;
    expect(event.payload.data.failureCode).toBe('REFERENCE_NOT_FOUND');
  });
});

describe('outbox publisher', () => {
  test('publishes every event once to the events queue, keyed by eventId', async () => {
    await waitFor('outbox fully published', async () => {
      const [row] = await sql`select count(*)::int as n from outbox_messages where published_at is null`;
      return row.n === 0;
    });
    const published = await queues.drain('events');
    const [row] = await sql`select count(*)::int as n from outbox_messages`;
    const eventIds = published.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(eventIds).size).toBe(row.n);
    expect(published.every((m) => m.MessageAttributes?.eventType?.StringValue === JSON.parse(m.Body!).eventType)).toBe(true);
    expect(await metric('outbox_lag_seconds')).toBe(0);
  });
});

/**
 * Faz o INSERT da transação `externalId` falhar com serialization_failure (40001) `times` vezes.
 * O contador é uma sequence porque nextval() não sofre rollback junto com a transação que falhou.
 */
async function installTransientFailure(externalId: string, times: number): Promise<void> {
  await sql.unsafe(`
    drop sequence if exists test_failure_seq;
    create sequence test_failure_seq;
    create or replace function test_transient_failure() returns trigger language plpgsql as $$
    begin
      if new.external_transaction_id = '${externalId}' and nextval('test_failure_seq') <= ${times} then
        raise exception 'simulated transient failure' using errcode = '40001';
      end if;
      return new;
    end; $$;
    drop trigger if exists trg_test_transient on wager_transactions;
    create trigger trg_test_transient before insert on wager_transactions
      for each row execute function test_transient_failure();
  `);
}

async function removeTransientFailure(): Promise<void> {
  await sql.unsafe(`
    drop trigger if exists trg_test_transient on wager_transactions;
    drop function if exists test_transient_failure();
    drop sequence if exists test_failure_seq;
  `);
}
