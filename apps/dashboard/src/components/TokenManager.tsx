import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Pencil, Plus, RotateCw, ShieldOff, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { EmptyState } from './EmptyState';
import { MonoId } from './MonoId';
import { TokenReveal } from './TokenReveal';
import { TokenStatusBadge } from './TokenStatusBadge';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import type { CreatedTokenApi, ProjectTokenApi, RotatedTokenApi } from '../types/api';

// Klient-side mirror `normalizeTokenLabel` (`apps/server/src/projects/token-status.ts`) — TYLKO do
// natychmiastowego feedbacku w formularzu (disabled submit); serwer zostaje authoritative, komunikat
// kolizji/błędu zawsze pokazujemy z odpowiedzi API (`describeApiError`), nigdy wymyślony tutaj.
const TOKEN_LABEL_MAX_LEN = 40;
const TOKEN_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
function isValidTokenLabel(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= TOKEN_LABEL_MAX_LEN && TOKEN_LABEL_RE.test(trimmed);
}

/** Zakres zarządzanych tokenów: tokeny jednego projektu (`/projects/:id/tokens`) albo tokeny KONTA
 * (`/account-tokens`, roadmap v1.5) — te same trasy lifecycle po stronie serwera, ta sama tabela tutaj. */
export type TokenManagerScope = { kind: 'project'; projectId: string } | { kind: 'account' };

export interface TokenManagerProps {
  scope: TokenManagerScope;
}

interface RevealState {
  token: string;
  label: string;
  reason: 'created' | 'rotated';
  graceUntil?: string | null;
}

/**
 * Tabela tokenów + tworzenie / rotacja (graceful) / unieważnienie / rename + jednorazowy `TokenReveal`.
 * Wydzielone z `ProjectTokensDialog` (roadmap v1.3) i współdzielone z sekcją "Tokeny konta" na ekranie
 * Projekty (roadmap v1.5) — różnią się tylko ścieżką API, kluczem zapytania i copy (empty state,
 * ostrzeżenie o ostatnim tokenie, tytuły `TokenReveal`).
 */
export function TokenManager({ scope }: TokenManagerProps) {
  const queryClient = useQueryClient();
  const isAccount = scope.kind === 'account';
  const basePath = isAccount ? '/account-tokens' : `/projects/${scope.projectId}/tokens`;
  const queryKey = isAccount ? queryKeys.accountTokens() : queryKeys.projectTokens(scope.projectId);

  const [newLabel, setNewLabel] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ProjectTokenApi | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ProjectTokenApi | null>(null);
  const [reveal, setReveal] = useState<RevealState | null>(null);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => api.get<ProjectTokenApi[]>(basePath),
  });
  const tokens = data ?? [];
  const usableCount = tokens.filter((t) => t.effectiveStatus === 'active' || t.effectiveStatus === 'grace').length;

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey });
    // Liczniki tokenów w tabeli projektów dotyczą wyłącznie tokenów projektowych.
    if (!isAccount) queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
  }

  const createMutation = useMutation({
    mutationFn: (label: string) => api.post<CreatedTokenApi>(basePath, { label }),
    onSuccess: (result) => {
      setNewLabel('');
      setReveal({ token: result.token, label: result.tokenRow.label, reason: 'created' });
      invalidateAll();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const rotateMutation = useMutation({
    mutationFn: (tokenId: string) => api.post<RotatedTokenApi>(`${basePath}/${tokenId}/rotate`),
    onSuccess: (result) => {
      setRotateTarget(null);
      setReveal({
        token: result.token,
        label: result.tokenRow.label,
        reason: 'rotated',
        graceUntil: result.previousTokenRow.expiresAt,
      });
      invalidateAll();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => api.post<ProjectTokenApi>(`${basePath}/${tokenId}/revoke`),
    onSuccess: () => {
      setRevokeTarget(null);
      toast.success('Token unieważniony');
      invalidateAll();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const renameMutation = useMutation({
    mutationFn: (vars: { tokenId: string; label: string }) =>
      api.patch<ProjectTokenApi>(`${basePath}/${vars.tokenId}`, { label: vars.label }),
    onSuccess: () => {
      setRenameTarget(null);
      invalidateAll();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  return (
    <>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={isAccount ? 'Brak tokenów konta' : 'Brak tokenów'}
          description={
            isAccount
              ? 'Utwórz pierwszy token konta — jeden token obsłuży wiele repo (projekt wskazuje nagłówek w .mcp.json).'
              : 'Ten projekt nie ma jeszcze żadnego tokena.'
          }
        />
      ) : (
        <div className="mb-4 overflow-hidden rounded-lg border border-border">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <Th>Etykieta</Th>
                  <Th>Status</Th>
                  <Th>id</Th>
                  <Th>Utworzony</Th>
                  <Th>Wygasa</Th>
                  <Th>Ostatnio użyty</Th>
                  <Th>Wyszukań (30d)</Th>
                  <th className="px-3 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">
                    Akcje
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const renaming = renameTarget?.id === token.id;
                  return (
                    <tr key={token.id} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2 font-medium">
                        {renaming ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={renameTarget.value}
                              onChange={(e) => setRenameTarget({ id: token.id, value: e.target.value })}
                              autoFocus
                              className="h-7 w-32 text-xs"
                              maxLength={TOKEN_LABEL_MAX_LEN}
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              className="size-7 p-0"
                              disabled={!isValidTokenLabel(renameTarget.value) || renameMutation.isPending}
                              onClick={() => renameMutation.mutate({ tokenId: token.id, label: renameTarget.value.trim() })}
                              aria-label="Zapisz etykietę"
                            >
                              <Check className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-7 p-0"
                              onClick={() => setRenameTarget(null)}
                              aria-label="Anuluj"
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 hover:text-primary"
                            onClick={() => setRenameTarget({ id: token.id, value: token.label })}
                          >
                            {token.label}
                            <Pencil className="size-3 text-faint" />
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <TokenStatusBadge status={token.effectiveStatus} />
                      </td>
                      <td className="px-3 py-2">
                        <MonoId value={token.id} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                        {formatAbsoluteTime(token.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                        {token.expiresAt ? formatAbsoluteTime(token.expiresAt) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                        {token.lastUsedAt ? formatAbsoluteTime(token.lastUsedAt) : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs tabular-nums">{token.searches30d}</td>
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={token.effectiveStatus !== 'active'}
                            onClick={() => setRotateTarget(token)}
                            aria-label={`Rotuj token ${token.label}`}
                          >
                            <RotateCw className="size-3.5" /> Rotuj
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={token.status === 'revoked'}
                            onClick={() => setRevokeTarget(token)}
                            aria-label={`Unieważnij token ${token.label}`}
                          >
                            <ShieldOff className="size-3.5" /> Unieważnij
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          Etykieta nowego tokena
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={isAccount ? 'np. laptop' : 'np. claude-code-laptop'}
            maxLength={TOKEN_LABEL_MAX_LEN}
          />
        </label>
        <Button
          variant="primary"
          disabled={!isValidTokenLabel(newLabel) || createMutation.isPending}
          onClick={() => createMutation.mutate(newLabel.trim())}
        >
          <Plus className="size-4" /> {createMutation.isPending ? 'Tworzenie…' : 'Nowy token'}
        </Button>
      </div>

      <AlertDialog open={rotateTarget !== null} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <AlertDialogContent>
          {rotateTarget && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Rotować token „{rotateTarget.label}"?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogDescription>
                Nowy token zastąpi go od razu. Stary token zostanie wydany na jeszcze przez okres karencji
                (skonfigurowany na serwerze) — zaktualizuj konfigurację klientów MCP w tym oknie, potem stary token
                przestanie działać.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={rotateMutation.isPending}>Anuluj</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => rotateMutation.mutate(rotateTarget.id)}
                  disabled={rotateMutation.isPending}
                >
                  {rotateMutation.isPending ? 'Rotowanie…' : 'Rotuj token'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          {revokeTarget && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Unieważnić token „{revokeTarget.label}"?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogDescription>
                Nieodwracalne — token przestanie działać NATYCHMIAST, bez okresu karencji. Użyj dla
                skompromitowanego credentiala.
                {usableCount <= 1 &&
                  (revokeTarget.effectiveStatus === 'active' || revokeTarget.effectiveStatus === 'grace') && (
                    <span className="mt-2 block font-semibold text-danger">
                      {isAccount
                        ? 'To ostatni działający token konta — repo łączące się nagłówkiem X-Context-Keeper-Project dostaną 401, dopóki nie wydasz nowego.'
                        : 'To jest ostatni działający token tego projektu — po unieważnieniu żaden klient MCP nie będzie mógł się uwierzytelnić, dopóki nie utworzysz nowego.'}
                    </span>
                  )}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={revokeMutation.isPending}>Anuluj</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => revokeMutation.mutate(revokeTarget.id)}
                  disabled={revokeMutation.isPending}
                >
                  {revokeMutation.isPending ? 'Unieważnianie…' : 'Unieważnij'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {reveal && (
        <TokenReveal
          open={reveal !== null}
          onOpenChange={(open) => !open && setReveal(null)}
          token={reveal.token}
          label={reveal.label}
          reason={reveal.reason}
          graceUntil={reveal.graceUntil}
          scope={isAccount ? 'account' : 'project'}
        />
      )}
    </>
  );
}

function Th({ children }: { children: string }) {
  return (
    <th className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">
      {children}
    </th>
  );
}
