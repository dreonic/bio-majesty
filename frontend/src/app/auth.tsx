import { ACCESS_GROUP, hasAccess } from '@bio-majesty/shared';
import { WebStorageStateStore } from 'oidc-client-ts';
import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { Button, Card, Spinner } from '../components/ui';
import { configureApi } from '../lib/api';
import type { RuntimeConfig } from './config';
import { SessionContext } from './session';

const RETURN_KEY = 'bm:returnTo';

/** Cognito managed login (authorization code + PKCE) via react-oidc-context. */
export function AuthRoot({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const origin = window.location.origin;
  return (
    <AuthProvider
      authority={config.cognito.authority}
      client_id={config.cognito.clientId}
      redirect_uri={`${origin}/auth/callback`}
      post_logout_redirect_uri={`${origin}/`}
      response_type="code"
      scope="openid email profile"
      automaticSilentRenew
      userStore={new WebStorageStateStore({ store: window.localStorage })}
      onSigninCallback={() => {
        const target = sessionStorage.getItem(RETURN_KEY) ?? '/';
        sessionStorage.removeItem(RETURN_KEY);
        window.history.replaceState({}, document.title, target);
      }}
    >
      <AuthGate config={config}>{children}</AuthGate>
    </AuthProvider>
  );
}

function AuthGate({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    configureApi({
      baseUrl: config.apiUrl,
      getToken: () => auth.user?.id_token,
      onUnauthorized: () => void auth.signinSilent().catch(() => auth.removeUser()),
    });
  }, [auth, config.apiUrl]);

  if (auth.isLoading || auth.activeNavigator) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    const signIn = () => {
      if (!window.location.pathname.startsWith('/auth/')) {
        sessionStorage.setItem(RETURN_KEY, `${window.location.pathname}${window.location.search}`);
      }
      void auth.signinRedirect();
    };
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-sm p-8 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto size-10" />
          <h1 className="mt-4 text-lg font-semibold text-ink">News Accumulator</h1>
          <p className="mt-1 text-sm text-ink-2">Collects, tags and summarises the news you follow, with a research assistant and a price panel.</p>
          {auth.error && <p className="mt-4 rounded-md bg-critical-wash px-3 py-2 text-left text-sm text-ink">Sign-in failed: {auth.error.message}</p>}
          <Button variant="primary" className="mt-6 w-full" onClick={signIn}>
            Sign in
          </Button>
        </Card>
      </div>
    );
  }

  // Cognito has no OIDC end-session endpoint; use its /logout URL.
  const signOut = () => {
    void auth.removeUser().then(() => {
      const url = new URL('/logout', config.cognito.domain);
      url.searchParams.set('client_id', config.cognito.clientId);
      url.searchParams.set('logout_uri', `${window.location.origin}/`);
      window.location.assign(url.toString());
    });
  };

  // The API refuses anyone outside the access group (any Google account can sign in).
  if (!hasAccess(auth.user?.profile['cognito:groups'])) {
    return <NoAccess email={auth.user?.profile.email ?? null} checkAgain={() => auth.signinSilent()} signOut={signOut} />;
  }

  return (
    <SessionContext.Provider value={{ email: auth.user?.profile.email ?? null, signOut, demo: false }}>{children}</SessionContext.Provider>
  );
}

/** Signed in, but not (yet) in the dashboard's Cognito group. */
function NoAccess({ email, checkAgain, signOut }: { email: string | null; checkAgain: () => Promise<unknown>; signOut: () => void }) {
  const [checking, setChecking] = useState(false);
  const [stillNo, setStillNo] = useState(false);
  // A fresh token carries the groups as they are now.
  const recheck = () => {
    setChecking(true);
    void checkAgain()
      .catch(() => undefined)
      .finally(() => {
        setChecking(false);
        setStillNo(true);
      });
  };
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8 text-center">
        <img src="/favicon.svg" alt="" className="mx-auto size-10" />
        <h1 className="mt-4 text-lg font-semibold text-ink">No access yet</h1>
        <p className="mt-2 text-sm text-ink-2">
          You're signed in{email ? ` as ${email}` : ''}, but this account hasn't been given access to the dashboard. Ask an admin to add it to the{' '}
          <span className="font-medium text-ink">{ACCESS_GROUP}</span> group, then check again.
        </p>
        {stillNo && !checking && <p className="mt-3 text-xs text-ink-2">Still no access.</p>}
        <Button variant="primary" className="mt-6 w-full" onClick={recheck} loading={checking}>
          Check again
        </Button>
        <Button variant="ghost" className="mt-2 w-full" onClick={signOut}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

/** Mock mode (npm run dev:mock): no Cognito, API served from sample data. */
export function DemoAuth({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  configureApi({ baseUrl: config.apiUrl, getToken: () => 'demo-token', onUnauthorized: () => undefined });
  return (
    <SessionContext.Provider value={{ email: 'exec@example.com', signOut: () => window.location.reload(), demo: true }}>{children}</SessionContext.Provider>
  );
}
