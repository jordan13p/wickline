// How fresh a quote is, as the view draws it: a filled dot only for a real-time price
// that is recent while its market trades. No Herdr imports, so tests run it under Node.
import { marketOf } from "./markets.js";
import { isCryptoPair } from "./quotes.js";

// A real-time quote older than this (inclusive) while its market is open has stalled.
export const LIVE_MAX_AGE_MS = 120_000;
// Yahoo reports no delay for Taiwan, whose quotes come 20 minutes late.
export const TAIWAN_YAHOO_DELAY_S = 1200;
// Providers whose prices are real time; any other source is delayed.
export const REALTIME_SOURCES = new Set(["mis", "finnhub", "binance"]);

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
 * "open", "pre", "post" or "closed" from the quote's trading periods; a pair trades "24h";
 * a stock without a regular session (no Yahoo quote yet) is "unknown".
 */
export function sessionOf(quote, now) {
  if (isCryptoPair(quote.symbol)) return "24h";
  if (!quote.periods?.regular) return "unknown";
  return marketSession(quote, now);
}

const result = (state, delayMinutes = null, stoppedAt = null) => ({ state, delayMinutes, stoppedAt });

/**
 * live: real time, trading, at most LIVE_MAX_AGE_MS old (a quote timed ahead of the clock counts as new).
 * unconfirmed: real time while the session is not known. stalled: real time, trading, older.
 * delayed: any other source; minutes only when known. closed / pre / post: the session itself.
 */
export function freshness(quote, session, now) {
  if (session === "closed" || session === "pre" || session === "post") return result(session);
  if (REALTIME_SOURCES.has(quote.source)) {
    if (session === "unknown") return result("unconfirmed");
    return now - quote.timestamp <= LIVE_MAX_AGE_MS ? result("live") : result("stalled", null, quote.timestamp);
  }
  const seconds = quote.delaySeconds > 0 ? quote.delaySeconds
    : marketOf(quote.symbol) === "tw" ? TAIWAN_YAHOO_DELAY_S : null;
  return result("delayed", seconds === null ? null : Math.ceil(seconds / 60));
}

/**
 * The detail dialog's source line as parts (joined with ` · `). A real-time price over another
 * source's line names both and puts the delay on the line, from the line's own source: `Price: TWSE
 * MIS`, `Line: Yahoo (delayed 20 min)`. Otherwise the source and, for a delayed one, its delay.
 * `tx(key, params)` translates; a `src.<id>` key names a provider.
 */
export function detailSource(quote, session, now, tx) {
  const minutes = (delayMinutes) => delayMinutes === null ? tx("freshness.delayUnknown")
    : tx("freshness.delayedMinutes", { minutes: delayMinutes });
  if (REALTIME_SOURCES.has(quote.source) && !isCryptoPair(quote.symbol)) {
    const price = tx("detail.priceFrom", { source: tx(`src.${quote.source}`) });
    if (!quote.chartSource) return [price];
    const chart = { ...quote, source: quote.chartSource, delaySeconds: quote.chartDelaySeconds ?? null };
    return [price, tx("detail.lineFrom", { source: tx(`src.${quote.chartSource}`), delay: minutes(freshness(chart, session, now).delayMinutes) })];
  }
  if (isCryptoPair(quote.symbol)) return [tx("detail.sourceCrypto")];
  return [tx("detail.sourceStock"), minutes(freshness(quote, session, now).delayMinutes)];
}
