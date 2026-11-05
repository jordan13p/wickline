// Symbols, coded errors, what the quote sources share, and number formatting.
// No Herdr imports, so tests run it under Node. The hosts live in providers/.

export const VERSION = "0.1.0";
export const USER_AGENT = `Bellwether-Herdr/${VERSION}`;
// Sent with every request.
export const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };
// Shown until the person saves a watchlist of their own.
export const STARTER_SYMBOLS = ["AAPL", "NVDA", "^GSPC", "BTC/USDT"];

/** English text by error code; `{name}` is filled from the error's params. */
export const MESSAGES_EN = {
  "symbol.invalid": "Enter a ticker, such as AAPL, 0700.HK or ^GSPC, or a pair, such as BTC/USDT.",
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
  }
}

/** A Binance Spot pair is written BASE/QUOTE (BTC/USDT); a dash stays a Yahoo symbol (BTC-USD). */
export function isCryptoPair(symbol) {
  return /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/.test(symbol);
}

/** Yahoo tickers or Binance pairs, never company names or URLs. Throws a message for people. */
export function normalizeSymbol(input) {
  let symbol = String(input ?? "").trim().toUpperCase();
  if (isCryptoPair(symbol)) return symbol;
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,31}$/.test(symbol)) {
    throw new QuoteError("symbol.invalid");
  }
  if (/^\d{6}\.SH$/.test(symbol)) symbol = symbol.replace(/\.SH$/, ".SS");
  const hk = symbol.match(/^(\d{1,5})\.HK$/);
  if (hk) symbol = String(Number(hk[1])).padStart(4, "0") + ".HK";
  return symbol;
}

export const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

export const cleanText = (value) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 100) || null
  : null;

const MAX_POINTS = 400;

/** Finite closes in order; gaps (null bars) are dropped. */
export function cleanSeries(values) {
  if (!Array.isArray(values)) return [];
  const series = values.filter((value) => positive(value));
  return series.length > MAX_POINTS ? series.slice(series.length - MAX_POINTS) : series;
}

/**
 * Where a stock's market is now: "pre", "open", "post" or "closed"; a pair trades around the clock.
 * Shown through the i18n keys `session.<value>`.
 */
export function marketSession(quote, now) {
  if (!quote.periods) return "24h";
  const within = (range) => range && now >= range[0] && now < range[1];
  if (within(quote.periods.regular)) return "open";
  if (within(quote.periods.pre)) return "pre";
  if (within(quote.periods.post)) return "post";
  return "closed";
}

/**
 * The line through `series`, scaled into its box as [x%, y%] points, and where
 * the reference price (the previous close) falls, or null when it is outside.
 * Fewer than two points draw nothing.
 */
export function chartGeometry(series, reference) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const values = positive(reference) ? [...series, reference] : series;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < max * 1e-9) { min -= 1; max += 1; }
  // 8% headroom keeps the stroke inside the box.
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;
  const y = (value) => Math.round((1 - (value - min) / (max - min)) * 10000) / 100;
  const last = series.length - 1;
  return {
    points: series.map((value, index) => [Math.round(index / last * 10000) / 100, y(value)]),
    reference: positive(reference) ? y(reference) : null,
  };
}

// Herdr's QuickJS runtime has no Intl, so numbers and dates are formatted by hand.
const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function significant(price) {
  // Below 1, keep 2 to 4 significant digits: 0.00000441 must not round to 0.000004.
  const places = Math.min(20, 3 - Math.floor(Math.log10(price)));
  let text = price.toFixed(places);
  const count = (s) => s.replace(".", "").replace(/^0+/, "").length;
  while (text.endsWith("0") && count(text) > 2) text = text.slice(0, -1);
  return text;
}

export function formatPrice(quote) {
  const [whole, fraction] = (quote.price < 1 ? significant(quote.price) : quote.price.toFixed(2)).split(".");
  const price = group(whole) + (fraction === undefined ? "" : "." + fraction);
  return quote.currency ? `${price} ${quote.currency}` : price;
}

/** The compact band leaves out USD and a pair's own quote currency. */
export function formatBandPrice(quote) {
  const named = quote.currency === "USD" || quote.symbol.endsWith(`/${quote.currency}`);
  return formatPrice(named ? { ...quote, currency: null } : quote);
}

export function formatChange(value) {
  return value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A quote from an earlier local day gets its date, so a closed market never reads as today's:
 * "Oct 31" in English, "10/31" in the other languages.
 */
export function formatStaleDate(timestamp, now, lang = "en") {
  const quoted = new Date(timestamp);
  const today = new Date(now);
  if (quoted.getFullYear() === today.getFullYear() && quoted.getMonth() === today.getMonth()
    && quoted.getDate() === today.getDate()) return "";
  return lang === "en" ? `${MONTHS[quoted.getMonth()]} ${quoted.getDate()}` : `${quoted.getMonth() + 1}/${quoted.getDate()}`;
}

/**
 * A row's second line, `[freshness label, date, name]` with empties dropped: a name that begins
 * with the label (a pair's "Binance Spot" after "Binance") replaces it, and a name that only
 * repeats the ticker is left out, so nothing on the row says the same thing twice.
 */
export function rowMeta(symbol, [label, date, name]) {
  const named = name && name !== symbol ? name : "";
  return [named && label && named.startsWith(label) ? "" : label, date, named].filter(Boolean);
}

const two = (n) => String(n).padStart(2, "0");

/** Local wall-clock time, 24-hour: "15:04", or "15:04:05" with seconds. */
export function formatTime(timestamp, seconds = false) {
  const date = new Date(timestamp);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${time}:${two(date.getSeconds())}` : time;
}
