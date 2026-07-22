import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest 4 transformuje przez oxc, który czyta experimentalDecorators z tsconfig.json.
  // Testy instancjonują serwisy ręcznie (bez kontenera DI Nesta), więc metadata nie jest potrzebna.
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    hookTimeout: 300_000, // pull + start kontenera pgvector
    testTimeout: 120_000,
  },
});
