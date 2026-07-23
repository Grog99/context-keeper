import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

/** Klucze zapytań scentralizowane (unikaj literałów w komponentach — łatwiej invalidateQueries po mutacji). */
export const queryKeys = {
  session: () => ['session'] as const,
  proposals: (filter: Record<string, unknown>) => ['proposals', filter] as const,
  proposal: (id: string) => ['proposals', id] as const,
  memories: (filter: Record<string, unknown>) => ['memories', filter] as const,
  memory: (id: string) => ['memories', id] as const,
  memoryRevisions: (id: string) => ['memories', id, 'revisions'] as const,
  memoryPurgePreview: (id: string) => ['memories', id, 'purge-preview'] as const,
  /** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — `GET /api/memories/events`. */
  events: (filter: Record<string, unknown>) => ['memories', 'events', filter] as const,
  projects: () => ['projects'] as const,
  audit: (filter: Record<string, unknown>) => ['audit', filter] as const,
  metrics: () => ['metrics'] as const,
  usage: (filter: Record<string, unknown>) => ['metrics', 'usage', filter] as const,
  config: () => ['config'] as const,
};
