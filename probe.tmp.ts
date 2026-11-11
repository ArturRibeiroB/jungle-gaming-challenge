import { SQL } from 'bun';
const db = new SQL(process.env.DATABASE_URL!);
const base = 'http://127.0.0.1:3000';
const C = Number(process.env.C ?? 32);
const wallets = await Promise.all(Array.from({ length: C }, async () => {
  const playerId = crypto.randomUUID();
  const w = await (await fetch(`${base}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } }) })).json();
  return { id: w.id, playerId };
}));
const waits = new Map<string, number>();
let sampling = true;
const sampler = (async () => { while (sampling) { const rows = await db`select coalesce(wait_event_type||':'||wait_event, state) as w from pg_stat_activity where datname = 'wagering' and backend_type = 'client backend' and pid <> pg_backend_pid()`; for (const r of rows) waits.set(r.w, (waits.get(r.w) ?? 0) + 1); await Bun.sleep(20); } })();
const t = performance.now(); let n = 0; const lat: number[] = [];
await Promise.all(wallets.map(async (w, c) => { for (let i = 0; i < 15; i++) { const ext = `pc-${Date.now()}-${c}-${i}`; const s = performance.now(); await (await fetch(`${base}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': `p:${ext}` }, body: JSON.stringify({ providerId: 'p', externalTransactionId: ext, playerId: w.playerId, walletId: w.id, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }) })).text(); lat.push(performance.now() - s); n++; } }));
const el = (performance.now() - t) / 1000; sampling = false; await sampler;
lat.sort((a, b) => a - b);
console.log(`C=${C} ${n} req in ${el.toFixed(2)}s => ${(n / el).toFixed(1)} rps, p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)}ms`);
console.log([...waits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
await db.close();
