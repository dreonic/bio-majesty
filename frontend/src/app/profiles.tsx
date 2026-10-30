import type { ProfileSummary, ProfilesResponse } from '@bio-majesty/shared';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Modal } from '../components/overlays';
import { useToast } from '../components/toast';
import { Button, Card, Field, Input, Spinner } from '../components/ui';
import { api, ApiError, setApiProfile } from '../lib/api';
import { useSession } from './session';

const STORAGE_KEY = 'bm:profile';
const profilesKey = ['profiles'] as const;

/** Query defaults for the account's client (its profiles) and each profile's own. */
export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  });
}

function rememberedProfile(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberProfile(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage disabled: the oldest profile opens next time
  }
}

interface ProfileContextValue {
  /** The account's profiles, oldest first. */
  profiles: ProfileSummary[];
  /** The profile everything below works on. */
  current: ProfileSummary;
  /** Work on another profile: the page stays (or goes to `path`), nothing loaded for the old one carries over. */
  switchTo: (id: string, path?: string) => void;
  create: (name: string) => Promise<ProfileSummary>;
  rename: (id: string, name: string) => Promise<void>;
  /** Delete a profile (not the account's last); deleting the current one opens another. */
  remove: (id: string) => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfiles(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('useProfiles is only available below ProfileGate');
  return value;
}

/**
 * Loads the account's profiles and picks the one to work on: a `?profile=` link (Telegram
 * buttons), else the last one opened in this browser, else the oldest. Everything below works on
 * that profile with a query cache of its own, so switching starts afresh: no news, chat, filters
 * or open article carry over. An account without profiles names its first one here.
 */
export function ProfileGate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const list = useQuery({ queryKey: profilesKey, queryFn: () => api<ProfilesResponse>('profiles') });
  const [wanted, setWanted] = useState(() => new URLSearchParams(location.search).get('profile') ?? rememberedProfile());

  const profiles = useMemo(() => list.data?.items ?? [], [list.data]);
  const current = profiles.find((p) => p.id === wanted) ?? profiles[0];
  // Requests from here on name this profile: set before its pages render and fetch.
  setApiProfile(current?.id ?? null);
  const currentId = current?.id;
  const profileClient = useMemo(() => newQueryClient(), [currentId]);
  useEffect(() => () => profileClient.clear(), [profileClient]);

  // Remember the profile; a ?profile= link has done its job once the profile is open.
  useEffect(() => {
    if (!currentId) return;
    rememberProfile(currentId);
    const params = new URLSearchParams(location.search);
    if (!params.has('profile')) return;
    params.delete('profile');
    void navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [currentId, location.pathname, location.search, navigate]);

  const value = useMemo<ProfileContextValue | null>(() => {
    if (!current) return null;
    const setList = (update: (items: ProfileSummary[]) => ProfileSummary[]) =>
      client.setQueryData<ProfilesResponse>(profilesKey, (old) => ({ items: update(old?.items ?? []) }));
    const switchTo = (id: string, path?: string) => {
      setWanted(id);
      rememberProfile(id);
      // The old profile's filters (?tab, categories, …) mean nothing in the new one.
      void navigate(path ?? location.pathname);
    };
    return {
      profiles,
      current,
      switchTo,
      create: async (name) => {
        const profile = await api<ProfileSummary>('profiles', { method: 'POST', body: { name } });
        setList((items) => [...items, profile]);
        return profile;
      },
      rename: async (id, name) => {
        const profile = await api<ProfileSummary>(`profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
        setList((items) => items.map((p) => (p.id === id ? profile : p)));
      },
      remove: async (id) => {
        await api<void>(`profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const rest = profiles.filter((p) => p.id !== id);
        if (id === current.id && rest[0]) switchTo(rest[0].id, '/');
        setList((items) => items.filter((p) => p.id !== id));
      },
    };
  }, [client, current, location.pathname, navigate, profiles]);

  if (list.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (list.isError) return <ProfilesFailed error={list.error} retry={() => void list.refetch()} />;
  if (!value) return <FirstProfile onCreated={(profile) => addToList(client, profile)} />;
  return (
    <ProfileContext.Provider value={value}>
      <QueryClientProvider client={profileClient} key={value.current.id}>
        {children}
      </QueryClientProvider>
    </ProfileContext.Provider>
  );
}

function addToList(client: QueryClient, profile: ProfileSummary) {
  client.setQueryData<ProfilesResponse>(profilesKey, (old) => ({ items: [...(old?.items ?? []), profile] }));
}

function ProfilesFailed({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">Couldn&apos;t load your profiles</h1>
        <p className="mt-2 text-sm text-ink-2">{error.message}</p>
        <Button variant="primary" className="mt-6 w-full" onClick={retry}>
          Try again
        </Button>
      </Card>
    </div>
  );
}

/** A new account: name its first profile before anything else. */
function FirstProfile({ onCreated }: { onCreated: (profile: ProfileSummary) => void }) {
  const { email, signOut } = useSession();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api<ProfileSummary>('profiles', { method: 'POST', body: { name: name.trim() } })
      .then(onCreated)
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8">
        <img src="/favicon.svg" alt="" className="mx-auto size-10" />
        <h1 className="mt-4 text-center text-lg font-semibold text-ink">Name your first profile</h1>
        <p className="mt-2 text-center text-sm text-ink-2">
          A profile follows one subject, with its own news, review queue, chat and settings. You can add more later from the menu at the top right.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Profile name" hint='For example the company or topic it follows, such as "Acme Group".'>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          </Field>
          {error && <p className="rounded-md bg-critical-wash px-3 py-2 text-sm text-ink">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={!name.trim()} loading={saving}>
            Create profile
          </Button>
        </form>
        <Button variant="ghost" className="mt-2 w-full" onClick={signOut} title={email ?? undefined}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

/** Name a new profile, then open its Settings (a new profile starts blank). */
export function AddProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { create, switchTo } = useProfiles();
  const toast = useToast();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    create(name.trim())
      .then((profile) => {
        onOpenChange(false);
        setName('');
        switchTo(profile.id, '/settings');
        toast.success(`${profile.name} added: describe its subject and add a category to start finding news`);
      })
      .catch(toast.error)
      .finally(() => setSaving(false));
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add profile"
      description="A separate desk with its own subject, assets, categories, news, chat, settings and Telegram chats."
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={saving} onClick={() => submit()}>
            Add profile
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Profile name" hint="Shown in the menu at the top right and on its Telegram messages.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
