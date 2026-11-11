import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, InvalidRequestError, type ApplicationErrorKind } from '../../application/errors';
import { DomainError } from '../../domain/errors';
import { Logger } from '../../observability/logger';

/**
 * Mapeamento único de erro -> HTTP, igual em todos os endpoints:
 *
 *   400 payload inválido            (INVALID_REQUEST, INVALID_MONEY, INVALID_AMOUNT, REFERENCE_REQUIRED, ...)
 *   404 recurso inexistente         (WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND)
 *   409 conflito                    (IDEMPOTENCY_CONFLICT, DUPLICATE_EXTERNAL_TRANSACTION, WALLET_ALREADY_EXISTS)
 *   503 falha transitória           (TRANSIENT_FAILURE, LOCK_TIMEOUT) + Retry-After: reenviar é seguro
 *   500 erro inesperado             (INTERNAL_ERROR)
 *
 * Rejeição por regra de negócio (422) e aceite pendente (202) não são exceções: são resultados
 * da transação, devolvidos pelo controller com o corpo completo.
 */
const STATUS_BY_KIND: Record<ApplicationErrorKind, HttpStatus> = {
  INVALID: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  TRANSIENT: HttpStatus.SERVICE_UNAVAILABLE,
};

const RETRY_AFTER_SECONDS = '1';

interface ErrorBody {
  error: { code: string; message: string; details?: readonly string[] };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApplicationError) {
      const details = exception instanceof InvalidRequestError && exception.details.length > 0 ? exception.details : undefined;
      if (exception.kind === 'TRANSIENT') {
        this.logger.warn('Transient failure', { code: exception.code }, exception.cause ?? exception);
      }
      return {
        status: STATUS_BY_KIND[exception.kind],
        body: { error: { code: exception.code, message: exception.message, ...(details ? { details } : {}) } },
      };
    }
    if (exception instanceof DomainError) {
      return { status: HttpStatus.BAD_REQUEST, body: { error: { code: exception.code, message: exception.message } } };
    }
    if (exception instanceof HttpException) {
      // Erros do próprio Nest/Express, ex.: JSON malformado (400) ou rota inexistente (404).
      const status = exception.getStatus();
      const code = status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      return { status, body: { error: { code, message: exception.message } } };
    }
    this.logger.error('Unhandled error', {}, exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } },
    };
  }
}
