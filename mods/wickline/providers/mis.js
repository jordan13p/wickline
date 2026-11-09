// TWSE MIS: the exchange's unofficial market-info feed, seconds behind, laid over Yahoo's delayed
// Taiwan quotes. Off until the person turns it on and consents. This file holds
// the feed's host, limits and decoder; the switch and consent live in settings.js and the settings
// dialog. No Herdr imports, so tests run it under Node.
import { HEADERS, QuoteError, cleanText, positive, withinLimits } from "../quotes.js";
import { failEach, parseJson } from "./provider.js";

export const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
export const MIS_BATCH = 50;
// Raise it with any change in substance to the statement or consent text (zh-TW prevails):
// a consent given to an older text no longer turns MIS on.
export const MIS_CONSENT_VERSION = 2;

/** @typedef {import("./provider.js").Provider} Provider */

/** `2330.TW` → `tse_2330.tw`, `6488.TWO` → `otc_6488.tw`; a code with letters keeps its case, or MIS returns nothing. */
export function misChannel(symbol) {
  const dot = symbol.lastIndexOf(".");
  return `${symbol.slice(dot + 1) === "TWO" ? "otc" : "tse"}_${symbol.slice(0, dot)}.tw`;
}

const number = (value) => {
  const n = Number(value);
  return positive(n) ? n : null;
};

// The best real bid or ask: "2265.0000_2260.0000_..." → 2265. Market orders show as 0.0000 and are skipped.
const best = (value) => (typeof value === "string" ? value.split("_").map(number).find(Boolean) ?? null : null);

/**
 * The price from the order book when the snapshot had no trade: the midpoint of the best bid and ask; with
 * orders on one side only, the stock's limit when that side waits at it (asks only at limit-down, bids only
 * at limit-up), as a stock locked at its limit trades only there. Anything else has no price.
 */
function bookPrice(bid, ask, up, down) {
  if (bid && ask) return (bid + ask) / 2;
  if (!positive(up) || !positive(down) || up >= 9999) return null;
  if (ask && ask === down) return down;
  if (bid && bid === up) return up;
  return null;
}

/**
 * Overlays by requested symbol. The price is the last trade (`z`); when the last 5-second snapshot
 * had none (`-`), the order book's (bookPrice). A row with neither, or without a time, has
 * no overlay and no error. A row MIS sent for a symbol that was not asked for is ignored.
 */
export function decodeMis(symbols, response, now) {
  // MIS does not document a rate limit; Herdr's fetch has no Retry-After either: wait at least a minute.
  if (response.status === 429) throw new QuoteError("mis.rateLimited", {}, { retryAfterMs: 60_000 });
  if (!response.ok) throw new QuoteError("mis.http", { status: response.status });
  const body = parseJson(response.text, "mis.unreadable");
  if (!Array.isArray(body?.msgArray)) throw new QuoteError("mis.unreadable");
  const wanted = new Map(symbols.map((symbol) => [misChannel(symbol), symbol]));
  const quotes = {};
  const errors = {};
  // Before the open (or for a halted stock) MIS sends a row's name without any price: keep the name.
  const names = {};
  for (const row of body.msgArray) {
    const symbol = typeof row?.ex === "string" && typeof row.c === "string" ? wanted.get(`${row.ex}_${row.c}.tw`) : undefined;
    if (!symbol) continue;
    const name = cleanText(row.n);
    if (name) names[symbol] = name;
    const bid = best(row.b);
    const ask = best(row.a);
    const price = number(row.z) ?? bookPrice(bid, ask, number(row.u), number(row.w));
    const time = Number(row.tlong);
    if (!price || !positive(time)) continue;
    if (!withinLimits(price, number(row.u), number(row.w))) {
      errors[symbol] = new QuoteError("mis.outOfLimits");
      continue;
    }
    quotes[symbol] = {
      symbol,
      source: "mis",
      name,
      price,
      previousClose: number(row.y),
      open: number(row.o),
      high: number(row.h),
      low: number(row.l),
      timestamp: time,
      fetchedAt: now,
    };
  }
  return { quotes, errors, names };
}

/** @type {Provider} */
export const mis = {
  id: "mis",
  markets: ["tw"],
  overlay: true,
  spacingMs: () => 0,
  intervalMs: (session) => (session === "open" || session === "unknown" ? 10_000 : 60_000),
  requests(symbols, { misUrl }) {
    const requests = [];
    for (let i = 0; i < symbols.length; i += MIS_BATCH) {
      const batch = symbols.slice(i, i + MIS_BATCH);
      requests.push({ url: `${misUrl}?ex_ch=${batch.map(misChannel).join("|")}&json=1&delay=0`, headers: HEADERS, symbols: batch, kind: "quote" });
    }
    return requests;
  },
  decode(request, response, now) {
    try {
      return decodeMis(request.symbols, response, now);
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
