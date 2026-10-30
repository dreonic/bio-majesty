import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ToastProvider } from '../components/toast';
import { Spinner } from '../components/ui';
import { ArticleSheetProvider } from '../features/news/ArticleSheet';
import { AuthRoot, DemoAuth } from './auth';
import type { RuntimeConfig } from './config';
import { Dashboard } from './Dashboard';
import { newQueryClient, ProfileGate } from './profiles';
import { Shell } from './Shell';

const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AdminPage = lazy(() => import('../features/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

export function App({ config, demo = false }: { config: RuntimeConfig; demo?: boolean }) {
  const Auth = demo ? DemoAuth : AuthRoot;
  // The account's profiles; each profile gets a client of its own below ProfileGate.
  const [accountClient] = useState(newQueryClient);

  return (
    <BrowserRouter>
      <Auth config={config}>
        <QueryClientProvider client={accountClient}>
          <ToastProvider>
            <ProfileGate>
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
                    <Route
                      path="admin"
                      element={
                        <Suspense fallback={<Spinner className="m-8" />}>
                          <AdminPage />
                        </Suspense>
                      }
                    />
                  </Route>
                  <Route path="auth/callback" element={<Navigate to="/" replace />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </ArticleSheetProvider>
            </ProfileGate>
          </ToastProvider>
        </QueryClientProvider>
      </Auth>
    </BrowserRouter>
  );
}
