/** §11 design-systemu: "Czas: relatywny + absolutny w tooltipie". */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffSec = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (diffSec < 5) return 'przed chwilą';
  if (diffSec < 60) return `${diffSec}s temu`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min temu`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} godz. temu`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} dni temu`;
}

export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'medium' });
}

/** Wartość `<input type="datetime-local">` — LOKALNA strefa (roadmap v1.2, "kind=event episodic":
 * `event_time` domyślnie teraz przy tworzeniu, backdatable przy edycji, przyszłe daty dozwolone bez
 * walidacji blokującej — patrz `validateEventTime` po stronie serwera). `datetime-local` nie ma
 * strefy — budujemy string ręcznie z lokalnych składowych `Date`, żeby uniknąć przesunięcia UTC,
 * które dałoby `toISOString()` na maszynie z inną strefą niż przeglądarka.
 */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — klucz grupowania wg DNIA KALENDARZOWEGO
 * w strefie lokalnej przeglądarki (nie UTC — recenzent grupuje po swoim dniu, nie po dniu serwera). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Nagłówek dnia w grupowanej "Oś czasu" — np. "środa, 22 lipca 2026". */
export function formatDayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Godzina w obrębie dnia (wiersz eventu pod nagłówkiem dnia już niesie datę) — mono, tabular. */
export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
