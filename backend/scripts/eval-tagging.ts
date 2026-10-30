/**
 * Score a candidate tagging model against one account's past decisions, so a
 * model switch in Settings can be justified with evidence.
 *
 * Usage (reads the deployed table and article texts; needs AWS credentials
 * plus the candidate provider's API key; calls the model once per example).
 * The account is its Cognito user's `sub` (User ID in the Cognito console):
 *   TABLE_NAME=... DATA_BUCKET=... AWS_REGION=ap-southeast-1 ANTHROPIC_API_KEY=... \
 *     npm run eval:tagging -w backend -- anthropic:claude-haiku-5-5 --sub <sub> --limit 50
 */
import { DEFAULT_SETTINGS } from '@bio-majesty/shared';
import { loadSubjectContext } from '../src/ai/subject';
import { classifyArticle } from '../src/ai/tasks/classify';
import { UsageCollector } from '../src/ai/usage';
import { listCategories } from '../src/repo/categories';
import { listFeedback } from '../src/repo/feedback';
import { getSettings } from '../src/repo/settings';
import { getJson, s3Keys } from '../src/storage/s3';
import type { StoredArticleText } from '../src/vectors/indexer';

const args = process.argv.slice(2);
const model = args.find((a) => a.includes(':'));
const sub = args.includes('--sub') ? args[args.indexOf('--sub') + 1] : undefined;
const limit = Number(args[args.indexOf('--limit') + 1]) || 50;
if (!model || !sub) {
  console.error('Usage: npm run eval:tagging -w backend -- <provider:model> --sub <sub> [--limit 50]');
  process.exit(1);
}

const categories = await listCategories(sub);
const subject = await loadSubjectContext(await getSettings(sub));
const examples = (await listFeedback(sub, { limit })).filter((f) => f.exec && f.decision !== 'rejected');
if (!examples.length) {
  console.error('No approved decisions to evaluate against yet.');
  process.exit(1);
}

const usage = new UsageCollector();
let sentimentHits = 0;
let jaccardSum = 0;
let errors = 0;
for (const f of examples) {
  const stored = await getJson<StoredArticleText>(s3Keys.articleText(sub, f.articleId));
  try {
    const c = await classifyArticle(
      { title: f.title, sourceName: f.sourceName, url: f.url, publishedAt: f.publishedAt, text: stored?.text ?? null, snippet: null, categoryHints: [] },
      categories,
      { ...DEFAULT_SETTINGS.models.tagging, model, fallbackModel: null },
      subject,
      usage,
    );
    if (c.sentiment === f.exec!.sentiment) sentimentHits++;
    const a = new Set(c.categoryIds);
    const b = new Set(f.exec!.categoryIds);
    const union = new Set([...a, ...b]);
    jaccardSum += union.size ? [...a].filter((x) => b.has(x)).length / union.size : 1;
  } catch (err) {
    errors++;
    console.error(`  error on "${f.title.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

const n = examples.length - errors;
const tokens = usage.toEntries().reduce((s, u) => ({ in: s.in + u.inputTokens, out: s.out + u.outputTokens }), { in: 0, out: 0 });
console.log(`Model: ${model}`);
console.log(`Examples: ${n} (errors: ${errors})`);
console.log(`Sentiment agreement with the reviewer: ${((sentimentHits / Math.max(1, n)) * 100).toFixed(1)}%`);
console.log(`Category overlap (mean Jaccard): ${((jaccardSum / Math.max(1, n)) * 100).toFixed(1)}%`);
console.log(`Tokens: ${tokens.in} in / ${tokens.out} out`);
