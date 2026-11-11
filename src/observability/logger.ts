import type { LoggerService } from '@nestjs/common';

/**
 * Campos de correlação. Nunca coloque aqui payload completo, valores monetários
 * ou dados pessoais: logs vão para sistemas com acesso mais amplo que o banco.
 */
export interface LogFields {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  [field: string]: string | number | boolean | null | undefined;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

/** Logger estruturado: uma linha JSON por evento, no stdout. */
export class Logger {
  constructor(private readonly context: string) {}

  debug(message: string, fields?: LogFields): void {
    write('debug', this.context, message, fields);
  }

  info(message: string, fields?: LogFields): void {
    write('info', this.context, message, fields);
  }

  warn(message: string, fields?: LogFields, error?: unknown): void {
    write('warn', this.context, message, fields, error);
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    write('error', this.context, message, fields, error);
  }
}

function write(level: Level, context: string, message: string, fields?: LogFields, error?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    return;
  }
  const line: Record<string, unknown> = { level, time: new Date().toISOString(), context, message };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) {
      line[key] = value;
    }
  }
  if (error !== undefined) {
    line.error = serializeError(error);
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Exceções do driver trazem o SQL completo na mensagem ("insert into ... values (...) - motivo"),
 * com valores, ids de player e payloads. Só o motivo vai para o log.
 */
const SQL_PREFIX = /^\s*(insert|update|select|delete|with|set|begin|commit)\b[\s\S]* - /i;

function redactSql(text: string): string {
  return text.replace(SQL_PREFIX, '[sql redacted] - ');
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: redactSql(String(error)) };
  }
  const message = redactSql(error.message);
  const frames = error.stack?.split('\n').filter((line) => /^\s+at /.test(line)) ?? [];
  return {
    name: error.name,
    message,
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    stack: [`${error.name}: ${message}`, ...frames.slice(0, 15)].join('\n'),
  };
}

/** Adaptador para os logs internos do NestJS saírem no mesmo formato JSON. */
export class NestJsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    write('info', context ?? 'Nest', String(message));
  }

  warn(message: unknown, context?: string): void {
    write('warn', context ?? 'Nest', String(message));
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    write('error', context ?? stackOrContext ?? 'Nest', String(message));
  }

  debug(message: unknown, context?: string): void {
    write('debug', context ?? 'Nest', String(message));
  }

  verbose(message: unknown, context?: string): void {
    write('debug', context ?? 'Nest', String(message));
  }
}
