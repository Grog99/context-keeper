const CSRF_COOKIE_NAME = 'ck_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Koperta błędu domenowego (`DashboardErrorFilter` po stronie serwera) — `code`/`staleIds` niosą
 * ten sam kontrakt co `ProposalError`/`ToolError` (patrz `apps/server/src/dashboard/dashboard-error.filter.ts`). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly staleIds?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Fetch wrapper dla `/api` (§M2 planu Fazy 5): `credentials:'include'` (cookie sesji + CSRF),
 * dołącza `X-CSRF-Token` z cookie `ck_csrf` na mutacjach (double-submit, symetrycznie z
 * `CsrfGuard`), mapuje non-2xx na `ApiError` typowany `{code, staleIds}`.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  if (MUTATING_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) headers.set(CSRF_HEADER_NAME, csrf);
  }

  const res = await fetch(`/api${path}`, { ...options, method, headers, body, credentials: 'include' });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  const data: unknown = isJson ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    const record = (data ?? {}) as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const staleIds = Array.isArray(record.staleIds) ? (record.staleIds as string[]) : undefined;
    const message = typeof record.message === 'string' ? record.message : `Żądanie nie powiodło się (${res.status})`;
    throw new ApiError(res.status, code, message, staleIds);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> => apiFetch<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: 'DELETE' }),
};
