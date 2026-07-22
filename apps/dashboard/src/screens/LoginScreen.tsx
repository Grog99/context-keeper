import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Diamond } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/query';

interface LoginResponse {
  authenticated: boolean;
}

/** Gate login-vs-app (§M2 planu Fazy 5) — po sukcesie po prostu inwaliduje `session` query;
 * `App.tsx` re-renderuje w stan zalogowany, bez lokalnego routingu tutaj. */
export function LoginScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.post<LoginResponse>('/auth/login', { password });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Zbyt wiele prób — spróbuj ponownie za chwilę.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Nieprawidłowe hasło.');
      } else {
        setError('Logowanie nie powiodło się. Spróbuj ponownie.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border-strong bg-surface p-8 shadow-md">
        <div className="mb-6 flex items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground">
          <Diamond className="size-[22px] fill-primary text-primary" />
          Context Keeper
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              Hasło dashboardu
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger-foreground"
            >
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={pending || password.length === 0}>
            {pending ? 'Logowanie…' : 'Zaloguj'}
          </Button>
        </form>
      </div>
    </div>
  );
}
