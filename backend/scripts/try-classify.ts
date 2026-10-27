/**
 * Tag a single article URL with the current prompts (for prompt tuning), against the fictional
 * profile in scripts/sample-profile.ts (edit it to try your own subject).
 *
 * Usage (no AWS needed):
 *   ANTHROPIC_API_KEY=... npm run try:classify -w backend -- https://example.com/article [provider:model]
 */
import { DEFAULT_SETTINGS } from '@bio-majesty/shared';
import { classifyArticle } from '../src/ai/tasks/classify';
import { fetchArticle } from '../src/extract/fetch-article';
import { SAMPLE_PROFILE_CONTEXT } from './sample-profile';

const [url, model = DEFAULT_SETTINGS.models.tagging.model] = process.argv.slice(2);
if (!url) {
  console.error('Usage: npm run try:classify -w backend -- <url> [provider:model]');
  process.exit(1);
}

const extracted = await fetchArticle(url);
console.log(`Fetched: ${extracted.status}${extracted.error ? ` (${extracted.error})` : ''}, ${extracted.text?.length ?? 0} chars`);
const result = await classifyArticle(
  {
    title: extracted.title ?? url,
    sourceName: extracted.siteName,
    url: extracted.finalUrl,
    publishedAt: extracted.publishedTime,
    text: extracted.status === 'ok' ? extracted.text : null,
    snippet: extracted.excerpt,
    categoryHints: [],
  },
  [],
  { ...DEFAULT_SETTINGS.models.tagging, model },
  SAMPLE_PROFILE_CONTEXT,
);
console.log(JSON.stringify(result, null, 2));
