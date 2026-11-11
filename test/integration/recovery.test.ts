import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { SQL } from 'bun';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { spawnInstance, spawnScript, startApp, testEnv } from '../support/app';
import { TestDatabase } from '../support/database';
import { createWallet, expectWalletConsistent, submitWager, wagerBody } from '../support/http';
import { TestQueues, waitFor, wagerMessage } from '../support/queues';

/**
 * Falhas de processo de verdade: scripts em outros processos que morrem no pior momento
 * (process.exit / SIGKILL), sem hooks de shutdown. Depois, outra instância assume.
 */

let db: TestDatabase;
let sql: SQL;
let queues: TestQueues;

beforeAll(async () => {
  db = await TestDatabase.create();
  sql = db.sql;
  queues = await TestQueues.create();
}, 30_000);

afterAll(async () => {
  await queues?.destroy();
  await db?.drop();
});

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

const pendingOutbox = () =>
  sql`select count(*)::int as n from outbox_messages where published_at is null`.then(([row]) => row.n as number);

describe('crash recovery', () => {
  test('worker killed after commit and before ack: redelivery is a replay, debit happens once', async () => {
    const api = await startApp(db, queues.env());
    let consumer: Awaited<ReturnType<typeof startApp>> | undefined;
    try {
      const wallet = await createWallet(api.baseUrl, '100.00');
      const message = wagerMessage(wagerBody(wallet, { kind: 'BET', amount: '35.00', externalTransactionId: 'crash-ack' }));
      await queues.send(message, { groupId: wallet.id });

      // 1. Processo separado recebe, commita e morre sem DeleteMessage.
      const crashing = spawnScript('test/fixtures/crash-after-commit.ts', db, queues.env());
      const output = await new Response(crashing.stdout).text();
      expect(await crashing.exited).toBe(137);
      expect(JSON.parse(output.trim())).toEqual({ received: 1, decision: { action: 'ack' } });

      // O efeito já está no banco, mas a mensagem continua na fila.
      expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '65.00', entries: 2 });
      expect(await queues.approximateCount('main')).toBe(1);

      // 2. Outra instância (com workers) recebe a mesma mensagem de novo.
      consumer = await startApp(db, { ...queues.env(), WORKERS_ENABLED: 'true' });
      await waitFor('redelivered message acked', async () => (await queues.approximateCount('main')) === 0, 20_000);

      const metrics = await (await fetch(`${consumer.baseUrl}/metrics`)).text();
      expect(metrics).toContain('wagering_duplicates_total{source="sqs"} 1');
      expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '65.00', entries: 2 });
      const [inbox] = await sql`select count(*)::int as n from inbox_messages where message_id = ${message.messageId}`;
      expect(inbox.n).toBe(1);
    } finally {
      await consumer?.close();
      await api.close();
    }
  }, 60_000);

  test('publisher killed after sending and before commit: another instance republishes safely', async () => {
    await queues.drain('events');
    const api = await startApp(db, queues.env());
    try {
      const wallet = await createWallet(api.baseUrl, '100.00');
      for (let i = 0; i < 4; i++) {
        await submitWager(api.baseUrl, wallet, { kind: 'BET', amount: '1.00' });
      }
      const pendingBefore = await pendingOutbox();
      expect(pendingBefore).toBeGreaterThan(0);

      // 1. Envia ao SQS e morre antes do commit: tudo continua pendente na outbox.
      const crashing = spawnScript('test/fixtures/crash-after-publish.ts', db, queues.env());
      const output = await new Response(crashing.stdout).text();
      expect(await crashing.exited).toBe(137);
      expect(JSON.parse(output.trim())).toEqual({ sent: true });
      expect(await pendingOutbox()).toBe(pendingBefore);

      // 2. Outra instância publica de novo.
      const publisher = await startApp(db, { ...queues.env(), WORKERS_ENABLED: 'true' });
      try {
        await waitFor('outbox drained', async () => (await pendingOutbox()) === 0);
      } finally {
        await publisher.close();
      }

      // 3. Mesmo eventId enviado duas vezes: o SQS FIFO descarta pelo MessageDeduplicationId.
      const received = await queues.drain('events');
      const eventIds = received.map((m) => JSON.parse(m.Body!).eventId as string);
      expect(eventIds).toHaveLength(pendingBefore);
      expect(new Set(eventIds).size).toBe(pendingBefore);
    } finally {
      await api.close();
    }
  }, 60_000);

  test('two publishers on the same outbox never publish the same event twice', async () => {
    await queues.drain('events');
    const api = await startApp(db, queues.env());
    const contexts: INestApplicationContext[] = [];
    try {
      const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(api.baseUrl, '100.00')));
      await Promise.all(
        wallets.flatMap((wallet) => Array.from({ length: 6 }, () => submitWager(api.baseUrl, wallet, { kind: 'BET', amount: '1.00' }))),
      );
      const total = await pendingOutbox();
      expect(total).toBe(5 + 5 * 6 * 2);

      // Dois contextos independentes = dois pools de conexão, como duas instâncias.
      const config = AppConfig.fromEnv(testEnv(db, { ...queues.env(), OUTBOX_BATCH_SIZE: '7' }));
      for (let i = 0; i < 2; i++) {
        contexts.push(await NestFactory.createApplicationContext(AppModule.register(config), { logger: false }));
      }
      const [first, second] = contexts.map((context) => context.get(OutboxPublisher));
      const drain = async (publisher: OutboxPublisher) => {
        let published = 0;
        for (let batch = await publisher.publishBatch(); batch > 0; batch = await publisher.publishBatch()) {
          published += batch;
        }
        return published;
      };
      const [byFirst, bySecond] = await Promise.all([drain(first!), drain(second!)]);

      expect(byFirst + bySecond).toBe(total);
      expect(byFirst).toBeGreaterThan(0);
      expect(bySecond).toBeGreaterThan(0);
      expect(await pendingOutbox()).toBe(0);

      const received = await queues.drain('events');
      expect(received).toHaveLength(total);
      expect(new Set(received.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(total);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await api.close();
    }
  }, 60_000);
});

describe('service restart', () => {
  test('hard kill and restart: pending work resumes and the books still balance', async () => {
    const portA = await freePort();
    const instanceA = await spawnInstance(db, portA, { ...queues.env(), WORKERS_ENABLED: 'false' });
    const wallet = await createWallet(instanceA.baseUrl, '100.00');
    await submitWager(instanceA.baseUrl, wallet, { kind: 'BET', amount: '20.00', externalTransactionId: 'restart-bet-1' });
    const refund = await submitWager(instanceA.baseUrl, wallet, {
      kind: 'REFUND',
      amount: '15.00',
      externalTransactionId: 'restart-refund',
      referenceExternalTransactionId: 'restart-bet-2',
    });
    expect(refund.status).toBe(202);
    await instanceA.kill();

    // Uma mensagem fica na fila enquanto o serviço está fora do ar.
    await queues.send(wagerMessage(wagerBody(wallet, { kind: 'BET', amount: '15.00', externalTransactionId: 'restart-bet-2' })), {
      groupId: wallet.id,
    });

    const portB = await freePort();
    const instanceB = await spawnInstance(db, portB, { ...queues.env(), WORKERS_ENABLED: 'true' });
    try {
      // B consome a mensagem, o worker resolve o REFUND e a outbox é drenada.
      await waitFor('refund resolved', async () => {
        const [row] = await sql`select status from wager_transactions where external_transaction_id = 'restart-refund'`;
        return row.status === 'PROCESSED';
      });
      await waitFor('outbox drained', async () => (await pendingOutbox()) === 0);

      expect(await expectWalletConsistent(sql, wallet.id)).toEqual({ balance: '80.00', entries: 4 });
      const replay = await submitWager(instanceB.baseUrl, wallet, {
        kind: 'BET',
        amount: '20.00',
        externalTransactionId: 'restart-bet-1',
      });
      expect(replay.body).toMatchObject({ idempotentReplay: true, balance: { amount: '80.00' } });
    } finally {
      await instanceB.close();
    }

    const [orphans] = await sql`select count(*)::int as n from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')`;
    expect(orphans.n).toBe(0);
  }, 60_000);
});
