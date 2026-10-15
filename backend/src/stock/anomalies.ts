import {
  candleDate,
  detectVolumeAnomalies,
  trailingAverageVolume,
  type Candle,
  type Quote,
  type Settings,
  type VolumeAnomaly,
} from '@bio-majesty/shared';
import { errorMessage, logger } from '../lib/logger';
import { addDays, jakartaDate } from '../lib/time';
import { notifyExec } from '../notify/notify';
import { formatVolumeAlert } from '../notify/telegram';
import { getAnomaly, putAnomaly, queryDaily } from '../repo/stock';

export const ANOMALY_WINDOW = 20;
/** Calendar days of daily candles to load so a 20-trading-day window is always covered. */
const LOOKBACK_DAYS = 45;

/** Intraday check: today's running volume vs the trailing daily average. Pure. */
export function intradayVolumeAnomaly(
  quote: Pick<Quote, 'volume' | 'marketTime' | 'price' | 'changePercent'>,
  dailyBeforeToday: Candle[],
  minRatio: number,
  now = new Date(),
): Omit<VolumeAnomaly, 'notifiedAt'> | null {
  if (!quote.volume || !quote.marketTime) return null;
  const today = jakartaDate(now);
  if (jakartaDate(new Date(quote.marketTime)) !== today) return null; // market closed / stale quote
  const prior = dailyBeforeToday.filter((c) => candleDate(c.time) < today);
  const { average, count } = trailingAverageVolume(prior, prior.length, ANOMALY_WINDOW);
  if (count < 10 || average <= 0) return null;
  const ratio = quote.volume / average;
  if (ratio < minRatio) return null;
  return {
    date: today,
    time: Date.parse(`${today}T00:00:00Z`) / 1000,
    volume: quote.volume,
    averageVolume: Math.round(average),
    ratio: Number(ratio.toFixed(2)),
    close: quote.price,
    changePercent: quote.changePercent !== null ? Number(quote.changePercent.toFixed(2)) : null,
    source: 'intraday',
  };
}

/** Record (and alert once per day for) unusual volume. Never throws. */
async function recordAnomaly(symbol: string, found: Omit<VolumeAnomaly, 'notifiedAt'>, settings: Settings): Promise<VolumeAnomaly> {
  const existing = await getAnomaly(symbol, found.date);
  let notifiedAt = existing?.notifiedAt ?? null;
  if (!notifiedAt && settings.stock.volumeAlerts) {
    const sent = await notifyExec(formatVolumeAlert(symbol, found), { buttonText: 'Open dashboard', path: '/' });
    if (sent) notifiedAt = new Date().toISOString();
  }
  // End-of-day numbers replace the intraday estimate; the alert timestamp is kept.
  const record: VolumeAnomaly = { ...found, notifiedAt };
  await putAnomaly(symbol, record);
  return record;
}

export async function checkEodVolume(symbol: string, settings: Settings, now = new Date()): Promise<VolumeAnomaly | null> {
  try {
    const daily = await queryDaily(symbol, addDays(now, -LOOKBACK_DAYS), now);
    const latest = daily[daily.length - 1];
    if (!latest || now.getTime() / 1000 - latest.time > 4 * 86_400) return null; // no recent session
    const found = detectVolumeAnomalies(daily, { window: ANOMALY_WINDOW, minRatio: settings.stock.volumeRatio }).find(
      (a) => a.date === candleDate(latest.time),
    );
    return found ? await recordAnomaly(symbol, found, settings) : null;
  } catch (err) {
    logger.error('End-of-day volume check failed', { error: errorMessage(err) });
    return null;
  }
}

export async function checkIntradayVolume(symbol: string, quote: Quote | null, settings: Settings, now = new Date()): Promise<VolumeAnomaly | null> {
  if (!quote) return null;
  try {
    const daily = await queryDaily(symbol, addDays(now, -LOOKBACK_DAYS), now);
    const found = intradayVolumeAnomaly(quote, daily, settings.stock.volumeRatio, now);
    if (!found) return null;
    const existing = await getAnomaly(symbol, found.date);
    if (existing?.notifiedAt) return existing; // already flagged today
    return await recordAnomaly(symbol, found, settings);
  } catch (err) {
    logger.error('Intraday volume check failed', { error: errorMessage(err) });
    return null;
  }
}
