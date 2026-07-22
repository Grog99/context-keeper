import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitedException } from './rate-limited.exception';

/** Dokłada nagłówek `Retry-After` przed wysłaniem standardowej odpowiedzi 429 Nesta. */
@Catch(RateLimitedException)
export class RateLimitExceptionFilter implements ExceptionFilter {
  catch(exception: RateLimitedException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', String(exception.retryAfterSec));
    res.status(exception.getStatus()).json(exception.getResponse());
  }
}
