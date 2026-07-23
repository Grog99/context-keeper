/**
 * Age-decay dla `kind=event` w rankingu retrievalu (roadmap v1.2, "kind=event episodic").
 * Post-RRF re-scoring w `MemoryService.search()`: `effectiveScore = rrfScore * decayFactor`.
 * Czysta funkcja — bez DB/IO, żeby była bezpośrednio testowalna jednostkowo (jak `rrf.ts`).
 *
 * Wykładniczy half-life: `decayFactor(age=0) = 1`, `decayFactor(age=halflife) = 0.5`,
 * `decayFactor(age=2·halflife) = 0.25`, ściśle malejący wraz z wiekiem.
 *
 * Przyszłe `event_time` (ujemny wiek — backdating "w drugą stronę", user-decyzja: dozwolone bez
 * walidacji blokującej) → surowy faktor > 1 → **clamp do 1**, nigdy bonus rankingowy ponad "świeże
 * teraz". `eventTime = null` (nie powinno się zdarzyć — `event_time` wymuszony przy tworzeniu przez
 * `validateEventTime`, ale defensywnie) → też 1, zamiast dzielenia przez brakującą wartość.
 */
export function eventDecayFactor(eventTime: Date | null, now: Date, halflifeDays: number): number {
  if (!eventTime) return 1;
  const ageDays = (now.getTime() - eventTime.getTime()) / 86_400_000;
  return Math.min(1, Math.pow(0.5, ageDays / halflifeDays));
}
