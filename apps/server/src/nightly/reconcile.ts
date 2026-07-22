import { conditionKey, type DetectedCondition, type NightlyConditionType } from './nightly.types';

/** Pending `origin='nightly'` proposal z poprzednich przebiegów, z prekalkulowanym `stale`
 * (`computeStaleIds` z `ProposalsService`, liczone przez wołającego PRZED wywołaniem `reconcile` —
 * ta funkcja zostaje pure, bez dostępu do DB, testowalna w izolacji, plan §2 "reconcile.ts"). */
export interface ExistingNightlyProposal {
  id: string;
  type: NightlyConditionType;
  affectedIds: string[];
  stale: boolean;
}

export interface ReconcileResult {
  toCreate: DetectedCondition[];
  /** Id-y proposali do wycofania jako "orphan" — sprzątanie BEZ odpowiadającego create (warunek już
   * w ogóle nie zachodzi w `detected`). Zawsze bezpieczne do zastosowania w pełni, niezależnie od
   * ewentualnego capa na `toCreate` — orphan withdraw nie ma z czym być sparowany. */
  toWithdraw: string[];
  /** `conditionKey -> id` istniejącego proposala, który jest STALE i ma dopasowany świeży warunek w
   * `toCreate` pod tym samym kluczem ("replace" — treść/wersje się zmieniły od poprzedniego
   * przebiegu). Withdraw starego wpisu i create nowego dla tego samego klucza to PARA, którą wołający
   * musi zastosować ATOMOWO: jeśli `cond` o danym `conditionKey` zostanie ucięty przez flood cap na
   * `toCreate`, odpowiadający mu wpis w tej mapie NIE MOŻE zostać zastosowany samodzielnie — stary
   * proposal zostaje pending, para jest odkładana w całości do kolejnego stateless re-scanu (żadnego
   * osierocenia warunku w kolejce). */
  replacements: Map<string, string>;
  /** Id-y proposali, które dopasowały aktualny warunek i są wciąż aktualne (bez akcji). */
  skipped: string[];
}

/**
 * Tabela decyzji dla bezstanowego self-cleaning re-scanu (plan §1 "Idempotentny self-cleaning
 * re-scan"), dopasowanie po `conditionKey` = `(type, sorted affectedIds)`:
 *
 *  - dopasowany istniejący + aktualny  -> skip (nic się nie zmieniło od poprzedniego przebiegu)
 *  - dopasowany istniejący + stale     -> "replace": wpis w `replacements` (stary id) + `cond` w
 *    `toCreate` (treść/wersje się zmieniły) — para do zastosowania atomowo przez wołającego
 *  - brak dopasowania w `existing`     -> create (nowo wykryty warunek)
 *  - istniejący bez dopasowania w `detected` (orphan — warunek już nie zachodzi, np. archiwizacja
 *    członka poza kolejką, albo politeness gate go odfiltrował) -> `toWithdraw` (bezwarunkowo)
 *
 * Każdy `existing` proposal dopasowuje się do co najwyżej jednego `detected` (klucz jest unikalny
 * z definicji — jeden warunek = jeden `conditionKey`), więc `toWithdraw`/`replacements`/`toCreate`/
 * `skipped` się nie nakładają. Ta funkcja NIE zna capa na `toCreate` (pure, bez DB) — to wołający
 * (`NightlyService`) odpowiada za sparowanie `replacements` z przetrwałymi po capie `toCreate` i za
 * pominięcie pary, której `cond` został ucięty.
 */
export function reconcile(
  detected: DetectedCondition[],
  existing: ExistingNightlyProposal[],
): ReconcileResult {
  const existingByKey = new Map<string, ExistingNightlyProposal>();
  for (const e of existing) {
    existingByKey.set(conditionKey(e.type, e.affectedIds), e);
  }

  const matchedIds = new Set<string>();
  const toCreate: DetectedCondition[] = [];
  const toWithdraw: string[] = [];
  const replacements = new Map<string, string>();
  const skipped: string[] = [];

  for (const cond of detected) {
    const match = existingByKey.get(cond.conditionKey);
    if (!match) {
      toCreate.push(cond);
      continue;
    }
    matchedIds.add(match.id);
    if (match.stale) {
      replacements.set(cond.conditionKey, match.id);
      toCreate.push(cond);
    } else {
      skipped.push(match.id);
    }
  }

  for (const e of existing) {
    if (!matchedIds.has(e.id)) {
      toWithdraw.push(e.id);
    }
  }

  return { toCreate, toWithdraw, replacements, skipped };
}
