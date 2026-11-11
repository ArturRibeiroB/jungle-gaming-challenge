import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TransactionOutcome, TransactionView } from '../../application/views';
import { WagerTransactionService } from '../../application/wager-transaction.service';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { ProviderAuthGuard } from './provider-auth.guard';
import { correlationIdOf, parseIdempotencyKey, parseUuidParam, parseWagerTransactionPayload } from './request-parsing';

/**
 * Status HTTP pelo resultado da transação. O replay devolve o mesmo status do original
 * (com idempotentReplay: true), então o provedor decide só pelo código.
 */
const STATUS_BY_OUTCOME: Record<WagerTransactionStatus, HttpStatus> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(private readonly transactions: WagerTransactionService) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionOutcome> {
    const outcome = await this.transactions.submit({
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
      payload: parseWagerTransactionPayload(body),
      correlationId: correlationIdOf(request),
    });
    response.status(STATUS_BY_OUTCOME[outcome.status]);
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.transactions.getById(parseUuidParam('transactionId', transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.transactions.getByExternalId(providerId, externalTransactionId);
  }
}
