import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { AuditService } from '../audit/audit.service';
import { scanForSecrets } from '../common/secret-scanner';
import {
  LLM_BREAKER_THRESHOLD,
  LLM_DEFAULT_SCAN_WINDOW_DAYS,
  LLM_RETRY_DEFAULT_WAIT_MS,
  LLM_RETRY_MAX_WAIT_MS,
  LLM_SKIPPED_SECRET_LIST_MAX,
} from './llm.constants';
import { LlmHttpError, type LlmProvider } from './llm-provider';
import {
  EMPTY_LLM_COUNTERS,
  type LlmChatMessage,
  type LlmChatResult,
  type LlmCounters,
  type LlmEndpoint,
  type LlmRunState,
  type NightlyLlmReport,
  type SkippedSecretEntry,
} from './llm.types';

/** Źródło treści w żądaniu: id pamięci + tekst, który z niego pochodzi. Skaner sekretów (G13) sprawdza
 * każde źródło OSOBNO, żeby wiedzieć, KTÓRY wpis pominąć i zapisać w audycie. */
export interface LlmSource {
  memoryId: string;
  text: string;
}

export interface LlmCallRequest<T> {
  /** Krótka nazwa kroku (np. `prune`, `conflicts`) — do audytu i logów, nigdy nie niesie treści. */
  purpose: string;
  sources: LlmSource[];
  messages: LlmChatMessage[];
  /** Zod-schemat odpowiedzi od wołającego (G10): niezgodność = policzony błąd, nie wyjątek. */
  schema: z.ZodType<T>;
}

export type LlmSkipReason = 'disabled' | 'key_unreadable' | 'secret' | 'breaker' | 'cap' | 'error';

export type LlmCallOutcome<T> = { ok: true; value: T } | { ok: false; reason: LlmSkipReason };

export interface LlmRunBudgetOptions {
  provider: LlmProvider;
  endpoint: LlmEndpoint;
  callCap: number;
  /** Okno przeglądu detektorów LLM w dniach (G6) — z ustawień przebiegu; opcjonalne, by testy B1 się nie zmieniały. */
  scanWindowDays?: number;
  audit: Pick<AuditService, 'log'>;
  actor: string;
  breakerThreshold?: number;
  /** Wstrzykiwalny sleep (testy: bez realnego czekania). */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, 'warn'>;
}

/** Zdejmuje jedno opcjonalne ogrodzenie ``` (z opcjonalnym tagiem języka) wokół odpowiedzi. */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const m = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

export type LlmParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** `JSON.parse` + `schema.safeParse`. Komunikat błędu jest STAŁY / niesie najwyżej ścieżki pól zoda —
 * nigdy treści odpowiedzi modelu (`SyntaxError.message` cytuje fragment wejścia, więc go nie używamy). */
export function parseLlmJson<T>(content: string, schema: z.ZodType<T>): LlmParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(content));
  } catch {
    return { ok: false, reason: 'odpowiedź nie jest poprawnym JSON-em' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length > 0 ? i.path.map(String).join('.') : '(root)'))
      .join(', ');
    return { ok: false, reason: `odpowiedź niezgodna ze schematem (pola: ${paths})` };
  }
  return { ok: true, value: parsed.data };
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Budżet kroku LLM JEDNEGO przebiegu nocnego joba — jedyna droga, którą detektory (B2/B3) wołają model.
 * Egzekwuje w jednym miejscu wszystkie reguły ticketu `nightly-llm-provider`:
 * opt-in (`disabled`), nieczytelny klucz (G7), skaner sekretów na treści wychodzącej (G13), bezpiecznik po
 * `K` kolejnych błędach (G8), cap żądań (ust. 4), jedna ponowna próba na 429/503 (G9; timeout bez retry),
 * walidacja odpowiedzi zodem (G10). `call()` NIGDY nie rzuca (fail-open, ust. 3): każdy wynik
 * negatywny to `{ok:false, reason}` plus odpowiedni licznik.
 *
 * Liczniki: `llmCalls` = żądania HTTP faktycznie wysłane (z retry), `llmErrors` = wywołania logiczne
 * zakończone błędem. Slot capa jest rezerwowany SYNCHRONICZNIE przed pierwszym `await`, więc przy
 * współbieżnych wywołaniach (detektory B2/B3 wołają ze współbieżnością `LLM_DETECTOR_CONCURRENCY`) sufit jest twardy. Kolejność kontroli:
 * stan → sekret → bezpiecznik → cap → wysyłka; skan sekretów idzie przed bezpiecznikiem i capem, więc
 * pominięcie wpisu ze względu na sekret nie zużywa slotu ani nie zależy od zdrowia providera.
 */
export class LlmRunBudget {
  private readonly c: LlmCounters = { ...EMPTY_LLM_COUNTERS };
  private readonly skippedSecret: SkippedSecretEntry[] = [];
  private readonly secretSeen = new Set<string>();
  private consecutiveFailures = 0;

  private constructor(
    readonly state: LlmRunState,
    private readonly deps: LlmRunBudgetOptions | null,
  ) {}

  /** Krok wyłączony (opt-in) — `call()` zwraca `disabled`, nic nie liczy. */
  static disabled(): LlmRunBudget {
    return new LlmRunBudget('disabled', null);
  }

  /** Odczyt ustawień zawiódł — traktowane jak `disabled`, ale stan jest widoczny w metadanych przebiegu. */
  static unavailable(): LlmRunBudget {
    return new LlmRunBudget('unavailable', null);
  }

  /** Klucza API nie da się odszyfrować (G7) — każde `call()` liczy `llmSkippedKeyUnreadable`. */
  static keyUnreadable(): LlmRunBudget {
    return new LlmRunBudget('key_unreadable', null);
  }

  static ready(opts: LlmRunBudgetOptions): LlmRunBudget {
    return new LlmRunBudget('ready', opts);
  }

  /** Czy `call()` ma szansę coś wysłać — detektory mogą pominąć budowanie promptów, gdy `false`. */
  get enabled(): boolean {
    return this.state === 'ready';
  }

  /** Okno przeglądu (G6) z ustawień przebiegu — wspólne dla detektorów B2/B3. Poza stanem `ready` wartość
   * domyślna (nieużywana: detektory nie ruszają przy `!enabled`). */
  get scanWindowDays(): number {
    return this.deps?.scanWindowDays ?? LLM_DEFAULT_SCAN_WINDOW_DAYS;
  }

  counters(): LlmCounters {
    return { ...this.c };
  }

  report(): NightlyLlmReport {
    return { state: this.state, skippedSecret: [...this.skippedSecret] };
  }

  async call<T>(req: LlmCallRequest<T>): Promise<LlmCallOutcome<T>> {
    try {
      return await this.callInner(req);
    } catch (err) {
      // Pas bezpieczeństwa: callInner łapie błędy providera i parsowania, ale `call()` z definicji nie
      // rzuca (fail-open) — np. nieoczekiwany wyjątek w audycie czy schemacie wołającego.
      this.recordFailure(req, err instanceof Error ? err.message : 'nieznany błąd');
      return { ok: false, reason: 'error' };
    }
  }

  private async callInner<T>(req: LlmCallRequest<T>): Promise<LlmCallOutcome<T>> {
    if (this.state === 'disabled' || this.state === 'unavailable') {
      return { ok: false, reason: 'disabled' };
    }
    if (this.state === 'key_unreadable') {
      this.c.llmSkippedKeyUnreadable++;
      return { ok: false, reason: 'key_unreadable' };
    }
    const deps = this.deps;
    if (!deps) return { ok: false, reason: 'disabled' };
    const threshold = deps.breakerThreshold ?? LLM_BREAKER_THRESHOLD;

    // G13: skaner sekretów NA treści wychodzącej, zanim cokolwiek opuści proces.
    const secretHits = await this.scanOutgoing(req);
    if (secretHits) {
      this.c.llmSkippedSecret++;
      return { ok: false, reason: 'secret' };
    }

    // G8: bezpiecznik.
    if (this.consecutiveFailures >= threshold) {
      this.c.llmSkippedBreaker++;
      return { ok: false, reason: 'breaker' };
    }

    // Cap: rezerwacja slotu synchronicznie, przed jakimkolwiek `await` (współbieżne wywołania).
    if (this.c.llmCalls >= deps.callCap) {
      this.c.llmSkippedCap++;
      return { ok: false, reason: 'cap' };
    }
    this.c.llmCalls++;

    let result: LlmChatResult;
    try {
      result = await deps.provider.chat(deps.endpoint, req.messages, { json: true });
    } catch (err) {
      if (err instanceof LlmHttpError && (err.status === 429 || err.status === 503)) {
        // G9: jedna ponowna próba, krótki backoff z górnym limitem na `Retry-After`, liczona do capa.
        const wait = Math.min(err.retryAfterMs ?? LLM_RETRY_DEFAULT_WAIT_MS, LLM_RETRY_MAX_WAIT_MS);
        await (deps.sleep ?? realSleep)(wait);
        if (this.c.llmCalls < deps.callCap) {
          this.c.llmCalls++;
          try {
            result = await deps.provider.chat(deps.endpoint, req.messages, { json: true });
          } catch (retryErr) {
            return this.fail(req, retryErr);
          }
        } else {
          return this.fail(req, err);
        }
      } else {
        // Timeout/sieć/inne HTTP: bez ponowienia (G9).
        return this.fail(req, err);
      }
    }

    // G10: walidacja odpowiedzi zodem wołającego — niezgodność to policzony błąd, nie wyjątek.
    const parsed = parseLlmJson(result.content, req.schema);
    if (!parsed.ok) {
      return this.fail(req, new Error(parsed.reason));
    }
    this.consecutiveFailures = 0;
    return { ok: true, value: parsed.value };
  }

  /** Skan źródeł (osobno) i — jako backstop — całej treści wiadomości. Zwraca `true`, gdy cokolwiek trafiło
   * (wtedy nic nie jest wysyłane). Zapisy audytu są best-effort: awaria audytu nie może wywrócić przebiegu. */
  private async scanOutgoing<T>(req: LlmCallRequest<T>): Promise<boolean> {
    const hits: SkippedSecretEntry[] = [];
    for (const source of req.sources) {
      const hit = scanForSecrets(source.text);
      if (hit) hits.push({ memoryId: source.memoryId, secretType: hit.kind });
    }
    if (hits.length === 0) {
      const backstop = scanForSecrets(req.messages.map((m) => m.content).join('\n'));
      if (!backstop) return false;
      // Trafienie tylko w złożonej treści (np. instrukcja systemowa) — nie wiemy, który wpis je wniósł,
      // więc przypisujemy wszystkim źródłom tego wywołania.
      for (const source of req.sources) hits.push({ memoryId: source.memoryId, secretType: backstop.kind });
    }
    for (const entry of hits) await this.recordSkippedSecret(entry, req.purpose);
    return true;
  }

  private async recordSkippedSecret(entry: SkippedSecretEntry, purpose: string): Promise<void> {
    // Jeden wpis w audycie i na liście na pamięć w przebiegu — ta sama pamięć bywa w wielu wywołaniach.
    if (this.secretSeen.has(entry.memoryId)) return;
    this.secretSeen.add(entry.memoryId);
    if (this.skippedSecret.length < LLM_SKIPPED_SECRET_LIST_MAX) this.skippedSecret.push(entry);
    const deps = this.deps;
    if (!deps) return;
    try {
      await deps.audit.log({
        eventType: 'llm_secret_skipped',
        actor: deps.actor,
        affectedIds: [entry.memoryId],
        metadata: { secretType: entry.secretType, purpose },
      });
    } catch (err) {
      (deps.logger ?? defaultLogger).warn(
        `[llm] nie udało się zapisać llm_secret_skipped dla ${entry.memoryId}: ${err instanceof Error ? err.message : 'błąd'}`,
      );
    }
  }

  private fail<T>(req: LlmCallRequest<T>, err: unknown): LlmCallOutcome<T> {
    this.recordFailure(req, err instanceof Error ? err.message : 'nieznany błąd');
    return { ok: false, reason: 'error' };
  }

  /** `message` pochodzi z błędów providera (status/opis przyczyny, już zredagowane) albo ze stałych
   * komunikatów parsera — nigdy z treści odpowiedzi modelu ani z treści pamięci. */
  private recordFailure<T>(req: LlmCallRequest<T>, message: string): void {
    this.c.llmErrors++;
    this.consecutiveFailures++;
    const ids = req.sources.map((s) => s.memoryId).join(',');
    (this.deps?.logger ?? defaultLogger).warn(
      `[llm] wywołanie nieudane (purpose=${req.purpose}, ids=${ids || '-'}): ${message}`,
    );
  }
}

const defaultLogger = new Logger('LlmRunBudget');
