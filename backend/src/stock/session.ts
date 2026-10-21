import { dateTimeInZone, type StockAsset, type TradingSession } from '@bio-majesty/shared';

/** Intraday refreshes continue this long after the session ends, to pick up the closing bar. */
const CLOSE_GRACE_MIN = 15;
/** The end-of-day refresh waits this long after the close (the source settles the daily bar). */
const EOD_DELAY_MIN = 60;

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * An asset's regular session as a daily pattern on its own clock, from one session the source
 * reported (Yahoo's currentTradingPeriod.regular). Crypto trades every day, everything else Mon–Fri.
 */
export function deriveSession(regular: { start: Date; end: Date }, timeZone: string, type: string | null): TradingSession {
  return {
    start: dateTimeInZone(timeZone, regular.start).slice(11),
    end: dateTimeInZone(timeZone, regular.end).slice(11),
    days: type === 'CRYPTOCURRENCY' ? 'daily' : 'weekdays',
  };
}

export function isTradingDay(session: TradingSession, ymd: string): boolean {
  if (session.days === 'daily') return true;
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function previousTradingDay(session: TradingSession, ymd: string): string | null {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  for (let back = 1; back <= 7; back++) {
    const day = new Date(t - back * 86_400_000).toISOString().slice(0, 10);
    if (isTradingDay(session, day)) return day;
  }
  return null;
}

export interface RefreshPlan {
  /** Fetch the latest intraday bars and quote (the session is open or just ended). */
  intraday: boolean;
  /** Trading date whose end-of-day refresh is due, or null. */
  eodFor: string | null;
}

/**
 * What a 15-minute tick should refresh for one asset. Uses the stored session pattern rather than
 * the source's live period, because a closed market reports its previous session. Holidays are
 * not known: they only cost a few empty requests.
 */
export function refreshPlan(
  asset: Pick<StockAsset, 'timeZone' | 'session' | 'intradayInterval'>,
  eodDoneFor: string | null,
  now: Date,
): RefreshPlan {
  const { session } = asset;
  const local = dateTimeInZone(asset.timeZone, now);
  const today = local.slice(0, 10);
  const minute = toMinutes(local.slice(11));
  const start = toMinutes(session.start);
  const end = toMinutes(session.end);
  const trading = isTradingDay(session, today);
  const open = start <= end ? minute >= start && minute <= end + CLOSE_GRACE_MIN : minute >= start || minute <= end + CLOSE_GRACE_MIN;
  // The latest trading date whose session ended at least EOD_DELAY_MIN ago (24-hour sessions: yesterday's).
  const closedToday = trading && start <= end && minute >= end + EOD_DELAY_MIN;
  const eodDate = closedToday ? today : previousTradingDay(session, today);
  return {
    intraday: asset.intradayInterval !== null && trading && open,
    eodFor: eodDate && eodDate !== eodDoneFor ? eodDate : null,
  };
}
