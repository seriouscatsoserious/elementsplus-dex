import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { ratioToNumber } from "../lib/amount";
import { displayFromAtomicString } from "../lib/market";
import type { Candle } from "../lib/types";

export interface ChartPoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Atomic-price candles → display floats (rendering only). */
export function toChartPoints(candles: Candle[], bp: number, qp: number): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const c of candles) {
    const o = displayFromAtomicString(c.open, bp, qp);
    const h = displayFromAtomicString(c.high, bp, qp);
    const l = displayFromAtomicString(c.low, bp, qp);
    const cl = displayFromAtomicString(c.close, bp, qp);
    if (!o || !h || !l || !cl) continue;
    out.push({ time: c.time as UTCTimestamp, open: ratioToNumber(o), high: ratioToNumber(h), low: ratioToNumber(l), close: ratioToNumber(cl), volume: Number(c.volume) / 10 ** bp });
  }
  return out;
}

function decimalsFor(v: number): number {
  if (!v || !Number.isFinite(v)) return 4;
  if (v >= 1000) return 2;
  if (v >= 1) return 4;
  return Math.min(10, Math.max(4, Math.ceil(-Math.log10(v)) + 2));
}

export function PriceChart({ points, label }: { points: ChartPoint[]; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#9A9DA6", fontFamily: "Geist, system-ui, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "#1A1C21" }, horzLines: { color: "#1A1C21" } },
      rightPriceScale: { borderColor: "#23262D" },
      timeScale: { borderColor: "#23262D", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#3A3E48", labelBackgroundColor: "#23262D" }, horzLine: { color: "#3A3E48", labelBackgroundColor: "#23262D" } },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: "#4FC3A1",
      downColor: "#FF8A5B",
      wickUpColor: "#4FC3A1",
      wickDownColor: "#FF8A5B",
      borderVisible: false,
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candles.current.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.22 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  const precision = useMemo(() => decimalsFor(points.at(-1)?.close ?? 0), [points]);

  useEffect(() => {
    if (!candles.current || !volume.current) return;
    candles.current.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    candles.current.setData(points.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.current.setData(points.map((p) => ({ time: p.time, value: p.volume, color: p.close >= p.open ? "rgba(79,195,161,0.28)" : "rgba(255,138,91,0.28)" })));
    chart.current?.timeScale().fitContent();
  }, [points, precision]);

  return <div className="chart-el" ref={el} role="img" aria-label={label} />;
}
