import type { Article, Feedback } from '@bio-majesty/shared';
import { loadSubjectContext } from '../ai/subject';
import { classifyArticle } from '../ai/tasks/classify';
import { UsageCollector } from '../ai/usage';
import { fetchArticle, type ExtractedArticle } from '../extract/fetch-article';
import { errorMessage, logger } from '../lib/logger';
import { aliasKeys, cleanUrl, domainOf, isGoogleNewsUrl } from '../lib/url';
import { addRunItem, aliasId, createArticle, existingAliases } from '../repo/articles';
import { listCategories } from '../repo/categories';
import { listFeedback } from '../repo/feedback';
import { addRunStats, recordRunUsage } from '../repo/runs';
import { getSettings } from '../repo/settings';
import { getJson, putJson, s3Keys } from '../storage/s3';
import { decodeGoogleNewsUrl } from '../sources/gnews-decode';
import type { MergedCandidate } from '../sources/types';
import { articleFromCandidate } from './article-factory';
import type { EnrichInput } from './state';

export type EnrichOutcome = 'pending' | 'filtered' | 'duplicate' | 'missing';

const EXAMPLES_TTL_MS = 10 * 60 * 1000;
const examplesCache = new Map<string, { at: number; limit: number; items: Feedback[] }>();

/** The account's most recent corrections (cached per Lambda instance). */
async function correctionExamples(sub: string, limit: number): Promise<Feedback[]> {
  const cached = examplesCache.get(sub);
  if (cached && cached.limit === limit && Date.now() - cached.at < EXAMPLES_TTL_MS) return cached.items;
  try {
    const items = await listFeedback(sub, { limit, onlyCorrections: true });
    examplesCache.set(sub, { at: Date.now(), limit, items });
    return items;
  } catch (err) {
    logger.warn('Could not load correction examples; tagging without them', { error: errorMessage(err) });
    return [];
  }
}

/** Resolve the publisher URL, fetch the article, tag it with the LLM, and store it for review. */
export async function enrichCandidate(input: EnrichInput): Promise<{ outcome: EnrichOutcome; articleId?: string }> {
  const { sub } = input;
  const candidate = await getJson<MergedCandidate>(s3Keys.relevantItem(input.runId, input.candidateId));
  if (!candidate) return { outcome: 'missing' };

  // 1. Resolve Google News redirect links to the publisher URL (best effort).
  let url = candidate.url;
  if (isGoogleNewsUrl(url)) {
    try {
      const decoded = await decodeGoogleNewsUrl(url);
      if (decoded) url = cleanUrl(decoded);
    } catch (err) {
      logger.warn('Google News decode failed; keeping Google link', { error: errorMessage(err) });
    }
  }

  const aliases = aliasKeys({
    url,
    gnewsId: candidate.gnewsId,
    title: candidate.title,
    sourceName: candidate.sourceName,
    sourceDomain: candidate.sourceDomain ?? domainOf(url),
  });

  // 2. The real URL may reveal a duplicate the collect step could not see.
  if (url !== candidate.url) {
    const known = await existingAliases(sub, aliases);
    if (aliases.some((a) => known.has(aliasId(a)))) {
      await addRunStats(sub, input.runId, { duplicates: 1 });
      return { outcome: 'duplicate' };
    }
  }

  // 3. Fetch and extract the article text (may be paywalled or blocked).
  let extracted: ExtractedArticle | null = null;
  if (!isGoogleNewsUrl(url)) extracted = await fetchArticle(url);

  // 4. Tag with the LLM.
  const [categories, settings] = await Promise.all([listCategories(sub), getSettings(sub)]);
  const usage = new UsageCollector();
  const examples = settings.learning.useFeedbackContext ? await correctionExamples(sub, settings.learning.maxExamples) : [];
  const subject = await loadSubjectContext(settings);
  let article: Article;
  try {
    const classification = await classifyArticle(
      {
        title: candidate.title,
        sourceName: candidate.sourceName ?? extracted?.siteName ?? null,
        url,
        publishedAt: candidate.publishedAt,
        text: extracted?.status === 'ok' ? extracted.text : null,
        snippet: candidate.snippet ?? extracted?.excerpt ?? null,
        categoryHints: candidate.categoryHints,
      },
      categories,
      settings.models.tagging,
      subject,
      usage,
      examples,
    );
    const publishedAt =
      candidate.publishedAt ??
      (classification.publishedDate ? new Date(`${classification.publishedDate}T00:00:00+07:00`).toISOString() : null);
    article = articleFromCandidate(candidate, {
      status: classification.relevant ? 'PENDING' : 'FILTERED',
      runId: input.runId,
      runType: input.runType,
      categoryId: input.categoryId,
      url,
      publishedAt,
      lang: extracted?.lang ?? candidate.lang,
      snippet: candidate.snippet ?? extracted?.excerpt ?? null,
      textStatus: extracted ? extracted.status : 'skipped',
      filterReason: classification.relevant ? null : `Tagger: not about ${settings.subject.name ? `${settings.subject.name} or ` : ''}any category`,
      suggestion: {
        categoryIds: classification.categoryIds,
        sentiment: classification.sentiment,
        rationale: classification.rationale,
        confidence: classification.confidence,
        relevance: classification.relevance,
        summary: classification.summary,
        model: classification.model,
      },
    });
  } catch (err) {
    // Keep the item reviewable even if every model attempt failed.
    logger.error('Tagging failed; storing article without suggestion', { error: errorMessage(err) });
    await addRunStats(sub, input.runId, { errors: 1 });
    article = articleFromCandidate(candidate, {
      status: 'PENDING',
      runId: input.runId,
      runType: input.runType,
      categoryId: input.categoryId,
      url,
      textStatus: extracted ? extracted.status : 'skipped',
    });
  } finally {
    await recordRunUsage(input.runId, usage.toEntries());
  }

  // 5. Persist.
  if (extracted?.text) {
    await putJson(s3Keys.articleText(sub, article.id), {
      url,
      title: extracted.title,
      text: extracted.text,
      extractedAt: new Date().toISOString(),
    });
  }
  const created = await createArticle(sub, article, aliases);
  if (!created) {
    await addRunStats(sub, input.runId, { duplicates: 1 });
    return { outcome: 'duplicate', articleId: article.id };
  }
  if (article.status === 'PENDING') {
    await addRunItem(input.runId, article.id);
    await addRunStats(sub, input.runId, { pending: 1 });
    return { outcome: 'pending', articleId: article.id };
  }
  await addRunStats(sub, input.runId, { filtered: 1 });
  return { outcome: 'filtered', articleId: article.id };
}
