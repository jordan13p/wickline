// How fresh a quote is, as the view draws it: a filled dot only for a real-time price
// that is recent while its market trades. No Herdr imports, so tests run it under Node.
import { stateText } from "./format.js";
import { DAY_MS, MINUTE_MS, TAIFEX_HOURS, exchangeRule, kindOf, localDay, weekdayOf } from "./markets.js";
import { isCryptoPair, priceLimit } from "./quotes.js";

// A real-time quote older than this (inclusive) while its market is open has stalled.
export const LIVE_MAX_AGE_MS = 120_000;
// Providers whose prices are real time; Yahoo Finance is real time only for some exchanges (exchangeRule).
export const REALTIME_SOURCES = new Set(["yahootw", "mis", "finnhub", "binance"]);
// A delayed quote has stalled once it is older than its exchange's delay plus this.
const DELAYED_GRACE_S = 300;
// A Yahoo Finance quote not fetched for longer than this while its market is open has stalled, however
// recent its price.
const FETCH_MAX_AGE_MS = 300_000;

/** A real-time source, or Yahoo Finance for a real-time exchange. */
export const isRealtime = (quote) => REALTIME_SOURCES.has(quote.source)
  || (quote.source === "yahoo" && exchangeRule(quote.exchange, quote.symbol).realtime);

// How old a quote may get while its market is open before it has stalled, in ms; null: it never does.
function staleAfterMs(quote) {
  if (isRealtime(quote)) return LIVE_MAX_AGE_MS;
  const { delayS, futures } = exchangeRule(quote.exchange, quote.symbol);
  return futures || delayS === null ? null : (delayS + DELAYED_GRACE_S) * 1000;
}

// A window of the local day around `now` (its from and to in local minutes since midnight), as [start, end) in
// ms, by the clock's fixed UTC offset: a lunch break, or a TAIFEX session.
function localWindow({ offsetMin, from, to }, now) {
  const dayStart = localDay(offsetMin, now) * DAY_MS - offsetMin * MINUTE_MS;
  return [dayStart + from * MINUTE_MS, dayStart + to * MINUTE_MS];
}

// When a Yahoo Finance quote's age is taken: at its fetch, but now for a `cached` one (its last fetch failed,
// see Watchlist.shown), so cached data never looks fresh. One without a fetch time (every provider sets it)
// counts as fetched now, so its age still grows rather than reading NaN, which would never stall.
const fetchedAt = (quote, now) => (quote.cached ? now : quote.fetchedAt ?? now);

// A quote's age against staleAfterMs. An overlay's (a real-time source's own) runs from its time to now. A
// Yahoo Finance quote's is taken when it was fetched, so it does not grow with the time a long list takes
// to come round again; it counts from today's open at the earliest, so a market's first minutes do not read
// stopped at the previous close, and a delayed one leaves out today's lunch break, so it does not read
// stopped just after lunch (no real-time exchange has one). FX counts from its own time: its regular period
// is the UTC day, so its 00:00 is no open and the minutes before it still count.
function quoteAgeMs(quote, now) {
  if (quote.source !== "yahoo") return now - quote.timestamp;
  const at = fetchedAt(quote, now);
  const { lunch, fx } = exchangeRule(quote.exchange, quote.symbol);
  const open = fx ? undefined : quote.periods?.regular?.[0];
  const start = open === undefined ? quote.timestamp : Math.max(quote.timestamp, open);
  if (!lunch) return at - start;
  const [lunchStart, lunchEnd] = localWindow(lunch, at);
  return at - start - Math.max(0, Math.min(at, lunchEnd) - Math.max(start, lunchStart));
}

// A real-time Yahoo Finance quote whose trade is from before today's open: the previous close, not a live
// price, until a fetch brings a trade from today. Not FX: its regular period is the UTC day, so the minute
// before 00:00 is not a close.
function beforeOpen(quote) {
  if (quote.source !== "yahoo" || !isRealtime(quote)) return false;
  return !exchangeRule(quote.exchange, quote.symbol).fx && quote.timestamp < quote.periods?.regular?.[0];
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

// From Friday 22:00 to Sunday 22:00 UTC, when the FX week is over: two hours later (on a UTC+2 clock) it is
// Saturday or Sunday.
function fxWeekend(now) {
  const weekday = weekdayOf(localDay(120, now));
  return weekday === 6 || weekday === 0;
}

// TAIFEX's sessions as [start, end) in ms that open on the Taipei day of `now` or the day before (a night session
// still running past midnight), on the weekdays it trades.
function taifexSegments(now) {
  const { offsetMin, weekdays, sessions } = TAIFEX_HOURS;
  const segments = [];
  for (const at of [now - DAY_MS, now]) {
    if (!weekdays.includes(weekdayOf(localDay(offsetMin, at)))) continue;
    for (const { from, to } of sessions) segments.push(localWindow({ offsetMin, from, to }, at));
  }
  return segments;
}

/**
 * The session a future trades in at `now`: "day" or "night", or null between sessions. Its segments are
 * quote.periods.segments when given, else TAIFEX_HOURS around `now`. A segment starting at or after 12:00 Taipei is
 * the night session. A segment holds [start, end).
 */
export function futuresSegment(quote, now) {
  const segments = quote.periods?.segments ?? taifexSegments(now);
  const segment = segments.find(([start, end]) => now >= start && now < end);
  if (!segment) return null;
  // Its start in Taipei minutes since midnight.
  const startMin = ((segment[0] + TAIFEX_HOURS.offsetMin * MINUTE_MS) % DAY_MS) / MINUTE_MS;
  return startMin >= 720 ? "night" : "day";
}

/** How long until a TAIFEX session opens later on the Taipei day of `now`, in ms; null when none does. */
export function msUntilTaifexOpens(now) {
  const starts = taifexSegments(now).map(([start]) => start).filter((start) => start > now);
  return starts.length ? Math.min(...starts) - now : null;
}

/** The detail's session key suffix: a trading future's "day" or "night", else `session` itself. */
export function sessionName(quote, session, now) {
  return (session === "open" && kindOf(quote.symbol) === "future" && futuresSegment(quote, now)) || session;
}

/**
 * "open", "pre", "post" or "closed" from the quote's trading periods, and "lunch" while open inside its
 * exchange's lunch break (Yahoo's regular period runs through it); FX is "closed" over the weekend whatever
 * its period says. A pair trades "24h"; a future (WTX&) is "open" inside a segment (futuresSegment), else
 * "closed", also with no periods yet; a stock without a regular session (no Yahoo quote yet) is "unknown".
 */
export function sessionOf(quote, now) {
  if (isCryptoPair(quote.symbol)) return "24h";
  if (kindOf(quote.symbol) === "future") return futuresSegment(quote, now) ? "open" : "closed";
  if (!quote.periods?.regular) return "unknown";
  const { lunch, fx } = exchangeRule(quote.exchange, quote.symbol);
  if (fx && fxWeekend(now)) return "closed";
  const session = marketSession(quote, now);
  if (session !== "open" || !lunch) return session;
  const [lunchStart, lunchEnd] = localWindow(lunch, now);
  return now >= lunchStart && now < lunchEnd ? "lunch" : "open";
}

const result = (state, delayMinutes = null, stoppedAt = null) => ({ state, delayMinutes, stoppedAt });

// Sessions a quote reads as, never stale: the market is not trading (regular-session prices only).
const PAUSED = new Set(["closed", "pre", "post", "lunch"]);

/**
 * How long until a quote turns stale in `session`, in ms: at least 1 while it has not yet, 0 or less once it
 * has (older than staleAfterMs by quoteAgeMs, or a Yahoo Finance quote not fetched for FETCH_MAX_AGE_MS).
 * null when it never will this session: a delayed quote's or a future's (WTX&) session is not open, or it is a
 * Yahoo future (`=F`) or from an exchange without a delay. A real-time quote counts in every session, also while
 * closed or not known yet: freshness reads it by its session then, but its moment is when pickOverlay (by the same
 * LIVE_MAX_AGE_MS) hands the row to another source, so the idle wake must still land on it. A delayed quote is a
 * Yahoo base, never handed over, and a future has one source: outside the open session neither reads stalled,
 * nothing to wake for.
 */
export function msUntilStale(quote, session, now) {
  if (session !== "open" && (!isRealtime(quote) || kindOf(quote.symbol) === "future")) return null;
  const limit = staleAfterMs(quote);
  if (limit === null) return null;
  const left = limit - quoteAgeMs(quote, now) + 1;
  // A Yahoo quote's age stands still until its next fetch: once past its limit it stays stale, else only
  // the fetch guard can turn it. A previous close never stalls by age (beforeOpen), only by that guard. A
  // cached quote's age grows with now, as an overlay's does.
  if (quote.source !== "yahoo" || quote.cached || (left <= 0 && !beforeOpen(quote))) return left;
  return FETCH_MAX_AGE_MS - (now - fetchedAt(quote, now)) + 1;
}

/**
 * live: real time (isRealtime), trading, at most LIVE_MAX_AGE_MS old (a quote timed ahead of the clock counts
 * as new). unconfirmed: real time while the session is not known, or a real-time Yahoo quote still at the
 * previous close after today's open (beforeOpen), until today's first trade or the fetch guard. stalled:
 * past its msUntilStale, real time or delayed. delayed: any other quote, with its exchange's minutes when the
 * table holds them; a Yahoo future (`=F`) or an exchange without a delay never stalls. closed / pre / post /
 * lunch: the session.
 */
export function freshness(quote, session, now) {
  if (PAUSED.has(session)) return result(session);
  const realtime = isRealtime(quote);
  if (realtime && session === "unknown") return result("unconfirmed");
  const left = msUntilStale(quote, session, now);
  if (left !== null && left <= 0) return result("stalled", null, quote.timestamp);
  if (beforeOpen(quote)) return result("unconfirmed");
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
 * (Yahoo 奇摩股市), which is never earlier than the stock's own trade today. TWSE's after-close window is a stock's:
 * a future's price belongs to its periods only up to their end.
 */
export function shownLimit(quote, session, now) {
  const { state } = freshness(quote, session, now);
  const regular = quote.periods?.regular;
  const end = regular && regular[1] + (kindOf(quote.symbol) === "future" ? 0 : AFTER_CLOSE_MS);
  const traded = Boolean(regular) && quote.timestamp >= regular[0] && quote.timestamp <= end;
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
 * same state when the line is the price's own source (Yahoo 奇摩股市), else as the line's own quote
 * reads (`chartTimestamp`, `chartFetchedAt`; see mergeOverlay): its state when that source is real time
 * (stalled once that quote is), else its exchange's delay: `Line: delayed 20 min · Yahoo Finance`. A
 * delayed stock keeps its plain wording as one line of two parts, with its exchange's delay in every
 * session; a pair is one part.
 * `tx(key, params)` translates; a `src.<id>` key names a provider.
 */
export function detailSource(quote, session, now, tx) {
  if (isRealtime(quote) && !isCryptoPair(quote.symbol)) {
    const own = stateText(freshness(quote, session, now), tx);
    const price = tx("detail.priceFrom", { state: own, source: tx(`src.${quote.source}`) });
    if (!quote.chartSource) return [[price]];
    if (quote.chartSource === quote.source) return [[price], [tx("detail.lineFrom", { state: own, source: tx(`src.${quote.source}`) })]];
    const chart = {
      ...quote, source: quote.chartSource, timestamp: quote.chartTimestamp, fetchedAt: quote.chartFetchedAt,
    };
    const state = isRealtime(chart) ? stateText(freshness(chart, session, now), tx) : delayWords(chart, tx);
    return [[price], [tx("detail.lineFrom", { state, source: tx(`src.${quote.chartSource}`) })]];
  }
  if (isCryptoPair(quote.symbol)) return [[tx("detail.sourceCrypto")]];
  return [[tx("detail.sourceStock"), delayWords(quote, tx)]];
}
