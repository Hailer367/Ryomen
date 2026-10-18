import { atr, closes, crossOver, crossUnder, ema, memoized, rollingMax, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/market/types";
import { buy, hold, sell, type Strategy, type StrategyContext } from "@/lib/strategies/types";

/**
 * Moving-Average Crossover — Ryomen's primary, default strategy.
 *
 * The rule, plainly: when the shorter average crosses above the longer one,
 * buy; when it crosses back below, sell. Nothing else. Each bot designates this
 * as its authoritative signal, so a crossover is acted on directly rather than
 * being outvoted by its supporting strategies.
 */
export const smaGoldenCross: Strategy = Object.freeze({
  id: "sma-golden-cross",
  name: "Moving-Average Crossover",
  category: "Trend",
  description:
    "Buys when the shorter simple moving average crosses above the longer one, and sells when it crosses back below.",
  philosophy: "When the short average moves from below to above the long average, momentum has flipped to bullish. That is the whole rule.",
  defaultParams: { fast: 20, slow: 50 },
  /**
   * The same cross, calibrated per bar size. On daily bars 20/50 is the classic
   * swing pair. On hourly bars that would mean 20 hours vs 50 hours — far too
   * twitchy, producing ~28 round trips a quarter and ~$570 of fees on a $10k
   * account. Widening to 50/200 (≈2 days vs ≈8 days) restores the same
   * character the rule was designed for.
   */
  granularityProfiles: {
    "30m": { params: { fast: 100, slow: 400 }, minCandles: 405 },
    "1h": { params: { fast: 50, slow: 200 }, minCandles: 205 },
    "4h": { params: { fast: 30, slow: 120 }, minCandles: 125 },
    "1d": { params: { fast: 20, slow: 50 }, minCandles: 55 },
  },
  paramsMeta: [
    { key: "fast", label: "Short average (SMA)", min: 3, max: 100 },
    { key: "slow", label: "Long average (SMA)", min: 10, max: 400 },
  ],
  minCandles: 55,
  evaluate({ candles, index, params }: StrategyContext) {
    const fast = Math.round(params.fast);
    const slow = Math.round(params.slow);
    if (index < slow + 1) return hold("Warming up: not enough history for both averages.");

    const price = closes(candles as never);
    const fastSeries = sma(price, fast);
    const slowSeries = sma(price, slow);

    const gapPct = ((fastSeries[index]! - slowSeries[index]!) / slowSeries[index]!) * 100;
    const strength = Math.min(1, Math.abs(gapPct) / 3);

    if (crossOver(fastSeries, slowSeries, index)) {
      return buy(
        `SMA(${fast}) crossed above SMA(${slow}) — buying.`,
        Math.max(0.7, strength),
      );
    }
    if (crossUnder(fastSeries, slowSeries, index)) {
      return sell(
        `SMA(${fast}) crossed below SMA(${slow}) — selling.`,
        Math.max(0.7, strength),
      );
    }
    return hold(
      `SMA(${fast}) is ${gapPct >= 0 ? "above" : "below"} SMA(${slow}) by ${Math.abs(gapPct).toFixed(2)}% — no cross.`,
    );
  },
});

/**
 * MACD Trend Rider — MACD signal-line crosses, gated by a long-term trend filter.
 */
export const macdTrend: Strategy = Object.freeze({
  id: "macd-trend",
  name: "MACD Trend Rider",
  category: "Momentum",
  description:
    "Buys MACD bullish crosses only when price is above a long-term EMA; exits on bearish crosses.",
  philosophy: "Momentum crosses are noisy on their own. A trend filter removes counter-trend whipsaws.",
  defaultParams: { fast: 12, slow: 26, signal: 9, trendFilter: 100 },
  paramsMeta: [
    { key: "fast", label: "MACD fast EMA", min: 3, max: 50 },
    { key: "slow", label: "MACD slow EMA", min: 10, max: 100 },
    { key: "signal", label: "Signal EMA", min: 2, max: 30 },
    { key: "trendFilter", label: "Trend filter EMA", min: 20, max: 400 },
  ],
  minCandles: 120,
  evaluate({ candles, index, params }: StrategyContext) {
    const filterPeriod = Math.round(params.trendFilter);
    if (index < filterPeriod + 2) return hold("Warming up: trend filter needs more history.");

    const price = closes(candles as never);
    const filter = ema(price, filterPeriod);
    const filterValue = filter[index];
    if (filterValue === null) return hold("Trend filter unavailable.");

    // Recompute MACD locally so each strategy stays self-contained.
    const { macd } = localMacd(price, Math.round(params.fast), Math.round(params.slow), Math.round(params.signal));
    const bullish = crossOver(macd.macd, macd.signal, index);
    const bearish = crossUnder(macd.macd, macd.signal, index);
    const aboveFilter = price[index] > filterValue;

    const hist = macd.histogram[index] ?? 0;
    const strength = Math.min(1, Math.abs(hist) / (price[index] * 0.01) || 0.5);

    if (bullish && aboveFilter) {
      return buy("MACD crossed above its signal line while price trades above the long-term trend filter.", Math.max(0.6, strength));
    }
    if (bearish) {
      return sell("MACD crossed below its signal line — momentum rolled over.", Math.max(0.55, strength));
    }
    return hold(
      `${aboveFilter ? "Above" : "Below"} trend filter; MACD histogram ${hist >= 0 ? "+" : ""}${hist.toFixed(4)}.`,
    );
  },
});

function localMacd(values: readonly number[], fast: number, slow: number, signalPeriod: number) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: (number | null)[] = values.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );
  const dense: number[] = [];
  const idx: number[] = [];
  macdLine.forEach((v, i) => {
    if (v !== null) {
      dense.push(v);
      idx.push(i);
    }
  });
  const denseSignal = ema(dense, signalPeriod);
  const signal: (number | null)[] = new Array(values.length).fill(null);
  denseSignal.forEach((v, j) => {
    if (v !== null) signal[idx[j]] = v;
  });
  const histogram: (number | null)[] = values.map((_, i) =>
    macdLine[i] !== null && signal[i] !== null ? (macdLine[i] as number) - (signal[i] as number) : null,
  );
  return { macd: { macd: macdLine, signal, histogram } };
}

/**
 * Donchian Breakout — buys new N-bar highs, exits on a shorter M-bar low.
 */
export const donchianBreakout: Strategy = Object.freeze({
  id: "donchian-breakout",
  name: "Donchian Breakout",
  category: "Breakout",
  description: "Buys when price closes above the prior N-bar high and exits on a close below the prior M-bar low.",
  philosophy: "Turtles were right: the only way to catch a large move is to buy strength and cut when it fails.",
  defaultParams: { entryPeriod: 20, exitPeriod: 10 },
  paramsMeta: [
    { key: "entryPeriod", label: "Breakout lookback", min: 5, max: 120 },
    { key: "exitPeriod", label: "Exit lookback", min: 3, max: 60 },
  ],
  minCandles: 25,
  evaluate({ candles, index, params }: StrategyContext) {
    const entry = Math.round(params.entryPeriod);
    const exit = Math.round(params.exitPeriod);
    if (index < entry + 2) return hold("Warming up: breakout channel not ready.");

    // Compare against the channel formed by bars *before* the current one.
    let priorHigh = -Infinity;
    for (let j = index - entry; j < index; j++) priorHigh = Math.max(priorHigh, candles[j].high);
    let priorLow = Infinity;
    for (let j = index - exit; j < index; j++) priorLow = Math.min(priorLow, candles[j].low);

    const price = candles[index].close;
    const breakoutPct = ((price - priorHigh) / priorHigh) * 100;

    if (price > priorHigh) {
      return buy(
        `Closed above the prior ${entry}-bar high (${priorHigh.toFixed(2)}), a fresh breakout.`,
        Math.min(1, Math.max(0.6, breakoutPct / 2)),
        { stopLossPrice: priorLow },
      );
    }
    if (price < priorLow) {
      return sell(
        `Closed below the prior ${exit}-bar low (${priorLow.toFixed(2)}) — breakout failed.`,
        0.7,
      );
    }
    return hold(`Inside the channel (${priorLow.toFixed(2)} – ${priorHigh.toFixed(2)}).`);
  },
});

/**
 * Bollinger Reversion — fades stretches away from a moving average.
 */
export const bollingerReversion: Strategy = Object.freeze({
  id: "bollinger-reversion",
  name: "Bollinger Reversion",
  category: "Mean Reversion",
  description: "Buys closes below the lower Bollinger Band and exits on a return to the upper band or middle band.",
  philosophy: "Range-bound assets oscillate around a mean; extremes are statistically likely to revert.",
  defaultParams: { period: 20, mult: 2, exitAtMiddle: 1 },
  paramsMeta: [
    { key: "period", label: "Band period", min: 5, max: 100 },
    { key: "mult", label: "Std-dev multiple", min: 1, max: 4 },
    { key: "exitAtMiddle", label: "Exit at middle band (1=yes)", min: 0, max: 1 },
  ],
  minCandles: 25,
  evaluate({ candles, index, params, position }: StrategyContext) {
    const period = Math.round(params.period);
    if (index < period + 1) return hold("Warming up: bands not ready.");

    const price = closes(candles as never);
    // Local band computation.
    const mid = sma(price, period);
    const mean = mid[index];
    if (mean === null) return hold("Bands unavailable.");
    let variance = 0;
    for (let j = index - period + 1; j <= index; j++) variance += (price[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    const upper = mean + params.mult * sd;
    const lower = mean - params.mult * sd;

    const exitMiddle = params.exitAtMiddle >= 0.5;
    const close = price[index];

    if (close < lower) {
      return buy(
        `Price (${close.toFixed(2)}) pierced the lower Bollinger Band (${lower.toFixed(2)}) — stretched below the mean.`,
        Math.min(1, Math.max(0.55, (lower - close) / (sd || 1))),
        { takeProfitPrice: exitMiddle ? mean : upper },
      );
    }
    if (position) {
      if (exitMiddle && close >= mean) {
        return sell(`Price reverted to the middle band (${mean.toFixed(2)}) — target reached.`, 0.7);
      }
      if (!exitMiddle && close >= upper) {
        return sell(`Price reached the upper Bollinger Band (${upper.toFixed(2)}).`, 0.65);
      }
    }
    return hold(`Price within bands (${lower.toFixed(2)} – ${upper.toFixed(2)}).`);
  },
});

/**
 * RSI Exhaustion Reversal — buys oversold recoveries, sells overbought rollovers.
 */
export const rsiReversal: Strategy = Object.freeze({
  id: "rsi-reversal",
  name: "RSI Exhaustion Reversal",
  category: "Mean Reversion",
  description: "Buys when RSI climbs back out of oversold territory and exits when RSI falls from overbought.",
  philosophy: "Momentum oscillators flag exhaustion. Trading the *recovery* from an extreme beats catching a knife.",
  defaultParams: { period: 14, oversold: 30, overbought: 70 },
  paramsMeta: [
    { key: "period", label: "RSI period", min: 5, max: 50 },
    { key: "oversold", label: "Oversold level", min: 5, max: 45 },
    { key: "overbought", label: "Overbought level", min: 55, max: 95 },
  ],
  minCandles: 20,
  evaluate({ candles, index, params }: StrategyContext) {
    const period = Math.round(params.period);
    if (index < period + 2) return hold("Warming up: RSI not ready.");

    const rsiSeries = localRsi(closes(candles as never), period);
    const now = rsiSeries[index];
    const prev = rsiSeries[index - 1];
    if (now === null || prev === null) return hold("RSI unavailable.");

    const oversold = params.oversold;
    const overbought = params.overbought;

    if (prev <= oversold && now > oversold) {
      return buy(`RSI reclaimed ${oversold} from oversold (now ${now.toFixed(1)}) — exhaustion reversing.`, 0.65);
    }
    if (prev >= overbought && now < overbought) {
      return sell(`RSI slipped below ${overbought} from overbought (now ${now.toFixed(1)}) — momentum fading.`, 0.65);
    }
    return hold(`RSI is ${now.toFixed(1)} — no extreme.`);
  },
});

function localRsi(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/**
 * BTC Momentum Rider — **Bitcoin only**.
 *
 * Time-series momentum gated by a trend filter, with three independent ways to
 * leave: momentum decays, the trend breaks, or price drops a volatility-scaled
 * distance from its high.
 *
 * Written to be safe to run forward on live data:
 *  - every input is derived from *closed* bars at or before `index`; nothing
 *    looks ahead, so the signal on the latest closed bar is the same one it
 *    would have produced in real time,
 *  - every indicator is memoised per bar array, so the decision depends only on
 *    the bars fed in — not on how far the series extends afterwards.
 */
export const btcMomentumRider: Strategy = Object.freeze({
  id: "btc-momentum-rider",
  name: "BTC Momentum Rider",
  category: "Momentum",
  coins: ["bitcoin"],
  description:
    "Bitcoin only. Buys accelerating momentum above a long-term trend, and exits when momentum decays, the trend breaks, or a volatility-scaled trailing stop is hit.",
  philosophy:
    "Bitcoin trends in bursts rather than grinding. Enter only when momentum is positive *and* accelerating, so a slow drift does not count as a rally — then let a volatility-scaled trail decide when it is over.",
  defaultParams: {
    trendPeriod: 30,
    rocPeriod: 12,
    entryThreshold: 3,
    exitThreshold: -1,
    atrPeriod: 14,
    atrMult: 2,
    trailPeriod: 10,
  },
  paramsMeta: [
    { key: "trendPeriod", label: "Trend filter EMA", min: 20, max: 300 },
    { key: "rocPeriod", label: "Momentum lookback", min: 3, max: 100 },
    { key: "entryThreshold", label: "Entry momentum %", min: 0, max: 20 },
    { key: "exitThreshold", label: "Exit momentum %", min: -20, max: 0 },
    { key: "atrPeriod", label: "ATR period", min: 5, max: 100 },
    { key: "atrMult", label: "ATR stop multiple", min: 0.5, max: 8 },
    { key: "trailPeriod", label: "Trail lookback", min: 5, max: 200 },
  ],
  minCandles: 50,
  /**
   * Per-bar-size calibration. The 1h set is the walk-forward consensus from
   * `npm run optimize:btc`: 972 combinations, an expanding training window and
   * a 260-bar untouched test segment per fold. Four folds, all profitable,
   * averaging +13.6% return against 3.1% drawdown, and the same parameters were
   * selected in three of four folds — which is the stability signal that
   * matters far more than the headline return.
   */
  granularityProfiles: {
    "1h": {
      params: {
        trendPeriod: 30,
        rocPeriod: 12,
        entryThreshold: 3,
        exitThreshold: -1,
        atrPeriod: 14,
        atrMult: 2,
        trailPeriod: 10,
      },
      minCandles: 50,
    },
    "4h": {
      params: {
        trendPeriod: 40,
        rocPeriod: 10,
        entryThreshold: 3.5,
        exitThreshold: -1,
        atrPeriod: 14,
        atrMult: 2,
        trailPeriod: 8,
      },
      minCandles: 50,
    },
    "1d": {
      params: {
        trendPeriod: 30,
        rocPeriod: 8,
        entryThreshold: 4,
        exitThreshold: -1.5,
        atrPeriod: 14,
        atrMult: 2,
        trailPeriod: 7,
      },
      minCandles: 45,
    },
  },
  evaluate({ candles, index, params, position }: StrategyContext) {
    const trendPeriod = Math.round(params.trendPeriod);
    const rocPeriod = Math.round(params.rocPeriod);
    const atrPeriod = Math.round(params.atrPeriod);
    const trailPeriod = Math.round(params.trailPeriod);

    const warmup = Math.max(trendPeriod, trailPeriod, rocPeriod + 2) + atrPeriod + 2;
    if (index < warmup) return hold(`Warming up (${index + 1}/${warmup} bars).`);

    const price = memoized(candles, "close", () => closes(candles as Candle[]));
    const trendSeries = memoized(candles, `ema:${trendPeriod}`, () => ema(price, trendPeriod));
    const atrSeries = memoized(candles, `atr:${atrPeriod}`, () => atr(candles as Candle[], atrPeriod));
    const highSeries = memoized(candles, "high", () => (candles as Candle[]).map((c) => c.high));
    const trailSeries = memoized(candles, `rmax:${trailPeriod}`, () => rollingMax(highSeries, trailPeriod));

    const trend = trendSeries[index];
    const atrValue = atrSeries[index];
    const recentHigh = trailSeries[index];
    if (trend === null || atrValue === null || recentHigh === null) {
      return hold("Indicators not ready.");
    }

    const close = price[index];
    const roc = ((close - price[index - rocPeriod]) / price[index - rocPeriod]) * 100;
    const prevRoc =
      index - rocPeriod - 1 >= 0
        ? ((price[index - 1] - price[index - 1 - rocPeriod]) / price[index - 1 - rocPeriod]) * 100
        : roc;
    const accelerating = roc > prevRoc;
    const trailStop = recentHigh - params.atrMult * atrValue;
    const inTrend = close > trend;

    if (position) {
      if (close < trend) {
        return sell(
          `Lost the ${trendPeriod}-bar trend filter (${close.toFixed(0)} < EMA ${trend.toFixed(0)}).`,
          0.8,
        );
      }
      if (roc < params.exitThreshold) {
        return sell(
          `Momentum decayed to ${roc.toFixed(2)}% over ${rocPeriod} bars (exit below ${params.exitThreshold}%).`,
          0.7,
        );
      }
      if (close <= trailStop) {
        return sell(
          `Trail hit: ${close.toFixed(0)} below ${trailStop.toFixed(0)} (${params.atrMult.toFixed(1)}×ATR under the ` +
            `${trailPeriod}-bar high).`,
          0.8,
        );
      }
      return hold(`Riding — momentum ${roc >= 0 ? "+" : ""}${roc.toFixed(2)}%, trail at ${trailStop.toFixed(0)}.`);
    }

    if (inTrend && roc > params.entryThreshold && accelerating) {
      return buy(
        `Momentum ${roc.toFixed(2)}% over ${rocPeriod} bars and accelerating (prev ${prevRoc.toFixed(2)}%), ` +
          `price above the ${trendPeriod}-EMA — entering.`,
        Math.min(1, 0.65 + roc / 25),
        { stopLossPrice: close - params.atrMult * 2 * atrValue },
      );
    }

    return hold(
      inTrend
        ? `In trend; momentum ${roc.toFixed(2)}%${accelerating ? " but flat" : " and decelerating"} ` +
            `(entry needs > ${params.entryThreshold}% and rising).`
        : `Below the ${trendPeriod}-EMA — waiting.`,
    );
  },
});

/**
 * ETH Pullback Rider — **Ethereum only**.
 *
 * Buys shallow dips that happen inside an intact uptrend, rather than chasing
 * breakouts. Chosen from measurement, not taste: over Ryomen's hourly history
 * ETH shows positive short-lag autocorrelation but strongly negative behaviour
 * around a ~100-bar mean, and a naive buy-the-dip system on that horizon made
 * +28.3% where the equivalent trend-follower made +4.1%. BTC shows the opposite
 * profile, which is why it gets the momentum rider instead.
 *
 * ETH is also markedly more volatile (0.49% per hourly bar vs BTC's 0.37%) and
 * twice as drawdown-prone, so exits are deliberately looser than BTC's.
 *
 * Forward-safe: every input derives from closed bars at or before `index`.
 */
export const ethPullbackRider: Strategy = Object.freeze({
  id: "eth-pullback-rider",
  name: "ETH Pullback Rider",
  category: "Trend",
  coins: ["ethereum"],
  description:
    "Ethereum only. Buys shallow pullbacks toward a medium moving average while the long-term trend holds, and exits when the trend breaks or a volatility-scaled trail is hit.",
  philosophy:
    "ETH trends over days and mean-reverts over hours. Rather than chase strength, wait for a routine dip inside an uptrend and buy it — then let a volatility-scaled trail decide when the trend is actually over.",
  defaultParams: {
    trendPeriod: 100,
    pullbackPeriod: 30,
    rocPeriod: 12,
    rocThreshold: -1,
    minDepthPct: 0,
    atrPeriod: 14,
    atrMult: 4,
    trailPeriod: 12,
  },
  paramsMeta: [
    { key: "trendPeriod", label: "Long trend EMA", min: 40, max: 300 },
    { key: "pullbackPeriod", label: "Pullback EMA", min: 5, max: 100 },
    { key: "rocPeriod", label: "Recovery lookback", min: 3, max: 100 },
    { key: "rocThreshold", label: "Recovery floor %", min: -10, max: 10 },
    { key: "minDepthPct", label: "Minimum dip depth %", min: 0, max: 10 },
    { key: "atrPeriod", label: "ATR period", min: 5, max: 100 },
    { key: "atrMult", label: "ATR stop multiple", min: 0.5, max: 8 },
    { key: "trailPeriod", label: "Trail lookback", min: 5, max: 200 },
  ],
  minCandles: 120,
  /**
   * Per-bar-size calibration. The 1h set is the walk-forward consensus from
   * `npm run optimize:asset -- ethereum eth-pullback-rider`: 3,888 combinations
   * over an expanding training window with a 260-bar untouched test segment per
   * fold. Four folds, all profitable, averaging +12.05% against 9.12% drawdown —
   * the wider drawdown than the BTC strategy is the real cost of ETH's higher
   * volatility, not a tuning artefact. `pullbackPeriod 30`, `entry -1%` and
   * `ATR ×4` were selected in every fold; the trend filter moved (60/100/150).
   *
   * The full-window figure matches the fold average to within 0.24%, which is
   * the check that matters — an earlier version showed +12% across folds while
   * losing money across the whole window, because walk-forward never validates
   * the earliest bars. The optimiser now prints both so that can't recur.
   */
  granularityProfiles: {
    "1h": {
      params: {
        trendPeriod: 100,
        pullbackPeriod: 30,
        rocPeriod: 12,
        rocThreshold: -1,
        minDepthPct: 0,
        atrPeriod: 14,
        atrMult: 4,
        trailPeriod: 12,
      },
      minCandles: 140,
    },
    "4h": {
      params: {
        trendPeriod: 90,
        pullbackPeriod: 18,
        rocPeriod: 8,
        rocThreshold: -1,
        minDepthPct: 0,
        atrPeriod: 14,
        atrMult: 3.5,
        trailPeriod: 12,
      },
      minCandles: 115,
    },
    "1d": {
      params: {
        trendPeriod: 75,
        pullbackPeriod: 12,
        rocPeriod: 6,
        rocThreshold: -1,
        minDepthPct: 0,
        atrPeriod: 14,
        atrMult: 3.5,
        trailPeriod: 10,
      },
      minCandles: 100,
    },
  },
  evaluate({ candles, index, params, position }: StrategyContext) {
    const trendPeriod = Math.round(params.trendPeriod);
    const pullbackPeriod = Math.round(params.pullbackPeriod);
    const rocPeriod = Math.round(params.rocPeriod);
    const atrPeriod = Math.round(params.atrPeriod);
    const trailPeriod = Math.round(params.trailPeriod);

    const warmup = Math.max(trendPeriod, trailPeriod, rocPeriod + 2) + atrPeriod + 2;
    if (index < warmup) return hold(`Warming up (${index + 1}/${warmup} bars).`);

    const price = memoized(candles, "close", () => closes(candles as Candle[]));
    const trendSeries = memoized(candles, `ema:${trendPeriod}`, () => ema(price, trendPeriod));
    const pullSeries = memoized(candles, `ema:${pullbackPeriod}`, () => ema(price, pullbackPeriod));
    const atrSeries = memoized(candles, `atr:${atrPeriod}`, () => atr(candles as Candle[], atrPeriod));
    const highSeries = memoized(candles, "high", () => (candles as Candle[]).map((c) => c.high));
    const trailSeries = memoized(candles, `rmax:${trailPeriod}`, () => rollingMax(highSeries, trailPeriod));

    const trend = trendSeries[index];
    const pull = pullSeries[index];
    const atrValue = atrSeries[index];
    const recentHigh = trailSeries[index];
    if (trend === null || pull === null || atrValue === null || recentHigh === null) {
      return hold("Indicators not ready.");
    }

    const close = price[index];
    const roc = ((close - price[index - rocPeriod]) / price[index - rocPeriod]) * 100;
    const trailStop = recentHigh - params.atrMult * atrValue;
    const uptrend = close > trend;
    // A dip must be a *real* dip. Without a depth requirement the strategy
    // buys every time price grazes the average and churns fees away.
    const depthPct = ((pull - close) / pull) * 100;
    const dipped = depthPct >= params.minDepthPct;

    if (position) {
      if (!uptrend) {
        return sell(
          `Pullback broke the ${trendPeriod}-bar trend filter (${close.toFixed(0)} < EMA ${trend.toFixed(0)}).`,
          0.8,
        );
      }
      if (close <= trailStop) {
        return sell(
          `Trail hit: ${close.toFixed(0)} below ${trailStop.toFixed(0)} (${params.atrMult.toFixed(1)}×ATR under the ` +
            `${trailPeriod}-bar high).`,
          0.75,
        );
      }
      return hold(`Holding the pullback — back above the ${pullbackPeriod}-EMA at ${pull.toFixed(0)}.`);
    }

    if (uptrend && dipped && roc >= params.rocThreshold) {
      return buy(
        `Pulled back ${depthPct.toFixed(1)}% into the ${pullbackPeriod}-EMA (${close.toFixed(0)}) with the ` +
          `${trendPeriod}-trend intact — buying the dip.`,
        Math.min(1, 0.6 + depthPct / 10),
        { stopLossPrice: close - params.atrMult * 2 * atrValue },
      );
    }

    return hold(
      !uptrend
        ? `Below the ${trendPeriod}-EMA (${close.toFixed(0)}) — waiting for the trend to turn up.`
        : `Only ${depthPct.toFixed(1)}% below the ${pullbackPeriod}-EMA (${pull.toFixed(0)}) — ` +
          `waiting for a ${params.minDepthPct}% dip.`,
    );
  },
});

/**
 * SOL Breakout Rider — **Solana only**.
 *
 * Enters on short-horizon breakouts confirmed by momentum, exits on a
 * volatility-scaled trail or a broken trend filter.
 *
 * Family chosen by measurement (`scripts/analyze.ts solana`): SOL is the
 * strongest short-horizon trend follower in the fleet — a naive trend-follower
 * on a 10-bar average made +28.2% over Ryomen's hourly history, decaying to
 * +9.7% at 100 bars. BTC peaks at a long horizon and ETH mean-reverts, so both
 * need slow filters; SOL's edge is in the short lookback, which is exactly what
 * a breakout system uses.
 *
 * SOL is also volatile (0.57% per hourly bar, the second-highest here) with an
 * 18.5% drawdown, so its trail is set by ATR rather than a fixed percentage.
 *
 * Forward-safe: every input derives from closed bars at or before `index`.
 */
export const solBreakoutRider: Strategy = Object.freeze({
  id: "sol-breakout-rider",
  name: "SOL Breakout Rider",
  category: "Breakout",
  coins: ["solana"],
  description:
    "Solana only. Buys breakouts above the recent high when momentum confirms and the trend filter holds, then trails the exit by ATR.",
  philosophy:
    "SOL's moves are front-loaded: the edge lives in the first few bars of a move, not in slow averages. Enter on the break, and let volatility decide when it is over.",
  defaultParams: {
    breakoutPeriod: 24,
    trendPeriod: 50,
    rocPeriod: 12,
    rocThreshold: 1,
    atrPeriod: 14,
    atrMult: 2.5,
    trailPeriod: 10,
  },
  paramsMeta: [
    { key: "breakoutPeriod", label: "Breakout lookback", min: 4, max: 100 },
    { key: "trendPeriod", label: "Trend filter EMA", min: 20, max: 300 },
    { key: "rocPeriod", label: "Momentum lookback", min: 3, max: 60 },
    { key: "rocThreshold", label: "Momentum trigger %", min: 0, max: 20 },
    { key: "atrPeriod", label: "ATR period", min: 5, max: 100 },
    { key: "atrMult", label: "ATR stop multiple", min: 0.5, max: 8 },
    { key: "trailPeriod", label: "Trail lookback", min: 5, max: 200 },
  ],
  minCandles: 100,
  /**
   * Per-bar-size calibration. The 1h set is the walk-forward consensus from
   * `npm run optimize:asset -- solana sol-breakout-rider <grid>`: 972
   * combinations, expanding training window, 260-bar untouched test segment per
   * fold. Four folds, all profitable, averaging +24.76% on 7.10% drawdown, and
   * the full window came in *above* the fold average at +28.81% — the reverse
   * of the earlier ETH result where the folds flattered a bad strategy.
   * `breakoutPeriod 24`, `rocPeriod 12` and `trailPeriod 10` were selected in
   * every fold; only the trend filter and ATR width moved.
   */
  granularityProfiles: {
    "1h": {
      params: {
        breakoutPeriod: 24,
        trendPeriod: 50,
        rocPeriod: 12,
        rocThreshold: 1,
        atrPeriod: 14,
        atrMult: 2.5,
        trailPeriod: 10,
      },
      minCandles: 100,
    },
    "4h": {
      params: {
        breakoutPeriod: 16,
        trendPeriod: 40,
        rocPeriod: 10,
        rocThreshold: 1.5,
        atrPeriod: 14,
        atrMult: 2.2,
        trailPeriod: 8,
      },
      minCandles: 80,
    },
    "1d": {
      params: {
        breakoutPeriod: 14,
        trendPeriod: 35,
        rocPeriod: 8,
        rocThreshold: 2,
        atrPeriod: 14,
        atrMult: 2.2,
        trailPeriod: 7,
      },
      minCandles: 70,
    },
  },
  evaluate({ candles, index, params, position }: StrategyContext) {
    const breakoutPeriod = Math.round(params.breakoutPeriod);
    const trendPeriod = Math.round(params.trendPeriod);
    const rocPeriod = Math.round(params.rocPeriod);
    const atrPeriod = Math.round(params.atrPeriod);
    const trailPeriod = Math.round(params.trailPeriod);

    const warmup = Math.max(trendPeriod, trailPeriod, breakoutPeriod, rocPeriod + 2) + atrPeriod + 2;
    if (index < warmup) return hold(`Warming up (${index + 1}/${warmup} bars).`);

    const price = memoized(candles, "close", () => closes(candles as Candle[]));
    const highSeries = memoized(candles, "high", () => (candles as Candle[]).map((c) => c.high));
    const trendSeries = memoized(candles, `ema:${trendPeriod}`, () => ema(price, trendPeriod));
    const atrSeries = memoized(candles, `atr:${atrPeriod}`, () => atr(candles as Candle[], atrPeriod));
    const trailSeries = memoized(candles, `rmax:${trailPeriod}`, () => rollingMax(highSeries, trailPeriod));
    // Breakout is measured against the bars *before* this one, so the channel
    // never contains the bar being tested.
    const priorHighSeries = memoized(candles, `hmax-prior:${breakoutPeriod}`, () =>
      rollingMax(highSeries.map((h, i) => (i === 0 ? h : highSeries[i - 1])), breakoutPeriod),
    );

    const trend = trendSeries[index];
    const atrValue = atrSeries[index];
    const trailHigh = trailSeries[index];
    const priorHigh = priorHighSeries[index];
    if (trend === null || atrValue === null || trailHigh === null || priorHigh === null) {
      return hold("Indicators not ready.");
    }

    const close = price[index];
    const roc = ((close - price[index - rocPeriod]) / price[index - rocPeriod]) * 100;
    const trailStop = trailHigh - params.atrMult * atrValue;

    if (position) {
      if (close < trend) {
        return sell(
          `Lost the ${trendPeriod}-bar trend filter (${close.toFixed(1)} < EMA ${trend.toFixed(1)}).`,
          0.8,
        );
      }
      if (close <= trailStop) {
        return sell(
          `Trail hit: ${close.toFixed(1)} below ${trailStop.toFixed(1)} (${params.atrMult.toFixed(1)}×ATR under the ` +
            `${trailPeriod}-bar high).`,
          0.75,
        );
      }
      return hold(`Riding the breakout — ${roc >= 0 ? "+" : ""}${roc.toFixed(1)}% momentum, trail ${trailStop.toFixed(1)}.`);
    }

    const brokeOut = close > priorHigh;
    if (brokeOut && roc > params.rocThreshold && close > trend) {
      const overPct = ((close - priorHigh) / priorHigh) * 100;
      return buy(
        `Broke the prior ${breakoutPeriod}-bar high (${priorHigh.toFixed(1)}) by ${overPct.toFixed(2)}% with ` +
          `momentum ${roc.toFixed(1)}% and price above the ${trendPeriod}-EMA.`,
        Math.min(1, 0.65 + overPct * 5),
        { stopLossPrice: close - params.atrMult * 2 * atrValue },
      );
    }

    return hold(
      close <= priorHigh
        ? `Below the prior ${breakoutPeriod}-bar high (${priorHigh.toFixed(1)}) — waiting for a break.`
        : `Broke out but momentum is only ${roc.toFixed(1)}% (needs > ${params.rocThreshold}%).`,
    );
  },
});

/**
 * Rate-of-Change Momentum — rides accelerating price changes confirmed by trend.
 */
export const rocMomentum: Strategy = Object.freeze({
  id: "roc-momentum",
  name: "ROC Momentum",
  category: "Momentum",
  description: "Measures N-bar rate of change and buys acceleration confirmed by price above its trend average.",
  philosophy: "Velocity, not price level, tells you where capital is flowing right now.",
  defaultParams: { rocPeriod: 12, thresholdPct: 3, trendSma: 50 },
  paramsMeta: [
    { key: "rocPeriod", label: "ROC period", min: 3, max: 60 },
    { key: "thresholdPct", label: "Trigger threshold %", min: 0.5, max: 20 },
    { key: "trendSma", label: "Trend SMA", min: 10, max: 200 },
  ],
  minCandles: 55,
  evaluate({ candles, index, params }: StrategyContext) {
    const rocPeriod = Math.round(params.rocPeriod);
    const trendPeriod = Math.round(params.trendSma);
    if (index < trendPeriod + rocPeriod) return hold("Warming up: momentum window not ready.");

    const price = closes(candles as never);
    const roc = ((price[index] - price[index - rocPeriod]) / price[index - rocPeriod]) * 100;
    const trend = sma(price, trendPeriod)[index];
    if (trend === null) return hold("Trend average unavailable.");

    const aboveTrend = price[index] > trend;
    const threshold = params.thresholdPct;

    if (roc > threshold && aboveTrend) {
      return buy(
        `${rocPeriod}-bar rate of change is +${roc.toFixed(2)}% with price above its ${trendPeriod}-SMA.`,
        Math.min(1, roc / (threshold * 3)),
      );
    }
    if (roc < -threshold) {
      return sell(`${rocPeriod}-bar rate of change is ${roc.toFixed(2)}% — momentum negative.`, 0.6);
    }
    return hold(`${rocPeriod}-bar ROC is ${roc >= 0 ? "+" : ""}${roc.toFixed(2)}%.`);
  },
});

/**
 * Volatility Trail — momentum inside a confirmed trend, exited by a
 * volatility-scaled trailing stop (a Chandelier-style exit).
 *
 * Deliberately different from the other trend strategies here: those exit on a
 * *signal* (a crossover, a MACD flip). This one lets a winner run and cuts the
 * position at a distance the market itself sets, via ATR.
 */
export const volatilityTrail: Strategy = Object.freeze({
  id: "volatility-trail",
  name: "Volatility Trail",
  category: "Trend",
  description:
    "Buys confirmed momentum while price is above its long-term trend, then exits when price falls a volatility-scaled distance from its recent best level.",
  philosophy:
    "Let winners run. Instead of a fixed stop, exit a distance proportional to the market's own volatility (ATR) below the recent high — so the exit breathes with the asset.",
  defaultParams: {
    trendPeriod: 40,
    rocPeriod: 18,
    rocThreshold: 1.5,
    atrPeriod: 14,
    atrMult: 3.5,
    trailPeriod: 10,
  },
  paramsMeta: [
    { key: "trendPeriod", label: "Trend filter EMA", min: 20, max: 300 },
    { key: "rocPeriod", label: "Momentum lookback", min: 3, max: 100 },
    { key: "rocThreshold", label: "Momentum trigger %", min: 0, max: 20 },
    { key: "atrPeriod", label: "ATR period", min: 5, max: 100 },
    { key: "atrMult", label: "ATR stop multiple", min: 0.5, max: 8 },
    { key: "trailPeriod", label: "Trail lookback", min: 5, max: 200 },
  ],
  minCandles: 60,
  /**
   * Calibrated per bar size.
   *
   * The 1h set was found by `npm run optimize`, which grid-searched 324
   * combinations against the older half of eight coins' hourly history and then
   * scored the winner on the newer half it had never seen: 14.7% in-sample,
   * 11.0% out-of-sample while buy-and-hold was −2.5%, so ~75% of the gain
   * generalised rather than being curve-fit. The wider ATR multiple and short
   * trail win because fees punish churn far harder than they reward it.
   */
  granularityProfiles: {
    "1h": {
      params: { trendPeriod: 40, rocPeriod: 18, rocThreshold: 1.5, atrPeriod: 14, atrMult: 3.5, trailPeriod: 10 },
      minCandles: 60,
    },
    "4h": {
      params: { trendPeriod: 60, rocPeriod: 12, rocThreshold: 1.5, atrPeriod: 14, atrMult: 3.0, trailPeriod: 12 },
      minCandles: 80,
    },
    "1d": {
      params: { trendPeriod: 50, rocPeriod: 10, rocThreshold: 2, atrPeriod: 14, atrMult: 3.0, trailPeriod: 10 },
      minCandles: 70,
    },
  },
  evaluate({ candles, index, params, position }: StrategyContext) {
    const trendPeriod = Math.round(params.trendPeriod);
    const rocPeriod = Math.round(params.rocPeriod);
    const atrPeriod = Math.round(params.atrPeriod);
    const trailPeriod = Math.round(params.trailPeriod);

    const warmup = Math.max(trendPeriod, trailPeriod) + atrPeriod + 2;
    if (index < warmup) {
      return hold(`Warming up (${index + 1}/${warmup} bars).`);
    }

    const price = memoized(candles, "close", () => closes(candles as Candle[]));
    const trendSeries = memoized(candles, `ema:${trendPeriod}`, () => ema(price, trendPeriod));
    const atrSeries = memoized(candles, `atr:${atrPeriod}`, () => atr(candles as Candle[], atrPeriod));
    const highSeries = memoized(candles, "high", () => (candles as Candle[]).map((c) => c.high));
    const recentHighSeries = memoized(candles, `rmax:${trailPeriod}`, () => rollingMax(highSeries, trailPeriod));

    const trend = trendSeries[index];
    const atrValue = atrSeries[index];
    const recentHigh = recentHighSeries[index];

    if (trend === null || atrValue === null || recentHigh === null) {
      return hold("Indicators not ready.");
    }

    const close = price[index];
    const trailStop = recentHigh - params.atrMult * atrValue;
    const inTrend = close > trend;

    // ── Holding ────────────────────────────────────────────────────────
    if (position) {
      if (close < trend) {
        return sell(
          `Lost the ${trendPeriod}-bar trend filter (close ${close.toFixed(2)} < EMA ${trend.toFixed(2)}).`,
          0.75,
        );
      }
      if (close <= trailStop) {
        return sell(
          `Hit the volatility trail: ${close.toFixed(2)} fell below ${trailStop.toFixed(2)} ` +
            `(${params.atrMult.toFixed(1)}×ATR below the ${trailPeriod}-bar high).`,
          0.8,
        );
      }
      const giveBackPct = ((recentHigh - close) / recentHigh) * 100;
      return hold(
        `Trailing up — ${giveBackPct.toFixed(1)}% below the ${trailPeriod}-bar high, stop at ${trailStop.toFixed(2)}.`,
      );
    }

    // ── Flat ───────────────────────────────────────────────────────────
    if (index < rocPeriod + 1) return hold("Warming up the momentum window.");

    const roc = ((close - price[index - rocPeriod]) / price[index - rocPeriod]) * 100;

    if (inTrend && roc > params.rocThreshold) {
      return buy(
        `Momentum +${roc.toFixed(2)}% over ${rocPeriod} bars with price above its ${trendPeriod}-EMA — entering.`,
        Math.min(1, 0.6 + roc / 20),
        { stopLossPrice: close - params.atrMult * 2 * atrValue },
      );
    }

    return hold(
      inTrend
        ? `In the uptrend but momentum is ${roc >= 0 ? "+" : ""}${roc.toFixed(2)}% (needs > ${params.rocThreshold}%).`
        : `Below the ${trendPeriod}-EMA trend filter — waiting.`,
    );
  },
});
