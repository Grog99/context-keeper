import { useQuery } from '@tanstack/react-query';
import { Folder, Info, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyBlock } from '../components/CopyBlock';
import { EmptyState } from '../components/EmptyState';
import { ScreenContainer } from '../components/ScreenContainer';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
import { useActiveContext } from '../lib/context';
import { queryKeys } from '../lib/query';
import type { AccountTokenApi, OnboardingApi, ProjectListItem } from '../types/api';

/** Placeholdery w blokach env/CLI — realny token pokazuje wyłącznie `TokenReveal` po wydaniu. */
const ENV_BLOCK = `# Windows (PowerShell / cmd)
setx CONTEXT_KEEPER_TOKEN "ck_…"

# macOS / Linux (profil shella)
export CONTEXT_KEEPER_TOKEN=ck_…`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono">{children}</code>;
}

/**
 * Ekran "Onboarding" (roadmap v1.2, przebudowa v1.5) — bloki do wklejenia w dowolnym zewnętrznym repo,
 * żeby podpiąć je pod TĘ instancję Context Keepera. Wszystkie teksty (`.mcp.json` z nagłówkiem projektu,
 * `AGENTS.md`, `CLAUDE.md`, wariant tokenu projektowego) renderuje SERWER (`GET /api/onboarding`, jedno
 * źródło z narzędziami MCP `list_projects`/`create_project`) — SPA ich nie duplikuje. Model domyślny:
 * token konta w zmiennej środowiskowej (raz na maszynę) + commitowany `.mcp.json` z nagłówkiem
 * `X-Context-Keeper-Project` per repo. Ekran NIGDY nie pokazuje wartości tokenu: tokeny konta wydaje się
 * w Projekty → Tokeny konta (albo CLI), a lista tutaj niesie wyłącznie etykiety.
 */
export function OnboardingScreen() {
  const { active } = useActiveContext();
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);

  const onboardingQuery = useQuery({
    queryKey: queryKeys.onboarding(),
    queryFn: () => api.get<OnboardingApi>('/onboarding'),
  });
  const accountTokensQuery = useQuery({
    queryKey: queryKeys.accountTokens(),
    queryFn: () => api.get<AccountTokenApi[]>('/account-tokens'),
  });
  // Tylko do zmapowania aktywnego projektu z przełącznika kontekstu (id → slug) dla domyślnego wyboru.
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const onboarding = onboardingQuery.data;
  const projects = onboarding?.projects ?? [];
  const contextSlug =
    active.kind === 'project' ? (projectsQuery.data?.find((p) => p.id === active.projectId)?.slug ?? null) : null;
  const selected =
    projects.find((p) => p.slug === chosenSlug) ??
    projects.find((p) => p.slug === contextSlug) ??
    projects[0] ??
    null;

  const usableAccountTokens = (accountTokensQuery.data ?? []).filter(
    (t) => t.effectiveStatus === 'active' || t.effectiveStatus === 'grace',
  );

  return (
    <ScreenContainer width="prose">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Onboarding</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Gotowe bloki do podpięcia zewnętrznego repo pod tę instancję Context Keepera: token konta ustawiasz raz na
        maszynie, a każde repo wskazuje swój projekt nagłówkiem w commitowanym <Mono>.mcp.json</Mono>.
      </p>

      {onboardingQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !onboarding ? (
        <EmptyState title="Nie udało się pobrać danych onboardingu" description="Odśwież stronę i spróbuj ponownie." />
      ) : (
        <div className="flex flex-col gap-5">
          {!onboarding.mcpUrlConfigured && (
            <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-2.5 py-2 text-xs text-warning-foreground">
              <Info className="mt-0.5 size-[15px] shrink-0 text-warning" />
              Nie skonfigurowano publicznego URL-a MCP — ustaw <Mono>PUBLIC_MCP_URL</Mono> w <Mono>.env</Mono> (albo
              podmień placeholder <Mono>{onboarding.mcpUrl}</Mono> ręcznie poniżej po skopiowaniu).
            </div>
          )}

          <Section title="1. Setup globalny (raz na maszynę)">
            {accountTokensQuery.isLoading ? (
              <Skeleton className="mb-3 h-10 w-full" />
            ) : usableAccountTokens.length === 0 ? (
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Nie masz jeszcze tokenu konta.</span> Wydaj go w{' '}
                <Link to="/projekty" className="underline decoration-dotted hover:decoration-solid">
                  Projekty → Tokeny konta
                </Link>{' '}
                albo z CLI: <Mono>create-account-token &lt;label&gt;</Mono>. Token pokazujemy tylko raz — zapisz go od
                razu.
              </p>
            ) : (
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Aktywne tokeny konta:{' '}
                <span className="font-mono text-foreground">{usableAccountTokens.map((t) => t.label).join(', ')}</span>.
                Wartość tokenu jest widoczna tylko raz, przy wydaniu — jeśli ją zgubiłeś, zrotuj token w{' '}
                <Link to="/projekty" className="underline decoration-dotted hover:decoration-solid">
                  Projekty → Tokeny konta
                </Link>
                .
              </p>
            )}
            <div className="mb-3 flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-2.5 py-2 text-xs text-warning-foreground">
              <ShieldAlert className="mt-0.5 size-[15px] shrink-0 text-warning" />
              Token konta daje odczyt i zapis we wszystkich projektach instancji — trzymaj go wyłącznie w swojej
              zmiennej środowiskowej; do CI i dla współpracowników użyj tokenu projektowego (sekcja 5).
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              Ustaw zmienną środowiskową z tokenem (raz, globalnie — nigdy w repo):
            </p>
            <CopyBlock label="zmienna środowiskowa" code={ENV_BLOCK} copyLabel="Kopiuj ustawienie zmiennej" className="mb-3" />
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">Adres serwera MCP:</p>
            <CopyBlock label="Adres MCP" code={onboarding.mcpUrl} copyLabel="Kopiuj adres MCP" className="mb-3" />

            <h3 className="mb-1 text-xs font-semibold text-foreground">Opcjonalnie: wpis globalny w Claude Code</h3>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              Pozwala agentowi w jeszcze nieskonfigurowanym repo wywołać <Mono>list_projects</Mono> /{' '}
              <Mono>create_project</Mono>. To krok opcjonalny — domyślna ścieżka to sam <Mono>.mcp.json</Mono> w repo.
              Token ląduje w <Mono>~/.claude.json</Mono> jako zwykły tekst. Nazwa serwera musi być dokładnie{' '}
              <Mono>{onboarding.serverName}</Mono> — repo z własnym <Mono>.mcp.json</Mono> o tej samej nazwie
              nadpisuje ten wpis w całości (zakres projektu wygrywa, nagłówki nie są scalane); wpis zakresu lokalnego
              przesłaniałby z kolei plik z repo.
            </p>
            <CopyBlock
              label="claude mcp add"
              code={`claude mcp add --transport http --scope user ${onboarding.serverName} ${onboarding.mcpUrl} --header "Authorization: Bearer ck_…"`}
              copyLabel="Kopiuj komendę claude mcp add"
            />
          </Section>

          <Section title="2. Repo — wybrany projekt (.mcp.json z nagłówkiem)">
            {selected === null ? (
              <EmptyState
                icon={Folder}
                title="Brak projektów"
                description="Utwórz projekt w Projekty → Nowy projekt albo poproś agenta z tokenem konta o create_project i zatwierdź propozycję w Kolejce."
                action={
                  <Link to="/projekty" className="text-xs font-semibold text-primary underline">
                    Przejdź do Projektów →
                  </Link>
                }
              />
            ) : (
              <>
                <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                  Wybierz projekt, który obsługuje to repo, i zacommituj plik <Mono>.mcp.json</Mono> — token zostaje
                  w zmiennej <Mono>CONTEXT_KEEPER_TOKEN</Mono>, nie w pliku. Tekst jest identyczny z tym, co zwraca
                  narzędzie MCP <Mono>list_projects</Mono>.
                </p>
                <Select value={selected.slug} onValueChange={setChosenSlug}>
                  <SelectTrigger className="mb-3 h-8 max-w-sm gap-1.5 px-2.5 text-xs" aria-label="Projekt repo">
                    <SelectValue placeholder="projekt" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.name} ({p.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <CopyBlock label=".mcp.json" code={selected.mcpJson} copyLabel="Kopiuj blok .mcp.json" />
              </>
            )}
          </Section>

          <Section title="3. Snippet AGENTS.md">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Do wklejenia w <Mono>AGENTS.md</Mono> onboardowanego repo — po angielsku (treść adresowana do dowolnego
              agenta LLM, nie tylko polskojęzycznego).
            </p>
            <CopyBlock label="AGENTS.md" code={onboarding.agentsMd} copyLabel="Kopiuj snippet AGENTS.md" />
          </Section>

          <Section title="4. Notatka dla Claude Code (CLAUDE.md)">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Claude Code nie wczytuje <Mono>AGENTS.md</Mono> automatycznie — zaciągnij go z <Mono>CLAUDE.md</Mono>.
              Codex/Cursor czytają <Mono>AGENTS.md</Mono> bezpośrednio, ten krok pomiń.
            </p>
            <CopyBlock label="CLAUDE.md" code={onboarding.claudeMd} copyLabel="Kopiuj notatkę CLAUDE.md" />
          </Section>

          <Section title="5. Token projektowy (CI / współpracownik / pojedyncze repo)">
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Token projektowy wskazuje projekt sam — <Mono>.mcp.json</Mono> bez nagłówka{' '}
              <Mono>X-Context-Keeper-Project</Mono>, ta sama zmienna <Mono>CONTEXT_KEEPER_TOKEN</Mono>. Wydasz go w{' '}
              <Link to="/projekty" className="underline decoration-dotted hover:decoration-solid">
                Projekty → Tokeny
              </Link>{' '}
              przy wybranym projekcie. Istniejące repo z takim <Mono>.mcp.json</Mono> działają bez zmian.
            </p>
            <CopyBlock
              label=".mcp.json (token projektowy)"
              code={onboarding.projectTokenMcpJson}
              copyLabel="Kopiuj .mcp.json dla tokenu projektowego"
            />
          </Section>

          <Section title="6. Na koniec">
            <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
              <li>Zrestartuj terminal i klienta MCP, przy pierwszym uruchomieniu zaakceptuj serwer.</li>
              <li>
                Zweryfikuj: <Mono>curl {onboarding.mcpUrl.replace(/\/mcp$/, '/health')}</Mono> powinno zwrócić{' '}
                <Mono>{'{"status":"ok",...}'}</Mono> (publiczny endpoint, bez tokenu).
              </li>
            </ol>
          </Section>
        </div>
      )}
    </ScreenContainer>
  );
}
