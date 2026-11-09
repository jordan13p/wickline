// Yahoo Finance: stocks, ETFs, indices and currencies, one ticker per request.
// No Herdr imports, so tests run it under Node.
import { HEADERS, QuoteError, cleanSeries, cleanText, normalizeSymbol, positive } from "../quotes.js";
import { failEach, parseJson } from "./provider.js";

// Each provider names the hosts it contacts; this is the only Yahoo host.
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** @typedef {import("./provider.js").Provider} Provider */

/** Today's 5-minute bars: the quote metadata and the intraday line in one request. */
export function yahooUrl(symbol) {
  return YAHOO_CHART + encodeURIComponent(normalizeSymbol(symbol)) + "?interval=5m&range=1d&includePrePost=false";
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);

const period = (value) => finite(value?.start) && finite(value?.end) && value.end > value.start
  ? [value.start * 1000, value.end * 1000] : null;

/** `response` is `{ status, ok, text }` with the body already read. */
export function decodeYahoo(symbol, response, now) {
  // Herdr's fetch does not expose headers, so Retry-After is unknown: wait at least a minute.
  if (response.status === 429) throw new QuoteError("yahoo.rateLimited", {}, { retryAfterMs: 60_000 });
  if (response.status === 404) throw new QuoteError("yahoo.notFound");
  if (!response.ok) throw new QuoteError("yahoo.http", { status: response.status });
  const body = parseJson(response.text, "yahoo.unreadable");
  const meta = body?.chart?.result?.[0]?.meta;
  if (body?.chart?.error || !meta) throw new QuoteError("yahoo.noQuote");
  // Never show another instrument's response under the requested ticker.
  let returned = null;
  try { returned = typeof meta.symbol === "string" ? normalizeSymbol(meta.symbol) : null; } catch { /* checked below */ }
  if (returned !== symbol) throw new QuoteError("yahoo.otherTicker");
  if (!positive(meta.regularMarketPrice) || !positive(meta.regularMarketTime)) {
    throw new QuoteError("yahoo.incomplete");
  }
  const close = positive(meta.previousClose) ? meta.previousClose : meta.chartPreviousClose;
  const delay = meta.exchangeDataDelayedBy;
  const bars = body.chart.result[0].indicators?.quote?.[0] ?? {};
  const series = cleanSeries(bars.close);
  const opens = cleanSeries(bars.open);
  const highs = cleanSeries(bars.high);
  const lows = cleanSeries(bars.low);
  const periods = meta.currentTradingPeriod ?? {};
  return {
    symbol,
    source: "yahoo",
    name: cleanText(meta.longName) ?? cleanText(meta.shortName) ?? symbol,
    price: meta.regularMarketPrice,
    changePercent: positive(close) ? (meta.regularMarketPrice - close) / close * 100 : null,
    currency: typeof meta.currency === "string" && /^[A-Z]{3}$/.test(meta.currency) ? meta.currency : null,
    // The exchange Yahoo names (NMS, TAI, OSA…), which gives an index its market (resolvedMarket).
    exchange: typeof meta.exchangeName === "string" && /^[A-Z]{2,5}$/.test(meta.exchangeName) ? meta.exchangeName : null,
    timestamp: meta.regularMarketTime * 1000,
    fetchedAt: now,
    delaySeconds: typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : null,
    series,
    open: opens[0] ?? null,
    high: positive(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : highs.length ? Math.max(...highs) : null,
    low: positive(meta.regularMarketDayLow) ? meta.regularMarketDayLow : lows.length ? Math.min(...lows) : null,
    previousClose: positive(close) ? close : null,
    periods: { pre: period(periods.pre), regular: period(periods.regular), post: period(periods.post) },
  };
}

/** @type {Provider} */
export const yahoo = {
  id: "yahoo",
  markets: ["us", "tw", "hk", "cn", "jp", "kr", "other"],
  // Stock requests are spaced at least this far apart.
  spacingMs: () => 1_000,
  intervalMs: () => 60_000,
  requests: (symbols) => symbols.map((symbol) => ({ url: yahooUrl(symbol), headers: HEADERS, symbols: [symbol], kind: "quote" })),
  decode(request, response, now) {
    const [symbol] = request.symbols;
    try {
      return { quotes: { [symbol]: decodeYahoo(symbol, response, now) }, errors: {} };
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
