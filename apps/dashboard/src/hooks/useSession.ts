import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query';

export interface SessionResponse {
  authenticated: boolean;
}

/** Gate login-vs-app (§M2 planu Fazy 5) — `GET /api/auth/session` bez `SessionGuard` po stronie
 * serwera (punkt wejścia), więc bezpieczne do odpytania przed zalogowaniem. */
export function useSession(): UseQueryResult<SessionResponse> {
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: () => api.get<SessionResponse>('/auth/session'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useInvalidateSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.session() });
}
