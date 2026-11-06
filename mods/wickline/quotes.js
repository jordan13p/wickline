// Symbols, coded errors and what the quote sources share.
// No Herdr imports, so tests run it under Node. The hosts live in providers/.

export const VERSION = "0.3.0";
export const USER_AGENT = `Wickline-Herdr/${VERSION}`;
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
