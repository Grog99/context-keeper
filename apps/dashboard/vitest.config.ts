import { defineConfig } from 'vitest/config';

// Testy dashboardu to czyste funkcje z `src/lib/` — środowisko node, bez jsdom (testing.md §8).
// Osobny plik zamiast bloku `test` w `vite.config.ts`: config buildu SPA (plugin React, proxy) zostaje nietknięty.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
