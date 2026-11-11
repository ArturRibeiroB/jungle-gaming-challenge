/**
 * Teste de carga: `bun run test:load` (com `docker compose up -d --wait` no ar).
 *
 * Roda contra as 3 instâncias do Compose (app + 2 workers) três cenários:
 *   1. HTTP distribuído: muitas wallets, BET/WIN aleatórios, 5% de reenvios (replay).
 *   2. HTTP hot wallet: todas as requisições na mesma wallet (pior caso do lock por wallet).
 *   3. SQS: N mensagens enfileiradas de uma vez, consumidas pelas 3 instâncias.
 *
 * Mede throughput, latência p50/p95/p99, taxa de erro, conflitos de concorrência
 * (métricas somadas das instâncias) e outbox lag (amostrado direto no banco).
 * No fim, confere a invariante saldo == ledger para todas as wallets usadas.
 *
 * Parâmetros (variáveis de ambiente): LOAD_DURATION_S, LOAD_CONCURRENCY, LOAD_WALLETS, LOAD_SQS_MESSAGES.
 * Relatório: stdout + load-test-results/<data>.md e .json.
 */
import { SQL } from 'bun';
import { cpus, platform, release, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

const DURATION_S = int('LOAD_DURATION_S', 20);
const CONCURRENCY = int('LOAD_CONCURRENCY', 32);
const WALLETS = int('LOAD_WALLETS', 100);
const SQS_MESSAGES = int('LOAD_SQS_MESSAGES', 2_000);
const DUPLICATE_RATE = 0.05;
const RUN = Date.now().toString(36);

const db = new SQL(required('DATABASE_URL'));
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
});

// ---------------------------------------------------------------- instâncias

/** URLs das instâncias publicadas pelo docker compose (ou LOAD_TARGETS=url1,url2). */
function discoverInstances(): string[] {
  if (process.env.LOAD_TARGETS) {
    return process.env.LOAD_TARGETS.split(',').map((url) => url.trim());
  }
  const output = Bun.spawnSync(['docker', 'compose', 'ps', '--format', 'json']).stdout.toString().trim();
  const services: { Service: string; Publishers?: { TargetPort: number; PublishedPort: number }[] }[] = output.startsWith('[')
    ? JSON.parse(output)
    : output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const urls = services
    .filter((service) => service.Service === 'app' || service.Service === 'worker')
    .flatMap((service) => service.Publishers ?? [])
    .filter((publisher) => publisher.TargetPort === 3000 && publisher.PublishedPort > 0)
    .map((publisher) => `http://127.0.0.1:${publisher.PublishedPort}`);
  return [...new Set(urls)];
}

// ---------------------------------------------------------------- medição

interface Sample {
  ms: number;
  status: number;
  code?: string;
}

interface ScenarioResult {
  name: string;
  description: string;
  requests: number;
  durationS: number;
  throughput: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  statuses: Record<string, number>;
  errorRate: number;
  outbox: OutboxLag;
  notes: string[];
}

interface OutboxLag {
  maxLagS: number;
  p95LagS: number;
  maxPending: number;
  drainS: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function summarize(samples: Sample[]) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.code ? `${sample.status} ${sample.code}` : String(sample.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  // Erro = falha de infraestrutura ou resposta inesperada. 422 é regra de negócio, não erro.
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500 || (s.status >= 400 && s.status !== 422)).length;
  return {
    latencyMs: {
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.at(-1) ?? 0),
    },
    statuses,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
  };
}

/** Amostra o backlog da outbox no banco a cada 250 ms enquanto o cenário roda. */
function sampleOutbox() {
  const lags: number[] = [];
  let maxPending = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const [row] = await db`
        select count(*)::int as pending,
               coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
          from outbox_messages where published_at is null`;
      lags.push(row.lag);
      maxPending = Math.max(maxPending, row.pending);
      await Bun.sleep(250);
    }
  })();
  return async (): Promise<OutboxLag> => {
    stopped = true;
    await loop;
    const started = performance.now();
    // Tempo para a outbox zerar depois que a carga parou.
    for (;;) {
      const [row] = await db`select count(*)::int as pending from outbox_messages where published_at is null`;
      if (row.pending === 0 || performance.now() - started > 60_000) {
        break;
      }
      await Bun.sleep(100);
    }
    const sorted = [...lags].sort((a, b) => a - b);
    return {
      maxLagS: round(sorted.at(-1) ?? 0),
      p95LagS: round(percentile(sorted, 95)),
      maxPending,
      drainS: round((performance.now() - started) / 1000),
    };
  };
}

// ---------------------------------------------------------------- HTTP

interface WalletRef {
  id: string;
  playerId: string;
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Sample & { body: any }> {
  const started = performance.now();
  try {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as any;
    return { ms: performance.now() - started, status: response.status, code: json?.error?.code ?? json?.failureCode, body: json };
  } catch {
    return { ms: performance.now() - started, status: 0, code: 'NETWORK_ERROR', body: undefined };
  }
}

async function createWallets(instances: string[], count: number, amount: string): Promise<WalletRef[]> {
  const wallets: WalletRef[] = [];
  for (let start = 0; start < count; start += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - start) }, async (_, i) => {
        const playerId = crypto.randomUUID();
        const result = await post(instances[(start + i) % instances.length]!, '/wallets', {
          playerId,
          initialBalance: { amount, currency: 'BRL' },
        });
        if (result.status !== 201) {
          throw new Error(`Could not create wallet: ${result.status} ${JSON.stringify(result.body)}`);
        }
        return { id: result.body.id as string, playerId };
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

function wagerBody(wallet: WalletRef, kind: string, amount: string, externalTransactionId: string) {
  return {
    providerId: 'load-provider',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'load-game',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function httpScenario(
  name: string,
  description: string,
  instances: string[],
  wallets: WalletRef[],
  durationS: number,
  pick: () => { kind: string; amount: string },
): Promise<ScenarioResult> {
  const samples: Sample[] = [];
  const sent: { key: string; body: unknown }[] = [];
  let replays = 0;
  let replaysConfirmed = 0;
  let counter = 0;
  const stopOutbox = sampleOutbox();
  const started = performance.now();
  const deadline = started + durationS * 1000;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, worker) => {
      while (performance.now() < deadline) {
        const n = counter++;
        const instance = instances[n % instances.length]!;
        // Uma fração das requisições é reenvio exato de uma anterior: deve virar replay.
        if (sent.length > 0 && Math.random() < DUPLICATE_RATE) {
          const previous = sent[Math.floor(Math.random() * sent.length)]!;
          const result = await post(instance, '/wagering/transactions', previous.body, { 'Idempotency-Key': previous.key });
          samples.push(result);
          replays += 1;
          if (result.body?.idempotentReplay === true) {
            replaysConfirmed += 1;
          }
          continue;
        }
        const wallet = wallets[Math.floor(Math.random() * wallets.length)]!;
        const { kind, amount } = pick();
        const externalId = `${name}-${RUN}-${worker}-${n}`;
        const body = wagerBody(wallet, kind, amount, externalId);
        const key = `load-provider:${externalId}`;
        const result = await post(instance, '/wagering/transactions', body, { 'Idempotency-Key': key });
        samples.push(result);
        if (result.status === 200) {
          sent.push({ key, body });
        }
      }
    }),
  );

  const elapsedS = (performance.now() - started) / 1000;
  const outbox = await stopOutbox();
  return {
    name,
    description,
    requests: samples.length,
    durationS: round(elapsedS),
    throughput: round(samples.length / elapsedS),
    ...summarize(samples),
    outbox,
    notes: [`${replays} reenvios idênticos, ${replaysConfirmed} responderam idempotentReplay=true`],
  };
}

// ---------------------------------------------------------------- SQS

async function sqsScenario(wallets: WalletRef[]): Promise<ScenarioResult> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo' }));
  const prefix = `sqs-${RUN}-`;
  const sentAt = new Map<string, number>();
  const stopOutbox = sampleOutbox();
  const started = performance.now();

  // Enfileira tudo o mais rápido possível (lotes de 10, 8 lotes em paralelo).
  const batches = Array.from({ length: Math.ceil(SQS_MESSAGES / 10) }, (_, b) => b);
  for (let i = 0; i < batches.length; i += 8) {
    await Promise.all(
      batches.slice(i, i + 8).map((b) => {
        const entries = Array.from({ length: Math.min(10, SQS_MESSAGES - b * 10) }, (_, j) => {
          const n = b * 10 + j;
          const wallet = wallets[n % wallets.length]!;
          const externalId = `${prefix}${n}`;
          const occurredAt = new Date();
          sentAt.set(externalId, occurredAt.getTime());
          return {
            Id: String(j),
            MessageGroupId: wallet.id,
            MessageDeduplicationId: externalId,
            MessageBody: JSON.stringify({
              messageId: `msg-${externalId}`,
              type: 'WagerTransactionRequested',
              occurredAt: occurredAt.toISOString(),
              data: { ...wagerBody(wallet, 'BET', '1.00', externalId), idempotencyKey: `load-provider:${externalId}` },
            }),
          };
        });
        return sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: entries }));
      }),
    );
  }
  const enqueuedS = (performance.now() - started) / 1000;

  // Espera todas virarem transação terminal.
  let done = 0;
  while (performance.now() - started < 300_000) {
    const [row] = await db`select count(*)::int as n from wager_transactions where external_transaction_id like ${prefix + '%'}`;
    done = row.n;
    if (done >= SQS_MESSAGES) {
      break;
    }
    await Bun.sleep(200);
  }
  const elapsedS = (performance.now() - started) / 1000;
  const outbox = await stopOutbox();

  // Latência ponta a ponta: envio para a fila -> transação commitada.
  const rows = await db`
    select external_transaction_id as id, status, extract(epoch from coalesce(processed_at, updated_at)) * 1000 as at
      from wager_transactions where external_transaction_id like ${prefix + '%'}`;
  const samples: Sample[] = rows.map((row: { id: string; status: string; at: number }) => ({
    ms: Number(row.at) - (sentAt.get(row.id) ?? Number(row.at)),
    status: row.status === 'PROCESSED' ? 200 : 422,
    code: row.status === 'PROCESSED' ? undefined : row.status,
  }));
  const missing = SQS_MESSAGES - samples.length;
  return {
    name: 'sqs-throughput',
    description: `${SQS_MESSAGES} mensagens BET 1.00 em ${wallets.length} wallets (grupo FIFO = wallet), consumidas pelas instâncias`,
    requests: samples.length,
    durationS: round(elapsedS),
    throughput: round(samples.length / elapsedS),
    ...summarize(samples),
    errorRate: missing / SQS_MESSAGES,
    outbox,
    notes: [
      `enfileiramento levou ${round(enqueuedS)} s; latência = envio à fila -> commit (inclui espera na fila)`,
      missing > 0 ? `${missing} mensagens não processadas dentro do limite de 5 min` : 'todas as mensagens processadas',
    ],
  };
}

// ---------------------------------------------------------------- métricas e invariante

async function scrape(instances: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const instance of instances) {
    const text = await (await fetch(`${instance}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || line.trim() === '' || line.includes('_bucket')) {
        continue;
      }
      const separator = line.lastIndexOf(' ');
      const key = line.slice(0, separator);
      totals.set(key, (totals.get(key) ?? 0) + Number(line.slice(separator + 1)));
    }
  }
  return totals;
}

function delta(before: Map<string, number>, after: Map<string, number>, prefix: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of after) {
    if (key.startsWith(prefix)) {
      const diff = value - (before.get(key) ?? 0);
      if (diff !== 0) {
        result[key] = round(diff);
      }
    }
  }
  return result;
}

async function checkInvariant(walletIds: string[]): Promise<{ checked: number; inconsistent: number }> {
  const rows = await db`
    select w.id, w.balance::text as balance,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(30, 2)::text as ledger
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id = any(${walletIds}::uuid[])
     group by w.id`;
  return {
    checked: rows.length,
    inconsistent: rows.filter((row: { balance: string; ledger: string }) => row.balance !== row.ledger).length,
  };
}

// ---------------------------------------------------------------- relatório

function environment(instances: string[]) {
  let docker = 'n/a (gerador rodando dentro de um container)';
  try {
    docker = Bun.spawnSync(['docker', 'info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes, {{.OperatingSystem}}']).stdout.toString().trim();
  } catch {
    // sem CLI do docker no PATH
  }
  return {
    cpu: `${cpus()[0]?.model} (${cpus().length} threads)`,
    memoryGb: round(totalmem() / 1024 ** 3),
    os: `${platform()} ${release()}`,
    bun: Bun.version,
    docker,
    instances: instances.length,
    // "compose": gerador dentro da rede do docker; "host": pelo port-forwarding do Docker Desktop.
    client: process.env.LOAD_NETWORK ?? 'host',
    concurrency: CONCURRENCY,
    durationS: DURATION_S,
    wallets: WALLETS,
    sqsMessages: SQS_MESSAGES,
  };
}

function markdown(env: ReturnType<typeof environment>, results: ScenarioResult[], extra: Record<string, unknown>): string {
  const lines = [
    `# Load test — ${new Date().toISOString()}`,
    '',
    '## Ambiente',
    '',
    ...Object.entries(env).map(([key, value]) => `- **${key}**: ${value}`),
    '',
    '## Resultados',
    '',
    '| Cenário | Req. | Duração (s) | Throughput (/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Outbox lag máx/p95 (s) | Outbox pendente máx | Drenagem (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.requests} | ${r.durationS} | ${r.throughput} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${(r.errorRate * 100).toFixed(2)}% | ${r.outbox.maxLagS} / ${r.outbox.p95LagS} | ${r.outbox.maxPending} | ${r.outbox.drainS} |`,
    ),
    '',
    ...results.flatMap((r) => [
      `### ${r.name}`,
      '',
      r.description,
      '',
      `- status: ${Object.entries(r.statuses)
        .map(([key, value]) => `\`${key}\` × ${value}`)
        .join(', ')}`,
      ...r.notes.map((note) => `- ${note}`),
      '',
    ]),
    '## Contadores das instâncias (delta durante o teste)',
    '',
    '```json',
    JSON.stringify(extra, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

const instances = discoverInstances();
if (instances.length === 0) {
  throw new Error('No instances found. Run `docker compose up -d --wait` first (or set LOAD_TARGETS).');
}
for (const instance of instances) {
  const ready = await fetch(`${instance}/health/ready`);
  if (!ready.ok) {
    throw new Error(`${instance} is not ready`);
  }
}
console.log(`Load test against ${instances.length} instances: ${instances.join(', ')}`);

const metricsBefore = await scrape(instances);
const wallets = await createWallets(instances, WALLETS, '1000000.00');
const [hotWallet] = await createWallets(instances, 1, '1000000.00');

const results: ScenarioResult[] = [];
console.log('1/3 http-distributed');
results.push(
  await httpScenario(
    'http-distributed',
    `${CONCURRENCY} clientes concorrentes por ${DURATION_S}s, ${WALLETS} wallets, 80% BET / 20% WIN de 1.00, ${DUPLICATE_RATE * 100}% reenvios, round-robin nas instâncias`,
    instances,
    wallets,
    DURATION_S,
    () => (Math.random() < 0.8 ? { kind: 'BET', amount: '1.00' } : { kind: 'WIN', amount: '1.00' }),
  ),
);
console.log('2/3 http-hot-wallet');
results.push(
  await httpScenario(
    'http-hot-wallet',
    `${CONCURRENCY} clientes concorrentes por ${Math.ceil(DURATION_S / 2)}s, todos na MESMA wallet (pior caso do lock por wallet)`,
    instances,
    [hotWallet!],
    Math.ceil(DURATION_S / 2),
    () => ({ kind: 'BET', amount: '0.01' }),
  ),
);
console.log('3/3 sqs-throughput');
results.push(await sqsScenario(wallets));

const metricsAfter = await scrape(instances);
const invariant = await checkInvariant([...wallets.map((w) => w.id), hotWallet!.id]);
const counters = {
  invariant,
  lockConflicts: delta(metricsBefore, metricsAfter, 'wagering_lock_conflicts_total'),
  retries: delta(metricsBefore, metricsAfter, 'wagering_retries_total'),
  duplicates: delta(metricsBefore, metricsAfter, 'wagering_duplicates_total'),
  idempotencyConflicts: delta(metricsBefore, metricsAfter, 'wagering_idempotency_conflicts_total'),
  sqsMessages: delta(metricsBefore, metricsAfter, 'sqs_messages_total'),
  dlq: delta(metricsBefore, metricsAfter, 'sqs_dlq_messages_total'),
  outboxPublished: delta(metricsBefore, metricsAfter, 'outbox_published_total'),
  outboxFailures: delta(metricsBefore, metricsAfter, 'outbox_publish_failures_total'),
};

const env = environment(instances);
const report = markdown(env, results, counters);
console.log(`\n${report}`);
mkdirSync('load-test-results', { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
writeFileSync(`load-test-results/${stamp}.md`, report);
writeFileSync(`load-test-results/${stamp}.json`, JSON.stringify({ env, results, counters }, null, 2));
console.log(`Saved load-test-results/${stamp}.md`);

await db.close();
sqs.destroy();
if (invariant.inconsistent > 0) {
  console.error(`INVARIANT VIOLATED in ${invariant.inconsistent} wallets`);
  process.exit(1);
}

// ---------------------------------------------------------------- utilitários

function int(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} (copy .env.example to .env)`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
