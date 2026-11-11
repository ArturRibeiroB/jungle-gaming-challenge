import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/events';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { newId } from '../../src/domain/id';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { PollingLoop } from '../../src/infrastructure/workers/polling-loop';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { T0, brl, openWallet, wager } from '../support/builders';

const ctx = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 };

describe('integration events', () => {
  test('envelope carries type and version from the class and JSON-only data', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), newId(), T0);
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.toJSON()).toEqual({
      eventId: event.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: T0.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test('processed event refuses a transaction that is not processed', () => {
    const tx = wager(openWallet(), WagerTransactionKind.Bet, '1.00');
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow();
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const wallet = openWallet('10.00');
    return WalletBalanceChanged.from(wallet, wallet.credit(brl('1.00'), newId(), T0), ctx);
  };

  test('enqueue uses the eventId as id and the wallet as aggregate', () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);
    expect(message.id).toBe(source.eventId);
    expect(message.aggregateId).toBe(source.aggregateId);
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(source.toJSON())));
    expect(message.isDue(T0)).toBe(true);
  });

  test('retry backoff doubles up to 60s and published messages are no longer due', () => {
    const message = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      message.scheduleRetry(T0);
      delays.push(message.nextAttemptAt!.getTime() - T0.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(message.attempts).toBe(8);
    expect(message.isDue(T0)).toBe(false);

    message.markPublished(T0);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(T0.getTime() + 3_600_000))).toBe(false);
  });
});

describe('InboxMessage', () => {
  test('tracks processing and payload identity', () => {
    const inbox = InboxMessage.receive({ messageId: 'm-1', consumerName: 'c', payloadHash: 'h1', receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(T0);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.matchesPayload('h1')).toBe(true);
    expect(inbox.matchesPayload('h2')).toBe(false);
  });
});

describe('PollingLoop', () => {
  test('stop() lets the in-flight iteration finish (graceful shutdown)', async () => {
    let finished = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const loop = new PollingLoop(
      'test',
      async () => {
        started();
        await Bun.sleep(150);
        finished += 1;
        return true;
      },
      10,
    );
    loop.start();
    await firstStarted;
    await loop.stop();
    expect(finished).toBe(1);
  });

  test('a failing iteration backs off instead of crashing the loop', async () => {
    let calls = 0;
    const loop = new PollingLoop(
      'test',
      async () => {
        calls += 1;
        throw new Error('dependency down');
      },
      20,
    );
    loop.start();
    await Bun.sleep(130);
    await loop.stop();
    // 20ms, 40ms, 80ms de espera: poucas chamadas, nunca um loop quente.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(4);
  });
});
