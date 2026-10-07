import { z } from 'zod';
import { auditEventType, memoryKind, memoryScope, memoryStatus, proposalOrigin, proposalStatus, proposalType, relationType } from '../db/schema/enums';
import { AUDIT_QUERY_MAX_LIMIT } from '../audit/audit.service';
import { AUTO_MODE_MAX_DAILY_LIMIT } from '../db/schema/projects';
import { decodeKeysetCursor } from '../common/keyset-cursor';
import {
  LLM_CALL_CAP_MAX,
  LLM_CALL_CAP_MIN,
  LLM_SCAN_WINDOW_MAX_DAYS,
  LLM_SCAN_WINDOW_MIN_DAYS,
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_MIN_MS,
} from '../llm/llm.constants';
import { isValidLlmEndpointUrl } from '../llm/llm-settings.service';
import { HEADER_MAX_LEN } from '../memory/validation';
import { LIST_SCOPES } from '../memory/memory-admin.service';
import { PROPOSALS_LIST_MAX_LIMIT } from '../proposals/proposals.service';
import { USAGE_BUCKETS } from '../usage/usage.service';

/**
 * Schematy zod dla `@Query()`/`@Param()`/`@Body()` całego `dashboard/*.controller.ts` (tech-review
 * #3 „JSON API dashboardu bez walidacji runtime", roadmap v1.4) — jedno miejsce, spięte z
 * `ZodValidationPipe` (`common/zod-validation.pipe.ts`) w kontrolerach. Wartości enumów WYŁĄCZNIE
 * z `db/schema/enums.ts`/serwisów (`.enumValues`, `LIST_SCOPES`, `USAGE_BUCKETS`) — nigdy ręcznie
 * przepisane literały (§Approach planu).
 *
 * Serwisy dalej robią WŁASNĄ walidację (cross-field, config-dependent, dzieloną z CLI/MCP) — ten
 * plik pokrywa wyłącznie kształt/typ/enum/strictness na granicy HTTP, PRZED wejściem w serwis.
 */

// ---- prymitywy ----------------------------------------------------------

/** Pokrywa każdy `generateId()` (`prefix_[0-9a-z]{12}`, §common/ids.ts) ORAZ legacy `tok_<md5hex>`
 * id z migracji 0010 (SQL-owy `md5(...)`, bez `generateId`) — celowo BEZ sprawdzania prefiksu, więc
 * dobrze uformowane, ale nieistniejące id i tak dostaje 404 `not_found` z serwisu, nie 400 stąd. */
export const opaqueId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** SPA zawsze wysyła `Date.toISOString()` (offset `Z`) — `{offset: true}` dopuszcza też inne
 * strefy, dla klientów spoza SPA (curl, przyszły automation). */
export const isoDateTime = z.iso.datetime({ offset: true });
/** Wersja transformowana do `Date` — dla pól, które serwis przyjmuje już jako `Date`
 * (`AuditService.query({from,to})`, `UsageService.searchSeries({from,to})`). `cursor` list (audyt,
 * propozycje) to NIE ISO, tylko opaque kursor keyset — patrz `keysetCursorQuery`. */
export const isoDateQuery = isoDateTime.transform((s) => new Date(s));

/** Opaque kursor keyset `(created_at, id)` (nightly-scale G6) — wspólny dla `GET /api/audit` i
 * `GET /api/proposals`. Dociera do serwisu już zdekodowany do `{ ts, id }`; dowolny input, który nie
 * jest dokładnie kursorem z `encodeKeysetCursor` (w tym stare ISO `createdAt`), -> 400. */
export const keysetCursorQuery = z
  .string()
  .max(256)
  .transform((s, ctx) => {
    const pos = decodeKeysetCursor(s);
    if (!pos) {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
      return z.NEVER;
    }
    return pos;
  });

/** Regex (NIE `z.coerce.number()`) — odrzuca `1e2`, `0x10`, `5.5`, wiodące zera po prostu jako
 * inny string, `abc`; tylko czyste cyfry ASCII przechodzą do `Number`. */
export function limitQuery(max: number) {
  return z
    .string()
    .regex(/^\d{1,4}$/)
    .transform((s) => Number(s))
    .pipe(z.number().int().min(1).max(max));
}

/** Express 5 „simple" query parser: `?tags=a` -> string, `?tags=a&tags=b` -> string[]. Dla pól
 * skalarnych (nie ten typ) powtórzony klucz daje tablicę -> nie przejdzie schematu skalarnego ->
 * 400 (zamierzone, §Risks planu). */
export const stringOrArray = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

/** Express 5 zostawia `req.body` jako `undefined`, gdy klient nie wysłał ciała (żadnego
 * `Content-Type`) — użyj WYŁĄCZNIE tam, gdzie body jest w całości opcjonalne (`{}`/pominięte oba
 * przechodzą, każdy nadmiarowy klucz nadal 400 dzięki `z.strictObject`). */
export function optionalBody<S extends z.ZodType>(schema: S) {
  return z.preprocess((v) => v ?? {}, schema);
}

/** Q1 (resolved) — STRICT EVERYWHERE: każdy handler dashboardu dostaje pipe na query, nawet gdy nie
 * przyjmuje żadnych filtrów (`GET /api/config`, `/api/metrics`, `/api/projects`, …) — nieznany klucz
 * query zawsze 400, nie ciche zignorowanie. */
export const emptyQuery = z.strictObject({});
/** Q1 (resolved) — analogicznie dla body na bezciałowych POST/PATCH/DELETE (archive/promote/
 * rotate/revoke/nightly-run/removeRelation): `undefined` i `{}` przechodzą, każdy klucz -> 400. */
export const emptyBody = optionalBody(z.strictObject({}));

// ---- GET /api/memories ---------------------------------------------------

export const memoriesListQuery = z.strictObject({
  scope: z.enum(LIST_SCOPES).optional(),
  projectId: opaqueId.optional(),
  kind: z.enum(memoryKind.enumValues).optional(),
  status: z.enum(memoryStatus.enumValues).optional(),
  tags: stringOrArray.optional(),
  q: z.string().max(HEADER_MAX_LEN).optional(),
  // Filtr „auto-zaakceptowane" (roadmap v1.6, A2, G6) — tylko literał 'true' (brak filtra = param pominięty).
  autoApproved: z
    .literal('true')
    .transform(() => true as const)
    .optional(),
});
export type MemoriesListQuery = z.output<typeof memoriesListQuery>;

// ---- GET /api/memories/events --------------------------------------------

export const memoryEventsQuery = z.strictObject({
  scope: z.enum(LIST_SCOPES).optional(),
  projectId: opaqueId.optional(),
});
export type MemoryEventsQuery = z.output<typeof memoryEventsQuery>;

// ---- POST /api/memories/:id/relations ------------------------------------

export const createRelationBody = z.strictObject({
  toId: opaqueId,
  type: z.enum(relationType.enumValues),
});
export type CreateRelationBody = z.output<typeof createRelationBody>;

// ---- POST /api/memories ---------------------------------------------------

export const humanCreateBody = z.strictObject({
  kind: z.enum(memoryKind.enumValues),
  header: z.string(),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(memoryScope.enumValues),
  projectId: opaqueId.nullable().optional(),
  // Wymagany gdy `kind='event'` (roadmap v1.2) — parsowanie/walidacja zostaje w `validateEventTime`
  // (Q6 resolved: leniwe jak MCP, pipe nie duplikuje reguły).
  eventTime: z.string().optional(),
});
export type HumanCreateBody = z.output<typeof humanCreateBody>;

// ---- PATCH /api/memories/:id ----------------------------------------------

export const editMemoryBody = z.strictObject({
  header: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  eventTime: z.string().optional(),
});
export type EditMemoryBody = z.output<typeof editMemoryBody>;

// ---- POST /api/memories/:id/purge ------------------------------------------

/** `reason` WYMAGANY na poziomie kształtu (string) — pusty-po-trim string dalej odrzucany przez
 * `PurgeService.purge` (§Risks planu, "nie duplikujemy" walidacji serwisu). */
export const purgeBody = z.strictObject({ reason: z.string() });
export type PurgeBody = z.output<typeof purgeBody>;

// ---- GET /api/audit ---------------------------------------------------------

export const auditListQuery = z.strictObject({
  eventType: z.enum(auditEventType.enumValues).optional(),
  from: isoDateQuery.optional(),
  to: isoDateQuery.optional(),
  projectId: opaqueId.optional(),
  limit: limitQuery(AUDIT_QUERY_MAX_LIMIT).optional(),
  cursor: keysetCursorQuery.optional(),
});
export type AuditListQuery = z.output<typeof auditListQuery>;

// ---- GET /api/proposals ------------------------------------------------------

export const proposalsListQuery = z.strictObject({
  status: z.enum(proposalStatus.enumValues).optional(),
  origin: z.enum(proposalOrigin.enumValues).optional(),
  type: z.enum(proposalType.enumValues).optional(),
  projectId: opaqueId.optional(),
  scope: z.enum(LIST_SCOPES).optional(),
  limit: limitQuery(PROPOSALS_LIST_MAX_LIMIT).optional(),
  cursor: keysetCursorQuery.optional(),
});
export type ProposalsListQuery = z.output<typeof proposalsListQuery>;

// ---- POST /api/proposals/bulk-approve|bulk-reject -----------------------------

/** Bez per-item regexu na `ids` (samo `z.string()`) — `normalizeBulkIds` (§ProposalsService)
 * dalej robi trim/dedupe/pusty-string/`BULK_MAX_IDS`, więc partial-success semantyka bulku (jeden
 * zły id -> `failed[]` dla TEGO itemu, nie 400 całości) zostaje nietknięta. */
export const bulkApproveBody = z.strictObject({ ids: z.array(z.string()) });
export type BulkApproveBody = z.output<typeof bulkApproveBody>;

export const bulkRejectBody = z.strictObject({ ids: z.array(z.string()), reason: z.string().optional() });
export type BulkRejectBody = z.output<typeof bulkRejectBody>;

// ---- POST /api/proposals/:id/approve|reject -----------------------------------

export const approveBody = optionalBody(
  z.strictObject({
    supersedes: opaqueId.optional(),
    expectedSupersedeVersion: z.number().int().min(0).optional(),
  }),
);
export type ApproveBody = z.output<typeof approveBody>;

export const rejectBody = optionalBody(z.strictObject({ reason: z.string().optional() }));
export type RejectBody = z.output<typeof rejectBody>;

// ---- PATCH /api/proposals/:id ---------------------------------------------------

export const editProposalBody = z.strictObject({
  header: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type EditProposalBody = z.output<typeof editProposalBody>;

// ---- POST /api/projects ------------------------------------------------------------

/** Zastępuje ręczny `body?.name?.trim()`/`if (!name)` w kontrolerze — `.trim().min(1)` daje 400
 * PRZED wejściem w serwis, dokładnie ten sam efekt. Tab/CR/LF w nazwie odrzucane (roadmap v1.5):
 * `list-projects` (CLI) to TSV parsowany przez `install.sh` po polu 3 — nazwa z tabulatorem przesunęłaby
 * kolumny. `slug` opcjonalny (tylko kształt; format/unikalność egzekwuje `ProjectsService`, jak przy
 * `tokenLabelBody`) — bez niego slug wyprowadzany z nazwy. */
export const createProjectBody = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\t\r\n]*$/, 'Project name must not contain tabs or line breaks'),
  tokenLabel: z.string().optional(),
  slug: z.string().max(200).optional(),
});
export type CreateProjectBody = z.output<typeof createProjectBody>;

// ---- PATCH /api/projects/:id --------------------------------------------------------

/** `slug` — tylko kształt (string ≤200); normalizacja, format i unikalność w `ProjectsService.updateSlug`. */
export const updateProjectBody = z.strictObject({
  includeEventsInDefaultSearch: z.boolean().optional(),
  slug: z.string().max(200).optional(),
  // Auto mode (roadmap v1.6, A2): przełącznik i dzienny limit auto-akceptacji (1..10000, całkowity).
  autoMode: z.boolean().optional(),
  autoModeDailyLimit: z.number().int().min(1).max(AUTO_MODE_MAX_DAILY_LIMIT).optional(),
});
export type UpdateProjectBody = z.output<typeof updateProjectBody>;

// ---- POST /api/projects/:id/tokens, PATCH .../tokens/:tokenId ------------------------

/** `label` wymagany na poziomie kształtu (string, nawet pusty) — `normalizeTokenLabel` (serwis)
 * dalej egzekwuje trim/niepustość/charset/długość. */
export const tokenLabelBody = z.strictObject({ label: z.string() });
export type TokenLabelBody = z.output<typeof tokenLabelBody>;

// ---- GET /api/metrics/usage ------------------------------------------------------------

export const usageQuery = z.strictObject({
  from: isoDateQuery.optional(),
  to: isoDateQuery.optional(),
  bucket: z.enum(USAGE_BUCKETS).optional(),
  projectId: opaqueId.optional(),
});
export type UsageQuery = z.output<typeof usageQuery>;

// ---- PUT /api/settings/llm ----------------------------------------------------------

/**
 * Ustawienia kroku LLM (roadmap v1.6) — pełny stan formularza + akcja na kluczu API. `endpoint`/`model`:
 * pusty string -> `null` robi serwis (`LlmSettingsService`); niepusty endpoint musi być URL-em http(s) bez
 * loginu i hasła. Spójność (włączony ⇒ endpoint i model, G14) i obecność `SECRETS_ENCRYPTION_KEY` (G5)
 * egzekwuje serwis. `apiKey` to write-only unia: `keep` (domyślnie z formularza) | `set` z wartością |
 * `clear`. `ZodValidationPipe` nie cytuje wejścia w komunikatach, więc klucz nie wycieka w 400.
 */
export const llmSettingsBody = z.strictObject({
  enabled: z.boolean(),
  endpoint: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === '' || isValidLlmEndpointUrl(v), 'Endpoint must be an http(s) URL without credentials')
    .nullable(),
  model: z.string().trim().max(200).nullable(),
  callCap: z.number().int().min(LLM_CALL_CAP_MIN).max(LLM_CALL_CAP_MAX),
  timeoutMs: z.number().int().min(LLM_TIMEOUT_MIN_MS).max(LLM_TIMEOUT_MAX_MS),
  scanWindowDays: z.number().int().min(LLM_SCAN_WINDOW_MIN_DAYS).max(LLM_SCAN_WINDOW_MAX_DAYS),
  apiKey: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('keep') }),
    z.strictObject({ action: z.literal('set'), value: z.string().trim().min(1).max(4096) }),
    z.strictObject({ action: z.literal('clear') }),
  ]),
});
export type LlmSettingsBody = z.output<typeof llmSettingsBody>;
