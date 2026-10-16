import { dateInZone, effectiveTags, MARKET_TIME_ZONE, type Article, type Sentiment } from '@bio-majesty/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** The article picked in the News or Review tab; its marker is drawn at full strength on the stock chart. */
export interface ChartFocus {
  articleId: string;
  /** Chart day: 00:00 UTC of the article's Jakarta date, the same day the API's markers use. */
  time: number;
  sentiment: Sentiment;
}

interface ChartFocusApi {
  focused: ChartFocus | null;
  focus: (article: Article | null) => void;
  /** Clear the focus if it is this article (e.g. it was un-saved or skipped). */
  release: (articleId: string) => void;
}

const ChartFocusContext = createContext<ChartFocusApi>({ focused: null, focus: () => undefined, release: () => undefined });

export function ChartFocusProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState<ChartFocus | null>(null);
  const focus = useCallback(
    (a: Article | null) => setFocused(a ? { articleId: a.id, time: chartDay(a.publishedAt), sentiment: effectiveTags(a).sentiment } : null),
    [],
  );
  const release = useCallback((articleId: string) => setFocused((f) => (f?.articleId === articleId ? null : f)), []);
  const value = useMemo(() => ({ focused, focus, release }), [focused, focus, release]);
  return <ChartFocusContext.Provider value={value}>{children}</ChartFocusContext.Provider>;
}

export function useChartFocus() {
  return useContext(ChartFocusContext);
}

function chartDay(iso: string): number {
  return Date.parse(`${dateInZone(MARKET_TIME_ZONE, new Date(iso))}T00:00:00Z`) / 1000;
}
