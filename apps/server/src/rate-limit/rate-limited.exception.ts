import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Błąd transportu (§5 tech-stack, FR-M7) — NIE koperta narzędzia MCP (`isError`), tylko HTTP 429
 * + `Retry-After`. Rzucany przez `McpRateLimitGuard`, obsługiwany przez `RateLimitExceptionFilter`.
 */
export class RateLimitedException extends HttpException {
  constructor(public readonly retryAfterSec: number) {
    super(
      {
        error: 'rate_limited',
        message: `Zbyt wiele żądań — spróbuj ponownie za ${retryAfterSec}s.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
