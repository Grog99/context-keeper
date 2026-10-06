/**
 * Stałe kroku LLM nocnego joba (roadmap v1.6, ticket `nightly-llm-provider`). Wartości domyślne cap/timeout
 * to PUNKT STARTOWY (G1/G11) — B2 dostraja je na realnym użyciu, C1 pod skalę wielu projektów. Zakresy
 * (`*_MAX`/`*_MIN`) są jednym źródłem prawdy dla CHECK-ów w migracji, schematu REST i walidacji serwisu.
 */

/** Domyślny sufit liczby ŻĄDAŃ HTTP do modelu na przebieg (retry wlicza się; G9/G11) — niezależny od
 * `NIGHTLY_MAX_PROPOSALS_PER_RUN`, bo wywołanie z werdyktem „zostaw" kosztuje tyle samo i nie daje proposala. */
export const LLM_DEFAULT_CALL_CAP = 100;
/** Domyślny timeout pojedynczego żądania (G11). */
export const LLM_DEFAULT_TIMEOUT_MS = 30_000;
export const LLM_CALL_CAP_MIN = 1;
export const LLM_CALL_CAP_MAX = 10_000;
export const LLM_TIMEOUT_MIN_MS = 1_000;
export const LLM_TIMEOUT_MAX_MS = 300_000;

/** Bezpiecznik (G8): po tylu KOLEJNYCH błędach logicznych wywołań reszta przebiegu pomija LLM. Martwy
 * provider kosztuje wtedy `K × timeout`, nie `cap × timeout` pod advisory lockiem. */
export const LLM_BREAKER_THRESHOLD = 3;

/** Retry na 429/503 (G9): domyślny backoff gdy brak `Retry-After`, i górny limit dla `Retry-After`. */
export const LLM_RETRY_DEFAULT_WAIT_MS = 1_000;
export const LLM_RETRY_MAX_WAIT_MS = 10_000;

/** Ile wpisów pominiętych przez skaner sekretów trafia na listę w `nightly_run.metadata.llm` (G13) —
 * zdarzenia audytu są pisane bez tego limitu; limit chroni tylko rozmiar jednego wiersza metadanych. */
export const LLM_SKIPPED_SECRET_LIST_MAX = 200;

/** AAD szyfrowania klucza API (`common/secret-box.ts`) — szyfrogram z innej kolumny/sekretu się nie odszyfruje. */
export const LLM_API_KEY_AAD = 'llm_settings.api_key';

/** Id wiersza instancji w `llm_settings` (`project_id IS NULL`); wiersze per projekt (przyszłość) dostają `generateId`. */
export const LLM_GLOBAL_SETTINGS_ID = 'global';
