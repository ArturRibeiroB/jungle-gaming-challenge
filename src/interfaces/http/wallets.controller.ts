import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { LedgerPageView, ReconciliationView, WalletView } from '../../application/views';
import { WalletService } from '../../application/wallet.service';
import { Money } from '../../domain/money';
import { ProviderAuthGuard } from './provider-auth.guard';
import { correlationIdOf, parseLimit, parseOpenWallet, parseUuidParam } from './request-parsing';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  open(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const { playerId, initialBalance } = parseOpenWallet(body);
    return this.wallets.open({
      playerId,
      initialBalance: Money.from(initialBalance),
      correlationId: correlationIdOf(request),
    });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.wallets.get(parseUuidParam('walletId', walletId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<LedgerPageView> {
    return this.wallets.ledger(parseUuidParam('walletId', walletId), { cursor, limit: parseLimit(limit) });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.wallets.reconcile(parseUuidParam('walletId', walletId));
  }
}
