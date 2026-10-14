import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ToastProvider } from '../components/toast';
import { Spinner } from '../components/ui';
import { ArticleSheetProvider } from '../features/news/ArticleSheet';
import { ApiError } from '../lib/api';
import { AuthRoot, DemoAuth } from './auth';
import type { RuntimeConfig } from './config';
import { Dashboard } from './Dashboard';
import { Shell } from './Shell';

const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function App({ config, demo = false }: { config: RuntimeConfig; demo?: boolean }) {
  const Auth = demo ? DemoAuth : AuthRoot;
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );

  return (
    <BrowserRouter>
      <Auth config={config}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <ArticleSheetProvider>
              <Routes>
                <Route element={<Shell config={config} />}>
                  <Route index element={<Dashboard config={config} />} />
                  <Route
                    path="settings"
                    element={
                      <Suspense fallback={<Spinner className="m-8" />}>
                        <SettingsPage />
                      </Suspense>
                    }
                  />
                </Route>
                <Route path="auth/callback" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ArticleSheetProvider>
          </ToastProvider>
        </QueryClientProvider>
      </Auth>
    </BrowserRouter>
  );
}
