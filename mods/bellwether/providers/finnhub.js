// Finnhub: real-time US quotes with the person's own API key, laid over Yahoo's delayed ones.
// Off until the person chooses it and saves a key. One request per symbol, within a per-minute
// budget. No Herdr imports, so tests run it under Node.
import { HEADERS, QuoteError, positive } from "../quotes.js";

export const FINNHUB_URL = "https://finnhub.io/api/v1";

/** @typedef {import("./yahoo.js").Provider} Provider */

/** Yahoo's class-share dash is a dot on Finnhub: `BRK-B` → `BRK.B`. */
export function finnhubSymbol(symbol) {
  return symbol.replace(/-/g, ".");
}

/**
 * How many US symbols Finnhub prices within `budgetPerMinute`: the cap keeps one round within a
 * quarter-minute of requests at the budget's pace. With a round spread over about 15 s plus the 15 s
 * wait after it, each symbol refreshes about every 30 s and one copy uses about half the budget,
 * leaving room for retries and a second copy. The rest stay on Yahoo.
 */
export function finnhubCap(budgetPerMinute) {
  return Math.floor(budgetPerMinute / 4);
}

const number = (value) => (positive(value) ? value : null);

/** The overlay for `symbol`; a zero price or time (Finnhub's answer for an unknown symbol) is no quote and no error. */
export function decodeFinnhub(symbol, response, now) {
  // The key was refused: no point asking again until it changes.
  if (response.status === 401 || response.status === 403) throw new QuoteError("finnhub.invalidKey", {}, { stopsSource: true });
  // No Retry-After in Herdr's fetch: wait at least a minute.
  if (response.status === 429) throw new QuoteError("finnhub.rateLimited", {}, { retryAfterMs: 60_000 });
  if (!response.ok) throw new QuoteError("finnhub.http", { status: response.status });
  let body;
  try { body = JSON.parse(response.text); } catch { throw new QuoteError("finnhub.unreadable"); }
  if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.c !== "number") {
    throw new QuoteError("finnhub.unreadable");
  }
  if (!positive(body.c) || !positive(body.t)) return {};
  return {
    [symbol]: {
      symbol,
      source: "finnhub",
      price: body.c,
      previousClose: number(body.pc),
      open: number(body.o),
      high: number(body.h),
      low: number(body.l),
      timestamp: body.t * 1000,
      fetchedAt: now,
    },
  };
}

/** @type {Provider} */
export const finnhub = {
  id: "finnhub",
  markets: ["us"],
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
      url: `${base}/quote?symbol=${encodeURIComponent(finnhubSymbol(symbol))}`, headers, symbols: [symbol], kind: "quote",
    }));
  },
  decode(request, response, now) {
    const [symbol] = request.symbols;
    try {
      return { quotes: decodeFinnhub(symbol, response, now), errors: {} };
    } catch (error) {
      if (!(error instanceof QuoteError)) throw error;
      return { quotes: {}, errors: { [symbol]: error } };
    }
  },
};
