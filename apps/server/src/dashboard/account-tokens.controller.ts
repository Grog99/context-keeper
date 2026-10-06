import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  ProjectsService,
  type CreatedToken,
  type PublicTokenRow,
  type RotatedToken,
} from '../projects/projects.service';
import { effectiveTokenStatus, type EffectiveTokenStatus } from '../projects/token-status';
import { UsageService } from '../usage/usage.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';
import { emptyBody, emptyQuery, opaqueId, tokenLabelBody, type TokenLabelBody } from './dashboard.schemas';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Sekcja "Tokeny konta" (`TokenManager`, `scope: account`) — ten sam kształt co `ProjectTokenDto`
 * (publiczny wiersz BEZ `token_hash` + `effectiveStatus` liczony server-side + `searches30d`), z
 * `projectId: null`. `searches30d` sumuje wyszukania ze WSZYSTKICH projektów (patrz
 * `UsageService.countSearchesByAccountTokens`). */
export interface AccountTokenDto extends PublicTokenRow {
  effectiveStatus: EffectiveTokenStatus;
  searches30d: number;
}

/**
 * Tokeny KONTA (roadmap v1.5, ticket #20) — `project_tokens` z `project_id IS NULL`, działają w każdym
 * projekcie instancji (projekt wskazuje nagłówek `X-Context-Keeper-Project`). Lustro tras tokenów
 * projektowych z `ProjectsController` (create / rotate / revoke / relabel) na tych samych metodach
 * `ProjectsService`; audyt (`token_created`/`rotated`/`revoked`/`relabeled`) dopisany TUTAJ, z
 * `metadata.scope: 'account'` i BEZ `projectId` — filtr audytu po projekcie nie łapie tych wpisów.
 *
 * Ownership check (`assertAccountToken`): `:tokenId` w URL nie implikuje, że to token konta — bez tej
 * kontroli ta ścieżka pozwalałaby rotować/unieważniać/przemianować token PROJEKTOWY (i odwrotnie
 * `assertTokenBelongsToProject` pilnuje drugiej strony). Plaintext tokenu wraca WYŁĄCZNIE z POST
 * (create) i POST rotate — `GET` używa jawnej projekcji kolumn bez `token_hash`.
 *
 * Walidacja jak w reszcie `dashboard/*.controller.ts` — `ZodValidationPipe` per argument.
 */
@Controller('api/account-tokens')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class AccountTokensController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  /** Lista + `effectiveStatus`/`searches30d` liczone server-side. */
  @Get()
  async list(
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
  ): Promise<AccountTokenDto[]> {
    const now = new Date();
    const since = new Date(now.getTime() - THIRTY_DAYS_MS);
    const [tokens, searches30d] = await Promise.all([
      this.projects.listAccountTokens(),
      this.usage.countSearchesByAccountTokens(since),
    ]);
    return tokens.map((token) => ({
      ...token,
      effectiveStatus: effectiveTokenStatus(token, now),
      searches30d: searches30d.get(token.id) ?? 0,
    }));
  }

  /** Nowy token konta (etykieta WYMAGANA, walidowana w serwisie) — plaintext zwracany raz. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(tokenLabelBody)) body: TokenLabelBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
  ): Promise<CreatedToken> {
    const created = await this.projects.createAccountToken(body.label);
    await this.audit.log({
      eventType: 'token_created',
      actor: DASHBOARD_ACTOR,
      metadata: { scope: 'account', tokenId: created.tokenRow.id, label: created.tokenRow.label },
    });
    return created;
  }

  /** Graceful rotation — jak tokeny projektowe (stary w `grace`, nowy od razu aktywny). */
  @Post(':tokenId/rotate')
  async rotate(
    @Param('tokenId', new ZodValidationPipe(opaqueId)) tokenId: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never>,
  ): Promise<RotatedToken> {
    await this.assertAccountToken(tokenId);
    const rotated = await this.projects.rotateToken(tokenId);
    await this.audit.log({
      eventType: 'token_rotated',
      actor: DASHBOARD_ACTOR,
      metadata: {
        scope: 'account',
        oldTokenId: rotated.previousTokenRow.id,
        oldLabel: rotated.previousTokenRow.label,
        newTokenId: rotated.tokenRow.id,
        newLabel: rotated.tokenRow.label,
        graceExpiresAt: rotated.previousTokenRow.expiresAt,
      },
    });
    return rotated;
  }

  /** Unieważnienie natychmiastowe — działa na `active` I `grace`, idempotentne. */
  @Post(':tokenId/revoke')
  async revoke(
    @Param('tokenId', new ZodValidationPipe(opaqueId)) tokenId: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never>,
  ): Promise<PublicTokenRow> {
    await this.assertAccountToken(tokenId);
    const revoked = await this.projects.revokeToken(tokenId);
    await this.audit.log({
      eventType: 'token_revoked',
      actor: DASHBOARD_ACTOR,
      metadata: { scope: 'account', tokenId: revoked.id, label: revoked.label },
    });
    return revoked;
  }

  /** Rename etykiety, dozwolony niezależnie od statusu tokena. */
  @Patch(':tokenId')
  async updateLabel(
    @Param('tokenId', new ZodValidationPipe(opaqueId)) tokenId: string,
    @Body(new ZodValidationPipe(tokenLabelBody)) body: TokenLabelBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>,
  ): Promise<PublicTokenRow> {
    const before = await this.assertAccountToken(tokenId);
    const updated = await this.projects.updateTokenLabel(tokenId, body.label);
    await this.audit.log({
      eventType: 'token_relabeled',
      actor: DASHBOARD_ACTOR,
      metadata: { scope: 'account', tokenId, oldLabel: before.label, newLabel: updated.label },
    });
    return updated;
  }

  /** Zwraca znaleziony wiersz (wołający oszczędza drugie zapytanie — `updateLabel` potrzebuje starej
   * etykiety do audytu). Token PROJEKTOWY pod tym `:tokenId` → 404, mutacja nigdy nie wywołana. */
  private async assertAccountToken(tokenId: string): Promise<PublicTokenRow> {
    const tokens = await this.projects.listAccountTokens();
    const found = tokens.find((t) => t.id === tokenId);
    if (!found) {
      throw new NotFoundException(`Token konta nie istnieje: ${tokenId}`);
    }
    return found;
  }
}
