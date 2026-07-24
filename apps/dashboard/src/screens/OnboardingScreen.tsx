import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { CopyBlock } from '../components/CopyBlock';
import { ScreenContainer } from '../components/ScreenContainer';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query';
import type { DashboardLimits } from '../types/api';

const MCP_HOST_PLACEHOLDER = 'https://<your-mcp-host>';

/** Snippet do wklejenia w `AGENTS.md` (Codex/Cursor czytają bezpośrednio, Claude Code przez
 * `@AGENTS.md` w CLAUDE.md — patrz Blok 3) dowolnego zewnętrznego repo, które ma dogfoodować TĘ
 * instancję Context Keepera. English (per konwencja `mcp-tool-contract.md` — treść adresowana do
 * dowolnego agenta LLM, nie tylko polskojęzycznych), uogólniony z `AGENTS.md` tego repo. */
const AGENTS_SNIPPET = `## Project memory — Context Keeper (MCP)

This project uses a Context Keeper instance as shared, persistent, human-gated
project memory, exposed as an MCP server named \`context-keeper\`. Tools:
\`search_memory\`, \`get_memory\`, \`save_memory\`. Each tool's own MCP description
carries the full contract (writes are human-gated, secrets are rejected, return
statuses) — this snippet only covers when to reach for them and what to store.

Work proactively:
- At the START of a task, call \`search_memory\` to pull relevant project context
  (decisions, conventions, environment specifics) before you start guessing.
- When a non-obvious decision, fact, or convention comes up, propose it with
  \`save_memory\` yourself — don't wait to be asked.

What to save, and as which kind:
- \`fact\` (the default) — one atomic, self-contained fact: a decision, a team
  convention, a "why", a deployment specific.
- \`document\` — a longer, self-contained reference saved whole (a decision record,
  a spec, a convention writeup). Pass \`kind: "document"\`.
- To fix something already in memory, find it via \`search_memory\` and re-save it
  with \`supersedes: <id>\` — your new header+body replace it in place — rather than
  adding a near-duplicate.
- \`event\` memories are human-only; you can't create them.

Memory hygiene:
- Save only what you can't derive from the repo — decisions, team conventions,
  the "why", deployment specifics. Don't store what's already in the README, docs,
  or code.`;

/** Notatka dla Claude Code (nie czyta `AGENTS.md` automatycznie, w odróżnieniu od Codex/Cursor) —
 * dokładnie ten sam mechanizm co `CLAUDE.md` tego repo. */
const CLAUDE_NOTE = `# CLAUDE.md
@AGENTS.md`;

/** Buduje `.mcp.json` (kształt tego repo — `type: "http"` + `Authorization: Bearer <placeholder>`).
 * `JSON.stringify` nad zwykłym stringiem (nie template literal) celowo — `Authorization` MUSI
 * wylądować w schowku jako literalny placeholder `${CONTEXT_KEEPER_TOKEN}`, nie zinterpolowany
 * string. */
function buildMcpJsonBlock(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'context-keeper': {
          type: 'http',
          url: mcpUrl,
          headers: {
            Authorization: 'Bearer ${CONTEXT_KEEPER_TOKEN}',
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Ekran "Onboarding" (roadmap v1.2, Warstwa 2) — trzy copy-able bloki (snippet AGENTS.md, blok
 * `.mcp.json`, notatka CLAUDE.md) + polskie kroki setupu, do wklejenia w DOWOLNE zewnętrzne repo,
 * żeby podpiąć je pod TĘ instancję Context Keepera. Bez selektora projektu — URL MCP jest
 * instance-wide, nie per-projekt (locked task decision). Publiczny URL rozwiązywany server-side
 * (`GET /api/config` -> `mcpPublicUrl`, `ConfigController.resolveMcpPublicUrl`); `null` renderuje
 * placeholder `https://<your-mcp-host>` + notatkę poniżej.
 */
export function OnboardingScreen() {
  const { data } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => api.get<DashboardLimits>('/config'),
    staleTime: 5 * 60_000,
  });

  const base = data?.mcpPublicUrl ?? null;
  const mcpUrl = base ? `${base}/mcp` : `${MCP_HOST_PLACEHOLDER}/mcp`;
  const healthUrl = base ? `${base}/health` : `${MCP_HOST_PLACEHOLDER}/health`;
  const mcpJsonBlock = buildMcpJsonBlock(mcpUrl);

  return (
    <ScreenContainer width="prose">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Onboarding</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Gotowe bloki do wklejenia w dowolnym zewnętrznym repo, żeby podpiąć je pod tę instancję Context Keepera
        jako trwałą, human-gated pamięć projektu.
      </p>

      <div className="flex flex-col gap-5">
        {base === null && (
          <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-2.5 py-2 text-xs text-warning-foreground">
            <Info className="mt-0.5 size-[15px] shrink-0 text-warning" />
            Nie skonfigurowano publicznego URL-a MCP — ustaw <code className="font-mono">PUBLIC_MCP_URL</code> w{' '}
            <code className="font-mono">.env</code> (albo podmień placeholder <code className="font-mono">{MCP_HOST_PLACEHOLDER}</code>{' '}
            ręcznie poniżej po skopiowaniu).
          </div>
        )}

        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">1. Kroki setupu</h2>
          <ol className="mb-1 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
            <li>
              Utwórz projekt i token w dashboardzie (Projekty → Nowy projekt) — token pokazujemy tylko raz, zapisz go
              od razu.
            </li>
            <li>
              Ustaw zmienną środowiskową <code className="font-mono">CONTEXT_KEEPER_TOKEN</code> w repo, które
              onboardujesz (<code className="font-mono">setx</code> na Windows / <code className="font-mono">export</code>{' '}
              w profilu shella) — token nigdy nie trafia do repo.
            </li>
            <li>
              Dodaj Blok 2 poniżej do <code className="font-mono">.mcp.json</code> w tamtym repo.
            </li>
            <li>
              Wklej Blok 1 (snippet <code className="font-mono">AGENTS.md</code>) do{' '}
              <code className="font-mono">AGENTS.md</code> tamtego repo — dla Claude Code dodaj też Blok 3 do{' '}
              <code className="font-mono">CLAUDE.md</code>.
            </li>
            <li>Zrestartuj terminal i klienta MCP, przy pierwszym uruchomieniu zaakceptuj serwer.</li>
            <li>
              Zweryfikuj: <code className="font-mono">curl {healthUrl}</code> powinno zwrócić{' '}
              <code className="font-mono">{'{"status":"ok",...}'}</code> (publiczny endpoint, bez tokenu).
            </li>
          </ol>
        </section>

        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">2. Blok 1 — snippet AGENTS.md / CLAUDE.md</h2>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Do wklejenia w <code className="font-mono">AGENTS.md</code> onboardowanego repo — po angielsku (treść
            adresowana do dowolnego agenta LLM, nie tylko polskojęzycznego).
          </p>
          <CopyBlock label="AGENTS.md" code={AGENTS_SNIPPET} copyLabel="Kopiuj snippet AGENTS.md" />
        </section>

        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">3. Blok 2 — połączenie .mcp.json</h2>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            <code className="font-mono">{'${CONTEXT_KEEPER_TOKEN}'}</code> to placeholder — MCP-klient podstawia
            realną wartość ze zmiennej środowiskowej, nigdy nie wpisuj tokenu wprost do pliku.
          </p>
          <CopyBlock label=".mcp.json" code={mcpJsonBlock} copyLabel="Kopiuj blok .mcp.json" />
        </section>

        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">4. Blok 3 — notatka dla Claude Code</h2>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Claude Code nie wczytuje <code className="font-mono">AGENTS.md</code> automatycznie — zaciągnij go z{' '}
            <code className="font-mono">CLAUDE.md</code>. Codex/Cursor czytają <code className="font-mono">AGENTS.md</code>{' '}
            bezpośrednio, ten krok pomiń.
          </p>
          <CopyBlock label="CLAUDE.md" code={CLAUDE_NOTE} copyLabel="Kopiuj notatkę CLAUDE.md" />
        </section>
      </div>
    </ScreenContainer>
  );
}
