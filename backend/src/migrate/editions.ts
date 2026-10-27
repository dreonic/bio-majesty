/**
 * Search queries stored with a language (`lang: 'id' | 'en'`, from when every query searched
 * Google News Indonesia) given the matching edition (`edition: 'ID:id' | 'ID:en'`), used once by
 * scripts/migrate-editions.ts. Pure: no AWS calls.
 *
 * Expand, then contract: the migration adds `edition` and keeps `lang`, so the version before
 * editions and the one after both read the queries during the deploy; the cleanup removes `lang`
 * from queries that have an edition.
 *
 * It also lists the accounts that have categories but no stored profile subject or asset list:
 * their settings came from the defaults, which used to describe Prodia and are now blank.
 */

export type Item = Record<string, unknown>;

const LEGACY_EDITIONS: Record<string, string> = { id: 'ID:id', en: 'ID:en' };

const pk = (i: Item) => String(i.PK);
const sk = (i: Item) => String(i.SK);

interface Query {
  q?: unknown;
  lang?: unknown;
  edition?: unknown;
}

function queriesOf(item: Item): Query[] {
  const search = item.search as { queries?: unknown } | undefined;
  return Array.isArray(search?.queries) ? (search.queries as Query[]) : [];
}

/** The category item with its queries replaced, or null when none of them change. */
function withQueries(item: Item, map: (q: Query) => Query): Item | null {
  const queries = queriesOf(item);
  const next = queries.map(map);
  if (next.every((q, i) => q === queries[i])) return null;
  return { ...item, search: { ...(item.search as Item), queries: next } };
}

export interface EditionMigration {
  /** Category items to put, rewritten in place. */
  puts: Item[];
  /** The category items as stored now (what the rewrite replaces), for a backup. */
  replaced: Item[];
  /** Accounts (Cognito subs) with categories whose profile or asset list would now come from the blank defaults. */
  onDefaults: string[];
  counts: { categories: number; queries: number };
}

export function planEditionMigration(items: Item[]): EditionMigration {
  const plan: EditionMigration = { puts: [], replaced: [], onDefaults: [], counts: { categories: 0, queries: 0 } };
  const withCategories = new Set<string>();
  const settings = new Map<string, Item>();
  for (const i of items) {
    if (!pk(i).startsWith('USER#')) continue;
    const sub = pk(i).slice('USER#'.length);
    if (sk(i) === 'SETTINGS') settings.set(sub, i);
    if (!sk(i).startsWith('CATEGORY#')) continue;
    withCategories.add(sub);
    let changed = 0;
    const next = withQueries(i, (q) => {
      if (q.edition !== undefined) return q;
      changed++;
      return { ...q, edition: LEGACY_EDITIONS[String(q.lang)] ?? 'ID:id' };
    });
    if (!next) continue;
    plan.puts.push(next);
    plan.replaced.push(i);
    plan.counts.categories++;
    plan.counts.queries += changed;
  }
  for (const sub of withCategories) {
    const data = (settings.get(sub)?.data ?? {}) as { profile?: { subject?: unknown }; stock?: { assets?: unknown } };
    if (!data.profile?.subject || !Array.isArray(data.stock?.assets)) plan.onDefaults.push(sub);
  }
  return plan;
}

/** Category items whose queries still carry `lang` next to their edition, without it. */
export function planLangCleanup(items: Item[]): Item[] {
  const puts: Item[] = [];
  for (const i of items) {
    if (!pk(i).startsWith('USER#') || !sk(i).startsWith('CATEGORY#')) continue;
    const next = withQueries(i, (q) => {
      if (q.lang === undefined || q.edition === undefined) return q;
      const { lang: _lang, ...rest } = q;
      return rest;
    });
    if (next) puts.push(next);
  }
  return puts;
}
