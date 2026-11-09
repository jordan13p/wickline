// Binance Spot market data: pairs written BASE/QUOTE, in batches, plus a 24-hour line per pair.
// No Herdr imports, so tests run it under Node.
import { HEADERS, QuoteError, cleanSeries, positive } from "../quotes.js";
import { failEach, parseJson } from "./provider.js";

// Each provider names the hosts it contacts; this is the default Binance host (a public market-data mirror).
export const BINANCE_URL = "https://data-api.binance.vision";
const BINANCE_BATCH = 100;

// `base` is the saved Binance URL (the public market-data mirror unless the person set another).
const endpoint = (base, path) => `${base.replace(/\/+$/, "")}/api/v3/${path}`;

/** @typedef {import("./provider.js").Provider} Provider */

/** One request for up to BINANCE_BATCH pairs: `?symbols=["BTCUSDT","ETHUSDT"]`. */
export function binanceUrl(base, pairs) {
  return `${endpoint(base, "ticker/24hr")}?symbols=${encodeURIComponent(JSON.stringify(pairs.map((pair) => pair.replace("/", ""))))}`;
}

/** Quotes by requested pair; a pair Binance did not return is absent. */
export function decodeBinance(pairs, response, now) {
  // -1121 Invalid symbol: one unknown or delisted pair fails the whole batch.
  if (response.status === 400) throw new QuoteError("binance.invalidPair", {}, { invalidSymbol: true });
  // No headers in Herdr's fetch, so no Retry-After: wait at least a minute.
  if (response.status === 429 || response.status === 418) throw new QuoteError("binance.rateLimited", {}, { retryAfterMs: 60_000 });
  // Unavailable for legal reasons: Binance refuses this region.
  if (response.status === 451) throw new QuoteError("binance.region");
  if (!response.ok) throw new QuoteError("binance.http", { status: response.status });
  const body = parseJson(response.text, "binance.unreadable");
  const wanted = new Map(pairs.map((pair) => [pair.replace("/", ""), pair]));
  const quotes = {};
  for (const ticker of Array.isArray(body) ? body : [body]) {
    const pair = typeof ticker?.symbol === "string" ? wanted.get(ticker.symbol) : undefined;
    if (!pair) continue;
    const price = Number(ticker.lastPrice);
    const close = Number(ticker.prevClosePrice);
    const time = Number(ticker.closeTime);
    if (!positive(price) || !positive(time)) continue;
    quotes[pair] = {
      symbol: pair,
      source: "binance",
      name: "Binance Spot",
      price,
      // Against the price 24 hours before the last trade.
      changePercent: positive(close) ? (price - close) / close * 100 : null,
      currency: pair.split("/")[1],
      timestamp: time,
      fetchedAt: now,
      delaySeconds: 0,
      series: [],
      open: positive(Number(ticker.openPrice)) ? Number(ticker.openPrice) : null,
      high: positive(Number(ticker.highPrice)) ? Number(ticker.highPrice) : null,
      low: positive(Number(ticker.lowPrice)) ? Number(ticker.lowPrice) : null,
      previousClose: positive(close) ? close : null,
      periods: null,
    };
  }
  return quotes;
}

/** The last 24 hours of one pair in 15-minute bars. */
export function binanceKlinesUrl(base, pair) {
  return `${endpoint(base, "klines")}?symbol=${encodeURIComponent(pair.replace("/", ""))}&interval=15m&limit=96`;
}

/** Closing prices, oldest first; throws when Binance answers with anything else. */
export function decodeKlines(response) {
  // Rate limited as the tickers are: the same backoff.
  if (response.status === 429 || response.status === 418) throw new QuoteError("binance.rateLimited", {}, { retryAfterMs: 60_000 });
  if (!response.ok) throw new QuoteError("binance.http", { status: response.status });
  const body = parseJson(response.text, "binance.unreadable");
  if (!Array.isArray(body)) throw new QuoteError("binance.unreadable");
  return cleanSeries(body.map((bar) => Array.isArray(bar) ? Number(bar[4]) : NaN));
}

/** @type {Provider} */
export const binance = {
  id: "binance",
  markets: ["crypto"],
  spacingMs: () => 0,
  // Tickers; a pair's line is asked again only once `linesMs` has passed.
  intervalMs: () => 15_000,
  linesMs: () => 60_000,
  // Per batch: its quote request, then a line request per pair of that batch.
  requests(pairs, { binanceUrl: base }) {
    const requests = [];
    for (let i = 0; i < pairs.length; i += BINANCE_BATCH) {
      const batch = pairs.slice(i, i + BINANCE_BATCH);
      requests.push({ url: binanceUrl(base, batch), headers: HEADERS, symbols: batch, kind: "quote" });
      for (const pair of batch) requests.push({ url: binanceKlinesUrl(base, pair), headers: HEADERS, symbols: [pair], kind: "line" });
    }
    return requests;
  },
  decode(request, response, now) {
    try {
      if (request.kind === "line") return { quotes: {}, errors: {}, lines: { [request.symbols[0]]: decodeKlines(response) } };
      const quotes = decodeBinance(request.symbols, response, now);
      const errors = {};
      for (const pair of request.symbols) if (!quotes[pair]) errors[pair] = new QuoteError("binance.noQuote");
      return { quotes, errors };
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
