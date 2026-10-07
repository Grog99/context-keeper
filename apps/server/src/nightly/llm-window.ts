const DAY_MS = 24 * 60 * 60_000;

/** Początek okna przeglądu LLM (G6, ust. 5): `now − days` dób; granica WŁĄCZNA (`createdAt >= start`).
 * Wspólne dla detektorów B2 (prune) i B3 (conflicts) — okno czytane z `LlmRunBudget.scanWindowDays`. */
export function llmWindowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Fakty z okna (po `createdAt`), bez id z żadnego ze zbiorów `exclude`, w stabilnej kolejności
 * `createdAt ASC, id ASC` — deterministyczne obcięcie capem wywołań: najstarsze (te, które najszybciej
 * wypadną z okna) idą pierwsze. Czysta funkcja, bez dostępu do DB.
 */
export function selectWindowFacts<T extends { id: string; createdAt: Date }>(
  facts: readonly T[],
  opts: { windowStart: Date; exclude: ReadonlyArray<ReadonlySet<string>> },
): T[] {
  const startMs = opts.windowStart.getTime();
  return facts
    .filter((f) => f.createdAt.getTime() >= startMs && !opts.exclude.some((set) => set.has(f.id)))
    .sort((a, b) => {
      const dt = a.createdAt.getTime() - b.createdAt.getTime();
      if (dt !== 0) return dt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
