// Symbols, coded errors and what the quote sources share.
// No Herdr imports, so tests run it under Node. The hosts live in providers/.

export const VERSION = "0.8.0";
export const USER_AGENT = `Wickline-Herdr/${VERSION}`;
// Sent with every request.
export const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };
// Shown until the person saves a watchlist of their own.
export const STARTER_SYMBOLS = ["AAPL", "NVDA", "^GSPC", "BTC/USDT"];

/** English text by error code; `{name}` is filled from the error's params. */
export const MESSAGES_EN = {
  "symbol.invalid": "Enter a ticker, such as AAPL, 0700.HK or ^GSPC, a Taiwan future, such as WTX&, or a pair, such as BTC/USDT.",
  "yahoo.rateLimited": "Yahoo rate limited requests.",
  "yahoo.notFound": "Ticker not found on Yahoo Finance.",
  "yahoo.http": "Yahoo returned HTTP {status}.",
  "yahoo.unreadable": "Yahoo returned an unreadable response.",
  "yahoo.noQuote": "No quote available for this ticker.",
  "yahoo.otherTicker": "Yahoo returned a different ticker.",
  "yahoo.incomplete": "Yahoo returned an incomplete quote.",
  "yahoo.unreachable": "Could not reach Yahoo Finance.",
  "binance.invalidPair": "Binance has no Spot pair with this name.",
  "binance.rateLimited": "Binance rate limited requests.",
  "binance.http": "Binance returned HTTP {status}.",
  "binance.unreadable": "Binance returned an unreadable response.",
  "binance.noQuote": "Binance returned no quote for this pair.",
  "binance.unreachable": "Could not reach Binance.",
  "binance.region": "Binance is not available in this region. Set another Binance URL in Settings.",
  "mis.rateLimited": "TWSE MIS rate limited requests.",
  "mis.http": "TWSE MIS returned HTTP {status}.",
  "mis.unreadable": "TWSE MIS returned an unreadable response.",
  "mis.outOfLimits": "The TWSE MIS price was outside the stock's daily price limits.",
  "mis.unreachable": "Could not reach TWSE MIS.",
  "yahootw.rateLimited": "Yahoo TW Stock rate limited requests.",
  "yahootw.refused": "Yahoo TW Stock refused the request.",
  "yahootw.http": "Yahoo TW Stock returned HTTP {status}.",
  "yahootw.unreadable": "Yahoo TW Stock returned an unreadable response.",
  "yahootw.outOfLimits": "The Yahoo TW Stock price was outside the stock's daily price limits.",
  "yahootw.otherTicker": "Yahoo TW Stock returned a different ticker.",
  "yahootw.noLiveRows": "Yahoo TW Stock returned no real-time prices.",
  "yahootw.unreachable": "Could not reach Yahoo TW Stock.",
  "finnhub.invalidKey": "Finnhub refused the API key. Check it in Settings.",
  "finnhub.rateLimited": "Finnhub rate limited requests.",
  "finnhub.http": "Finnhub returned HTTP {status}.",
  "finnhub.unreadable": "Finnhub returned an unreadable response.",
  "finnhub.unreachable": "Could not reach Finnhub.",
  "finnhub.redirected": "Finnhub's answer came from another address. The key is not sent again until you change the US settings in Settings.",
  // `{source}` is a provider id; the view shows its name.
  "request.timeout": "{source} did not answer within {seconds}s.",
};

/** Fills `{name}` from params; an unknown name stays as written. */
export const fill = (text, params) => text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);

export class QuoteError extends Error {
  constructor(code, params = {}, options = {}) {
    super(fill(MESSAGES_EN[code] ?? code, params));
    this.code = code;
    this.params = params;
    this.retryAfterMs = options.retryAfterMs;
    this.invalidSymbol = options.invalidSymbol === true;
    // The source refuses every request until its settings change (a rejected key).
    this.stopsSource = options.stopsSource === true;
  }
}

/** A Binance Spot pair is written BASE/QUOTE (BTC/USDT); a dash stays a Yahoo symbol (BTC-USD). */
export function isCryptoPair(symbol) {
  return /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/.test(symbol);
}

/** A TAIFEX future as Yahoo 奇摩股市 writes it: letters then & (near month) or @ (next month), such as WTX&. */
export const isFutureForm = (symbol) => /^[A-Z]{1,6}[&@]$/.test(symbol);

/** Yahoo tickers, Binance pairs or Taiwan futures, never company names or URLs. Throws a message for people. */
export function normalizeSymbol(input) {
  let symbol = String(input ?? "").trim().toUpperCase();
  if (isCryptoPair(symbol) || isFutureForm(symbol)) return symbol;
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,31}$/.test(symbol)) {
    throw new QuoteError("symbol.invalid");
  }
  if (/^\d{6}\.SH$/.test(symbol)) symbol = symbol.replace(/\.SH$/, ".SS");
  const hk = symbol.match(/^(\d{1,5})\.HK$/);
  if (hk) symbol = String(Number(hk[1])).padStart(4, "0") + ".HK";
  return symbol;
}

export const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A field as a positive number (a numeric string counts), else null: "2265.0000" → 2265, "-" → null. */
export const positiveOrNull = (value) => {
  const n = Number(value);
  return positive(n) ? n : null;
};

/** A volume with its unit, the two together or neither: a volume that is not positive is none. */
export const sized = (volume, sizeUnit) => (positive(volume) ? { volume, sizeUnit } : {});

// What a quote carries about the day's trading, which only the source that gives its price may speak for.
export const ACTIVITY_FIELDS = ["volume", "previousVolume", "turnover", "avgPrice", "lastSize", "inner", "outer", "book", "sizeUnit"];

/** `quote` without its activity (ACTIVITY_FIELDS); null stays null. */
export function withoutActivity(quote) {
  if (!quote) return quote;
  const rest = { ...quote };
  for (const field of ACTIVITY_FIELDS) delete rest[field];
  return rest;
}

// MIS sends limit-up 9999.95 (and no limit-down) for a stock without daily limits. It is off the tick grid
// (ticks of 5 from 1000), so a real limit-up past 9999 still counts.
const NO_LIMIT_UP = 9999.95;
export const hasLimits = (up, down) => positive(up) && positive(down) && up !== NO_LIMIT_UP;

/**
 * Whether a quote's price is at its own source's limit-up or limit-down: "up", "down" or null. Exact on
 * purpose: MIS's no-trade midpoint half a tick under a 0.01-tick limit (8.315 against 8.32) is within 0.005
 * of it, and is not a stock at its limit.
 */
export function priceLimit(quote) {
  if (!quote || !positive(quote.price) || !hasLimits(quote.limitUp, quote.limitDown)) return null;
  if (Math.abs(quote.price - quote.limitUp) < 1e-6) return "up";
  if (Math.abs(quote.price - quote.limitDown) < 1e-6) return "down";
  return null;
}

export const limitPair = (up, down) => (hasLimits(up, down) ? { limitUp: up, limitDown: down } : { limitUp: null, limitDown: null });

/** A price within its source's limits; a stock without limits has none to check. */
export function withinLimits(price, up, down) {
  return !hasLimits(up, down) || (down <= price && price <= up);
}

export const cleanText = (value) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 100) || null
  : null;

/**
 * Whether a quote's time is a trade's: every source times a quote by a trade, except a MIS price taken from the order
 * book (`fromBook`), timed by its snapshot. Where a trade is counted (Watchlist#observe) or printed as one (the closed,
 * 休市 and 今日無成交 labels).
 */
export const timedByTrade = (quote) => !quote.fromBook;

// An exchange code (NMS, TAI, OSA…) and a currency (USD, TWD) as a source sends them; anything else is null.
export const exchangeCode = (value) => (typeof value === "string" && /^[A-Z]{2,5}$/.test(value) ? value : null);
export const currencyCode = (value) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null);

const MAX_POINTS = 400;

/**
 * Finite closes in order with the time of each kept close; gaps (null bars) are dropped, each with its time. `times` is
 * null when they cannot be matched to the values: not an array, another length than `values`, or a time that is not a positive
 * number among those kept after the cap (a null time must never become 1970).
 */
export function cleanTimedSeries(values, times) {
  if (!Array.isArray(values)) return { series: [], times: null };
  const aligned = Array.isArray(times) && times.length === values.length;
  const series = [];
  const kept = [];
  values.forEach((value, i) => {
    if (!positive(value)) return;
    series.push(value);
    if (aligned) kept.push(times[i]);
  });
  const start = Math.max(0, series.length - MAX_POINTS);
  const keptTimes = kept.slice(start);
  return { series: series.slice(start), times: aligned && keptTimes.every(positive) ? keptTimes : null };
}

/** Finite closes in order; gaps (null bars) are dropped. */
export const cleanSeries = (values) => cleanTimedSeries(values, null).series;
