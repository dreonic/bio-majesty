import type { Candle, StockMarker } from '@bio-majesty/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { displayOffsetSeconds, formatCompact, formatPrice } from '../../lib/format';
import type { ChartFocus } from './chart-focus';

/** Chart colors from the validated palette (docs/design.md). */
const C = {
  surface: '#fcfcfb',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  up: '#0ca30c',
  down: '#d03b3b',
  upVolume: 'rgba(12, 163, 12, 0.35)',
  downVolume: 'rgba(208, 59, 59, 0.35)',
  neutral: '#898781',
  undecided: '#fab219',
};

/** Shape + color per sentiment (shape keeps them apart without relying on color). */
const MARKER_STYLE: Record<StockMarker['sentiment'], Pick<SeriesMarker<Time>, 'shape' | 'color'>> = {
  positive: { shape: 'arrowUp', color: C.up },
  negative: { shape: 'arrowDown', color: C.down },
  neutral: { shape: 'circle', color: C.neutral },
  undecided: { shape: 'square', color: C.undecided },
};

/** Markers are faded until their article is picked in the News or Review tab. */
const FADED_ALPHA = 0.35;

function fade(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface Props {
  candles: Candle[];
  intraday: boolean;
  markers: StockMarker[];
  /** The picked article: its marker is drawn at full strength (added if it is not saved yet). */
  focus?: ChartFocus | null;
  /** Daily candle times with unusual volume (drawn at full strength). */
  highlightTimes?: Set<number>;
  onDaySelected: (dayTime: number | null) => void;
}

interface Readout {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function StockChart({ candles, intraday, markers, focus, highlightTimes, onDaySelected }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const byTimeRef = useRef(new Map<number, Readout>());
  const [readout, setReadout] = useState<Readout | null>(null);
  const onDaySelectedRef = useRef(onDaySelected);
  onDaySelectedRef.current = onDaySelected;

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: C.surface },
        textColor: C.muted,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: C.grid, separatorHoverColor: 'rgba(42, 120, 214, 0.15)', enableResize: false },
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.axis },
      timeScale: { borderColor: C.axis, rightOffset: 2, fixLeftEdge: true },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => formatPrice(p) },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      borderVisible: false,
      priceLineVisible: true,
      priceLineColor: C.axis,
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1);

    const onMove = (param: MouseEventParams<Time>) => {
      const t = typeof param.time === 'number' ? param.time : null;
      setReadout(t !== null ? (byTimeRef.current.get(t) ?? null) : null);
    };
    const onClick = (param: MouseEventParams<Time>) => {
      onDaySelectedRef.current(typeof param.time === 'number' ? param.time : null);
    };
    // Re-fit when the width changes (divider drag, panel re-expanded): a fit done while the
    // panel was collapsed to 0px would otherwise leave the bars squeezed at the left edge.
    // Height changes (e.g. the day's news list below) keep the user's zoom.
    let lastWidth = 0;
    const onSizeChange = (width: number) => {
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      if (width > 0) chart.timeScale().fitContent();
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    chart.timeScale().subscribeSizeChange(onSizeChange);

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;
    markersRef.current = createSeriesMarkers(candle, []);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
      chart.timeScale().unsubscribeSizeChange(onSizeChange);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Push data whenever it changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleRef.current || !volumeRef.current) return;
    // Lightweight Charts renders UTC; shift intraday bars so the axis reads in the display time zone.
    const shift = (t: number) => (intraday ? displayOffsetSeconds(t) : 0);
    const byTime = new Map<number, Readout>();
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    candleRef.current.setData(
      sorted.map((c) => {
        const time = c.time + shift(c.time);
        byTime.set(time, { ...c, time });
        return { time: time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
      }),
    );
    volumeRef.current.setData(
      sorted.map((c) => {
        const up = c.close >= c.open;
        const strong = !intraday && highlightTimes?.has(c.time);
        return { time: (c.time + shift(c.time)) as UTCTimestamp, value: c.volume, color: strong ? (up ? C.up : C.down) : up ? C.upVolume : C.downVolume };
      }),
    );
    byTimeRef.current = byTime;
    chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    chart.timeScale().fitContent();
  }, [candles, intraday, highlightTimes]);

  // News markers (daily ranges only): one marker per day and sentiment, count as label.
  useEffect(() => {
    if (!markersRef.current) return;
    if (intraday || !candles.length) {
      markersRef.current.setMarkers([]);
      return;
    }
    const first = candles[0]!.time;
    type Group = { time: number; sentiment: StockMarker['sentiment']; count: number; focused: boolean };
    const groups = new Map<string, Group>();
    for (const m of markers) {
      if (m.time < first) continue;
      const key = `${m.time}|${m.sentiment}`;
      const g = groups.get(key) ?? { time: m.time, sentiment: m.sentiment, count: 0, focused: false };
      g.count++;
      if (m.articleId === focus?.articleId) g.focused = true;
      groups.set(key, g);
    }
    // A picked review item is not a saved marker yet: show it on its own day.
    if (focus && focus.time >= first && ![...groups.values()].some((g) => g.focused)) {
      const key = `${focus.time}|${focus.sentiment}`;
      groups.set(key, { ...(groups.get(key) ?? { time: focus.time, sentiment: focus.sentiment, count: 0 }), focused: true });
    }
    const list: SeriesMarker<Time>[] = [...groups.values()]
      .sort((a, b) => a.time - b.time)
      .map((g) => {
        const style = MARKER_STYLE[g.sentiment];
        return {
          time: g.time as UTCTimestamp,
          position: g.sentiment === 'positive' ? 'belowBar' : 'aboveBar',
          shape: style.shape,
          color: g.focused ? style.color : fade(style.color, FADED_ALPHA),
          size: g.focused ? 1.6 : 1,
          text: g.count > 1 ? String(g.count) : undefined,
        };
      });
    markersRef.current.setMarkers(list);
  }, [markers, candles, intraday, focus]);

  const last = candles[candles.length - 1];
  const shown = readout ?? (last ? { ...last, time: last.time + (intraday ? displayOffsetSeconds(last.time) : 0) } : null);
  const change = shown ? shown.close - shown.open : 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {shown && (
        <div className="tabular pointer-events-none absolute top-1.5 left-2 z-10 flex flex-wrap gap-x-2.5 rounded bg-surface/85 px-1.5 py-0.5 text-[11px] text-ink-2">
          <span className="text-ink">{new Date(shown.time * 1000).toISOString().slice(0, intraday ? 16 : 10).replace('T', ' ')}</span>
          <span>O {formatPrice(shown.open)}</span>
          <span>H {formatPrice(shown.high)}</span>
          <span>L {formatPrice(shown.low)}</span>
          <span>
            C <span className={change >= 0 ? 'text-good-text' : 'text-critical'}>{formatPrice(shown.close)}</span>
          </span>
          <span>Vol {formatCompact(shown.volume)}</span>
        </div>
      )}
    </div>
  );
}
