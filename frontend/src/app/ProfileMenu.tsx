import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, LogOut, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Input } from '../components/ui';
import { cn } from '../lib/cn';
import { AddProfileDialog, useProfiles } from './profiles';
import { useSession } from './session';

/** With more profiles than this, a search box filters the list. */
const SEARCH_ABOVE = 10;

/**
 * The navbar's current profile. Its menu shows the signed-in account (email and Sign out), then
 * the account's profiles to switch between, then Add profile.
 */
export function ProfileMenu() {
  const { email, signOut } = useSession();
  const { profiles, current, switchTo } = useProfiles();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = profiles.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)));
  const pick = (id: string) => {
    setOpen(false);
    if (id !== current.id) switchTo(id);
  };
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-wash';

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          // The menu opens with the full list again.
          if (next) setSearch('');
          setOpen(next);
        }}
      >
        <Popover.Trigger
          aria-label={`Profile: ${current.name}. Account and profiles`}
          className="inline-flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink hover:bg-wash"
        >
          <span className="truncate">{current.name}</span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={4} className="z-50 flex max-h-[min(32rem,80vh)] w-72 flex-col rounded-md border border-hairline bg-raised p-1 shadow-lg">
            <div className="shrink-0 px-2 pt-1.5 pb-1">
              <p className="text-xs text-ink-2">Signed in as</p>
              <p className="truncate text-sm font-medium text-ink" title={email ?? undefined}>
                {email ?? 'this account'}
              </p>
            </div>
            <button type="button" onClick={signOut} className={cn(item, 'shrink-0')}>
              <LogOut className="size-4 shrink-0 text-ink-2" aria-hidden /> Sign out
            </button>
            <div className="my-1 shrink-0 border-t border-hairline" />
            <p className="shrink-0 px-2 pt-0.5 pb-1 text-xs text-ink-2">Profiles</p>
            {profiles.length > SEARCH_ABOVE && (
              <div className="relative mb-1 shrink-0">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && shown[0]) pick(shown[0].id);
                  }}
                  placeholder="Find a profile"
                  aria-label="Find a profile"
                  className="h-8 pl-8"
                />
              </div>
            )}
            {/* Only the profiles scroll: the account above and Add profile below stay in view. */}
            <div role="menu" aria-label="Profiles" className="min-h-0 overflow-y-auto">
              {shown.map((p) => {
                const selected = p.id === current.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => pick(p.id)}
                    className={cn(item, 'font-medium', selected && 'bg-accent-wash')}
                  >
                    <Check className={cn('size-4 shrink-0', selected ? 'text-accent-strong' : 'invisible')} aria-hidden />
                    <span className="truncate">{p.name}</span>
                  </button>
                );
              })}
              {shown.length === 0 && <p className="px-2 py-3 text-sm text-ink-2">No matches</p>}
            </div>
            <div className="mt-1 shrink-0 border-t border-hairline pt-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setAdding(true);
                }}
                className={cn(item, 'font-medium')}
              >
                <Plus className="size-4 shrink-0 text-ink-2" aria-hidden /> Add profile
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <AddProfileDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
