# syntax=docker/dockerfile:1
# Multi-stage build dla @context-keeper/server (monorepo pnpm). Kontekst build = root repo.

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# `npm install -g` zamiast corepack: corepack prepare/--activate zapisuje stan aktywacji
# pod HOME usera, który go uruchomił (tu: root) — w runtime stage działamy jako `node`
# (inny HOME), więc corepack tej aktywacji nie widzi i przy KAŻDYM `pnpm ...` próbuje
# doinstalować pnpm z registry (a bez sieci/uprawnień do zapisu w /app to się wywala EACCES).
# Globalny `npm install -g` nie ma tego problemu — binarka jest dostępna dla każdego usera.
RUN npm install -g pnpm@10.33.2
WORKDIR /app

# --- build: pełna instalacja + kompilacja (dashboard PRZED server, §M5 planu Fazy 5 —
# `copy-dashboard.mjs` w server'owym `build` kopiuje apps/dashboard/dist -> dist/public) + wyodrębnienie paczki prod ---
FROM base AS build
COPY . /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @context-keeper/dashboard build
RUN pnpm --filter @context-keeper/server build
# `deploy` tworzy samodzielny katalog z dist + node_modules (tylko prod deps). `dist/public` (SPA) już
# jest wewnątrz apps/server/dist w tym momencie, więc jedzie razem z resztą paczki.
# --legacy: paczka nie ma cross-depów workspace, więc nie potrzebujemy injected deploy (pnpm 10).
RUN pnpm deploy --filter=@context-keeper/server --prod --legacy /prod/server

# --- runtime: chudy obraz z samą paczką prod ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /prod/server /app
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT_MCP||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
