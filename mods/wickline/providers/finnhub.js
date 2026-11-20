// Finnhub: real-time US quotes with the user's own API key, laid over Yahoo's delayed ones.
// Off until the user chooses it and saves a key. One request per symbol, within a per-minute budget.
import { HEADERS, QuoteError, positive } from "../quotes.js";
import { RATE_LIMIT_RETRY_MS, failEach, parseJson } from "./provider.js";

export const FINNHUB_URL = "https://finnhub.io/api/v1";
// The key goes only to finnhub.io over https. A saved address may change the path, never the host, a port, userinfo,
// a query or a fragment. Checked by the dialog and again before every round.
const FINNHUB_ADDRESS = /^https:\/\/finnhub\.io(\/[^\s?#]*)?$/i;
// An answer's final address, after any redirect, must be on finnhub.io over https.
const FINNHUB_ORIGIN = /^https:\/\/finnhub\.io(?=[/?#]|$)/i;

/** Whether the saved Finnhub address may be sent the key. */
export function finnhubAddressOk(url) {
  return typeof url === "string" && FINNHUB_ADDRESS.test(url.trim());
}

/** @typedef {import("./provider.js").Provider} Provider */

/** Yahoo's class-share dash is a dot on Finnhub: `BRK-B` → `BRK.B`. */
export function finnhubSymbol(symbol) {
  return symbol.replace(/-/g, ".");
}

/**
 * How many US symbols Finnhub prices within `budgetPerMinute`; the rest stay on Yahoo. The cap keeps one round
 * within a quarter-minute of requests at the budget's pace. A round then takes about 15 s and waits 15 s, so each
 * symbol refreshes about every 30 s and one copy uses about half the budget, leaving room for retries and a second
 * copy.
 */
export function finnhubCap(budgetPerMinute) {
  return Math.floor(budgetPerMinute / 4);
}

const positiveValue = (value) => (positive(value) ? value : null);

/** The overlay for `symbol`; a zero price or time (Finnhub's answer for an unknown symbol) is no quote and no error. */
function decodeFinnhub(symbol, response, now) {
  // Redirected elsewhere, or no final address to tell: the key may have gone with it, so it is not sent again until
  // the settings change.
  if (typeof response.url !== "string" || !FINNHUB_ORIGIN.test(response.url)) {
    throw new QuoteError("finnhub.redirected", {}, { stopsSource: true });
  }
  // The key was refused: no point asking again until it changes.
  if (response.status === 401 || response.status === 403)
    throw new QuoteError("finnhub.invalidKey", {}, { stopsSource: true });
  if (response.status === 429) throw new QuoteError("finnhub.rateLimited", {}, { retryAfterMs: RATE_LIMIT_RETRY_MS });
  if (!response.ok) throw new QuoteError("finnhub.http", { status: response.status });
  const body = parseJson(response.text, "finnhub.unreadable");
  if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.c !== "number") {
    throw new QuoteError("finnhub.unreadable");
  }
  if (!positive(body.c) || !positive(body.t)) return {};
  return {
    [symbol]: {
      symbol,
      source: "finnhub",
      price: body.c,
      previousClose: positiveValue(body.pc),
      open: positiveValue(body.o),
      high: positiveValue(body.h),
      low: positiveValue(body.l),
      timestamp: body.t * 1000,
      fetchedAt: now,
    },
  };
}

/** @type {Provider} */
export const finnhub = {
  id: "finnhub",
  markets: ["us"],
  kinds: ["stock"],
  overlay: true,
  // Refresh never spends the budget: Finnhub keeps its own pace.
  manualRefresh: false,
  // The first `finnhubCap` US symbols in list order.
  cap: ({ budgetPerMinute }) => finnhubCap(budgetPerMinute),
  // Spread over the interval, at least a second apart, so a round never bursts past the budget.
  spacingMs: (count, interval) => Math.max(1000, interval / count),
  intervalMs: (session) => (session === "open" || session === "unknown" ? 15_000 : 60_000),
  // The key travels only in the header, never in the URL.
  requests(symbols, { finnhubUrl, finnhubKey }) {
    const base = finnhubUrl.replace(/\/+$/, "");
    const headers = { ...HEADERS, "X-Finnhub-Token": finnhubKey };
    return symbols.map((symbol) => ({
      url: `${base}/quote?symbol=${encodeURIComponent(finnhubSymbol(symbol))}`,
      headers,
      symbols: [symbol],
      kind: "quote",
    }));
  },
  decode(request, response, now) {
    const [symbol] = request.symbols;
    try {
      return { quotes: decodeFinnhub(symbol, response, now), errors: {} };
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
