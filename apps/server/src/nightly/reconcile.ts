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
  toWithdraw: string[];
  /** Id-y proposali, które dopasowały aktualny warunek i są wciąż aktualne (bez akcji). */
  skipped: string[];
}

/**
 * Tabela decyzji dla bezstanowego self-cleaning re-scanu (plan §1 "Idempotentny self-cleaning
 * re-scan"), dopasowanie po `conditionKey` = `(type, sorted affectedIds)`:
 *
 *  - dopasowany istniejący + aktualny  -> skip (nic się nie zmieniło od poprzedniego przebiegu)
 *  - dopasowany istniejący + stale     -> withdraw starego + create nowego (treść/wersje się zmieniły)
 *  - brak dopasowania w `existing`     -> create (nowo wykryty warunek)
 *  - istniejący bez dopasowania w `detected` (orphan — warunek już nie zachodzi, np. archiwizacja
 *    członka poza kolejką, albo politeness gate go odfiltrował) -> withdraw
 *
 * Każdy `existing` proposal dopasowuje się do co najwyżej jednego `detected` (klucz jest unikalny
 * z definicji — jeden warunek = jeden `conditionKey`), więc `toWithdraw`/`toCreate`/`skipped` się
 * nie nakładają.
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
  const skipped: string[] = [];

  for (const cond of detected) {
    const match = existingByKey.get(cond.conditionKey);
    if (!match) {
      toCreate.push(cond);
      continue;
    }
    matchedIds.add(match.id);
    if (match.stale) {
      toWithdraw.push(match.id);
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

  return { toCreate, toWithdraw, skipped };
}
