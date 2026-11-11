import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Logger } from '../../src/observability/logger';

describe('Logger', () => {
  let write: Mock<typeof process.stdout.write>;

  beforeEach(() => {
    write = spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
  });

  const lastLine = () => JSON.parse(String(write.mock.calls.at(-1)?.[0]));

  test('writes one JSON line with correlation fields', () => {
    new Logger('Test').error('boom', { correlationId: 'c-1', walletId: 'w-1', skipped: undefined });
    expect(lastLine()).toMatchObject({ level: 'error', context: 'Test', message: 'boom', correlationId: 'c-1', walletId: 'w-1' });
    expect(lastLine()).not.toHaveProperty('skipped');
  });

  test('redacts SQL statements (with values) from driver errors', () => {
    const error = Object.assign(
      new Error(`insert into "outbox_messages" ("payload") values ('{"amount":"40.00","playerId":"p-1"}') - simulated failure`),
      { name: 'DriverException', code: 'P0001' },
    );
    new Logger('Test').error('failed', {}, error);
    const line = JSON.stringify(lastLine());
    expect(lastLine().error).toMatchObject({ name: 'DriverException', code: 'P0001', message: '[sql redacted] - simulated failure' });
    expect(line).not.toContain('40.00');
    expect(line).not.toContain('p-1');
  });
});
