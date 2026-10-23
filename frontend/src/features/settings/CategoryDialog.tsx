import type { Category, Lang, SearchQuery } from '@bio-majesty/shared';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Modal } from '../../components/overlays';
import { useToast } from '../../components/toast';
import { Button, Field, Input, Select, Switch, Textarea } from '../../components/ui';
import { useCreateCategory, useSuggestQueries, useUpdateCategory } from '../../lib/queries';
import { BACKFILL_OPTIONS } from './constants';

/** Starting points for the Prodia group (editable before saving). */
const SUGGESTED: { name: string; description: string }[] = [
  { name: 'Prodia Widyahusada', description: 'News about PT Prodia Widyahusada Tbk (PRDA) itself: results, corporate actions, management, dividends, expansion, partnerships.' },
  { name: 'Prodia Digital Indonesia', description: 'PT Prodia Digital Indonesia, the digital health subsidiary.' },
  { name: 'Proline (Prodia Diagnostic Line)', description: 'PT Prodia Diagnostic Line: reagents, diagnostic supplies and distribution.' },
  { name: 'ProSTEM', description: 'PT Prodia StemCell Indonesia and stem-cell services.' },
  { name: 'Prodia Utama', description: 'PT Prodia Utama, the controlling shareholder of PRDA.' },
  { name: 'Healthcare regulation', description: 'Indonesian regulation and policy affecting clinical laboratories (Kemenkes, BPJS Kesehatan, BPOM, tariffs).' },
  { name: 'Competitors', description: 'News about competing clinical laboratory and diagnostics chains in Indonesia.' },
];

/** Query reference shown under "Search queries"; each operator was checked against Google News RSS search. */
const QUERY_SYNTAX: { op: string; meaning: string }[] = [
  { op: '"exact phrase"', meaning: 'exact wording' },
  { op: 'A OR B', meaning: 'either term (OR in capitals)' },
  { op: '-word', meaning: 'leave out results with this word' },
  { op: '(A OR B) word', meaning: 'group alternatives' },
  { op: 'intitle:word', meaning: 'word must be in the headline' },
  { op: 'site:kontan.co.id', meaning: 'only that site' },
  { op: 'site:linkedin.com/posts', meaning: 'only LinkedIn posts' },
  { op: '-site:example.com', meaning: 'leave out that site; also adds social media and other non-news pages' },
];

export function CategoryDialog({ category, existingCount, onClose }: { category: Category | null; existingCount: number; onClose: () => void }) {
  const isNew = !category;
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [enabled, setEnabled] = useState(category?.search.enabled ?? true);
  const [queries, setQueries] = useState<SearchQuery[]>(category?.search.queries ?? []);
  const [exclude, setExclude] = useState((category?.search.exclude ?? []).join(', '));
  const [googleNews, setGoogleNews] = useState(category?.search.sources.googleNews ?? true);
  const [gdelt, setGdelt] = useState(category?.search.sources.gdelt ?? true);
  const [months, setMonths] = useState(6);
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const suggest = useSuggestQueries();
  const toast = useToast();

  const applySuggestion = () =>
    suggest.mutate(
      { name, description },
      {
        onSuccess: (s) => {
          if (!description.trim()) setDescription(s.description);
          setQueries(s.queries);
          setExclude(s.exclude.join(', '));
          toast.success(`Suggested ${s.queries.length} queries — review them before saving`);
        },
        onError: toast.error,
      },
    );

  const save = () => {
    const search = {
      enabled,
      queries: queries.filter((q) => q.q.trim().length >= 2).map((q) => ({ ...q, q: q.q.trim() })),
      exclude: exclude.split(',').map((e) => e.trim()).filter(Boolean),
      sources: { googleNews, gdelt },
    };
    const opts = { onSuccess: () => { toast.success(isNew ? (enabled && months ? 'Category added — backfill started' : 'Category added') : 'Category updated'); onClose(); }, onError: toast.error };
    if (isNew) create.mutate({ name: name.trim(), description: description.trim(), search, backfillMonths: enabled ? months : 0 }, opts);
    else update.mutate({ id: category.id, name: name.trim(), description: description.trim(), search }, opts);
  };

  const setQuery = (i: number, patch: Partial<SearchQuery>) => setQueries(queries.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'Add category' : `Edit “${category.name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={create.isPending || update.isPending} disabled={!name.trim() || (enabled && !queries.some((q) => q.q.trim().length >= 2))}>
            {isNew ? 'Add category' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {isNew && (
          <Field label="Start from a suggestion (optional)">
            <Select
              className="w-full"
              value=""
              onChange={(e) => {
                const s = SUGGESTED[Number(e.target.value)];
                if (s) {
                  setName(s.name);
                  setDescription(s.description);
                }
              }}
            >
              <option value="">Choose…</option>
              {SUGGESTED.map((s, i) => (
                <option key={s.name} value={i}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Prodia Widyahusada" maxLength={80} />
        </Field>
        <Field label="Description" hint="The AI reads this to decide which articles belong here.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
        </Field>

        <Switch checked={enabled} onChange={setEnabled} label="Search for news in this category (off = label only)" />

        {enabled && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">Search queries</span>
                <Button size="sm" icon={<Sparkles className="size-4" />} onClick={applySuggestion} loading={suggest.isPending} disabled={!name.trim()}>
                  Suggest with AI
                </Button>
              </div>
              <div className="space-y-1 text-xs text-ink-2">
                <p>Google News syntax:</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {QUERY_SYNTAX.map(({ op, meaning }) => (
                    <Fragment key={op}>
                      <dt>
                        <Op>{op}</Op>
                      </dt>
                      <dd>{meaning}</dd>
                    </Fragment>
                  ))}
                </dl>
                <p>
                  Leave out <Op>when:</Op>, <Op>after:</Op> and <Op>before:</Op>; the dashboard adds dates itself. <Op>allintitle:</Op>, <Op>inurl:</Op> and{' '}
                  <Op>source:</Op> don't work properly here.
                </p>
                <p>
                  GDELT can't handle <Op>site:</Op>, <Op>intitle:</Op> or <Op>( )</Op> groups; switch it off in categories that use them.
                </p>
              </div>
              {queries.map((q, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={q.q} onChange={(e) => setQuery(i, { q: e.target.value })} placeholder='"Prodia Widyahusada" OR PRDA' />
                  <Select value={q.lang} onChange={(e) => setQuery(i, { lang: e.target.value as Lang })} aria-label="Language" className="w-36">
                    <option value="id">Indonesian</option>
                    <option value="en">English</option>
                  </Select>
                  <Button size="sm" variant="ghost" aria-label="Remove query" onClick={() => setQueries(queries.filter((_, j) => j !== i))} icon={<Trash2 className="size-4" />} />
                </div>
              ))}
              {queries.length < 20 && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setQueries([...queries, { q: '', lang: 'id' }])}>
                  Add query
                </Button>
              )}
            </div>
            <Field label="Exclude terms" hint="Comma-separated. Results mentioning these are treated as unrelated (e.g. prodia.com for the AI company).">
              <Input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="prodia.com, image generation" />
            </Field>
            <div className="flex flex-wrap gap-6">
              <Switch checked={googleNews} onChange={setGoogleNews} label="Google News" />
              <Switch checked={gdelt} onChange={setGdelt} label="GDELT" />
            </div>
            {isNew && (
              <Field label="Initial backfill" hint="Searches the past now; the category joins the daily run when it finishes.">
                <Select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="w-full">
                  <option value={0}>No backfill — start with the daily run</option>
                  {BACKFILL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      Last {m} month{m === 1 ? '' : 's'}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
        {isNew && existingCount >= 8 && <p className="text-xs text-ink-2">Note: categories beyond the eighth share a neutral gray color.</p>}
      </div>
    </Modal>
  );
}

function Op({ children }: { children: ReactNode }) {
  return <code className="rounded bg-wash px-1">{children}</code>;
}
