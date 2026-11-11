import { Injectable } from '@nestjs/common';

type Labels = Readonly<Record<string, string>>;

interface MetricDefinition {
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly help: string;
  readonly buckets?: readonly number[];
}

/** Catálogo fechado: só estas métricas existem, o que evita nomes digitados errado no call site. */
const DEFINITIONS = {
  wagering_transactions_total: { type: 'counter', help: 'Transações finalizadas por status e kind' },
  wagering_duplicates_total: { type: 'counter', help: 'Requisições/mensagens duplicadas detectadas (replay)' },
  wagering_idempotency_conflicts_total: { type: 'counter', help: 'Mesma chave com payload diferente' },
  wagering_retries_total: { type: 'counter', help: 'Novas tentativas internas por motivo' },
  wagering_lock_conflicts_total: { type: 'counter', help: 'Timeouts esperando o lock de uma wallet' },
  wagering_processing_duration_seconds: {
    type: 'histogram',
    help: 'Latência de processamento de uma transação',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  },
  wagering_reconciliation_mismatches_total: { type: 'counter', help: 'Reconciliações com saldo divergente do ledger' },
  sqs_messages_total: { type: 'counter', help: 'Mensagens SQS consumidas por resultado' },
  sqs_dlq_messages_total: { type: 'counter', help: 'Mensagens enviadas para a DLQ' },
  outbox_published_total: { type: 'counter', help: 'Eventos publicados pela outbox' },
  outbox_publish_failures_total: { type: 'counter', help: 'Falhas ao publicar eventos da outbox' },
  outbox_lag_seconds: { type: 'gauge', help: 'Idade do evento pendente mais antigo da outbox' },
  outbox_pending_messages: { type: 'gauge', help: 'Eventos ainda não publicados' },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof DEFINITIONS;

interface HistogramValue {
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * Métricas em memória no formato de exposição do Prometheus (GET /metrics).
 * Cada instância expõe as suas; o Prometheus agrega entre instâncias.
 */
@Injectable()
export class Metrics {
  private readonly values = new Map<MetricName, Map<string, number | HistogramValue>>();

  increment(name: MetricName, labels: Labels = {}, by = 1): void {
    const series = this.series(name);
    const key = labelKey(labels);
    series.set(key, ((series.get(key) as number | undefined) ?? 0) + by);
  }

  set(name: MetricName, value: number, labels: Labels = {}): void {
    this.series(name).set(labelKey(labels), value);
  }

  observe(name: MetricName, value: number, labels: Labels = {}): void {
    const definition: MetricDefinition = DEFINITIONS[name];
    const bounds = definition.buckets ?? [];
    const series = this.series(name);
    const key = labelKey(labels);
    const current = (series.get(key) as HistogramValue | undefined) ?? { buckets: bounds.map(() => 0), sum: 0, count: 0 };
    bounds.forEach((bound, index) => {
      if (value <= bound) {
        current.buckets[index]! += 1;
      }
    });
    current.sum += value;
    current.count += 1;
    series.set(key, current);
  }

  /** Mede a duração de `work` em segundos. */
  async time<T>(name: MetricName, labels: Labels, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.observe(name, (performance.now() - started) / 1000, labels);
    }
  }

  /** Valor atual de um contador/gauge (usado nos testes e no diagnóstico). */
  value(name: MetricName, labels: Labels = {}): number {
    const current = this.values.get(name)?.get(labelKey(labels));
    return typeof current === 'number' ? current : (current?.count ?? 0);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, definition] of Object.entries(DEFINITIONS) as [MetricName, MetricDefinition][]) {
      lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} ${definition.type}`);
      for (const [key, value] of this.values.get(name) ?? []) {
        if (typeof value === 'number') {
          lines.push(`${name}${key} ${value}`);
          continue;
        }
        const bounds = definition.buckets ?? [];
        bounds.forEach((bound, index) => {
          lines.push(`${name}_bucket${withLabel(key, 'le', String(bound))} ${value.buckets[index]}`);
        });
        lines.push(`${name}_bucket${withLabel(key, 'le', '+Inf')} ${value.count}`);
        lines.push(`${name}_sum${key} ${value.sum}`, `${name}_count${key} ${value.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private series(name: MetricName): Map<string, number | HistogramValue> {
    let series = this.values.get(name);
    if (!series) {
      series = new Map();
      this.values.set(name, series);
    }
    return series;
  }
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function withLabel(key: string, name: string, value: string): string {
  const label = `${name}="${value}"`;
  return key === '' ? `{${label}}` : `${key.slice(0, -1)},${label}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
