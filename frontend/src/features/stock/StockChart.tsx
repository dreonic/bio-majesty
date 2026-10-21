import type { Candle } from '@bio-majesty/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { displayOffsetSeconds, formatCompact, formatPrice } from '../../lib/format';

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
};

interface Props {
  candles: Candle[];
  intraday: boolean;
  /** Decimal places of the asset's prices. */
  decimals: number;
  /** Daily candle times with unusual volume (drawn at full strength). */
  highlightTimes?: Set<number>;
}

interface Readout {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function StockChart({ candles, intraday, decimals, highlightTimes }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const byTimeRef = useRef(new Map<number, Readout>());
  const [readout, setReadout] = useState<Readout | null>(null);

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
    // Re-fit when the width changes (divider drag, panel re-expanded): a fit done while the
    // panel was collapsed to 0px would otherwise leave the bars squeezed at the left edge.
    // Height changes (e.g. the unusual-volume list below) keep the user's zoom.
    let lastWidth = 0;
    const onSizeChange = (width: number) => {
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      if (width > 0) chart.timeScale().fitContent();
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().subscribeSizeChange(onSizeChange);

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.timeScale().unsubscribeSizeChange(onSizeChange);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Each asset has its own price precision (whole rupiah, cents, FX pips).
  useEffect(() => {
    chartRef.current?.applyOptions({ localization: { priceFormatter: (p: number) => formatPrice(p, decimals) } });
    candleRef.current?.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals } });
  }, [decimals]);

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

  const last = candles[candles.length - 1];
  const shown = readout ?? (last ? { ...last, time: last.time + (intraday ? displayOffsetSeconds(last.time) : 0) } : null);
  const change = shown ? shown.close - shown.open : 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {shown && (
        <div className="tabular pointer-events-none absolute top-1.5 left-2 z-10 flex flex-wrap gap-x-2.5 rounded bg-surface/85 px-1.5 py-0.5 text-[11px] text-ink-2">
          <span className="text-ink">{new Date(shown.time * 1000).toISOString().slice(0, intraday ? 16 : 10).replace('T', ' ')}</span>
          <span>O {formatPrice(shown.open, decimals)}</span>
          <span>H {formatPrice(shown.high, decimals)}</span>
          <span>L {formatPrice(shown.low, decimals)}</span>
          <span>
            C <span className={change >= 0 ? 'text-good-text' : 'text-critical'}>{formatPrice(shown.close, decimals)}</span>
          </span>
          <span>Vol {formatCompact(shown.volume)}</span>
        </div>
      )}
    </div>
  );
}
