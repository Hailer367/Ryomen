"use client";

import { ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

export interface EquityPoint {
  time: number;
  equity: number;
}

interface Props {
  points: EquityPoint[];
  baseline?: number;
  height?: number;
  color?: string;
}

export function EquityChart({ points, baseline, height = 200, color = "#4f9cf9" }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa1ad",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(35,39,47,0.5)" },
        horzLines: { color: "rgba(35,39,47,0.5)" },
      },
      rightPriceScale: { borderColor: "#23272f", scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: "#23272f", timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
      crosshair: { horzLine: { visible: true, labelVisible: true }, vertLine: { visible: false } },
    });

    const series = chart.addAreaSeries({
      lineColor: color,
      topColor: `${color}44`,
      bottomColor: `${color}05`,
      lineWidth: 1,
      priceLineVisible: false,
    });

    series.setData(
      points
        .filter((p) => Number.isFinite(p.equity))
        .sort((a, b) => a.time - b.time)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.equity })),
    );

    if (baseline !== undefined) {
      series.createPriceLine({
        price: baseline,
        color: "#666d78",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "start",
      });
    }

    chart.timeScale().fitContent();

    const observer = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [points, baseline, height, color]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
