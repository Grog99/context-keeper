import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serwuje SPA na własnym porcie z HMR; /api proxy do PORT_DASHBOARD backendu (§M2 planu
// Fazy 5 — "Dev: ... vite.config.ts proxies /api → http://localhost:${PORT_DASHBOARD}"). Prod: brak
// proxy, SPA i API dzielą origin (Nest serwuje statyki, M5).
const DASHBOARD_API_PORT = Number(process.env.VITE_API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${DASHBOARD_API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
