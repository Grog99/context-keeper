import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleOff, KeyRound, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { EmptyState } from '../components/EmptyState';
import { ScreenContainer } from '../components/ScreenContainer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import type {
  LlmApiKeyAction,
  LlmCheckResult,
  LlmRunState,
  LlmSettings,
  LlmSettingsResponse,
  LlmSettingsUpdate,
} from '../types/api';

// Klient-side mirror zakresów (`apps/server/src/llm/llm.constants.ts`) — TYLKO do wyłączenia „Zapisz" i
// podpowiedzi przy polu; serwer zostaje authoritative (komunikat błędu zawsze z API).
const CALL_CAP_MIN = 1;
const CALL_CAP_MAX = 10_000;
const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 300;
const WINDOW_MIN_DAYS = 1;
const WINDOW_MAX_DAYS = 365;

const RUN_STATE_LABEL: Record<LlmRunState, string> = {
  disabled: 'wyłączony',
  ready: 'włączony',
  key_unreadable: 'klucz nieczytelny',
  unavailable: 'ustawienia niedostępne',
};

function parseIntStrict(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/**
 * Ekran „Ustawienia" (roadmap v1.6, §9.9 design-systemu) — ustawienia instancji; dziś jedna sekcja,
 * „Model LLM" (opcjonalny krok LLM nocnego joba). Ignoruje `ContextSwitcher` (ustawienia są globalne).
 * Klucz API jest write-only: ekran widzi tylko stan `none | set | unreadable`, a wpisana wartość żyje
 * wyłącznie w lokalnym stanie pola (nigdy w cache'u React Query) i znika po zapisie.
 */
export function UstawieniaScreen() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.llmSettings(),
    queryFn: () => api.get<LlmSettingsResponse>('/settings/llm'),
  });

  return (
    <ScreenContainer width="prose">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Ustawienia</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Ustawienia całej instancji — poza kontekstem projektu. Zmiany działają od następnego przebiegu, bez redeployu.
      </p>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Model LLM</h2>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          Opcjonalny krok nocnego joba, który zapyta model językowy o werdykt. Domyślnie wyłączony — bez niego job
          działa dokładnie jak dotąd.
        </p>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError || !data ? (
          <div role="alert" className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger-foreground">
            Nie udało się wczytać ustawień.{' '}
            <button type="button" className="font-semibold underline" onClick={() => refetch()}>
              Ponów
            </button>
          </div>
        ) : (
          <>
            {/* `key`: po zapisie `updatedAt` się zmienia → formularz startuje od zera z zapisanych wartości
                (czyści też pole klucza i wynik „Sprawdź połączenie", które dotyczyły starej konfiguracji). */}
            <LlmForm key={data.settings.updatedAt ?? 'initial'} settings={data.settings} />
            <LastRun lastRun={data.lastRun} />
          </>
        )}
      </section>
    </ScreenContainer>
  );
}

function StatusLine({ settings }: { settings: LlmSettings }) {
  if (settings.apiKey === 'unreadable') {
    return (
      <Badge variant="danger">
        <KeyRound className="size-3" />
        Klucz nieczytelny — wpisz ponownie
      </Badge>
    );
  }
  if (settings.enabled) {
    return (
      <Badge variant="success">
        <CircleCheck className="size-3" />
        Włączony
        <span className="font-mono normal-case tracking-normal">· {settings.model}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="neutral">
      <CircleOff className="size-3" />
      Wyłączony
    </Badge>
  );
}

function LlmForm({ settings }: { settings: LlmSettings }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? '');
  const [model, setModel] = useState(settings.model ?? '');
  const [callCap, setCallCap] = useState(String(settings.callCap));
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round(settings.timeoutMs / 1000)));
  const [windowDays, setWindowDays] = useState(String(settings.scanWindowDays));
  const [keyMode, setKeyMode] = useState<'keep' | 'set' | 'clear'>('keep');
  const [keyValue, setKeyValue] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [checkResult, setCheckResult] = useState<LlmCheckResult | null>(null);

  const capNum = parseIntStrict(callCap);
  const timeoutNum = parseIntStrict(timeoutSec);
  const capValid = capNum !== null && capNum >= CALL_CAP_MIN && capNum <= CALL_CAP_MAX;
  const timeoutValid = timeoutNum !== null && timeoutNum >= TIMEOUT_MIN_S && timeoutNum <= TIMEOUT_MAX_S;
  const windowNum = parseIntStrict(windowDays);
  const windowValid = windowNum !== null && windowNum >= WINDOW_MIN_DAYS && windowNum <= WINDOW_MAX_DAYS;
  const keyValid = keyMode !== 'set' || keyValue.trim() !== '';
  const formValid = capValid && timeoutValid && windowValid && keyValid;

  const dirty =
    enabled !== settings.enabled ||
    endpoint.trim() !== (settings.endpoint ?? '') ||
    model.trim() !== (settings.model ?? '') ||
    callCap.trim() !== String(settings.callCap) ||
    timeoutSec.trim() !== String(Math.round(settings.timeoutMs / 1000)) ||
    windowDays.trim() !== String(settings.scanWindowDays) ||
    keyMode !== 'keep';

  const saveMutation = useMutation({
    mutationFn: (body: LlmSettingsUpdate) => api.put<LlmSettings>('/settings/llm', body),
    onSuccess: () => {
      // Pole klucza czyścimy zawsze (także gdy `invalidate` jeszcze nie przyniósł nowego `updatedAt`).
      setKeyValue('');
      setKeyMode('keep');
      queryClient.invalidateQueries({ queryKey: queryKeys.llmSettings() });
      toast.success('Zapisano');
    },
  });

  const checkMutation = useMutation({
    mutationFn: () => api.post<LlmCheckResult>('/settings/llm/check'),
    onSuccess: (result) => setCheckResult(result),
    onError: (err) => setCheckResult({ ok: false, error: describeApiError(err) }),
  });

  function handleSave(): void {
    if (!formValid || capNum === null || timeoutNum === null || windowNum === null) return;
    const apiKey: LlmApiKeyAction =
      keyMode === 'set' ? { action: 'set', value: keyValue.trim() } : keyMode === 'clear' ? { action: 'clear' } : { action: 'keep' };
    saveMutation.mutate({
      enabled,
      endpoint: endpoint.trim() === '' ? null : endpoint.trim(),
      model: model.trim() === '' ? null : model.trim(),
      callCap: capNum,
      timeoutMs: timeoutNum * 1000,
      scanWindowDays: windowNum,
      apiKey,
    });
  }

  const keyDisabledHint = !settings.encryptionKeyConfigured;
  const checkDisabled = dirty || checkMutation.isPending || !settings.endpoint || !settings.model;

  return (
    <div className="flex flex-col gap-4">
      <StatusLine settings={settings} />

      <div
        role="note"
        className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-warning-foreground"
      >
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        <span>
          Po włączeniu treść pamięci jest wysyłana do wskazanego endpointu — poza tę maszynę, jeśli to zewnętrzne
          API. Wpisy, w których skaner znajdzie sekret, nie są wysyłane (lista poniżej, w ostatnim przebiegu).
        </span>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/40 px-3.5 py-3">
          <label htmlFor="llm-enabled" className="text-[13.5px] font-medium text-foreground">
            Włącz krok LLM w nocnym jobie
          </label>
          <Switch id="llm-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <Field
          id="llm-endpoint"
          label="Endpoint"
          hint={
            <>
              Pełny adres <span className="font-mono text-2xs">…/chat/completions</span>. Ollama:{' '}
              <span className="font-mono text-2xs">http://localhost:11434/v1/chat/completions</span>
            </>
          }
        >
          <Input
            id="llm-endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.openai.com/v1/chat/completions"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          id="llm-model"
          label="Model"
          hint={enabled ? 'Wymagany po włączeniu — nazwa zależy od providera, nie ma wartości domyślnej.' : 'Nazwa zależy od providera, nie ma wartości domyślnej.'}
        >
          <Input
            id="llm-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <div>
          <div className="mb-1 text-[13px] font-medium text-foreground">Klucz API</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="llm-key-state">
              {keyMode === 'clear'
                ? 'zostanie usunięty po zapisaniu'
                : settings.apiKey === 'set'
                  ? 'ustawiony'
                  : settings.apiKey === 'unreadable'
                    ? 'nieczytelny'
                    : 'brak'}
            </span>
            {keyMode === 'set' ? (
              <>
                <Input
                  type="password"
                  aria-label="Nowy klucz API"
                  value={keyValue}
                  onChange={(e) => setKeyValue(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  className="h-8 w-64 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setKeyMode('keep');
                    setKeyValue('');
                  }}
                >
                  Anuluj
                </Button>
              </>
            ) : keyMode === 'clear' ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setKeyMode('keep')}>
                Cofnij
              </Button>
            ) : (
              <>
                <Button type="button" variant="secondary" size="sm" disabled={keyDisabledHint} onClick={() => setKeyMode('set')}>
                  Zmień
                </Button>
                {settings.apiKey !== 'none' && (
                  <Button type="button" variant="ghost-danger" size="sm" onClick={() => setConfirmClear(true)}>
                    Usuń
                  </Button>
                )}
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {keyDisabledHint ? (
              <>
                Ustaw <span className="font-mono text-2xs">SECRETS_ENCRYPTION_KEY</span> na serwerze i zrestartuj
                aplikację — bez tego klucza API nie da się zapisać. Klucz jest opcjonalny (lokalne Ollama/vLLM go nie
                wymagają).
              </>
            ) : (
              'Klucz jest opcjonalny i tylko do zapisu — po zapisaniu nie da się go odczytać. W bazie leży zaszyfrowany.'
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            id="llm-cap"
            label="Limit wywołań na przebieg"
            hint={`${CALL_CAP_MIN}–${CALL_CAP_MAX}. Liczone w żądaniach do modelu (ponowienie też), domyślnie 100.`}
            invalid={!capValid}
          >
            <Input
              id="llm-cap"
              inputMode="numeric"
              value={callCap}
              onChange={(e) => setCallCap(e.target.value)}
              aria-invalid={!capValid}
              className="tabular-nums"
            />
          </Field>
          <Field
            id="llm-timeout"
            label="Timeout (s)"
            hint={`${TIMEOUT_MIN_S}–${TIMEOUT_MAX_S} s na pojedyncze żądanie, domyślnie 30.`}
            invalid={!timeoutValid}
          >
            <Input
              id="llm-timeout"
              inputMode="numeric"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              aria-invalid={!timeoutValid}
              className="tabular-nums"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            id="llm-window"
            label="Okno przeglądu (dni)"
            hint={`${WINDOW_MIN_DAYS}–${WINDOW_MAX_DAYS}. Detektor ocenia fakty zatwierdzone w ostatnich N dniach (domyślnie 1). Jednorazowe podniesienie przemieli starsze wpisy — w granicach limitu wywołań.`}
            invalid={!windowValid}
          >
            <Input
              id="llm-window"
              inputMode="numeric"
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              aria-invalid={!windowValid}
              className="tabular-nums"
            />
          </Field>
        </div>

        {saveMutation.isError && (
          <div role="alert" className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger-foreground">
            {describeApiError(saveMutation.error)}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="submit" variant="primary" disabled={!dirty || !formValid || saveMutation.isPending}>
            {saveMutation.isPending ? 'Zapisywanie…' : 'Zapisz'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={checkDisabled}
            onClick={() => {
              setCheckResult(null);
              checkMutation.mutate();
            }}
          >
            {checkMutation.isPending ? 'Sprawdzanie…' : 'Sprawdź połączenie'}
          </Button>
          {dirty && <span className="text-xs text-faint">Zapisz zmiany, żeby sprawdzić połączenie.</span>}
        </div>

        {checkResult && (
          <div
            role="status"
            className={
              checkResult.ok
                ? 'rounded-md border border-success bg-success-subtle px-3 py-2 text-xs text-success-foreground'
                : 'rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger-foreground'
            }
          >
            {checkResult.ok ? (
              <span className="font-mono tabular-nums">
                OK · {checkResult.model} · {checkResult.latencyMs} ms
              </span>
            ) : (
              checkResult.error
            )}
          </div>
        )}
        <p className="text-xs text-faint">
          „Sprawdź połączenie" robi jedno testowe wywołanie zapisanej konfiguracji. Pasek zdrowia ani metryki nie
          odpytują modelu.
        </p>
      </form>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć klucz API?</AlertDialogTitle>
            <AlertDialogDescription>
              Po zapisaniu zmian zaszyfrowany klucz zniknie z bazy. Endpointy, które go wymagają, przestaną
              odpowiadać, dopóki nie wpiszesz nowego.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setKeyMode('clear');
                setKeyValue('');
              }}
            >
              Usuń klucz
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  invalid,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className={`mt-1 text-xs ${invalid ? 'text-danger' : 'text-muted-foreground'}`}>{hint}</p>}
    </div>
  );
}

function LastRun({ lastRun }: { lastRun: LlmSettingsResponse['lastRun'] }) {
  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="mb-2 text-[13px] font-semibold text-foreground">Ostatni przebieg</h3>
      {!lastRun ? (
        <EmptyState title="Brak udanego przebiegu" description="Liczniki pojawią się po pierwszym nocnym jobie." className="py-6" />
      ) : (
        <>
          <p className="mb-2.5 text-xs text-muted-foreground">
            <span title={formatAbsoluteTime(lastRun.at)}>{formatRelativeTime(lastRun.at)}</span>
            {' · krok LLM: '}
            <span className="font-medium text-foreground">{lastRun.llm ? RUN_STATE_LABEL[lastRun.llm.state] : 'brak danych (przebieg sprzed v1.6)'}</span>
          </p>
          <table className="w-full max-w-sm border-collapse text-xs">
            <tbody>
              {(
                [
                  ['Wywołania', lastRun.counters.llmCalls],
                  ['Błędy', lastRun.counters.llmErrors],
                  ['Pominięte — limit', lastRun.counters.llmSkippedCap],
                  ['Pominięte — bezpiecznik', lastRun.counters.llmSkippedBreaker],
                  ['Pominięte — sekret', lastRun.counters.llmSkippedSecret],
                  ['Pominięte — klucz', lastRun.counters.llmSkippedKeyUnreadable],
                  ['Propozycje — do usunięcia', lastRun.counters.llmPruneDeleteProposed],
                  ['Propozycje — do skrócenia', lastRun.counters.llmPruneUpdateProposed],
                ] as const
              ).map(([label, value]) => (
                <tr key={label} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 text-muted-foreground">{label}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-foreground">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastRun.llm && lastRun.llm.skippedSecret.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-foreground">Pominięte z powodu sekretu</div>
              <ul className="flex flex-col gap-1">
                {lastRun.llm.skippedSecret.map((e) => (
                  <li key={e.memoryId} className="flex items-center gap-2">
                    <Link to={`/pamiec?id=${e.memoryId}`} className="font-mono text-xs underline decoration-dotted hover:decoration-solid">
                      {e.memoryId}
                    </Link>
                    <Badge variant="danger" className="normal-case tracking-normal">
                      {e.secretType}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
