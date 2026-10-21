import { aliasKeys, type AliasKey } from '../lib/url';
import { aliasId, existingAliases } from '../repo/articles';
import { addRunStats } from '../repo/runs';
import { getJson, listKeys, putJson, s3Keys } from '../storage/s3';
import type { MergedCandidate, RawCandidate } from '../sources/types';
import type { PipelineState } from './state';

export function candidateAliases(c: RawCandidate): AliasKey[] {
  return aliasKeys({
    url: c.url,
    gnewsId: c.gnewsId,
    title: c.title,
    sourceName: c.sourceName,
    sourceDomain: c.sourceDomain,
  });
}

/**
 * Merge hits that refer to the same article (same URL, Google News id, or
 * headline + outlet) — e.g. one story found by several queries or by both
 * Google News and GDELT. Direct publisher URLs (GDELT) win over Google links.
 */
export function mergeCandidates(raw: RawCandidate[]): MergedCandidate[] {
  const byAlias = new Map<string, MergedCandidate>();
  const merged: MergedCandidate[] = [];
  for (const c of raw) {
    const aliases = candidateAliases(c).map(aliasId);
    const existing = aliases.map((a) => byAlias.get(a)).find(Boolean);
    if (existing) {
      existing.foundBy.push({ provider: c.provider, query: c.query });
      if (!existing.categoryHints.includes(c.categoryId)) existing.categoryHints.push(c.categoryId);
      if (existing.gnewsId && c.provider === 'gdelt') {
        existing.url = c.url; // prefer the publisher URL
      }
      existing.sourceName ??= c.sourceName;
      existing.sourceDomain ??= c.sourceDomain;
      existing.publishedAt ??= c.publishedAt;
      existing.gnewsId ??= c.gnewsId;
      for (const a of aliases) byAlias.set(a, existing);
      continue;
    }
    const m: MergedCandidate = { ...c, foundBy: [{ provider: c.provider, query: c.query }], categoryHints: [c.categoryId] };
    merged.push(m);
    for (const a of aliases) byAlias.set(a, m);
  }
  return merged;
}

/** Gather raw search results for the run, merge them, and drop articles the account already knows. */
export async function collectCandidates(state: PipelineState): Promise<PipelineState> {
  const files = await listKeys(s3Keys.rawPrefix(state.runId));
  const raw: RawCandidate[] = [];
  for (const key of files) raw.push(...((await getJson<RawCandidate[]>(key)) ?? []));

  const merged = mergeCandidates(raw);
  const allAliases = merged.flatMap(candidateAliases);
  const known = await existingAliases(state.sub, allAliases);
  const fresh = merged.filter((c) => !candidateAliases(c).some((a) => known.has(aliasId(a))));

  await putJson(s3Keys.candidates(state.runId), fresh);
  await addRunStats(state.sub, state.runId, { found: merged.length, duplicates: merged.length - fresh.length });
  const { tasks: _tasks, ...rest } = state;
  return { ...rest, candidateCount: fresh.length };
}
