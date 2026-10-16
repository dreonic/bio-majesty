import { errorMessage, logger } from '../lib/logger';
import { addDays } from '../lib/time';
import { escapeHtml } from '../notify/telegram';
import { notifyExec } from '../notify/notify';
import { getSettings } from '../repo/settings';
import { getStockStatus, putDailyCandles, putIntradayCandles, putQuote, putStockStatus } from '../repo/stock';
import { HISTORY_START, stockProvider } from '../stock';
import { checkEodVolume, checkIntradayVolume } from '../stock/anomalies';

const ALERT_AFTER_FAILURES = 3;
/** Yahoo keeps 15-minute bars for about 60 days: what a resync can load. */
const INTRADAY_BACKFILL_DAYS = 59;
/** The end-of-day run re-fetches this many days of 15-minute bars, so a short outage leaves no gap. */
const INTRADAY_REFETCH_DAYS = 7;

/**
 * Scheduled market-data refresh:
 *  - intraday: every 15 min during IDX hours (delayed 15m bars + quote)
 *  - eod:      after the close (re-fetch the last two weeks of daily bars and the last week of 15m bars)
 *  - resync:   full daily history since listing plus the 15m bars the provider still has
 *              (also runs automatically the first time)
 * After each refresh, unusually high volume is recorded and alerted once per day.
 */
export async function handler(event: { mode?: 'intraday' | 'eod' | 'resync' }): Promise<{ candles: number }> {
  const settings = await getSettings();
  const symbol = settings.stock.symbol;
  const provider = stockProvider();
  const status = await getStockStatus(symbol);
  // First run after deploy: load the full daily history before anything else.
  const mode = !status.historyLoadedAt ? 'resync' : (event.mode ?? 'intraday');
  try {
    const now = new Date();
    let candles = 0;
    if (mode === 'intraday') {
      const snapshot = await provider.intraday(symbol, addDays(now, -2));
      await putIntradayCandles(symbol, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      await checkIntradayVolume(symbol, snapshot.quote, settings, now);
    } else {
      const snapshot = await provider.daily(symbol, mode === 'resync' ? HISTORY_START : addDays(now, -15));
      await putDailyCandles(symbol, snapshot.candles);
      if (snapshot.quote) await putQuote(snapshot.quote);
      candles = snapshot.candles.length;
      await checkEodVolume(symbol, settings, now);
      candles += await refillIntraday(symbol, addDays(now, mode === 'resync' ? -INTRADAY_BACKFILL_DAYS : -INTRADAY_REFETCH_DAYS));
    }
    await putStockStatus(symbol, {
      lastSuccessAt: now.toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      historyLoadedAt: mode === 'resync' ? now.toISOString() : status.historyLoadedAt,
    });
    logger.info('Stock data refreshed', { mode, symbol, provider: provider.name, candles });
    return { candles };
  } catch (err) {
    const message = errorMessage(err);
    const failures = status.consecutiveFailures + 1;
    await putStockStatus(symbol, { ...status, lastError: message, consecutiveFailures: failures });
    logger.error('Stock refresh failed', { mode, symbol, provider: provider.name, error: message, failures });
    if (failures === ALERT_AFTER_FAILURES) {
      await notifyExec(
        `⚠️ <b>Stock data for ${escapeHtml(symbol)} is not updating</b>\n${failures} failed refreshes in a row (${escapeHtml(provider.name)}): ${escapeHtml(message.slice(0, 300))}`,
      );
    }
    throw err;
  }
}

/** Best effort: the daily refresh still counts as done if the 15-minute provider fails (the 15-minute runs alert on that). */
async function refillIntraday(symbol: string, from: Date): Promise<number> {
  try {
    const snapshot = await stockProvider().intraday(symbol, from);
    await putIntradayCandles(symbol, snapshot.candles);
    return snapshot.candles.length;
  } catch (err) {
    logger.warn('15-minute refill failed', { symbol, from: from.toISOString(), error: errorMessage(err) });
    return 0;
  }
}
