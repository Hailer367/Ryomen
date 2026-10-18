"use client";

import { ColorType, createChart, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartOverlay {
  label: string;
  color: string;
  values: (number | null)[];
}

export interface ChartMarker {
  time: number;
  side: "buy" | "sell";
  text?: string;
}

interface Props {
  candles: ChartCandle[];
  overlays?: ChartOverlay[];
  markers?: ChartMarker[];
  height?: number;
  /**
   * Refit the visible range only when this value changes. Without it a
   * streaming replay would re-fit (and lose the user's zoom) on every tick.
   */
  fitKey?: string | number;
  /**
   * Keep the right edge pinned to the newest bar and hold the zoom steady at a
   * fixed number of visible bars. Essential for a replay: without it the chart
   * "zooms in" as bars stream, ending on one giant candle.
   */
  follow?: boolean;
  visibleBars?: number;
}

export function CandleChart({
  candles,
  overlays = [],
  markers = [],
  height = 440,
  fitKey,
  follow = false,
  visibleBars = 110,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayRefs = useRef<ISeriesApi<"Line">[]>([]);

  // Create the chart once and keep it alive across data updates.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa1ad",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(35,39,47,0.55)" },
        horzLines: { color: "rgba(35,39,47,0.55)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#23272f", scaleMargins: { top: 0.08, bottom: 0.16 } },
      timeScale: { borderColor: "#23272f", timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
      localization: { locale: "en-US" },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#3fb950",
      downColor: "#f85149",
      borderVisible: false,
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
      priceLineVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      overlayRefs.current = [];
    };
  }, [height]);

  // Push data whenever candles / overlays / markers change.
  const lastFitRef = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const data = candles
      .filter((c) => Number.isFinite(c.close))
      .map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
    series.setData(data);

    // Rebuild overlay line series.
    for (const s of overlayRefs.current) chart.removeSeries(s);
    overlayRefs.current = [];
    for (const overlay of overlays) {
      const line = chart.addLineSeries({
        color: overlay.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(
        candles
          .map((c, i) => ({ time: c.time as UTCTimestamp, value: overlay.values[i] }))
          .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null && Number.isFinite(p.value)),
      );
      overlayRefs.current.push(line);
    }

    series.setMarkers(
      markers
        .filter((m) => Number.isFinite(m.time))
        .sort((a, b) => a.time - b.time)
        .map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
          color: m.side === "buy" ? "#3fb950" : "#f85149",
          shape: m.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: m.text ?? (m.side === "buy" ? "B" : "S"),
        })),
    );

    if (data.length === 0) return;

    if (follow) {
      // Steady zoom, right edge tracking the newest bar.
      const pad = Math.max(2, Math.round(visibleBars * 0.08));
      chart.timeScale().setVisibleLogicalRange({
        from: data.length - visibleBars,
        to: data.length + pad,
      });
      return;
    }

    if (fitKey !== undefined && lastFitRef.current !== fitKey) {
      lastFitRef.current = fitKey;
      chart.timeScale().fitContent();
    }
  }, [candles, overlays, markers, fitKey, follow, visibleBars]);

  return <div ref={containerRef} className="chart-shell" style={{ height }} />;
}
