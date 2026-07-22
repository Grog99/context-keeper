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
