import { z } from 'zod';

/**
 * Google News editions a search query can use: a country and a language, keyed by Google's own
 * edition ID (`ceid`). Each one was checked against news.google.com/rss/search on 2026-10-27
 * (local headlines in its language); Google redirects combinations it lacks, e.g. SG:zh-Hans,
 * to another edition, so add new ones only after the same check.
 */
export const EDITIONS = {
  'AU:en': { label: 'Australia · English', hl: 'en-AU', lang: 'en' },
  'BR:pt-419': { label: 'Brazil · Portuguese', hl: 'pt-BR', lang: 'pt' },
  'CA:en': { label: 'Canada · English', hl: 'en-CA', lang: 'en' },
  'CN:zh-Hans': { label: 'China · Chinese (Simplified)', hl: 'zh-CN', lang: 'zh' },
  'FR:fr': { label: 'France · French', hl: 'fr', lang: 'fr' },
  'DE:de': { label: 'Germany · German', hl: 'de', lang: 'de' },
  'HK:zh-Hant': { label: 'Hong Kong · Chinese (Traditional)', hl: 'zh-HK', lang: 'zh' },
  'IN:en': { label: 'India · English', hl: 'en-IN', lang: 'en' },
  'ID:en': { label: 'Indonesia · English', hl: 'en-ID', lang: 'en' },
  'ID:id': { label: 'Indonesia · Indonesian', hl: 'id', lang: 'id' },
  'IT:it': { label: 'Italy · Italian', hl: 'it', lang: 'it' },
  'JP:ja': { label: 'Japan · Japanese', hl: 'ja', lang: 'ja' },
  'MY:en': { label: 'Malaysia · English', hl: 'en-MY', lang: 'en' },
  'MY:ms': { label: 'Malaysia · Malay', hl: 'ms-MY', lang: 'ms' },
  'NL:nl': { label: 'Netherlands · Dutch', hl: 'nl', lang: 'nl' },
  'NZ:en': { label: 'New Zealand · English', hl: 'en-NZ', lang: 'en' },
  'PH:en': { label: 'Philippines · English', hl: 'en-PH', lang: 'en' },
  'SG:en': { label: 'Singapore · English', hl: 'en-SG', lang: 'en' },
  'KR:ko': { label: 'South Korea · Korean', hl: 'ko', lang: 'ko' },
  'ES:es': { label: 'Spain · Spanish', hl: 'es', lang: 'es' },
  'TW:zh-Hant': { label: 'Taiwan · Chinese (Traditional)', hl: 'zh-TW', lang: 'zh' },
  'TH:th': { label: 'Thailand · Thai', hl: 'th', lang: 'th' },
  'AE:ar': { label: 'United Arab Emirates · Arabic', hl: 'ar', lang: 'ar' },
  'GB:en': { label: 'United Kingdom · English', hl: 'en-GB', lang: 'en' },
  'US:en': { label: 'United States · English', hl: 'en-US', lang: 'en' },
  'VN:vi': { label: 'Vietnam · Vietnamese', hl: 'vi', lang: 'vi' },
} as const satisfies Record<string, { label: string; hl: string; lang: string }>;

export type Edition = keyof typeof EDITIONS;
/** Edition IDs in the order the edition picker lists them (by country). */
export const EDITION_IDS = Object.keys(EDITIONS) as [Edition, ...Edition[]];
export const EditionSchema = z.enum(EDITION_IDS);

/** Edition of a query added by hand (the AI's suggestions pick their own). */
export const DEFAULT_EDITION: Edition = 'US:en';
