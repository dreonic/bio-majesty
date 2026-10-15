/**
 * Check that every configured model can do the two things the app needs:
 * structured tagging and a tool-calling chat turn.
 *
 * Usage (keys from env vars, no AWS needed):
 *   ANTHROPIC_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... npm run smoke:models -w backend
 *   npm run smoke:models -w backend -- anthropic:claude-haiku-5-5 openai:gpt-6-luna
 *
 * This calls real model APIs (a few cents per model).
 */
import { DEFAULT_SETTINGS, LANGUAGE_MODELS, type Category } from '@bio-majesty/shared';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { configuredProviders, languageModel } from '../src/ai/registry';
import { mergeProviderOptions } from '../src/ai/run-task';
import { classifyArticle } from '../src/ai/tasks/classify';

const categories: Category[] = [
  {
    id: 'corp',
    name: 'Prodia Widyahusada',
    description: 'Corporate news about PT Prodia Widyahusada Tbk (PRDA).',
    color: '#2a78d6',
    search: { enabled: false, queries: [], exclude: [], sources: { googleNews: false, gdelt: false } },
    backfill: { months: 0, status: 'none', runId: null, startedAt: null, completedAt: null, error: null },
    active: true,
    createdAt: '',
    updatedAt: '',
  },
];

const FIXTURES = [
  {
    title: 'Prodia membukukan kenaikan laba bersih 12% pada kuartal III',
    text: 'PT Prodia Widyahusada Tbk (PRDA) melaporkan laba bersih naik 12% secara tahunan pada kuartal ketiga, didorong oleh peningkatan layanan pemeriksaan kesehatan korporat dan tes khusus. Manajemen menargetkan pembukaan klinik baru tahun depan.',
  },
  {
    title: 'Kemenkes kaji ulang tarif pemeriksaan laboratorium untuk peserta BPJS',
    text: 'Kementerian Kesehatan sedang mengkaji tarif pemeriksaan laboratorium yang ditanggung BPJS Kesehatan. Pelaku industri laboratorium khawatir penurunan tarif akan menekan margin.',
  },
];

async function smoke(model: string): Promise<boolean> {
  let ok = true;
  const settings = { ...DEFAULT_SETTINGS.models.tagging, model, fallbackModel: null };
  for (const f of FIXTURES) {
    const started = Date.now();
    try {
      const c = await classifyArticle(
        { title: f.title, sourceName: 'Smoke test', url: 'https://example.com', publishedAt: null, text: f.text, snippet: null, categoryHints: ['corp'] },
        categories,
        settings,
      );
      console.log(`  ✓ tagging (${Date.now() - started} ms): ${c.sentiment}, categories=[${c.categoryIds.join(',')}], conf=${c.confidence.toFixed(2)}`);
    } catch (err) {
      ok = false;
      console.log(`  ✗ tagging failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    let called = false;
    const res = await generateText({
      model: await languageModel(model),
      instructions: 'Answer using the tool.',
      prompt: 'What is the latest PRDA closing price?',
      tools: {
        getStockPrices: tool({
          description: 'Get PRDA prices',
          inputSchema: z.object({ from: z.string() }),
          execute: async () => {
            called = true;
            return { lastClose: 3140 };
          },
        }),
      },
      stopWhen: isStepCount(3),
      providerOptions: mergeProviderOptions(model, null) as never,
    });
    if (!called) throw new Error('model did not call the tool');
    console.log(`  ✓ tool calling: "${res.text.slice(0, 80).replace(/\s+/g, ' ')}"`);
  } catch (err) {
    ok = false;
    console.log(`  ✗ tool calling failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ok;
}

const providers = await configuredProviders();
const requested = process.argv.slice(2);
const models = requested.length ? requested : LANGUAGE_MODELS.filter((m) => providers.includes(m.provider)).map((m) => m.id);
if (!models.length) {
  console.error('No models to test: set at least one provider API key (e.g. ANTHROPIC_API_KEY).');
  process.exit(1);
}
let failed = 0;
for (const model of models) {
  console.log(model);
  if (!(await smoke(model))) failed++;
}
console.log(failed ? `\n${failed} model(s) failed` : '\nAll models passed');
process.exit(failed ? 1 : 0);
