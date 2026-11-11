import { expect } from 'bun:test';
import type { SQL } from 'bun';

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export async function request<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function createWallet(baseUrl: string, amount = '100.00', currency = 'BRL'): Promise<TestWallet> {
  const playerId = crypto.randomUUID();
  const result = await request(baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency } },
  });
  expect(result.status).toBe(201);
  return { id: result.body.id, playerId };
}

export interface WagerInput {
  kind: string;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  currency?: string;
  providerId?: string;
  idempotencyKey?: string;
}

export function wagerBody(wallet: TestWallet, input: WagerInput) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? 'BRL' },
    ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
  };
}

export async function submitWager(baseUrl: string, wallet: TestWallet, input: WagerInput): Promise<HttpResult> {
  const body = wagerBody(wallet, input);
  return request(baseUrl, 'POST', '/wagering/transactions', {
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}` },
  });
}

/**
 * Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger,
 * conferido direto no banco (não pela API, que poderia ter o mesmo bug).
 */
export async function expectWalletConsistent(sql: SQL, walletId: string): Promise<{ balance: string; entries: number }> {
  const [row] = await sql`
    select w.balance::text as balance,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(30, 2)::text as ledger,
           count(l.id)::int as entries,
           max(l.wallet_version) as last_version,
           w.version
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id = ${walletId}
     group by w.id`;
  expect(row.balance).toBe(row.ledger);
  expect(row.version).toBe(row.last_version ?? 1);
  return { balance: row.balance, entries: row.entries };
}
