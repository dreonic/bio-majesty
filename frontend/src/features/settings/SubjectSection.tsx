import { displaySymbol, STOCK_SOURCE_INFO } from '@bio-majesty/shared';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, CardFooter, Field, Input, SectionTitle, Select, Spinner, Textarea } from '../../components/ui';
import { useSettings, useStockAssets, useUpdateSettings } from '../../lib/queries';

/** Who the profile's news is about, and what sentiment means: it shapes every AI task of this profile. */
export function SubjectSection() {
  const settings = useSettings();
  const assets = useStockAssets().data ?? [];
  const update = useUpdateSettings();
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [context, setContext] = useState('');
  /** An asset ID, or '' for the subject itself. */
  const [basis, setBasis] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    const p = settings.data.subject;
    setSubject(p.name);
    setContext(p.context);
    setBasis(p.sentimentAsset ?? '');
  }, [settings.data]);

  if (!settings.data) {
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  }
  const p = settings.data.subject;
  const dirty = subject !== p.name || context !== p.context || (basis || null) !== p.sentimentAsset;
  // The same ticker from two sources needs its source named.
  const ambiguous = (ticker: string) => assets.filter((a) => displaySymbol(a.id) === ticker).length > 1;
  const save = () =>
    update.mutate(
      { subject: { name: subject.trim(), context: context.trim(), sentimentAsset: basis || null } },
      { onSuccess: () => toast.success('Subject saved — it applies from the next run'), onError: toast.error },
    );

  return (
    <Card>
      <SectionTitle
        title="Subject"
        description="Who your news is about. The AI uses this to filter and tag news, write digests and answer in chat. Changes apply from the next run; news already found keeps its tags."
      />
      <div className="space-y-4 px-5 py-4">
        <Field label="Subject" hint='How the AI refers to what you follow, e.g. "Acme Group", "the Singapore property market" or "EU AI rules". Leave it empty to follow only the topics of your categories.'>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Context" hint="Entities and their other names, look-alikes that are not related, typical news sources, and what counts as good or bad news.">
          <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={10} maxLength={6000} />
        </Field>
        <Field label="Judge news sentiment against" hint="Positive and negative mean likely to help or hurt this. Add assets under Assets.">
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                The {displaySymbol(a.id)} price{a.name ? ` (${a.name})` : ''}
                {ambiguous(displaySymbol(a.id)) ? ` from ${STOCK_SOURCE_INFO[a.source].label}` : ''}
              </option>
            ))}
            <option value="">The subject itself: good or bad news for it (no asset)</option>
          </Select>
        </Field>
      </div>
      <CardFooter>
        <Button variant="primary" size="sm" disabled={!dirty} loading={update.isPending} onClick={save}>
          Save subject
        </Button>
      </CardFooter>
    </Card>
  );
}
