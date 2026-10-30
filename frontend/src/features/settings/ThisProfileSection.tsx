import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useProfiles } from '../../app/profiles';
import { Modal } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Button, Card, Field, Input, SectionTitle } from '../../components/ui';

/** The open profile itself: its name (in the profile menu and on its Telegram messages), and deleting it. */
export function ThisProfileSection() {
  const { profiles, current, rename, remove } = useProfiles();
  const toast = useToast();
  const [name, setName] = useState(current.name);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => setName(current.name), [current.name]);

  const dirty = name.trim().length > 0 && name.trim() !== current.name;
  const onlyOne = profiles.length <= 1;
  const save = () => {
    setSaving(true);
    rename(current.id, name.trim())
      .then(() => toast.success('Profile renamed'))
      .catch(toast.error)
      .finally(() => setSaving(false));
  };
  const deleteProfile = () => {
    const deletedName = current.name;
    setDeleting(true);
    remove(current.id)
      .then(() => toast.success(`${deletedName} deleted`))
      .catch((err: unknown) => {
        toast.error(err);
        setDeleting(false);
        setConfirming(false);
      });
  };

  return (
    <Card>
      <SectionTitle
        title="This profile"
        description="Everything on this page and the dashboard belongs to this profile. Switch profiles or add one from the menu at the top right."
        actions={
          <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={save}>
            Save name
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-4 px-5 pt-4 pb-2">
        <div className="min-w-56 flex-1">
          <Field label="Name" hint="Shown in the profile menu and at the top of this profile's Telegram messages.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" />}
          disabled={onlyOne}
          title={onlyOne ? 'This is your only profile: add another one before deleting it' : undefined}
          onClick={() => setConfirming(true)}
        >
          Delete profile
        </Button>
      </div>
      <p className="px-5 pb-4 text-xs text-ink-2">
        Profile ID <code className="tabular">{current.id}</code> (for scripts such as export:feedback)
      </p>
      <Modal
        open={confirming}
        onOpenChange={(open) => !deleting && setConfirming(open)}
        title={`Delete ${current.name}?`}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 className="size-4" />} loading={deleting} onClick={deleteProfile}>
              Delete for good
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          Its news (saved news too), categories, assets, review decisions, chats, settings and Telegram connections are deleted for good. Your other
          profiles stay as they are.
        </p>
      </Modal>
    </Card>
  );
}
