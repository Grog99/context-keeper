import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, ne } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { generateId, ID_PREFIX } from '../common/ids';
import { idsAny } from '../common/sql-helpers';
import { AppConfigService } from '../config/config.service';
import { DB, PG_POOL, type Database, type PgPool } from '../db/db.tokens';
import { embeddings, memories, proposals, stagingEmbeddings } from '../db/schema';
import type { MemoryKind, MemoryScope } from '../db/schema/enums';
import { findAnnNeighbors } from '../embeddings/ann-search';
import { EmbeddingService } from '../embeddings/embedding.service';
import { LlmRunBudget } from '../llm/llm-budget';
import { LlmService } from '../llm/llm.service';
import { EMPTY_LLM_COUNTERS, type NightlyLlmReport } from '../llm/llm.types';
import { computeStaleIds } from '../proposals/proposals.service';
import { isConflictPayload, isLlmDetectedPayload } from '../proposals/proposals.types';
import { UsageService } from '../usage/usage.service';
import { buildClusters, pickCanonicalMerge, type NeighborPair } from './dedup-cluster';
import { runLlmConflicts, selectConflictPairs } from './llm-conflicts';
import { runLlmPrune } from './llm-prune';
import { llmWindowStart, selectWindowFacts } from './llm-window';
import {
  conditionKey,
  EMPTY_LLM_CONFLICT_COUNTERS,
  EMPTY_LLM_PRUNE_COUNTERS,
  PRUNE_SCORER,
  type DetectedCondition,
  type NightlyConditionType,
  type NightlyCounters,
  type NightlyRunResult,
  type PruneScorer,
  type PruneThresholds,
} from './nightly.types';
import { reconcile, type ExistingNightlyProposal } from './reconcile';

/**
 * Klucz advisory locka (plan §1 "Advisory lock") — stała, arbitralna wartość zarezerwowana
 * WYŁĄCZNIE dla nocnego joba (jeden globalny namespace `pg_try_advisory_lock` na całą instancję
 * Postgresa, nigdy nie reużywać dla innego mechanizmu). Session-level lock: żyje na dedykowanym
 * kliencie z `PG_POOL`, ginie automatycznie razem z połączeniem przy crashu/kill — bez potrzeby
 * ręcznego sprzątania zawieszonego locka.
 */
export const NIGHTLY_LOCK_KEY = 87_942_611;

const EMPTY_COUNTERS: NightlyCounters = {
  created: 0,
  withdrawn: 0,
  skippedAsDup: 0,
  mergeProposed: 0,
  pruneProposed: 0,
  skippedPoliteness: 0,
  skippedCap: 0,
  searchEventsPruned: 0,
  ...EMPTY_LLM_COUNTERS,
  ...EMPTY_LLM_PRUNE_COUNTERS,
  ...EMPTY_LLM_CONFLICT_COUNTERS,
};

const DAY_MS = 24 * 60 * 60_000;

interface FactRow {
  id: string;
  version: number;
  scope: MemoryScope;
  projectId: string | null;
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
  accessCount: number;
  createdAt: Date;
  lastAccessedAt: Date | null;
  /** Wektor aktywnego modelu (LEFT JOIN embeddings w `loadApprovedFacts`) — `null`, gdy fakt nie ma
   * jeszcze embeddingu dla `activeModel` (np. nie przeliczony przez `reembed`). Fakt bez wektora jest
   * WCIĄŻ obecny w `facts` (nadal kandyduje do prune scoringu) — jedynie ANN/merge detection go
   * pomija (Fix 4, code review commit d057871). */
  vector: number[] | null;
}

/** Wspólny kontekst obu detektorów LLM (B2 prune, B3 conflicts), liczony RAZ na przebieg: początek okna
 * oraz zbiory wyłączeń niezależne od wyniku prune (recency, pending). `null` = odczyt się nie udał
 * (fail-open) — oba detektory się pomijają. */
interface LlmScanContext {
  windowStart: Date;
  recencyIds: Set<string>;
  pendingIds: Set<string>;
}

/** Wynik skanu ANN jednego faktu: `dedup` (`dist <= NIGHTLY_DEDUP_DISTANCE`, idzie do klastrów merge) oraz
 * `band` (`dedup < dist <= górna granica pasma`, kandydaci detektora sprzeczności B3). */
interface NeighborScan {
  dedup: NeighborPair[];
  band: NeighborPair[];
}

/** Ile faktów jest przetwarzanych naraz w `findNeighborPairs` (Fix 4, code review commit d057871) —
 * bounded concurrency zamiast ściśle sekwencyjnej pętli, bez nowej zależności (brak p-limit w repo). */
const NEIGHBOR_SCAN_CONCURRENCY = 10;

/**
 * Nocny job — proposer, NIE executor (plan Fazy 6 §1 "Overall shape"). Jedyny producent proposali
 * `origin='nightly'` (`type` ograniczony do merge/delete/update); NIGDY nie woła `ProposalsService.approve()`
 * i nigdy nie pisze do `memories`/`embeddings` — wyłącznie do `proposals`/`staging_embeddings`/
 * `audit_log`. Uruchamiany przez CLI `run-nightly` ALBO ręcznie z dashboardu (roadmap v1.1, ekran
 * "Operacje" → `POST /api/nightly/run`, `NightlyController`) — oba wejścia wołają dokładnie ten sam
 * `run()`, więc CLI/UI parity jest strukturalna. Scheduling (`NIGHTLY_CRON`/`NIGHTLY_TZ`) to kontrakt
 * dla zewnętrznego schedulera (Faza 8) — ten serwis go nie konsumuje.
 *
 * `run()` jest bezstanowe (stateless self-cleaning re-scan, plan §1): każdy przebieg wykrywa
 * warunki OD ZERA z aktualnego stanu `memories`, porównuje z pending `origin='nightly'` proposalami
 * z poprzednich przebiegów (`reconcile.ts`) i tylko RÓŻNICUJE kolejkę (create/withdraw) — nie ma
 * checkpointów ani historii przebiegów poza samą tabelą `proposals`. Mid-run crash zostawia bazę
 * spójną (każdy insert/withdraw jest niezależny) — kolejny przebieg samo-naprawia stan.
 *
 * Od roadmap v1.6 job ma OPCJONALNY krok LLM (opt-in w Ustawieniach, domyślnie wyłączony): `runLocked`
 * otwiera na starcie budżet przebiegu (`LlmService.openRunBudget`) i dokłada jego liczniki + blok `llm`
 * do wyniku. Fail-open (ust. 3): żadna awaria ustawień/providera nie zamienia przebiegu w `failed`.
 *
 * Detektor LLM prune (B2, `detectLlmPrune`) to trzeci detektor obok dedup/merge i recency prune: ocenia
 * fakty (`kind=fact`, approved) z OKNA po `created_at` (ustawienie `scan_window_days`, domyślnie 1 dzień),
 * jeden wpis na wywołanie przez `LlmRunBudget`, i produkuje zwykłe warunki `delete`/`update` dla wspólnej
 * ścieżki politeness -> reconcile -> cap -> apply. Pod model NIE trafia fakt z klastra merge, kwalifikujący
 * się do recency prune ani z pending proposalem (dowolnego pochodzenia). Warunki z detektora LLM niosą
 * `payload.rationale` i są wyłączone z orphan-withdraw (ust. 13): okno to „detektor przestał patrzeć", nie
 * „warunek ustał", więc taki proposal żyje do decyzji człowieka. Znane, zaakceptowane zachowanie (B2):
 * odrzucony proposal LLM może wrócić, dopóki fakt jest w oknie (job pozostaje bezstanowy).
 *
 * Detektor sprzeczności (B3, `detectLlmConflicts`) jest czwartym detektorem, wołanym PO LLM prune na tym samym
 * budżecie (wspólny cap, prune najpierw — nadwyżka liczy się w `llmSkippedCap`). Kandydaci to pary z PASMA
 * `(NIGHTLY_DEDUP_DISTANCE, NIGHTLY_CONFLICT_DISTANCE]` tego samego skanu ANN co dedup (bez nowych zapytań),
 * zakotwiczone na oknie `created_at` (≥ jedna strona w oknie), bez stron z klastra merge / recency prune /
 * pending proposala / LLM prune. Jedno wywołanie = jedna para, model orzeka binarnie; wynik to zwykły warunek
 * `delete` na STARSZYM wpisie z `counterpartId`. Orphan-withdraw: proposal konfliktu traci wyłączenie (B2 ust. 13),
 * gdy którakolwiek strona przestała być `approved`.
 */
@Injectable()
export class NightlyService {
  private readonly logger = new Logger(NightlyService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: PgPool,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
    @Inject(PRUNE_SCORER) private readonly pruneScorer: PruneScorer,
    private readonly usage: UsageService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Punkt wejścia (plan §2 "nightly.service.ts"). Lock na dedykowanym kliencie z `PG_POOL`, held
   * przez cały przebieg, zwolniony w `finally`. `pg_try_advisory_lock` nie blokuje — zajęty lock
   * (przebieg równoległy albo ręczny trigger nakładający się na inny) daje czysty no-op
   * (`skipped-locked`), nie kolejkowanie i nie błąd.
   */
  async run(opts: { actor: string }): Promise<NightlyRunResult> {
    const actor = opts.actor;
    const startedAt = new Date();
    const client = await this.pool.connect();
    let acquired = false;

    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [NIGHTLY_LOCK_KEY],
      );
      acquired = rows[0]?.locked === true;

      if (!acquired) {
        const finishedAt = new Date();
        const result: NightlyRunResult = {
          status: 'skipped-locked',
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          counters: EMPTY_COUNTERS,
          llm: null,
        };
        this.logger.warn('[nightly] lock zajęty przez inny przebieg — skipped-locked, no-op.');
        await this.audit.log({ eventType: 'nightly_run', actor, metadata: { ...result } });
        return result;
      }

      const { counters, llm } = await this.runLocked(actor);
      const finishedAt = new Date();
      const result: NightlyRunResult = {
        status: 'success',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        counters,
        llm,
      };
      await this.audit.log({ eventType: 'nightly_run', actor, metadata: { ...result } });
      return result;
    } catch (err) {
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[nightly] przebieg zakończony błędem: ${message}`);
      await this.audit.log({
        eventType: 'nightly_run',
        actor,
        metadata: {
          status: 'failed',
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: message,
        },
      });
      throw err;
    } finally {
      if (acquired) {
        // best-effort — jeśli unlock zawiedzie, sesja i tak zwalnia lock przy `client.release()`
        // (session-level lock ginie z połączeniem, patrz komentarz przy `NIGHTLY_LOCK_KEY`).
        await client.query('SELECT pg_advisory_unlock($1)', [NIGHTLY_LOCK_KEY]).catch(() => {});
      }
      client.release();
    }
  }

  // ---- orkiestracja pod lockiem: detekcja -> reconcile -> apply ---------

  private async runLocked(actor: string): Promise<{ counters: NightlyCounters; llm: NightlyLlmReport }> {
    const budget = await this.openLlmBudget(actor);
    // Detektory korzystające z modelu (B2 prune, B3) dostają `budget` i wołają `budget.call(...)` — jedyna
    // droga do providera (cap, bezpiecznik, skaner sekretów, liczniki). Krok B2: `detectLlmPrune` niżej.
    const activeModel = this.embedding.model;
    const facts = await this.loadApprovedFacts(activeModel);
    const factById = new Map(facts.map((f) => [f.id, f]));
    // Snapshot (Fix 1, code review commit d057871; przeniesiony do JS w nightly-scale G2): sąsiedzi ANN
    // muszą pochodzić z TYCH SAMYCH faktów co `factById`, inaczej fakt zatwierdzony współbieżnie w
    // trakcie przebiegu mógłby wrócić jako sąsiad, mimo że nie ma go w snapshotcie ->
    // `buildMergeCondition` rzucałby na `factById.get(id)` i wywalał CAŁY przebieg. Członkostwo
    // sprawdza `findNeighborPairs` w JS (`factById.has`), NIE w SQL: dawne `id IN (snapshot)` niosło
    // wszystkie id jako osobne parametry KAŻDEGO zapytania ANN (O(N²) bajtów, twardy sufit 65 535
    // parametrów Postgresa), a liczba bind-parametrów ma być stała, niezależna od liczby faktów.
    // Fakt spoza snapshotu może zająć slot w top-k, ale JS go odrzuca; wypiera realnego sąsiada tylko
    // jeśli sam jest bliskim duplikatem (klaster i tak już nieaktualny) — para i tak powstaje z obu
    // końców, a kolejny stateless re-scan koryguje resztę.

    const dedupDistance = this.config.get('NIGHTLY_DEDUP_DISTANCE');
    const annNeighbors = this.config.get('NIGHTLY_ANN_NEIGHBORS');
    // Górna granica pasma sprzeczności (B3). Przy wyłączonym kroku LLM pasmo jest PUSTE (górna = dedup) —
    // detektor nie buduje par ani promptów (ust. 16), a skan ANN zachowuje się dokładnie jak dotąd.
    const conflictDistance = this.config.get('NIGHTLY_CONFLICT_DISTANCE');
    if (budget.enabled && conflictDistance <= dedupDistance) {
      this.logger.warn(
        `[nightly] NIGHTLY_CONFLICT_DISTANCE=${conflictDistance} <= NIGHTLY_DEDUP_DISTANCE=${dedupDistance} — pasmo sprzeczności jest puste, detektor sprzeczności nic nie oceni.`,
      );
    }
    const bandUpper = budget.enabled ? Math.max(conflictDistance, dedupDistance) : dedupDistance;

    // Bounded concurrency zamiast ściśle sekwencyjnej pętli (Fix 4, code review commit d057871) —
    // chunk po `NEIGHBOR_SCAN_CONCURRENCY`, `Promise.all` w obrębie chunku, wyniki akumulowane przed
    // startem kolejnego chunku (bez nowej zależności typu p-limit).
    const pairs: NeighborPair[] = [];
    const bandPairs: NeighborPair[] = [];
    for (let i = 0; i < facts.length; i += NEIGHBOR_SCAN_CONCURRENCY) {
      const chunk = facts.slice(i, i + NEIGHBOR_SCAN_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((fact) =>
          this.findNeighborPairs(fact, factById, activeModel, annNeighbors, dedupDistance, bandUpper),
        ),
      );
      for (const found of results) {
        pairs.push(...found.dedup);
        bandPairs.push(...found.band);
      }
    }
    const clusters = buildClusters(pairs);
    const clusteredIds = new Set(clusters.flat());

    const mergeConditions = clusters.map((ids) => this.buildMergeCondition(ids, factById));
    const pruneConditions = this.buildPruneConditions(facts, clusteredIds);
    // Kontekst LLM liczony raz dla obu detektorów (fail-open: błąd odczytu pending => oba pomijają się).
    const llmCtx = await this.loadLlmScanContext(budget, pruneConditions);
    const llmPrune = await this.detectLlmPrune(budget, llmCtx, facts, clusteredIds);
    // B3 PO prune, na tym samym budżecie (G1: prune wydaje cap pierwszy). Wpis z warunkiem LLM prune z tego
    // przebiegu nie wchodzi w parę (ust. 22 — jeden wpis, najwyżej jedna propozycja na przebieg).
    const llmPruneIds = new Set(llmPrune.conditions.flatMap((c) => c.affectedIds));
    const llmConflicts = await this.detectLlmConflicts(
      budget,
      llmCtx,
      bandPairs,
      factById,
      clusteredIds,
      llmPruneIds,
    );
    const allDetected = [
      ...mergeConditions,
      ...pruneConditions,
      ...llmPrune.conditions,
      ...llmConflicts.conditions,
    ];

    // Politeness gate (plan §5 pkt 5): pomiń warunki, których affectedIds nakładają się na pending
    // proposal spoza nightly — redukcja "reviewer churn". Efekt uboczny (zamierzony): jeśli dla
    // tego samego warunku istniał już nightly proposal z poprzedniego przebiegu, orphan-branch
    // reconcile poniżej go wycofa (bez specjalnego przypadku — po prostu "nie wykryty w tym biegu").
    const busyIds = await this.loadBusyIds();
    const politeConditions = allDetected.filter((c) => !c.affectedIds.some((id) => busyIds.has(id)));
    const skippedPoliteness = allDetected.length - politeConditions.length;

    const existing = await this.loadExistingNightly();
    const reconciled = reconcile(politeConditions, existing);

    // Flood backstop (plan §5 pkt 6): limit NOWYCH proposali w jednym przebiegu. Obcięcie
    // deterministyczne (sort po conditionKey) — pominięte warunki NIE giną, zostają wykryte
    // ponownie przy kolejnym stateless re-scanie (żadnego cichego odrzucenia, tylko odłożenie w
    // czasie). Orphan `toWithdraw` NIE podlega capowi: usunięcie osieroconego wpisu z kolejki to
    // sprzątanie, nie "nowa propozycja" — backstop go nie dotyczy.
    const cap = this.config.get('NIGHTLY_MAX_PROPOSALS_PER_RUN');
    const sortedToCreate = [...reconciled.toCreate].sort((a, b) =>
      a.conditionKey.localeCompare(b.conditionKey),
    );
    const finalToCreate = sortedToCreate.slice(0, cap);
    const skippedCap = sortedToCreate.length - finalToCreate.length;
    if (skippedCap > 0) {
      this.logger.warn(
        `[nightly] NIGHTLY_MAX_PROPOSALS_PER_RUN=${cap} osiągnięty — ${skippedCap} warunków ` +
          'pominiętych w tym przebiegu (zostaną ponownie wykryte przy kolejnym run-nightly).',
      );
    }

    let created = 0;
    let mergeProposed = 0;
    let pruneProposed = 0;
    let llmPruneDeleteProposed = 0;
    let llmPruneUpdateProposed = 0;
    let llmConflictProposed = 0;
    for (const cond of finalToCreate) {
      await this.createProposal(cond, actor);
      created++;
      if (cond.type === 'merge') mergeProposed++;
      else if (cond.detector === 'llm-prune') {
        if (cond.type === 'delete') llmPruneDeleteProposed++;
        else llmPruneUpdateProposed++;
      } else if (cond.detector === 'llm-conflicts') llmConflictProposed++;
      else pruneProposed++;
    }

    // Sparowane withdraw (Fix 2, code review commit d057871): odpowiednik "replace" liczony WYŁĄCZNIE
    // dla warunków, które przetrwały cap (są w `finalToCreate`) — jeśli `cond` danego `conditionKey`
    // został ucięty przez cap, jego stary odpowiednik w `reconciled.replacements` NIE trafia do
    // withdraw w tym przebiegu (para odkładana w całości, żeby nigdy nie osierocić warunku w
    // kolejce — złapie ją kolejny stateless re-scan, znów jako "stale" albo już jako "fresh").
    const pairedWithdraw = finalToCreate
      .map((cond) => reconciled.replacements.get(cond.conditionKey))
      .filter((id): id is string => id !== undefined);
    const allToWithdraw = [...reconciled.toWithdraw, ...pairedWithdraw];

    let withdrawn = 0;
    for (const proposalId of allToWithdraw) {
      const didWithdraw = await this.withdrawProposal(proposalId, actor);
      if (didWithdraw) withdrawn++;
    }

    // Retencja `search_events` (roadmap v1.1 "Pomiary", plan §5(b/g)) — piggyback na tym samym
    // przebiegu/lockcie, brak osobnego schedulera. Niezależne od dedup/prune pamięci powyżej —
    // czysto addytywny krok, nie zmienia żadnej z istniejących decyzji merge/delete. Fail-open
    // (analogicznie do `MemoryService.recordSearchSafe`) — awaria retencji jest złapana i
    // zalogowana, NIGDY nie może zamienić skądinąd udanego przebiegu (dedup/merge/prune proposale
    // powyżej już zacommitowane) w `failed` całego `run()`.
    const retentionDays = this.config.get('SEARCH_EVENTS_RETENTION_DAYS');
    let searchEventsPruned = 0;
    try {
      searchEventsPruned = await this.usage.pruneOlderThan(new Date(Date.now() - retentionDays * DAY_MS));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[nightly] retencja search_events nie powiodła się (fail-open, przebieg kontynuowany): ${message}`,
      );
    }

    return {
      counters: {
        created,
        withdrawn,
        skippedAsDup: reconciled.skipped.length,
        mergeProposed,
        pruneProposed,
        skippedPoliteness,
        skippedCap,
        searchEventsPruned,
        llmPruneCandidates: llmPrune.candidates,
        llmPruneKept: llmPrune.kept,
        llmPruneDeleteProposed,
        llmPruneUpdateProposed,
        llmConflictCandidates: llmConflicts.candidates,
        llmConflictConsistent: llmConflicts.consistent,
        llmConflictProposed,
        ...budget.counters(),
      },
      llm: budget.report(),
    };
  }

  /** Otwiera budżet LLM przebiegu. Odczyt ustawień z bazy, który się nie uda, daje stan `unavailable` —
   * nigdy `failed` (fail-open, ust. 3). Nieczytelny klucz (G7) jest widoczny jako `llm.state` w metadanych
   * przebiegu + jedno ostrzeżenie w logu; detektory nie ruszają przy
   * `!budget.enabled` (ust. 15), więc `llmSkippedKeyUnreadable` zostaje 0 — sygnałem jest `llm.state`. */
  private async openLlmBudget(actor: string): Promise<LlmRunBudget> {
    try {
      const budget = await this.llm.openRunBudget(actor);
      if (budget.state === 'key_unreadable') {
        this.logger.warn(
          '[nightly] krok LLM pominięty: zapisanego klucza API nie da się odszyfrować (zmieniony SECRETS_ENCRYPTION_KEY?) — wpisz go ponownie w Ustawieniach.',
        );
      }
      return budget;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[nightly] nie udało się odczytać ustawień LLM (fail-open, krok LLM pominięty): ${message}`);
      return LlmRunBudget.unavailable();
    }
  }

  /**
   * Kontekst wspólny dla detektorów LLM (B2 prune, B3 conflicts), liczony raz na przebieg. Przy `!budget.enabled`
   * `null` bez żadnych zapytań (ust. 15/16 — domyślny stan = dzisiejszy przebieg). Wyjątek (np. awaria zapytania o
   * pending) jest łapany i logowany: oba detektory się pomijają, przebieg i proposale dedup/recency idą dalej.
   */
  private async loadLlmScanContext(
    budget: LlmRunBudget,
    pruneConditions: DetectedCondition[],
  ): Promise<LlmScanContext | null> {
    if (!budget.enabled) return null;
    try {
      const recencyIds = new Set(pruneConditions.flatMap((c) => c.affectedIds));
      const pendingIds = await this.loadPendingAffectedIds();
      const windowStart = llmWindowStart(new Date(), budget.scanWindowDays);
      return { windowStart, recencyIds, pendingIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[nightly] kontekst detektorów LLM nie powiódł się (fail-open, kroki LLM pominięte): ${message}`,
      );
      return null;
    }
  }

  // ---- detekcja: LLM prune (B2) -------------------------------------------

  /**
   * Detektor LLM prune. Przy `!budget.enabled` (albo bez kontekstu) NIE wybiera kandydatów ani nie buduje promptów
   * (ust. 15) — domyślny stan daje dokładnie dzisiejszy przebieg. Wyłączenia z oceny: fakty spoza okna `created_at`
   * (G6), z klastra merge (ust. 17), kwalifikujące się do recency prune (ust. 21 — wygrywa tańszy,
   * deterministyczny `delete`) i z pending proposalem dowolnego pochodzenia (ust. 22). Fail-open: wyjątek
   * jest łapany i logowany — przebieg i proposale dedup/recency idą dalej.
   */
  private async detectLlmPrune(
    budget: LlmRunBudget,
    ctx: LlmScanContext | null,
    facts: FactRow[],
    clusteredIds: Set<string>,
  ): Promise<{ conditions: DetectedCondition[]; candidates: number; kept: number }> {
    if (!budget.enabled || !ctx) return { conditions: [], candidates: 0, kept: 0 };
    let candidateCount = 0;
    try {
      const candidates = selectWindowFacts(facts, {
        windowStart: ctx.windowStart,
        exclude: [clusteredIds, ctx.recencyIds, ctx.pendingIds],
      });
      candidateCount = candidates.length;
      const result = await runLlmPrune({ budget, candidates, config: this.config });
      return { conditions: result.conditions, candidates: candidateCount, kept: result.kept };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[nightly] detektor LLM prune nie powiódł się (fail-open, przebieg kontynuowany): ${message}`,
      );
      return { conditions: [], candidates: candidateCount, kept: 0 };
    }
  }

  // ---- detekcja: sprzeczności (B3) ------------------------------------------

  /**
   * Detektor sprzeczności. Przy `!budget.enabled` (albo bez kontekstu) nie buduje par ani promptów (ust. 16).
   * Pary pochodzą z pasma ANN `bandPairs` (bez nowych zapytań, ust. 11), są zakotwiczone na oknie (ust. 10) i
   * odpadają, gdy którakolwiek strona jest w klastrze merge, kwalifikuje się do recency prune, ma pending
   * proposal albo dostała warunek z LLM prune w tym przebiegu (ust. 22). Wywołania idą na TYM SAMYM budżecie co
   * prune — wyczerpany cap daje `llmSkippedCap`, nie wywołania ponad cap (G1). Fail-open jak `detectLlmPrune`.
   */
  private async detectLlmConflicts(
    budget: LlmRunBudget,
    ctx: LlmScanContext | null,
    bandPairs: NeighborPair[],
    factById: Map<string, FactRow>,
    clusteredIds: Set<string>,
    llmPruneIds: Set<string>,
  ): Promise<{ conditions: DetectedCondition[]; candidates: number; consistent: number }> {
    if (!budget.enabled || !ctx) return { conditions: [], candidates: 0, consistent: 0 };
    let candidateCount = 0;
    try {
      const pairs = selectConflictPairs(bandPairs, factById, {
        windowStart: ctx.windowStart,
        exclude: [clusteredIds, ctx.recencyIds, ctx.pendingIds, llmPruneIds],
      });
      candidateCount = pairs.length;
      const result = await runLlmConflicts({ budget, pairs });
      return { conditions: result.conditions, candidates: candidateCount, consistent: result.consistent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[nightly] detektor sprzeczności nie powiódł się (fail-open, przebieg kontynuowany): ${message}`,
      );
      return { conditions: [], candidates: candidateCount, consistent: 0 };
    }
  }

  /** Pamięci dotknięte JAKIMKOLWIEK pending proposalem (też nightly) — fakt z pending proposalem nie idzie
   * pod model (ust. 22): ponowna ocena to czysty koszt, a przy nondeterminizmie dałaby drugą, inną
   * propozycję na tym samym wpisie. */
  private async loadPendingAffectedIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ affectedIds: proposals.affectedIds })
      .from(proposals)
      .where(eq(proposals.status, 'pending'));
    return new Set(rows.flatMap((r) => r.affectedIds));
  }

  // ---- detekcja: dedup (ANN) ---------------------------------------------

  /** Paginacja typu keyset (`WHERE id > lastId ORDER BY id LIMIT`, Fix 3, code review commit
   * d057871) — trzyma pamięć procesu pod kontrolą przy dużej liczbie approved facts (plan §3 "ANN
   * query cost at scale") BEZ pułapki plain `OFFSET`: offsetowanie po round-tripach nie ma izolacji
   * snapshotu, więc wiersz który zmienia pozycję w przefiltrowanym zbiorze między stronami (np.
   * archiwizacja mid-scan) mógłby zostać całkowicie pominięty. Keyset (`id > lastId`) nie ma tej
   * wady — każda strona zaczyna się dokładnie tam, gdzie skończyła się poprzednia, niezależnie od
   * tego, co wypadło ze zbioru w międzyczasie. Wyłącznie `kind='fact'`: dokumenty są wielo-chunkowe
   * (`chunker.ts`), poza zakresem v1 nocnego joba (plan §1 "Candidate detection via ANN" — ANN dedup
   * zakłada jeden wektor na pamięć).
   *
   * LEFT JOIN embeddings (Fix 4, code review commit d057871) na `(memoryId, activeModel)`
   * eliminuje osobne zapytanie "własny wektor" per fakt w `findNeighborPairs` (N+1). MUSI być LEFT,
   * nie INNER — fakt bez embeddingu aktywnego modelu (jeszcze nie przeliczony przez `reembed`) wciąż
   * jest potrzebny w `facts` dla prune scoringu (`buildPruneConditions` iteruje po wszystkich
   * faktach niezależnie od statusu embeddingu); tylko ANN/merge detection go pomija. */
  private async loadApprovedFacts(activeModel: string): Promise<FactRow[]> {
    const batchSize = this.config.get('NIGHTLY_BATCH_SIZE');
    const out: FactRow[] = [];
    let lastId: string | undefined;
    for (;;) {
      const conditions = [eq(memories.status, 'approved'), eq(memories.kind, 'fact')];
      if (lastId !== undefined) conditions.push(gt(memories.id, lastId));

      const batch = await this.db
        .select({
          id: memories.id,
          version: memories.version,
          scope: memories.scope,
          projectId: memories.projectId,
          header: memories.header,
          body: memories.body,
          tags: memories.tags,
          kind: memories.kind,
          accessCount: memories.accessCount,
          createdAt: memories.createdAt,
          lastAccessedAt: memories.lastAccessedAt,
          vector: embeddings.vector,
        })
        .from(memories)
        .leftJoin(
          embeddings,
          and(eq(embeddings.memoryId, memories.id), eq(embeddings.embeddingModel, activeModel)),
        )
        .where(and(...conditions))
        .orderBy(asc(memories.id))
        .limit(batchSize);
      if (batch.length === 0) break;
      out.push(...batch);
      lastId = batch[batch.length - 1].id;
      if (batch.length < batchSize) break;
    }
    return out;
  }

  /**
   * ANN per-fact przez współdzielony `findAnnNeighbors` (`embeddings/ann-search.ts`) — wcześniej
   * hand-rollowane zapytanie identyczne w kształcie do `MemoryService.vectorArm()`, wydzielone jako
   * osobny prymityw po code review finding "reuse" (commit d057871). Własny wektor faktu jako query,
   * `ORDER BY dist LIMIT NIGHTLY_ANN_NEIGHBORS`, tylko pary `<= NIGHTLY_DEDUP_DISTANCE` (filtr
   * progiem zostaje TUTAJ, nie w helperze — helper zwraca surowe pary). Od B3 wynik ma dwie listy: `dedup`
   * (`dist <= NIGHTLY_DEDUP_DISTANCE`) i `band` (powyżej dedup, do `bandUpper` = `NIGHTLY_CONFLICT_DISTANCE`). W przeciwieństwie do
   * `vectorArm` (który miesza `global OR project-tego-tokena` dla wyszukiwania, `scopeCondition`
   * permisywny) partycja tu jest ŚCISŁA — dokładnie ten sam `(scope, projectId)` co fakt źródłowy,
   * nigdy unia — nocny job nigdy nie scala między projektami ani przez granicę global/project (plan
   * §1). `groupByMemory: false` (w przeciwieństwie do `vectorArm`) — fakty mają dokładnie jeden
   * wektor, bez kolapsowania multi-chunk. Fakt bez wektora aktywnego modelu (jeszcze nie przeliczony
   * przez `reembed`) -> brak par, poza zakresem tego przebiegu.
   *
   * Wektor faktu przekazywany jako parametr (Fix 4, code review commit d057871) — pobrany raz przez
   * LEFT JOIN w `loadApprovedFacts`, bez osobnego zapytania per fakt (eliminacja jednego z dwóch N+1
   * round-tripów tej pętli).
   *
   * Snapshot (Fix 1, code review commit d057871; nightly-scale G2): wiersze ANN spoza `factById`
   * (fakt zatwierdzony współbieżnie PO snapshotcie) są odrzucane W JS, przed filtrem dystansu — bez
   * tego `buildMergeCondition` (który indeksuje WYŁĄCZNIE po snapshotcie przez `factById`) rzucałby
   * na brakujący klucz i wywalał cały przebieg (TOCTOU); taki fakt poczeka na kolejny stateless
   * re-scan. Członkostwa NIE ma w SQL (dawne `inArray(memories.id, snapshotIds)`): liczba
   * bind-parametrów zapytania ANN jest stała (wektor, model, status, scope 1–2, kind, id faktu,
   * limit), niezależna od liczby zatwierdzonych faktów. `ne(memories.id, fact.id)` (w
   * `extraConditions`) wyklucza sam fakt z własnego wyniku ANN.
   *
   * `eq(memories.kind, fact.kind)` (roadmap v1.3 "Dedup kind-aware", defense-in-depth): partycja ANN
   * jest ścisła też po `kind`, symetrycznie ze `scope`/`projectId` wyżej — klaster nigdy nie miesza
   * kindów. NO-OP dzisiaj (`loadApprovedFacts` już filtruje do `kind='fact'`, więc `fact.kind` jest
   * zawsze `'fact'`) — zabezpieczenie na wypadek, gdyby skan kiedyś rozszerzył się o document/event.
   */
  private async findNeighborPairs(
    fact: FactRow,
    factById: Map<string, FactRow>,
    activeModel: string,
    annNeighbors: number,
    dedupDistance: number,
    bandUpper: number,
  ): Promise<NeighborScan> {
    if (!fact.vector) return { dedup: [], band: [] };

    const scopeCondition =
      fact.scope === 'global'
        ? and(eq(memories.scope, 'global'))
        : and(eq(memories.scope, 'project'), eq(memories.projectId, fact.projectId as string));

    const rows = await findAnnNeighbors({
      db: this.db,
      queryVector: fact.vector,
      embeddingModel: activeModel,
      scopeCondition,
      extraConditions: [
        eq(memories.kind, fact.kind),
        ne(memories.id, fact.id),
      ],
      groupByMemory: false, // fakty mają dokładnie jeden wektor — bez kolapsowania multi-chunk
      limit: annNeighbors,
    });

    // Snapshot najpierw, potem podział po dystansie: `dedup` (<= dedupDistance) idzie do klastrów merge,
    // `band` ((dedupDistance, bandUpper]) do detektora sprzeczności. Przy `bandUpper === dedupDistance` pasmo jest puste.
    const inSnapshot = rows.filter((r) => factById.has(r.memoryId));
    return {
      dedup: inSnapshot
        .filter((r) => r.dist <= dedupDistance)
        .map((r) => ({ a: fact.id, b: r.memoryId, dist: r.dist })),
      band: inSnapshot
        .filter((r) => r.dist > dedupDistance && r.dist <= bandUpper)
        .map((r) => ({ a: fact.id, b: r.memoryId, dist: r.dist })),
    };
  }

  private buildMergeCondition(clusterIds: string[], factById: Map<string, FactRow>): DetectedCondition {
    const members = clusterIds.map((id) => {
      const row = factById.get(id);
      if (!row) throw new Error(`buildMergeCondition: brak faktu ${id} w załadowanym zbiorze`);
      return row;
    });
    const payload = pickCanonicalMerge(
      members.map((m) => ({
        id: m.id,
        header: m.header,
        body: m.body,
        tags: m.tags,
        kind: m.kind,
        accessCount: m.accessCount,
      })),
    );
    const baseVersions: Record<string, number> = {};
    for (const m of members) baseVersions[m.id] = m.version;
    const first = members[0];

    return {
      type: 'merge',
      detector: 'dedup',
      scope: first.scope,
      projectId: first.projectId,
      affectedIds: clusterIds,
      baseVersions,
      payload,
      conditionKey: conditionKey('merge', clusterIds),
    };
  }

  // ---- detekcja: prune ----------------------------------------------------

  /** Pomija fakty już objęte klastrem scalenia (plan §2 "skipping facts already in a merge
   * cluster") — merge i prune to rozłączne propozycje dla tego samego faktu w jednym przebiegu
   * (fakt kandydujący do scalenia nie jest jednocześnie kandydatem do usunięcia). */
  private buildPruneConditions(facts: FactRow[], clusteredIds: Set<string>): DetectedCondition[] {
    const thresholds: PruneThresholds = {
      minAgeDays: this.config.get('NIGHTLY_PRUNE_MIN_AGE_DAYS'),
      staleDays: this.config.get('NIGHTLY_PRUNE_STALE_DAYS'),
      maxAccessCount: this.config.get('NIGHTLY_PRUNE_MAX_ACCESS'),
    };
    const now = new Date();
    const out: DetectedCondition[] = [];

    for (const fact of facts) {
      if (clusteredIds.has(fact.id)) continue;
      const score = this.pruneScorer.score({
        createdAt: fact.createdAt,
        lastAccessedAt: fact.lastAccessedAt,
        accessCount: fact.accessCount,
        now,
        thresholds,
      });
      if (!score.eligible) continue;
      out.push({
        type: 'delete',
        detector: 'recency',
        scope: fact.scope,
        projectId: fact.projectId,
        affectedIds: [fact.id],
        baseVersions: { [fact.id]: fact.version },
        payload: { memoryId: fact.id },
        conditionKey: conditionKey('delete', [fact.id]),
      });
    }
    return out;
  }

  // ---- reconcile: stan kolejki --------------------------------------------

  /** Pamięci dotknięte pending proposalem SPOZA nightly (plan §5 pkt 5 — politeness gate). */
  private async loadBusyIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ affectedIds: proposals.affectedIds })
      .from(proposals)
      .where(and(eq(proposals.status, 'pending'), ne(proposals.origin, 'nightly')));
    return new Set(rows.flatMap((r) => r.affectedIds));
  }

  /** Pending `origin='nightly'` proposale + ich staleness (`computeStaleIds` reużyte 1:1 z
   * `ProposalsService`, plan §1 "Idempotentny self-cleaning re-scan"). */
  private async loadExistingNightly(): Promise<ExistingNightlyProposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.status, 'pending'), eq(proposals.origin, 'nightly')));
    if (rows.length === 0) return [];

    const allIds = Array.from(new Set(rows.flatMap((r) => r.affectedIds)));
    const versionRows =
      allIds.length > 0
        ? await this.db
            .select({ id: memories.id, version: memories.version, status: memories.status })
            .from(memories)
            .where(idsAny(memories.id, allIds))
        : [];
    const versionMap = new Map(versionRows.map((r) => [r.id, r.version]));
    const statusMap = new Map(versionRows.map((r) => [r.id, r.status]));

    return rows.map((r) => {
      const baseVersions = (r.baseVersions ?? {}) as Record<string, number>;
      const staleIds = computeStaleIds(versionMap, baseVersions, r.affectedIds);
      return {
        id: r.id,
        // Nightly PRODUKUJE wyłącznie merge/delete/update (`NightlyConditionType`) — rzut bezpieczny, bo
        // filtr `origin='nightly'` wyżej gwarantuje, że to zawsze wiersz zapisany przez ten serwis.
        type: r.type as NightlyConditionType,
        affectedIds: r.affectedIds,
        stale: staleIds.length > 0,
        // Czytamy kolumnę `payload` (nie `edited_payload`): edycje jej nie ruszają, a `rationale` i tak przeżywa edit.
        // B3: proposal KONFLIKTU traci wyłączenie, gdy którakolwiek strona zniknęła albo nie jest już `approved`
        // (np. dwa konflikty na tym samym starszym wpisie — approve jednego archiwizuje cel drugiego) — wtedy nie
        // zostanie wykryty ponownie i orphan-withdraw go wycofa. Zmiana wersji (edycja) nadal zostaje `stale`.
        exemptFromOrphanWithdraw:
          isLlmDetectedPayload(r.payload) &&
          !(isConflictPayload(r.payload) && r.affectedIds.some((id) => statusMap.get(id) !== 'approved')),
      };
    });
  }

  // ---- apply: create / withdraw -------------------------------------------

  private async createProposal(cond: DetectedCondition, actor: string): Promise<void> {
    const proposalId = generateId(ID_PREFIX.proposal);
    await this.db.insert(proposals).values({
      id: proposalId,
      type: cond.type,
      origin: 'nightly',
      status: 'pending',
      payload: cond.payload,
      affectedIds: cond.affectedIds,
      baseVersions: cond.baseVersions,
      contentHash: null,
      scope: cond.scope,
      projectId: cond.projectId,
    });
    await this.audit.log({
      eventType: 'proposal_created',
      actor,
      affectedIds: cond.affectedIds,
      metadata: {
        proposalId,
        type: cond.type,
        origin: 'nightly',
        conditionKey: cond.conditionKey,
        detector: cond.detector,
        ...('rationale' in cond.payload && cond.payload.rationale
          ? { category: cond.payload.rationale.category }
          : {}),
      },
    });
  }

  /** Strażnik `origin='nightly' AND status='pending'` (plan §3 "Withdraw guard") — no-op na
   * proposalu human/agent albo już zdecydowanym (np. wyścig z równoległym approve/reject między
   * detekcją a apply). Zwraca, czy realnie coś wycofano (do liczników `withdrawn`). */
  private async withdrawProposal(proposalId: string, actor: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(proposals)
        .set({ status: 'withdrawn', updatedAt: new Date() })
        .where(
          and(
            eq(proposals.id, proposalId),
            eq(proposals.origin, 'nightly'),
            eq(proposals.status, 'pending'),
          ),
        )
        .returning({ id: proposals.id, affectedIds: proposals.affectedIds, type: proposals.type });
      if (updated.length === 0) return false;

      await tx.delete(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, proposalId));
      // Brak dedykowanego eventType 'proposal_withdrawn' w taksonomii audytu (świadomie — jedyna
      // zmiana enumów w tej fazie to `proposal_status.withdrawn`, plan §5 pkt 2, dla zachowania
      // "dokładnie jednej migracji"). Reużywamy `proposal_rejected`, semantycznie najbliższe
      // ("proposal zamknięty bez materializacji"), rozróżnione w `metadata.withdrawnBy` od decyzji
      // ludzkiej (`reject-proposal` CLI nie ustawia tego pola).
      await this.audit.log(
        {
          eventType: 'proposal_rejected',
          actor,
          affectedIds: updated[0].affectedIds,
          metadata: { proposalId, type: updated[0].type, origin: 'nightly', withdrawnBy: 'nightly' },
        },
        tx,
      );
      return true;
    });
  }
}
