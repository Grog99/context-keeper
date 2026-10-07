import { AUTO_HOLD_REASONS, type AutoHoldReason, type SimilarMemoryHit } from '../db/schema';
import type { SaveMemoryKind } from './memory.types';

export interface AutoModeGuardInput {
  type: 'create' | 'update';
  kind: SaveMemoryKind;
  /** Wynik detekcji prawie-duplikatów (A1) — tylko `create` fact/document; `null` = nie policzono. */
  similar: SimilarMemoryHit[] | null;
  /** Czy staging embeddingu powstał (provider odpowiedział w budżecie). Bez niego auto-akceptacja dałaby
   * pamięć bez wektora (create) albo skasowała wektory celu korekty (update) — decyzja D1. */
  vectorStaged: boolean;
  /** Tylko `update`: cel ma `source='human'` albo kiedykolwiek miał `human_edit`. */
  humanTarget: boolean;
  /** Auto-akceptacje projektu w oknie 24 h (przed bieżącą) i limit projektu. */
  approvalsInWindow: number;
  dailyLimit: number;
}

/**
 * Bezpieczniki auto mode (roadmap v1.6, A2) — czysta funkcja decyzyjna: zwraca zbiór powodów, dla których
 * zapis ma ZOSTAĆ w kolejce (pusty = wolno auto-zatwierdzić). Kolejność wyniku = kolejność
 * `AUTO_HOLD_REASONS`. `auto_failed` nigdy nie wychodzi stąd — ustawia je wyłącznie `catch` w
 * `MemoryService.decideAutoMode`.
 * - `near_duplicate` (a): create fact/document z niepustym `similar` (event wyłączony — G2/G4, korekta ma (b)),
 * - `not_computed` (a′): create fact/document bez sygnału (`similar===null`) ORAZ — D1 — każdy zapis
 *   (też event i update) bez staging wektora,
 * - `human_target` (b): korekta treści napisanej/poprawionej przez człowieka,
 * - `daily_limit` (c): limit okna 24 h wyczerpany.
 */
export function evaluateAutoModeGuards(input: AutoModeGuardInput): AutoHoldReason[] {
  const { type, kind } = input;
  const isFactOrDocCreate = type === 'create' && kind !== 'event';
  const reasons = new Set<AutoHoldReason>();

  if (isFactOrDocCreate && input.similar !== null && input.similar.length > 0) reasons.add('near_duplicate');
  if ((isFactOrDocCreate && input.similar === null) || !input.vectorStaged) reasons.add('not_computed');
  if (type === 'update' && input.humanTarget) reasons.add('human_target');
  if (input.approvalsInWindow >= input.dailyLimit) reasons.add('daily_limit');

  return AUTO_HOLD_REASONS.filter((r) => reasons.has(r));
}
