import type { AdminUser } from '@bio-majesty/shared';
import { Mail, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useSession } from '../../app/session';
import { Modal } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, EmptyState, Input, SectionTitle, Spinner, Switch } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { useAdminUsers, useDeleteUser, useInviteUser, useResendInvite, useUpdateUser } from '../../lib/queries';

/** User management for the admins group: who may use the dashboard, and who else manages it. */
export function AdminPage() {
  const { admin } = useSession();
  const users = useAdminUsers();
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  if (!admin) return <Navigate to="/" replace />;

  const list = users.data?.users ?? [];
  const me = users.data?.me ?? '';
  // Signed in (e.g. with Google) but never let in, and not switched off on purpose.
  const waiting = list.filter((u) => !u.access && u.enabled && u.status !== 'FORCE_CHANGE_PASSWORD');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Admin</h1>
          <p className="mt-1 text-sm text-ink-2">
            Who can use the dashboard. Every user with access is a separate account with its own news, settings and chats. Removing access takes effect
            when the person&apos;s sign-in renews, within an hour.
          </p>
        </div>

        {users.isPending ? (
          <Spinner />
        ) : users.isError ? (
          <Card className="px-5 py-4 text-sm text-ink">{users.error.message}</Card>
        ) : (
          <>
            {waiting.length > 0 && (
              <Card>
                <SectionTitle title="Waiting for access" description="These people signed in but can't use the dashboard yet. Let in the ones you know." />
                <ul className="divide-y divide-hairline">
                  {waiting.map((user) => (
                    <WaitingRow key={user.username} user={user} onDelete={() => setDeleting(user)} />
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <SectionTitle
                title="Users"
                description="Invite people by email (they get a temporary password), or let them sign in with Google and give them access above."
              />
              <InviteForm />
              {list.length === 0 ? (
                <EmptyState title="No users yet" />
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {list.map((user) => (
                    <UserRow key={user.username} user={user} self={user.username === me} onDelete={() => setDeleting(user)} />
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
      {deleting && <DeleteDialog user={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function InviteForm() {
  const invite = useInviteUser();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(email, {
      onSuccess: (user) => {
        toast.success(`Invitation sent to ${user.email ?? email}`);
        setEmail('');
      },
      onError: toast.error,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 px-5 py-4">
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@company.com"
        aria-label="Email to invite"
        className="w-auto min-w-0 flex-1 sm:max-w-sm"
      />
      <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={invite.isPending}>
        Invite
      </Button>
    </form>
  );
}

function Identity({ user, self = false }: { user: AdminUser; self?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
        <span className="truncate">{user.email ?? user.username}</span>
        {self && <Badge>You</Badge>}
      </p>
      <p className="mt-0.5 text-xs text-ink-2">
        {[user.name, user.provider === 'google' ? 'Google sign-in' : 'Email and password', `added ${formatDate(user.createdAt)}`].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

function WaitingRow({ user, onDelete }: { user: AdminUser; onDelete: () => void }) {
  const update = useUpdateUser();
  const toast = useToast();
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <Identity user={user} />
      <Button
        size="sm"
        variant="primary"
        loading={update.isPending}
        onClick={() =>
          update.mutate(
            { username: user.username, change: { access: true } },
            { onSuccess: () => toast.success(`${user.email ?? user.username} can now use the dashboard`), onError: toast.error },
          )
        }
      >
        Give access
      </Button>
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={onDelete}>
        Delete
      </Button>
    </li>
  );
}

function status(user: AdminUser): { label: string; className?: string; title?: string } {
  if (!user.enabled) return { label: 'Disabled', className: 'border-critical/30 bg-critical-wash text-ink', title: "Can't sign in" };
  if (user.status === 'FORCE_CHANGE_PASSWORD') return { label: 'Invited', className: 'border-accent/30 bg-accent-wash text-ink', title: "Hasn't signed in yet" };
  if (!user.access) return { label: 'No access' };
  return { label: 'Active', className: 'border-good/30 bg-good-wash text-ink' };
}

function UserRow({ user, self, onDelete }: { user: AdminUser; self: boolean; onDelete: () => void }) {
  const update = useUpdateUser();
  const resend = useResendInvite();
  const toast = useToast();
  const badge = status(user);
  const change = (patch: Parameters<typeof update.mutate>[0]['change'], done: string) =>
    update.mutate({ username: user.username, change: patch }, { onSuccess: () => toast.success(done), onError: toast.error });
  const who = user.email ?? user.username;

  return (
    <li className={cn('flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3', !user.enabled && 'bg-surface')}>
      <Identity user={user} self={self} />
      <Badge className={badge.className} title={badge.title}>
        {badge.label}
      </Badge>
      <Switch
        label="Access"
        checked={user.access}
        disabled={self || update.isPending}
        onChange={(access) => change({ access }, access ? `${who} can now use the dashboard` : `Removed access for ${who}`)}
      />
      <Switch
        label="Admin"
        checked={user.admin}
        disabled={self || !user.access || update.isPending}
        onChange={(admin) => change({ admin }, admin ? `${who} is now an admin` : `${who} is no longer an admin`)}
      />
      {/* Fixed width keeps the switches of every row in one column. */}
      <div className="flex items-center gap-1 sm:w-64 sm:justify-end">
        {user.status === 'FORCE_CHANGE_PASSWORD' && user.enabled && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Mail className="size-4" />}
            loading={resend.isPending}
            onClick={() => resend.mutate(user.username, { onSuccess: () => toast.success(`Invitation sent again to ${who}`), onError: toast.error })}
          >
            Resend
          </Button>
        )}
        {!self && (
          <Button size="sm" variant="ghost" onClick={() => change({ enabled: !user.enabled }, user.enabled ? `Disabled ${who}` : `Enabled ${who}`)}>
            {user.enabled ? 'Disable' : 'Enable'}
          </Button>
        )}
        {!self && (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={onDelete} aria-label={`Delete ${who}`}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

function DeleteDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const remove = useDeleteUser();
  const toast = useToast();
  const who = user.email ?? user.username;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${who}?`}
      description="This deletes the user and everything in their account: news, categories, assets, settings, chats and the Telegram link. It can't be undone."
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(user.username, {
                onSuccess: () => {
                  toast.success(`Deleting ${who}`);
                  onClose();
                },
                onError: toast.error,
              })
            }
          >
            Delete user and data
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-2">
        They are signed out and locked out right away; their data is removed in the background within a few minutes. If they sign in with Google again
        later, they start as a new, empty account waiting for access.
      </p>
    </Modal>
  );
}
