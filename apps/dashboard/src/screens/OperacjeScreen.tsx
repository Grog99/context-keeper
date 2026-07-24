import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { ScreenContainer } from '../components/ScreenContainer';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { queryKeys } from '../lib/query';
import type { NightlyRunResult } from '../types/api';

/**
 * Ekran "Operacje" (roadmap v1.1, USER DECISION Stage 2 — dedykowany ekran, NIE toolbar Kolejki):
 * ręczny trigger nocnego joba (`POST /api/nightly/run`, `nightly.controller.ts`), cienki wrapper nad
 * tym samym `NightlyService.run()` co CLI `run-nightly`. Synchroniczny POST — blokuje do końca
 * przebiegu (dogfooding-scale), przycisk pokazuje pending/disabled stan jako client-side guard przed
 * podwójnym kliknięciem (serwer i tak no-opuje drugi równoległy trigger przez advisory lock).
 * Feedback WYŁĄCZNIE przez toast (user decision) — bez panelu inline z wynikiem.
 */
export function OperacjeScreen() {
  const queryClient = useQueryClient();

  const nightlyMutation = useMutation({
    mutationFn: () => api.post<NightlyRunResult>('/nightly/run'),
    onSuccess: (result) => {
      if (result.status === 'skipped-locked') {
        toast.info('Nocny job już trwa (pominięto) — poczekaj na zakończenie równoległego przebiegu.');
      } else {
        const c = result.counters;
        toast.success(
          `+${c.created} propozycji · merge ${c.mergeProposed} · prune ${c.pruneProposed} · wycofano ${c.withdrawn}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ['proposals'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  return (
    <ScreenContainer width="prose">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Operacje</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Rzadkie, uprzywilejowane czynności administracyjne — poza codziennym flow recenzenta w Kolejce.
      </p>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Nocny job</h2>
        <p className="mb-3.5 text-xs leading-relaxed text-muted-foreground">
          Proposer dedup/merge + prune — skanuje zatwierdzone fakty, wykrywa duplikaty (ANN) i kandydatów do
          usunięcia (recency). Wynik ląduje w Kolejce jak każda inna propozycja — nic nie jest zatwierdzane
          automatycznie. Normalnie odpalany przez zewnętrzny scheduler; ten przycisk uruchamia przebieg
          ręcznie i czeka na wynik.
        </p>
        <Button variant="secondary" disabled={nightlyMutation.isPending} onClick={() => nightlyMutation.mutate()}>
          <Wrench className="size-[15px]" />
          {nightlyMutation.isPending ? 'Uruchamianie…' : 'Uruchom nocny job'}
        </Button>
      </section>
    </ScreenContainer>
  );
}
