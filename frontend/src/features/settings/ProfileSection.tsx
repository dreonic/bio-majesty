import { displaySymbol } from '@bio-majesty/shared';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, Field, Input, SectionTitle, Select, Spinner, Textarea } from '../../components/ui';
import { useSettings, useStockAssets, useUpdateSettings } from '../../lib/queries';

/** Who the account's news is about, and what sentiment means: it shapes every AI task of this account. */
export function ProfileSection() {
  const settings = useSettings();
  const assets = useStockAssets().data ?? [];
  const update = useUpdateSettings();
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [context, setContext] = useState('');
  /** A symbol, or '' for the subject's business outlook. */
  const [basis, setBasis] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    const p = settings.data.profile;
    setSubject(p.subject);
    setContext(p.context);
    setBasis(p.sentimentSymbol ?? '');
  }, [settings.data]);

  if (!settings.data) {
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  }
  const p = settings.data.profile;
  const dirty = subject !== p.subject || context !== p.context || (basis || null) !== p.sentimentSymbol;
  const save = () =>
    update.mutate(
      { profile: { subject: subject.trim(), context: context.trim(), sentimentSymbol: basis || null } },
      { onSuccess: () => toast.success('Profile saved — it applies from the next run'), onError: toast.error },
    );

  return (
    <Card>
      <SectionTitle
        title="Profile"
        description="Who your news is about. The AI uses this to filter and tag news, write digests and answer in chat. Changes apply from the next run; news already found keeps its tags."
        actions={
          <Button variant="primary" size="sm" disabled={!dirty || subject.trim().length < 2} loading={update.isPending} onClick={save}>
            Save profile
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        <Field label="Subject" hint='How the AI refers to it, e.g. "the Prodia group".'>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Context" hint="Entities and their other names, look-alikes that are not related, typical news sources, what tends to move the price.">
          <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={10} maxLength={6000} />
        </Field>
        <Field label="Judge news sentiment against" hint="Positive and negative mean likely to help or hurt this. Add assets under Assets.">
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {assets.map((a) => (
              <option key={a.symbol} value={a.symbol}>
                The {displaySymbol(a.symbol)} price{a.name ? ` (${a.name})` : ''}
              </option>
            ))}
            <option value="">The subject&apos;s business outlook (no asset)</option>
          </Select>
        </Field>
      </div>
    </Card>
  );
}
