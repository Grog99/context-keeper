import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
      'apps/server/src/db/migrations/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  // apps/dashboard-scoped (§M2 planu Fazy 5) — React/przeglądarka, ESM; reszta workspace'u to
  // Node/CommonJS (apps/server) i tych reguł/globalsów nie potrzebuje.
  {
    files: ['apps/dashboard/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks.configs.flat.recommended.plugins['react-hooks'],
      'react-refresh': reactRefresh.configs.vite.plugins['react-refresh'],
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...reactRefresh.configs.vite.rules,
    },
  },
  // shadcn/ui primitives (`components/ui/**`) i `lib/context.tsx` legalnie współeksportują
  // nie-komponentowe wartości obok komponentu (np. `buttonVariants` obok `Button`, hooki obok
  // Providera) — to utrwalony wzorzec (shadcn/ui, React Context), nie błąd; fast-refresh po prostu
  // traci stan HMR dla tych plików, co nie jest tu istotne.
  {
    files: ['apps/dashboard/src/components/ui/**/*.tsx', 'apps/dashboard/src/lib/context.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
