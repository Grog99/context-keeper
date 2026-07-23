import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { useSession } from './hooks/useSession';
import { useTheme } from './hooks/useTheme';
import { ActiveContextProvider } from './lib/context';
import { queryClient } from './lib/query';
import { AuditScreen } from './screens/AuditScreen';
import { DevPreviewScreen } from './screens/DevPreviewScreen';
import { LoginScreen } from './screens/LoginScreen';
import { MemoryBrowserScreen } from './screens/MemoryBrowserScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { OperacjeScreen } from './screens/OperacjeScreen';
import { OsCzasuScreen } from './screens/OsCzasuScreen';
import { PomiaryScreen } from './screens/PomiaryScreen';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { QueueScreen } from './screens/QueueScreen';

/** Gate login-vs-app (§M2 planu Fazy 5) — `GET /api/auth/session` decyduje który poddrzewo renderować. */
function Gate() {
  const { data, isLoading } = useSession();
  useTheme();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Ładowanie…
      </div>
    );
  }

  if (!data?.authenticated) {
    return <LoginScreen />;
  }

  return (
    <Routes>
      <Route path="/dev-preview" element={<DevPreviewScreen />} />
      <Route element={<AppShell />}>
        <Route path="/kolejka" element={<QueueScreen />} />
        <Route path="/pamiec" element={<MemoryBrowserScreen />} />
        <Route path="/os-czasu" element={<OsCzasuScreen />} />
        <Route path="/projekty" element={<ProjectsScreen />} />
        <Route path="/audyt" element={<AuditScreen />} />
        <Route path="/pomiary" element={<PomiaryScreen />} />
        <Route path="/operacje" element={<OperacjeScreen />} />
        <Route path="/onboarding" element={<OnboardingScreen />} />
        <Route path="*" element={<Navigate to="/kolejka" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ActiveContextProvider>
        <TooltipProvider delayDuration={200}>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
          <Toaster />
        </TooltipProvider>
      </ActiveContextProvider>
    </QueryClientProvider>
  );
}
