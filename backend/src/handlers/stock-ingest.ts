import { errorMessage, logger } from '../lib/logger';
import { addDays } from '../lib/time';
import { escapeHtml } from '../notify/telegram';
import { notifyExec } from '../notify/notify';
import { getSettings } from '../repo/settings';
import { getStockStatus, putDailyCandles, putIntradayCandles, putQuote, putStockStatus } from '../repo/stock';
import { HISTORY_START, stockProvider } from '../stock';
import { checkEodVolume, checkIntradayVolume } from '../stock/anomalies';

const ALERT_AFTER_FAILURES = 3;

/**
 * Scheduled market-data refresh:
 *  - intraday: every 15 min during IDX hours (delayed 15m bars + quote)
 *  - eod:      after the close (re-fetch the last two weeks of daily bars)
 *  - resync:   full daily history since listing (also runs automatically the first time)
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
