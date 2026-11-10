// How fresh a quote is, as the view draws it: a filled dot only for a real-time price
// that is recent while its market trades. No Herdr imports, so tests run it under Node.
import { stateText } from "./format.js";
import { exchangeRule } from "./markets.js";
import { isCryptoPair, priceLimit } from "./quotes.js";

// A real-time quote older than this (inclusive) while its market is open has stalled.
export const LIVE_MAX_AGE_MS = 120_000;
// Providers whose prices are real time; Yahoo Finance is real time only for some exchanges (exchangeRule).
export const REALTIME_SOURCES = new Set(["yahootw", "mis", "finnhub", "binance"]);
// A delayed quote has stalled once it is older than its exchange's delay plus this.
const DELAYED_GRACE_S = 300;

/** A real-time source, or Yahoo Finance for a real-time exchange. */
export const isRealtime = (quote) => REALTIME_SOURCES.has(quote.source)
  || (quote.source === "yahoo" && exchangeRule(quote.exchange, quote.symbol).realtime);

// How old a quote may get while its market is open before it has stalled, in ms; null: it never does.
function staleAfterMs(quote) {
  if (isRealtime(quote)) return LIVE_MAX_AGE_MS;
  const { delayS, futures } = exchangeRule(quote.exchange, quote.symbol);
  return futures || delayS === null ? null : (delayS + DELAYED_GRACE_S) * 1000;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// The local day's lunch break around `now` as [start, end) in ms, by the exchange clock's fixed UTC offset.
function lunchWindow({ offsetMin, from, to }, now) {
  const dayStart = Math.floor((now + offsetMin * MINUTE_MS) / DAY_MS) * DAY_MS - offsetMin * MINUTE_MS;
  return [dayStart + from * MINUTE_MS, dayStart + to * MINUTE_MS];
}

// A quote's age against staleAfterMs. A delayed quote counts from today's open at the earliest, so a market's
// first minutes do not read stopped at the previous close, and without today's lunch break, so it does not
// read stopped just after lunch; a real-time one always from its own time.
function quoteAgeMs(quote, now) {
  if (isRealtime(quote)) return now - quote.timestamp;
  const open = quote.periods?.regular?.[0];
  const start = open === undefined ? quote.timestamp : Math.max(quote.timestamp, open);
  const { lunch } = exchangeRule(quote.exchange, quote.symbol);
  if (!lunch) return now - start;
  const [lunchStart, lunchEnd] = lunchWindow(lunch, now);
  return now - start - Math.max(0, Math.min(now, lunchEnd) - Math.max(start, lunchStart));
}

// A delayed quote's minutes late, from its exchange's rule; null when the rule gives none.
function delayMinutes(quote) {
  const { delayS } = exchangeRule(quote.exchange, quote.symbol);
  return delayS === null ? null : Math.ceil(delayS / 60);
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

// From Friday 22:00 to Sunday 22:00 UTC, when the FX week is over: two hours later it is Saturday or Sunday
// (day 0, 1970-01-01, was a Thursday: adding 4 to a day count gives its weekday, Sunday 0).
function fxWeekend(now) {
  const weekday = (Math.floor((now + 120 * MINUTE_MS) / DAY_MS) + 4) % 7;
  return weekday === 6 || weekday === 0;
}

/**
 * "open", "pre", "post" or "closed" from the quote's trading periods, and "lunch" while open inside its
 * exchange's lunch break (Yahoo's regular period runs through it); FX is "closed" over the weekend whatever
 * its period says. A pair trades "24h"; a stock without a regular session (no Yahoo quote yet) is "unknown".
 */
export function sessionOf(quote, now) {
  if (isCryptoPair(quote.symbol)) return "24h";
  if (!quote.periods?.regular) return "unknown";
  const { lunch, fx } = exchangeRule(quote.exchange, quote.symbol);
  if (fx && fxWeekend(now)) return "closed";
  const session = marketSession(quote, now);
  if (session !== "open" || !lunch) return session;
  const [lunchStart, lunchEnd] = lunchWindow(lunch, now);
  return now >= lunchStart && now < lunchEnd ? "lunch" : "open";
}

const result = (state, delayMinutes = null, stoppedAt = null) => ({ state, delayMinutes, stoppedAt });

// Sessions a quote reads as, never stale: the market is not trading (regular-session prices only).
const PAUSED = new Set(["closed", "pre", "post", "lunch"]);

/**
 * How long until a quote turns stale in `session`, in ms: at least 1 while it has not yet, 0 or less once it
 * has (older than staleAfterMs by quoteAgeMs). null when it never will this session: the market is not
 * trading, a delayed quote's session is not open, or it is a future or from an exchange without a delay. A
 * real-time quote counts also while its session is not known: it reads unconfirmed, but a stale overlay
 * still hands its row to another source (pickOverlay).
 */
export function msUntilStale(quote, session, now) {
  if (PAUSED.has(session) || (!isRealtime(quote) && session !== "open")) return null;
  const limit = staleAfterMs(quote);
  return limit === null ? null : limit - quoteAgeMs(quote, now) + 1;
}

/**
 * live: real time (isRealtime), trading, at most LIVE_MAX_AGE_MS old (a quote timed ahead of the clock counts
 * as new). unconfirmed: real time while the session is not known. stalled: past its msUntilStale, real time
 * or delayed. delayed: any other quote, with its exchange's minutes when the table holds them; a future or an
 * exchange without a delay never stalls. closed / pre / post / lunch: the session.
 */
export function freshness(quote, session, now) {
  if (PAUSED.has(session)) return result(session);
  const realtime = isRealtime(quote);
  if (realtime && session === "unknown") return result("unconfirmed");
  const left = msUntilStale(quote, session, now);
  if (left !== null && left <= 0) return result("stalled", null, quote.timestamp);
  return realtime ? result("live") : result("delayed", delayMinutes(quote));
}

// After the close, how long a price still belongs to the session: TWSE's fixed-price trades end an hour later.
const AFTER_CLOSE_MS = 90 * MINUTE_MS;

/**
 * A quote's limit as drawn: "up", "down" or null (see priceLimit), only while it still holds: live, or once
 * the market is not open (closed, after hours) for a price from the regular session its periods describe.
 * Never stalled (the lock may have opened since), unconfirmed, or before the open: Yahoo gives Taiwan no
 * pre-market period, so MIS's trial match at 08:45 reads "closed", and only its time, outside the session,
 * tells it apart, also while a copy that slept still holds yesterday's periods. The time may be the feed's
 * (Yahoo 奇摩股市), which is never earlier than the stock's own trade today.
 */
export function shownLimit(quote, session, now) {
  const { state } = freshness(quote, session, now);
  const regular = quote.periods?.regular;
  const traded = Boolean(regular) && quote.timestamp >= regular[0] && quote.timestamp <= regular[1] + AFTER_CLOSE_MS;
  return state === "live" || ((state === "closed" || state === "post") && traded) ? priceLimit(quote) : null;
}

// A delayed quote's lateness in words: its exchange's minutes, else that the delay is not provided.
function delayWords(quote, tx) {
  const late = delayMinutes(quote);
  return late === null ? tx("freshness.delayUnknown") : tx("freshness.delayedMinutes", { minutes: late });
}

/**
 * The detail dialog's sources as lines, each a list of parts (joined with ` · `). A real-time price
 * names its state and source on one line: `Price: Live · TWSE MIS`; its line follows on its own, as the
 * same state when the line is the price's own source (Yahoo 奇摩股市), else as the line's own source
 * reads: its session's state when that source is real time (never stalled: the merged time is the
 * price's), else its exchange's delay: `Line: delayed 20 min · Yahoo Finance`. A delayed stock keeps its
 * plain wording as one line of two parts, with its exchange's delay in every session; a pair is one part.
 * `tx(key, params)` translates; a `src.<id>` key names a provider.
 */
export function detailSource(quote, session, now, tx) {
  if (isRealtime(quote) && !isCryptoPair(quote.symbol)) {
    const own = stateText(freshness(quote, session, now), tx);
    const price = tx("detail.priceFrom", { state: own, source: tx(`src.${quote.source}`) });
    if (!quote.chartSource) return [[price]];
    if (quote.chartSource === quote.source) return [[price], [tx("detail.lineFrom", { state: own, source: tx(`src.${quote.source}`) })]];
    const chart = { ...quote, source: quote.chartSource, timestamp: now };
    const state = isRealtime(chart) ? stateText(freshness(chart, session, now), tx) : delayWords(chart, tx);
    return [[price], [tx("detail.lineFrom", { state, source: tx(`src.${quote.chartSource}`) })]];
  }
  if (isCryptoPair(quote.symbol)) return [[tx("detail.sourceCrypto")]];
  return [[tx("detail.sourceStock"), delayWords(quote, tx)]];
}
