import { newId } from '../../src/domain/id';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

export const T0 = new Date('2026-11-11T12:00:00.000Z');
export const HASH = 'a'.repeat(64);

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export function openWallet(initial = '100.00', playerId = newId()): Wallet {
  return Wallet.open({
    id: newId(),
    playerId,
    initialBalance: brl(initial),
    openingTransactionId: newId(),
    at: T0,
  }).wallet;
}

export function wager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}
