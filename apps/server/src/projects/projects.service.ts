import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { isUniqueViolation } from '../common/pg-errors';
import { generateToken, hashToken, isValidTokenFormat } from '../common/tokens';
import { AppConfigService } from '../config/config.service';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { memories, projectTokens, projects, type ProjectRow, type ProjectTokenRow } from '../db/schema';
import { tokenScopeOf, type TokenScope } from './project-scope';
import { insertProject } from './project-rows';
import { ProjectSlugService } from './project-slug.service';
import { assertValidProjectSlug, normalizeProjectSlugInput } from './slug';
import { normalizeTokenLabel } from './token-status';

/** Etykieta pierwszego tokena gdy operator nie poda własnej (`createProject`/CLI/dashboard "Nowy projekt"). */
export const DEFAULT_TOKEN_LABEL = 'default';

// Coalescing throttle dla `touchTokenUsage` (D3 planu) — ≤1 UPDATE per token per 60s, best-effort,
// nigdy na krytycznej ścieżce auth (fire-and-forget, patrz `touchTokenUsage`).
const LAST_USED_THROTTLE_MS = 60_000;

/** Kontekst projektu wyprowadzony z bearer tokena (dołączany do requestu przez BearerGuard).
 * `includeEventsInDefaultSearch` opcjonalne (roadmap v1.2, "kind=event episodic") — żeby ręcznie
 * budowane `ProjectContext` w testach dalej się kompilowały bez tego pola; `undefined` ⇒ wyłączone
 * (patrz `MemoryService.search`). `tokenId`/`tokenLabel` opcjonalne z tego samego powodu (roadmap
 * v1.3, "Wiele tokenów per projekt + graceful rotation") — atrybucja per-agent w `audit_log.metadata`
 * i `search_events.token_id` (§memory/memory.service.ts `attribution`). */
export interface ProjectContext {
  projectId: string;
  projectName: string;
  includeEventsInDefaultSearch?: boolean;
  tokenId?: string;
  tokenLabel?: string;
}

/** Para (tokenId, tokenLabel) — kształt atrybucji niesionej w `ProjectContext`, wydzielony jako
 * osobny typ dla miejsc, które chcą go przekazywać/przyjmować bez reszty `ProjectContext`. */
export interface TokenContext {
  tokenId: string;
  tokenLabel: string;
}

/** Wynik utworzenia projektu: projekt + jego pierwszy token. Pełny `ck_…` widoczny TYLKO raz
 * (w bazie zostaje hash — `tokenRow` NIE niesie `tokenHash`, patrz `toPublicTokenRow`). */
export interface CreatedProject {
  project: ProjectRow;
  token: string;
  tokenRow: PublicTokenRow;
}

/** Wynik `createToken`/`rotateToken`: nowy token widoczny RAZ + jego publiczny wiersz. */
export interface CreatedToken {
  token: string;
  tokenRow: PublicTokenRow;
}

/** `rotateToken` zwraca też stary wiersz (teraz w `grace`) — kontroler go potrzebuje do audytu
 * (`token_rotated` niesie old+new ids/labels/grace expiry, §F planu). */
export interface RotatedToken extends CreatedToken {
  previousTokenRow: PublicTokenRow;
}

/** Zgrupowane liczniki tokenów per projekt (badge w `ProjectsScreen`, §F/H planu). `grace` liczony
 * z LIVE `expires_at > now()` — wiersz w `grace` po wygaśnięciu przestaje być liczony tutaj jako
 * "grace" (jest już efektywnie `expired`, patrz `token-status.ts`), mimo że w DB wciąż ma
 * `status='grace'` (brak nocnego sweepu, §Approach planu). */
export interface TokenCounts {
  active: number;
  grace: number;
  revoked: number;
}

/** Projekcja `project_tokens` BEZ `token_hash` — jedyny kształt, jaki serwis zwraca wołającym poza
 * samym momentem mintowania (gdzie i tak zwracamy tylko plaintext `token`, nigdy hash). Egzekwuje
 * "sekret nigdy nie opuszcza serwisu" na poziomie typu, nie tylko konwencji. */
export type PublicTokenRow = Omit<ProjectTokenRow, 'tokenHash'>;

const TOKEN_ROW_COLUMNS = {
  id: projectTokens.id,
  projectId: projectTokens.projectId,
  label: projectTokens.label,
  status: projectTokens.status,
  createdAt: projectTokens.createdAt,
  graceStartedAt: projectTokens.graceStartedAt,
  expiresAt: projectTokens.expiresAt,
  revokedAt: projectTokens.revokedAt,
  lastUsedAt: projectTokens.lastUsedAt,
} as const;

function toPublicTokenRow(row: ProjectTokenRow): PublicTokenRow {
  const { tokenHash: _tokenHash, ...rest } = row;
  return rest;
}

/** Wynik `lookupToken`: token + projekt (NULL dla tokenu konta, `project_tokens.project_id IS NULL`).
 * Scope tokenu rozstrzyga `token.projectId === null`, nie samo "brak wiersza projektu". */
export interface TokenLookup {
  token: PublicTokenRow;
  project: ProjectRow | null;
}

/** Ile razy `createProject` powtarza całą transakcję po wyścigu o slug (23505 na `projects_slug_key`). */
const SLUG_RETRY_ATTEMPTS = 5;

/** Nazwa partial unique indexu etykiety aktywnych tokenów dla danego scope'u — `23505` na innym
 * indeksie (np. `project_tokens_token_hash_key`) NIE jest kolizją etykiety i ma propagować. */
function labelIndexFor(scope: TokenScope): string {
  return scope === 'account' ? 'project_tokens_account_label_active_key' : 'project_tokens_project_label_active_key';
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly lastUsedThrottle = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly slugs: ProjectSlugService,
  ) {}

  /**
   * Predykat "token usable" (§Approach planu "Why lazy expiry"): `active` ZAWSZE, `grace` tylko
   * dopóki `expires_at` w przyszłości. DB clock (`now()`), NIE app clock — auth i granica karencji
   * muszą się zgadzać niezależnie od zegara procesu Node. MUSI dawać identyczny wynik co
   * `effectiveTokenStatus` w `token-status.ts` (integration test na granicy, §J planu).
   */
  private usableTokenCondition() {
    return or(
      eq(projectTokens.status, 'active'),
      and(eq(projectTokens.status, 'grace'), gt(projectTokens.expiresAt, sql`now()`)),
    );
  }

  /**
   * Projekt + pierwszy token, jedna transakcja (ręczne "Nowy projekt" z dashboardu/CLI dalej mintuje
   * pierwszy token). Projekt BEZ tokena powstaje wyłącznie przy approve propozycji `create_project`
   * (`insertProject` w `project-rows.ts`, ticket #15) — tamtejszy agent z tokenem konta tokena projektu nie potrzebuje.
   *
   * Etykieta pierwszego tokena: `opts.label` (domyślnie `DEFAULT_TOKEN_LABEL`).
   *
   * Slug (roadmap v1.5): bez `opts.slug` wyprowadzany z nazwy (`slugifyProjectName`, fallback
   * `project-<końcówka id>`) i pierwszy wolny kandydat `-2`, `-3`… (zajęty = istniejący projekt ALBO
   * oczekująca propozycja `create_project`). Jawny `opts.slug` jest normalizowany (trim + lowercase),
   * walidowany i NIE dostaje sufiksu — kolizja to `validation_error`. Wyścig o slug (23505 na
   * `projects_slug_key`) powtarza całą transakcję (po błędzie jest już przerwana), max
   * `SLUG_RETRY_ATTEMPTS` razy.
   */
  async createProject(name: string, opts?: { label?: string; slug?: string }): Promise<CreatedProject> {
    const normalizedLabel = normalizeTokenLabel(opts?.label ?? DEFAULT_TOKEN_LABEL);
    const projectId = generateId(ID_PREFIX.project);
    let explicitSlug: string | undefined;
    if (opts?.slug !== undefined) {
      explicitSlug = normalizeProjectSlugInput(opts.slug);
      assertValidProjectSlug(explicitSlug);
      await this.slugs.assertSlugAvailable(explicitSlug);
    }

    for (let attempt = 1; ; attempt++) {
      const slug = explicitSlug ?? (await this.slugs.pickFreeSlug(name, projectId));
      const token = generateToken();
      try {
        return await this.db.transaction(async (tx) => {
          const project = await insertProject(tx, { id: projectId, name, slug });
          const [tokenRow] = await tx
            .insert(projectTokens)
            .values({
              id: generateId(ID_PREFIX.token),
              projectId: project.id,
              tokenHash: hashToken(token),
              label: normalizedLabel,
              status: 'active',
            })
            .returning();
          return { project, token, tokenRow: toPublicTokenRow(tokenRow) };
        });
      } catch (err) {
        if (isUniqueViolation(err, 'projects_slug_key')) {
          if (explicitSlug !== undefined) {
            throw new ToolError('validation_error', `Slug "${slug}" jest już zajęty.`);
          }
          if (attempt < SLUG_RETRY_ATTEMPTS) continue;
        }
        throw err;
      }
    }
  }

  /**
   * Token KONTA (roadmap v1.5, ticket #11) — `project_id = NULL`, działa w każdym projekcie
   * instancji (projekt wskazuje nagłówek). Etykieta wymagana jak dla tokenów projektowych, unikalna
   * wśród AKTYWNYCH tokenów konta (partial unique `project_tokens_account_label_active_key`).
   * Tylko poziom serwisu — endpointy `/api` i komenda CLI to osobny zakres (C).
   */
  async createAccountToken(label: string): Promise<CreatedToken> {
    const normalizedLabel = normalizeTokenLabel(label);
    await this.assertLabelAvailable(null, normalizedLabel);

    const token = generateToken();
    try {
      const [tokenRow] = await this.db
        .insert(projectTokens)
        .values({
          id: generateId(ID_PREFIX.token),
          projectId: null,
          tokenHash: hashToken(token),
          label: normalizedLabel,
          status: 'active',
        })
        .returning();
      return { token, tokenRow: toPublicTokenRow(tokenRow) };
    } catch (err) {
      if (isUniqueViolation(err, labelIndexFor('account'))) {
        throw this.labelCollisionError(normalizedLabel, 'account');
      }
      throw err;
    }
  }

  /** Tokeny konta, najnowsze pierwsze — jawna projekcja kolumn, NIGDY `token_hash`. */
  async listAccountTokens(): Promise<PublicTokenRow[]> {
    return this.db
      .select(TOKEN_ROW_COLUMNS)
      .from(projectTokens)
      .where(isNull(projectTokens.projectId))
      .orderBy(desc(projectTokens.createdAt));
  }

  /**
   * Nowy token obok istniejących (roadmap v1.3) — WYMAGANA etykieta (atrybucja per-agent, locked
   * decision planu §0 pkt 3), unikalna wśród AKTYWNYCH tokenów projektu (partial unique index).
   * Pre-check przed insertem daje czytelny `validation_error` w normalnym przypadku; `23505` złapany
   * jako fallback na wyścig (dwa równoległe requesty z tą samą etykietą).
   */
  async createToken(projectId: string, label: string): Promise<CreatedToken> {
    const normalizedLabel = normalizeTokenLabel(label);
    const project = await this.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
    }
    await this.assertLabelAvailable(projectId, normalizedLabel);

    const token = generateToken();
    try {
      const [tokenRow] = await this.db
        .insert(projectTokens)
        .values({
          id: generateId(ID_PREFIX.token),
          projectId,
          tokenHash: hashToken(token),
          label: normalizedLabel,
          status: 'active',
        })
        .returning();
      return { token, tokenRow: toPublicTokenRow(tokenRow) };
    } catch (err) {
      if (isUniqueViolation(err, labelIndexFor('project'))) {
        throw this.labelCollisionError(normalizedLabel, 'project');
      }
      throw err;
    }
  }

  /**
   * Graceful rotation, TOKEN-scoped (§Approach planu "Rotation is token-scoped, not project-scoped")
   * — jedna transakcja, UPDATE stary wiersz -> `grace` NAJPIERW, INSERT zamiennik DOPIERO POTEM.
   * Ta kolejność jest load-bearing: partial unique index obejmuje wyłącznie `status='active'`, więc
   * UPDATE zwalnia etykietę z indeksu ZANIM insert spróbuje jej użyć — odwrócenie kolejności
   * (insert przed update) trafiłoby we własny wiersz jako kolizję `23505`.
   *
   * `opts.label` opcjonalny — domyślnie dziedziczy etykietę starego tokena (ten sam logiczny agent).
   * Jeśli podano inną etykietę, podlega tej samej regule kolizji co `createToken` (tylko wśród
   * aktywnych — stary wiersz jest już w `grace` w momencie insertu, więc nie koliduje sam ze sobą).
   */
  async rotateToken(tokenId: string, opts?: { label?: string }): Promise<RotatedToken> {
    const graceHours = this.config.get('TOKEN_GRACE_PERIOD_HOURS');
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + graceHours * 60 * 60 * 1000);

      const updated = await tx
        .update(projectTokens)
        .set({ status: 'grace', graceStartedAt: now, expiresAt })
        .where(and(eq(projectTokens.id, tokenId), eq(projectTokens.status, 'active')))
        .returning();

      if (updated.length === 0) {
        // Zero wierszy: rozróżnij not-found vs "istnieje, ale nie jest active" (już grace/revoked).
        const [existing] = await tx.select().from(projectTokens).where(eq(projectTokens.id, tokenId)).limit(1);
        if (!existing) {
          throw new NotFoundException(`Token nie istnieje: ${tokenId}`);
        }
        throw new ToolError(
          'validation_error',
          `Token nie jest aktywny (status=${existing.status}) — nie można rotować. Aktywny token można zrotować tylko raz na cykl.`,
        );
      }

      const oldRow = updated[0];
      const label = opts?.label ? normalizeTokenLabel(opts.label) : oldRow.label;
      if (label !== oldRow.label) {
        await this.assertLabelAvailable(oldRow.projectId, label, undefined, tx);
      }

      const scope = tokenScopeOf(oldRow.projectId);
      const token = generateToken();
      try {
        const [newRow] = await tx
          .insert(projectTokens)
          .values({
            id: generateId(ID_PREFIX.token),
            projectId: oldRow.projectId,
            tokenHash: hashToken(token),
            label,
            status: 'active',
          })
          .returning();
        return {
          token,
          tokenRow: toPublicTokenRow(newRow),
          previousTokenRow: toPublicTokenRow(oldRow),
        };
      } catch (err) {
        if (isUniqueViolation(err, labelIndexFor(scope))) {
          throw this.labelCollisionError(label, scope);
        }
        throw err;
      }
    });
  }

  /**
   * Unieważnienie natychmiastowe (§Approach planu) — działa na `active` I `grace`. Idempotentne:
   * już-`revoked` -> zwraca istniejący wiersz zamiast błędu (powtórne kliknięcie/retry nie jest
   * błędem operatora). Nieznane id -> 404. Synchroniczne z definicji (żaden cache token→projekt nie
   * istnieje, więc UPDATE od razu jest widoczny dla kolejnego lookupu auth).
   */
  async revokeToken(tokenId: string): Promise<PublicTokenRow> {
    const [updated] = await this.db
      .update(projectTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(projectTokens.id, tokenId), ne(projectTokens.status, 'revoked')))
      .returning();
    if (updated) {
      return toPublicTokenRow(updated);
    }
    const [existing] = await this.db.select().from(projectTokens).where(eq(projectTokens.id, tokenId)).limit(1);
    if (!existing) {
      throw new NotFoundException(`Token nie istnieje: ${tokenId}`);
    }
    return toPublicTokenRow(existing); // już revoked — idempotentny zwrot bieżącego stanu
  }

  /**
   * Rename etykiety (roadmap v1.3, w zakresie — §0 pkt 5 planu) — dozwolony NIEZALEŻNIE od statusu
   * tokena (kosmetyczny, nie dotyka `usableTokenCondition()`). Kolizja liczy się TYLKO gdy token
   * będący przedmiotem rename jest sam `active` (partial unique index egzekwuje unikalność wyłącznie
   * wśród `active` — token w `grace`/`revoked` nigdy nie koliduje, bez względu na to, czyją etykietę
   * "zabiera", bo sam nie jest objęty indeksem).
   */
  async updateTokenLabel(tokenId: string, label: string): Promise<PublicTokenRow> {
    const normalizedLabel = normalizeTokenLabel(label);
    const [existing] = await this.db.select().from(projectTokens).where(eq(projectTokens.id, tokenId)).limit(1);
    if (!existing) {
      throw new NotFoundException(`Token nie istnieje: ${tokenId}`);
    }
    if (existing.status === 'active' && normalizedLabel !== existing.label) {
      await this.assertLabelAvailable(existing.projectId, normalizedLabel, tokenId);
    }

    try {
      const [updated] = await this.db
        .update(projectTokens)
        .set({ label: normalizedLabel })
        .where(eq(projectTokens.id, tokenId))
        .returning();
      return toPublicTokenRow(updated);
    } catch (err) {
      const scope = tokenScopeOf(existing.projectId);
      if (isUniqueViolation(err, labelIndexFor(scope))) {
        throw this.labelCollisionError(normalizedLabel, scope);
      }
      throw err;
    }
  }

  /** Tokeny projektu, najnowsze pierwsze — jawna projekcja kolumn, NIGDY `token_hash` (§Risks planu
   * "Secret handling"). */
  async listTokens(projectId: string): Promise<PublicTokenRow[]> {
    return this.db
      .select(TOKEN_ROW_COLUMNS)
      .from(projectTokens)
      .where(eq(projectTokens.projectId, projectId))
      .orderBy(desc(projectTokens.createdAt));
  }

  /** Badge liczników na `ProjectsScreen` (§F/H planu) — jeden zagregowany zapytanie zamiast N+1.
   * `grace` filtrowany LIVE `expires_at > now()` (patrz komentarz przy `TokenCounts`). */
  async countTokensByProject(): Promise<Map<string, TokenCounts>> {
    const rows = await this.db
      .select({
        projectId: projectTokens.projectId,
        active: sql<number>`count(*) FILTER (WHERE ${eq(projectTokens.status, 'active')})::int`,
        grace: sql<number>`count(*) FILTER (WHERE ${projectTokens.status} = 'grace' AND ${projectTokens.expiresAt} > now())::int`,
        revoked: sql<number>`count(*) FILTER (WHERE ${eq(projectTokens.status, 'revoked')})::int`,
      })
      .from(projectTokens)
      .where(isNotNull(projectTokens.projectId)) // tokeny konta nie należą do żadnego projektu
      .groupBy(projectTokens.projectId);
    return new Map(
      rows.map((r) => [r.projectId as string, { active: r.active, grace: r.grace, revoked: r.revoked }]),
    );
  }

  /**
   * `last_used_at` — best-effort, off critical path (§D3 planu, ten sam trade-off co
   * `RateLimiterService`/`LoginThrottleService`): coalesce do ≤1 UPDATE per token per 60s przez
   * in-memory throttle, fire-and-forget (NIGDY awaited na ścieżce auth — `BearerGuard` woła to bez
   * `await`). Awaria UPDATE-u jest złapana i zalogowana, nigdy nie propagowana — dokładnie jak
   * `MemoryService.recordSearchSafe`.
   */
  touchTokenUsage(tokenId: string): void {
    const now = Date.now();
    const last = this.lastUsedThrottle.get(tokenId);
    if (last !== undefined && now - last < LAST_USED_THROTTLE_MS) return;
    this.lastUsedThrottle.set(tokenId, now);
    this.db
      .update(projectTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(projectTokens.id, tokenId))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[projects] touchTokenUsage nie powiódł się (fail-open): ${message}`);
      });
  }

  async listProjects(): Promise<ProjectRow[]> {
    return this.db.select().from(projects).orderBy(projects.createdAt);
  }

  /** Dialog szczegółów projektu (roadmap v1.2, "kind=event episodic") — dziś jedyne edytowalne pole
   * jest `includeEventsInDefaultSearch`; kontroler audytuje zmianę (`project_settings_changed`),
   * serwis sam nie audytuje (wzorem `createProject`/`rotateToken`, §M1 planu Fazy 5).
   * `updates.includeEventsInDefaultSearch === undefined` (pole pominięte w body) → no-op zwracający
   * bieżący wiersz, bez uderzania w `UPDATE` (`drizzle`'s `mapUpdateSet` rzuca "No values to set"
   * na pustym obiekcie `.set()`, więc filtrujemy `undefined` PRZED złożeniem zapytania). */
  async updateProject(
    projectId: string,
    updates: { includeEventsInDefaultSearch?: boolean },
  ): Promise<ProjectRow> {
    if (updates.includeEventsInDefaultSearch === undefined) {
      const current = await this.findById(projectId);
      if (!current) {
        throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
      }
      return current;
    }
    const [project] = await this.db
      .update(projects)
      .set({ includeEventsInDefaultSearch: updates.includeEventsInDefaultSearch })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) {
      throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
    }
    return project;
  }

  /** Liczba pamięci per projekt (§M1 planu Fazy 5, dashboard FR-D3) — jeden zagregowany zapytanie
   * zamiast N+1 per wiersz listy projektów. */
  async countMemoriesByProject(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ projectId: memories.projectId, count: sql<number>`count(*)::int` })
      .from(memories)
      .where(isNotNull(memories.projectId))
      .groupBy(memories.projectId);
    return new Map(rows.map((r) => [r.projectId as string, r.count]));
  }

  async findById(projectId: string): Promise<ProjectRow | null> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Lookup tokenu (§10, roadmap v1.3/v1.5) — główne wejście auth `BearerGuard`: jeden trafiony indeks
   * po `token_hash` (SHA-256) + `usableTokenCondition()` w tym samym zapytaniu, więc revocation i
   * wygasanie grace są synchroniczne z auth, bez osobnego kroku/cache. LEFT JOIN `projects`: token
   * konta (`project_id IS NULL`) zwraca `project: null`. Bez constant-time compare (token
   * wysokoentropijny, lookup indeksowany).
   */
  async lookupToken(token: string): Promise<TokenLookup | null> {
    if (!isValidTokenFormat(token)) return null;
    const [row] = await this.db
      .select({ project: projects, token: TOKEN_ROW_COLUMNS })
      .from(projectTokens)
      .leftJoin(projects, eq(projects.id, projectTokens.projectId))
      .where(and(eq(projectTokens.tokenHash, hashToken(token)), this.usableTokenCondition()))
      .limit(1);
    return row ?? null;
  }

  /**
   * Kompatybilny wrapper nad `lookupToken` — TYLKO dla tokenów projektowych (zwraca `null` dla
   * tokenu konta, który nie ma "swojego" projektu). Sygnatura bez zmian, żeby istniejące testy
   * (e2e/integration) działały nietknięte. To NIE jest wejście auth — guard używa `lookupToken`.
   */
  async resolveByToken(token: string): Promise<{ project: ProjectRow; token: PublicTokenRow } | null> {
    const found = await this.lookupToken(token);
    if (!found || found.project === null) return null;
    return { project: found.project, token: found.token };
  }

  /** Kolizja etykiety wśród aktywnych tokenów projektu (albo tokenów konta) — komunikat dzielony
   * przez `createToken`/`createAccountToken`/`rotateToken`/`updateTokenLabel` (pre-check ORAZ
   * `23505` fallback). */
  private labelCollisionError(label: string, scope: TokenScope): ToolError {
    return new ToolError(
      'validation_error',
      scope === 'account'
        ? `Etykieta "${label}" jest już użyta przez aktywny token konta.`
        : `Etykieta "${label}" jest już użyta przez aktywny token tego projektu.`,
    );
  }

  /** `projectId === null` → unikalność wśród aktywnych tokenów KONTA (`project_id IS NULL`). */
  private async assertLabelAvailable(
    projectId: string | null,
    label: string,
    excludeTokenId?: string,
    executor: Database | Tx = this.db,
  ): Promise<void> {
    const conditions = [
      projectId === null ? isNull(projectTokens.projectId) : eq(projectTokens.projectId, projectId),
      eq(projectTokens.label, label),
      eq(projectTokens.status, 'active'),
    ];
    if (excludeTokenId) conditions.push(ne(projectTokens.id, excludeTokenId));
    const [existing] = await executor
      .select({ id: projectTokens.id })
      .from(projectTokens)
      .where(and(...conditions))
      .limit(1);
    if (existing) {
      throw this.labelCollisionError(label, tokenScopeOf(projectId));
    }
  }
}
