// TWSE MIS: the exchange's unofficial market-info feed, seconds behind, laid over Yahoo's delayed Taiwan quotes.
// Off until the user turns it on and consents. This file holds the feed's host, limits and decoder; the switch and
// consent live in settings.js and the settings dialog.
import {
  BOOK_LEVELS,
  HEADERS,
  QuoteError,
  cleanText,
  hasLimits,
  limitPair,
  positive,
  positiveOrNull,
  sized,
  withinLimits,
} from "../quotes.js";
import { RATE_LIMIT_RETRY_MS, failEach, parseJson } from "./provider.js";
import { fastPace } from "../markets.js";

export const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
export const MIS_BATCH = 50;
// Raise it with any change in substance to the statement or consent text (zh-TW prevails), so a consent given to an
// older text no longer turns MIS on.
export const MIS_CONSENT_VERSION = 2;

/** @typedef {import("./provider.js").Provider} Provider */

/** A symbol's MIS channel: `2330.TW` → `tse_2330.tw`, `6488.TWO` → `otc_6488.tw`. Letters keep their case. */
export function misChannel(symbol) {
  const dot = symbol.lastIndexOf(".");
  return `${symbol.slice(dot + 1) === "TWO" ? "otc" : "tse"}_${symbol.slice(0, dot)}.tw`;
}

// The best real bid or ask: "2265.0000_2260.0000_..." → 2265. Market orders show as 0.0000 and are skipped.
const best = (value) =>
  typeof value === "string" ? (value.split("_").map(positiveOrNull).find(Boolean) ?? null) : null;

// MIS's price of a market order.
const MARKET_PRICE = /^0(\.0+)?$/;

/**
 * One side of the book, in the order sent, at most BOOK_LEVELS: `prices` ("2170.0000_2165.0000_…") zipped with
 * `sizes` ("2280_208_…", in lots) as `{ price, size }`. A level without a positive size or a price (`-`) is skipped.
 * A market order (`0.0000` with a size) has a null `price` and keeps its place, ahead of the limit orders.
 */
function levels(prices, sizes) {
  if (typeof prices !== "string") return [];
  const sized = typeof sizes === "string" ? sizes.split("_") : [];
  return prices
    .split("_")
    .map((price, i) => ({
      price: positiveOrNull(price),
      size: positiveOrNull(sized[i]),
      market: MARKET_PRICE.test(price),
    }))
    .filter((level) => level.size !== null && (level.price !== null || level.market))
    .map(({ price, size }) => ({ price, size }))
    .slice(0, BOOK_LEVELS);
}

/**
 * The price from the order book when the snapshot had no trade: the midpoint of the best bid and ask. With orders on
 * one side only, the stock's limit when that side waits at it (asks only at limit-down, bids only at limit-up), as a
 * stock locked at its limit trades only there. Anything else has no price.
 */
function bookPrice(bid, ask, up, down) {
  if (bid && ask) return (bid + ask) / 2;
  if (!hasLimits(up, down)) return null;
  if (ask && ask === down) return down;
  if (bid && bid === up) return up;
  return null;
}

/**
 * One MIS answer, by requested symbol; a row for a symbol not asked for is ignored.
 * - `quotes`: the last trade (`z`), or, when the 5-second snapshot had none, the book's price (bookPrice), marked
 *   `fromBook` and timed by the snapshot. Each carries its own `book`, `{ bids, asks }`.
 * - `auction`: each symbol MIS flags as in a call auction (`ts` "1" with a snapshot time, 08:30 to the open and
 *   13:25 to the close), mapped to the snapshot's time. Its book is the auction's, never a price. Its trial price `pz`
 *   is ignored, as an auction whose orders do not cross has none. Its levels, if any, go in `auctionBook` as
 *   `{ bids, asks, auction: true }`.
 * - `noLevels`: a named row neither flagged nor priced, with no priced level: MIS answered before any order.
 * A row with no price or no time gets no quote and no error. Each optional key is there only when not empty.
 */
function decodeMis(symbols, response, now) {
  // MIS does not document a rate limit, and Herdr's fetch gives no Retry-After.
  if (response.status === 429) throw new QuoteError("mis.rateLimited", {}, { retryAfterMs: RATE_LIMIT_RETRY_MS });
  if (!response.ok) throw new QuoteError("mis.http", { status: response.status });
  const body = parseJson(response.text, "mis.unreadable");
  if (!Array.isArray(body?.msgArray)) throw new QuoteError("mis.unreadable");
  const wanted = new Map(symbols.map((symbol) => [misChannel(symbol), symbol]));
  const quotes = {};
  const errors = {};
  // Before the open (or for a halted stock) MIS sends a row's name without any price: keep the name.
  const names = {};
  const auction = {};
  const auctionBook = {};
  const noLevels = {};
  for (const row of body.msgArray) {
    const symbol =
      typeof row?.ex === "string" && typeof row.c === "string" ? wanted.get(`${row.ex}_${row.c}.tw`) : undefined;
    if (!symbol) continue;
    const name = cleanText(row.n);
    if (name) names[symbol] = name;
    const time = Number(row.tlong);
    const book = { bids: levels(row.b, row.g), asks: levels(row.a, row.f) };
    const leveled = book.bids.length > 0 || book.asks.length > 0;
    // A market order alone is no order book yet: a row without a priced level still reads as having none.
    const priced = [...book.bids, ...book.asks].some((level) => level.price !== null);
    if (row.ts === "1" && positive(time)) {
      auction[symbol] = time;
      if (leveled) auctionBook[symbol] = { ...book, auction: true };
      continue;
    }
    const bid = best(row.b);
    const ask = best(row.a);
    const limits = limitPair(positiveOrNull(row.u), positiveOrNull(row.w));
    const traded = positiveOrNull(row.z);
    const lastSize = positiveOrNull(row.tv);
    const price = traded ?? bookPrice(bid, ask, limits.limitUp, limits.limitDown);
    if (!price || !positive(time)) {
      if (name && !priced) noLevels[symbol] = true;
      continue;
    }
    if (!withinLimits(price, limits.limitUp, limits.limitDown)) {
      errors[symbol] = new QuoteError("mis.outOfLimits");
      continue;
    }
    quotes[symbol] = {
      symbol,
      source: "mis",
      name,
      price,
      previousClose: positiveOrNull(row.y),
      open: positiveOrNull(row.o),
      high: positiveOrNull(row.h),
      low: positiveOrNull(row.l),
      ...limits,
      ...sized(positiveOrNull(row.v), "lot"),
      // The last trade's size (`tv`), in lots too; a price from the book has none.
      ...(traded && lastSize && { lastSize, sizeUnit: "lot" }),
      book,
      timestamp: time,
      fetchedAt: now,
      ...(!traded && { fromBook: true }),
    };
  }
  const some = (record) => Object.keys(record).length > 0;
  return {
    quotes,
    errors,
    names,
    ...(some(auction) && { auction }),
    ...(some(auctionBook) && { auctionBook }),
    ...(some(noLevels) && { noLevels }),
  };
}

/** @type {Provider} */
export const mis = {
  id: "mis",
  markets: ["tw"],
  // Its index codes are another scheme (tse_t00.tw): stocks only.
  kinds: ["stock"],
  overlay: true,
  spacingMs: () => 0,
  intervalMs: (session) => (fastPace(session) ? 10_000 : 60_000),
  requests(symbols, { misUrl }) {
    const requests = [];
    for (let i = 0; i < symbols.length; i += MIS_BATCH) {
      const batch = symbols.slice(i, i + MIS_BATCH);
      requests.push({
        url: `${misUrl}?ex_ch=${batch.map(misChannel).join("|")}&json=1&delay=0`,
        headers: HEADERS,
        symbols: batch,
        kind: "quote",
      });
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
