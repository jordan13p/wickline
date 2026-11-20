// How fresh a quote is, as the view draws it: a filled dot only for a real-time price that is recent while its market
// trades. Also its session, and the moments its row reads differently (nextEdge).
import { taipeiAt, taipeiDay, taipeiMinute } from "./calendar.js";
import { formatStaleDate, nextDayTurn } from "./format.js";
import { TAIFEX_HOURS, TWSE_HOURS, US_HOURS, exchangeRule, kindOf, resolvedMarket } from "./markets.js";
import { isCryptoPair, priceLimit } from "./quotes.js";
import { DAY_MS, MINUTE_MS, dayStart, localDay, localWindow, tradesOn, usOffsetMin, weekdayOf } from "./time.js";

// A real-time quote older than this (inclusive) while its market is open has stalled.
export const LIVE_MAX_AGE_MS = 120_000;
// Providers whose prices are real time; Yahoo Finance is real time only for some exchanges (exchangeRule).
export const REALTIME_SOURCES = new Set(["yahootw", "mis", "finnhub", "binance"]);
// A delayed quote has stalled once it is older than its exchange's delay plus this.
const DELAYED_GRACE_S = 300;
// A Yahoo Finance quote not fetched for longer than this while its market is open has stalled, however recent its
// price.
const FETCH_MAX_AGE_MS = 300_000;

/** Whether a quote is real time: a real-time source, or Yahoo Finance for a real-time exchange. */
export const isRealtime = (quote) =>
  REALTIME_SOURCES.has(quote.source) ||
  (quote.source === "yahoo" && exchangeRule(quote.exchange, quote.symbol).realtime);

// How old a quote may get while its market is open before it has stalled, in ms; null when it never does.
function staleAfterMs(quote) {
  if (isRealtime(quote)) return LIVE_MAX_AGE_MS;
  const { delayS, futures } = exchangeRule(quote.exchange, quote.symbol);
  return futures || delayS === null ? null : (delayS + DELAYED_GRACE_S) * 1000;
}

// When a Yahoo Finance quote's age is taken: at its fetch, but now for a `cached` one (its last fetch failed), so a
// cached delayed quote ages to now. A quote without a fetch time counts as fetched now, so its age still grows rather
// than reading NaN, which would never stall.
const fetchedAt = (quote, now) => (quote.cached ? now : (quote.fetchedAt ?? now));

// A quote's age, against staleAfterMs.
// - A real-time source's own quote ages from its time to now.
// - A Yahoo Finance quote ages to its fetch, so it does not grow while a long list comes round again. It counts from
//   today's open at the earliest, so a market's first minutes do not read stopped at the previous close. It leaves
//   out today's lunch break, so it does not read stopped just after lunch.
// - FX counts from its own time: its regular period is the UTC day, so 00:00 is no open.
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

// Whether a real-time Yahoo Finance quote's trade is from before today's open: the previous close, not a live price,
// until a fetch brings a trade from today. Not FX: its regular period is the UTC day, so the minute before 00:00 is
// not a close.
function beforeOpen(quote) {
  if (quote.source !== "yahoo" || !isRealtime(quote)) return false;
  return !exchangeRule(quote.exchange, quote.symbol).fx && quote.timestamp < quote.periods?.regular?.[0];
}

/** A delayed quote's minutes late, from its exchange's rule; null when the rule gives none. */
export function delayMinutes(quote) {
  const { delayS } = exchangeRule(quote.exchange, quote.symbol);
  return delayS === null ? null : Math.ceil(delayS / 60);
}

/** Where a quote's market is now by its periods: "pre", "open", "post" or "closed"; "24h" without periods. */
export function marketSession(quote, now) {
  if (!quote.periods) return "24h";
  const within = (range) => range && now >= range[0] && now < range[1];
  if (within(quote.periods.regular)) return "open";
  if (within(quote.periods.pre)) return "pre";
  if (within(quote.periods.post)) return "post";
  return "closed";
}

// The clock on which the FX weekend is whole days: UTC+2.
const FX_WEEK_OFFSET_MIN = 120;

// Whether the FX week is over, from Friday 22:00 to Sunday 22:00 UTC: on a UTC+2 clock it is Saturday or Sunday.
function fxWeekend(now) {
  const weekday = weekdayOf(localDay(FX_WEEK_OFFSET_MIN, now));
  return weekday === 6 || weekday === 0;
}

// TAIFEX's sessions as [start, end) in ms that open on the Taipei day of `now` or the day before (a night session
// still running past midnight), on trading weekdays.
function taifexSegments(now) {
  const { offsetMin, sessions } = TAIFEX_HOURS;
  const segments = [];
  for (const at of [now - DAY_MS, now]) {
    if (!tradesOn(TAIFEX_HOURS, localDay(offsetMin, at))) continue;
    for (const { from, to } of sessions) segments.push(localWindow({ offsetMin, from, to }, at));
  }
  return segments;
}

// Taipei minutes since midnight from which a TAIFEX segment starting then is the night session's (12:00).
const NIGHT_FROM_MIN = 720;

// A night session's segment: it starts at or after 12:00 Taipei.
const isNight = ([start]) => taipeiMinute(start) >= NIGHT_FROM_MIN;

/** Whether a quote's night session is closed: removed by a listed day, or without trades (closureOf). */
export const nightClosed = (quote) => quote.closure?.kind === "nightRemoved" || quote.closure?.kind === "nightNoTrades";

/**
 * The session a future trades in at `now`: "day", "night", or null between sessions. The segments are
 * `quote.periods.segments` when given, else TAIFEX's hours around `now`; a closed night is left out.
 */
export function futuresSegment(quote, now) {
  const segments = quote.periods?.segments ?? taifexSegments(now);
  const segment = segments.find((span) => now >= span[0] && now < span[1] && !(nightClosed(quote) && isNight(span)));
  if (!segment) return null;
  return isNight(segment) ? "night" : "day";
}

/**
 * The exchange's lunch break on the local day of `at`, as [start, end] in ms, when it falls strictly inside `regular`
 * (or anywhere when `regular` is null); else null, also for an exchange without one.
 */
export function lunchWithin(quote, regular, at) {
  const { lunch } = exchangeRule(quote.exchange, quote.symbol);
  if (!lunch) return null;
  const [start, end] = localWindow(lunch, at);
  return !regular || (start > regular[0] && end < regular[1]) ? [start, end] : null;
}

// Taiwan's call auctions in Taipei minutes since midnight, [from, to): the morning trial match, which ends at TWSE's
// open, and the closing auction, which ends at its close. A Taiwan stock's trading stops when the closing auction
// starts.
export const TW_TRIAL_MATCH = { from: 510, to: TWSE_HOURS.from };
const TW_CLOSING_AUCTION = { from: 805, to: TWSE_HOURS.to };
const TW_AUCTIONS = [TW_TRIAL_MATCH, TW_CLOSING_AUCTION];
// How long before TWSE's close its closing auction begins, in ms.
const CLOSING_AUCTION_MS = (TW_CLOSING_AUCTION.to - TW_CLOSING_AUCTION.from) * MINUTE_MS;

// A Taiwan auction window on the Taipei date of `at`, as [start, end) in ms.
const auctionWindow = (window, at) => localWindow({ offsetMin: TWSE_HOURS.offsetMin, ...window }, at);

/** Whether `now` is inside one of Taiwan's call auctions (TW_AUCTIONS) on a TWSE trading weekday. */
export function inTaiwanAuction(now) {
  const minute = taipeiMinute(now);
  return TW_AUCTIONS.some(({ from, to }) => minute >= from && minute < to) && tradesOn(TWSE_HOURS, taipeiDay(now));
}

/**
 * The start of the Taiwan call auction whose window holds `now`, on a TWSE trading weekday; else null. A Yahoo
 * 奇摩股市 book fetched at or after it is the auction's (Watchlist#marked).
 */
export function auctionWindowStart(now) {
  if (!tradesOn(TWSE_HOURS, taipeiDay(now))) return null;
  for (const window of TW_AUCTIONS) {
    const [start, end] = auctionWindow(window, now);
    if (now >= start && now < end) return start;
  }
  return null;
}

/**
 * Whether MIS still flags a symbol as in a call auction: its flagged snapshot's time (`auctionAt`, set by
 * Watchlist#marked) is younger than a live MIS price. The only place that reads `auctionAt`.
 */
export const auctionFlagged = (auctionAt, now) => now - auctionAt < LIVE_MAX_AGE_MS;

/**
 * Whether `quote` is in a call auction at `now`: inside an auction window with a real-time source on (`twRealtime`),
 * or while MIS flags it. sessionOf reads it as "auction" unless the price is a delayed one from today.
 */
const auctionOf = (quote, now) => (quote.twRealtime && inTaiwanAuction(now)) || auctionFlagged(quote.auctionAt, now);

// A Taiwan stock (not an index, not a future).
const isTaiwanStock = (quote) =>
  kindOf(quote.symbol) === "stock" && resolvedMarket(quote.symbol, quote.exchange) === "tw";

const edge = (at) => ({ at, opening: false });
const opening = (at) => ({ at, opening: true });

// The next start after `now` of `weekday` (Sunday 0) on a clock at `offsetMin`; a week on when today is that weekday.
function nextDayStart(offsetMin, weekday, now) {
  const today = localDay(offsetMin, now);
  return dayStart(offsetMin, today + ((weekday - weekdayOf(today) + 7) % 7 || 7));
}

/**
 * The moments around `now` at which sessionOf can change for `quote`, along its own branches. An opening is a moment
 * the market starts trading again.
 * - A pair: none.
 * - A future: each segment's start (an opening) and end, from its periods and from TAIFEX's hours both, since the row
 *   moves from the first to the second at 15:00.
 * - Without a regular period: a Taiwan or US quote's hours on a trading weekday, the start an opening.
 * - FX: the weekend's start and end (Friday and Sunday 22:00 UTC), the end an opening.
 * - Any other: its pre, regular and post bounds, and the lunch inside the regular period. The regular start and the
 *   lunch's end are openings.
 */
function sessionEdges(quote, now) {
  if (isCryptoPair(quote.symbol)) return [];
  if (kindOf(quote.symbol) === "future") {
    const segments = [...(quote.periods?.segments ?? []), ...taifexSegments(now)];
    return segments.flatMap(([start, end]) => [opening(start), edge(end)]);
  }
  const regular = quote.periods?.regular;
  if (!regular) {
    const hours = hoursWindow(quote, now);
    return hours?.weekday ? [opening(hours.regular[0]), edge(hours.regular[1])] : [];
  }
  if (exchangeRule(quote.exchange, quote.symbol).fx) {
    return [edge(nextDayStart(FX_WEEK_OFFSET_MIN, 6, now)), opening(nextDayStart(FX_WEEK_OFFSET_MIN, 1, now))];
  }
  const { pre, post } = quote.periods;
  const edges = [...(pre ?? []).map(edge), opening(regular[0]), edge(regular[1]), ...(post ?? []).map(edge)];
  const lunch = lunchWithin(quote, regular, now);
  return lunch ? [...edges, edge(lunch[0]), opening(lunch[1])] : edges;
}

// The next turn of the row's own day (nextDayTurn). Never an opening: it only redraws.
function dayEdges(quote, now) {
  return [edge(nextDayTurn(quote, now))];
}

// A Taiwan row's next `closureDeadline` (from closureOf), where its closure may turn: an inference deadline or its
// mark's end.
const deadlineEdges = (quote) => (quote.closureDeadline ? [edge(quote.closureDeadline)] : []);

// Where a row's call auction can begin or end: the moment MIS's flag lapses, and for a Taiwan stock with a real-time
// source on, each auction window's start and end today and tomorrow, on trading weekdays.
// None while the row reads a closure: sessionOf reads the closure first, and the closure's end is an edge of its own.
// Never an opening: a call auction trades nothing, so these only redraw.
function auctionEdges(quote, now) {
  if (quote.closure) return [];
  const edges = quote.auctionAt === undefined ? [] : [edge(quote.auctionAt + LIVE_MAX_AGE_MS)];
  if (!quote.twRealtime) return edges;
  for (const at of [now, now + DAY_MS]) {
    if (!tradesOn(TWSE_HOURS, taipeiDay(at))) continue;
    for (const window of TW_AUCTIONS) edges.push(...auctionWindow(window, at).map(edge));
  }
  return edges;
}

// Every source of a row's edges; what a row reads changes only at one of them.
const EDGE_SOURCES = [sessionEdges, dayEdges, deadlineEdges, auctionEdges];

/**
 * The next moment after `now` at which `quote`'s row reads differently, or null. With `{ openings: true }`, only a
 * moment its market starts trading again; a listed closed day has none. Always later than `now`, so a wait cut at it
 * is never zero.
 */
export function nextEdge(quote, now, { openings = false } = {}) {
  let next = null;
  for (const source of EDGE_SOURCES) {
    for (const { at, opening: opens } of source(quote, now)) {
      if (opens && quote.closure?.kind === "listed") continue;
      if (at > now && (opens || !openings) && (next === null || at < next)) next = at;
    }
  }
  return next;
}

/** The detail's session key suffix: a trading future's "day" or "night", else `session` itself. */
export function sessionName(quote, session, now) {
  return (session === "open" && kindOf(quote.symbol) === "future" && futuresSegment(quote, now)) || session;
}

/**
 * A Taiwan or US quote's regular window from its exchange's hours on the exchange's date of `now`, whatever the
 * weekday, and whether that date is a trading weekday, as `{ regular, weekday }`. null for any other quote.
 */
export function hoursWindow(quote, now) {
  const market = resolvedMarket(quote.symbol, quote.exchange);
  const hours = market === "tw" ? TWSE_HOURS : market === "us" ? { ...US_HOURS, offsetMin: usOffsetMin(now) } : null;
  if (!hours) return null;
  return { regular: localWindow(hours, now), weekday: tradesOn(hours, localDay(hours.offsetMin, now)) };
}

/**
 * The session `quote` reads at `now`, first match wins:
 * - a pair: "24h";
 * - a Taiwan listed closed day: "holiday", whatever its periods say;
 * - a Taiwan day without trades, inferred: "noTrades" (a night without trades leaves a future "closed");
 * - in a call auction: "auction", unless the price is a delayed one from today;
 * - a future: "open" inside a segment, else "closed";
 * - without a regular period: by its exchange's hours for a Taiwan or US quote, "open" or "closed"; else "unknown";
 * - FX: by its week only, "closed" over the weekend and "open" otherwise;
 * - else from its periods: "pre", "open", "post" or "closed", and "lunch" inside its exchange's lunch break (Yahoo's
 *   regular period runs through it).
 */
export function sessionOf(quote, now) {
  if (isCryptoPair(quote.symbol)) return "24h";
  const closure = quote.closure?.kind;
  if (closure === "listed") return "holiday";
  if (closure === "noTrades") return "noTrades";
  if (auctionOf(quote, now)) {
    const delayedToday = !isRealtime(quote) && taipeiDay(quote.timestamp) === taipeiDay(now);
    if (!delayedToday) return "auction";
  }
  if (kindOf(quote.symbol) === "future") return futuresSegment(quote, now) ? "open" : "closed";
  if (!quote.periods?.regular) {
    const hours = hoursWindow(quote, now);
    if (!hours) return "unknown";
    const [start, end] = hours.regular;
    return hours.weekday && now >= start && now < end ? "open" : "closed";
  }
  if (exchangeRule(quote.exchange, quote.symbol).fx) return fxWeekend(now) ? "closed" : "open";
  const session = marketSession(quote, now);
  if (session !== "open") return session;
  // marketSession has read the regular period, so inside the lunch break is "lunch" wherever the break falls.
  const lunch = lunchWithin(quote, null, now);
  return lunch && now >= lunch[0] && now < lunch[1] ? "lunch" : "open";
}

const result = (state, delayMinutes = null, stoppedAt = null) => ({ state, delayMinutes, stoppedAt });

// Whether a price read by its exchange's hours (no periods, not a future) is from today's session and was already
// past its stale limit at the close. The hours say when the market closed, not when this feed stopped, so such a
// price is never taken for the close. A Taiwan stock's trading stops at 13:25, when the closing auction begins.
function stoppedBeforeClose(quote, twStock, now) {
  if (quote.periods?.regular || kindOf(quote.symbol) === "future") return false;
  const hours = hoursWindow(quote, now);
  if (!hours?.weekday || now < hours.regular[1]) return false;
  const limit = staleAfterMs(quote);
  if (limit === null) return false;
  const [start, end] = hours.regular;
  const close = twStock ? end - CLOSING_AUCTION_MS : end;
  return quote.timestamp >= start && quote.timestamp < close - limit;
}

// Whether a Taiwan stock's MIS price from today is timed before the closing auction, after 13:30. MIS's close always
// carries 13:30's time, so this is a stuck MIS cache that never sent the close, and must not pass for it.
function misMissedClose(quote, twStock, now) {
  if (quote.source !== "mis" || !twStock || taipeiMinute(now) < TWSE_HOURS.to) return false;
  const today = taipeiDay(now);
  return taipeiDay(quote.timestamp) === today && quote.timestamp < taipeiAt(today, TW_CLOSING_AUCTION.from);
}

// Sessions a quote reads as, never stale: the market is not trading, or a call auction is matching orders.
const PAUSED = new Set(["closed", "holiday", "noTrades", "pre", "post", "lunch", "auction"]);

/**
 * How long until a quote turns stale in `session`, in ms: at least 1 while it has not, 0 or less once it has (too old,
 * or a Yahoo Finance quote not fetched for FETCH_MAX_AGE_MS).
 * null when it never will this session: a delayed quote or a future outside the open session, a Yahoo future (`=F`),
 * or an exchange without a delay.
 * A real-time quote counts in every session: its moment is also when pickOverlay hands the row to another source, so
 * the idle wake must still land on it.
 */
export function msUntilStale(quote, session, now) {
  if (session !== "open" && (!isRealtime(quote) || kindOf(quote.symbol) === "future")) return null;
  const limit = staleAfterMs(quote);
  if (limit === null) return null;
  const left = limit - quoteAgeMs(quote, now) + 1;
  // A Yahoo quote's age stands still until its next fetch: once past its limit it stays stale, else only the fetch
  // guard can turn it. A previous close never stalls by age (beforeOpen), only by that guard. A cached quote's age
  // grows with now, as an overlay's does.
  if (quote.source !== "yahoo" || quote.cached || (left <= 0 && !beforeOpen(quote))) return left;
  return FETCH_MAX_AGE_MS - (now - fetchedAt(quote, now)) + 1;
}

/** The moment `quote` turns stale in `session`, or null when it never will or already has. */
export function staleAt(quote, session, now) {
  const left = msUntilStale(quote, session, now);
  return left !== null && left > 0 ? now + left : null;
}

/**
 * A quote's state, as `{ state, delayMinutes, stoppedAt }`:
 * - "live": real time, trading, at most LIVE_MAX_AGE_MS old (a time ahead of the clock counts as new) and not cached;
 * - "unconfirmed": real time in an "unknown" session, or a real-time Yahoo quote still at the previous close after
 *   today's open, until today's first trade or the fetch guard;
 * - "stalled": past its msUntilStale, real time or delayed; a cached real-time price at once;
 * - "delayed": any other quote, with its exchange's minutes when known;
 * - the session itself while the market is not trading (closed, holiday, noTrades, pre, post, lunch, auction). A
 *   "closed" read from the hours is "stalled" when the price had stalled before the close, or is a MIS price that
 *   never reached it.
 */
export function freshness(quote, session, now) {
  if (session === "closed") {
    const twStock = isTaiwanStock(quote);
    const stopped = stoppedBeforeClose(quote, twStock, now) || misMissedClose(quote, twStock, now);
    if (stopped) return result("stalled", null, quote.timestamp);
  }
  if (PAUSED.has(session)) return result(session);
  const realtime = isRealtime(quote);
  if (realtime && session === "unknown") return result("unconfirmed");
  const left = msUntilStale(quote, session, now);
  if (left !== null && left <= 0) return result("stalled", null, quote.timestamp);
  if (beforeOpen(quote)) return result("unconfirmed");
  if (!realtime) return result("delayed", delayMinutes(quote));
  // A cached price is no longer being refreshed, so its age says nothing about the feed. It reads stopped at its own
  // time from the first failure, instead of passing for live until the age limit.
  return quote.cached ? result("stalled", null, quote.timestamp) : result("live");
}

/** The states of a market closed for the rest of the day, whose row label carries its own date. */
const CLOSED_STATES = new Set(["closed", "holiday", "noTrades"]);

/**
 * The date a row adds after its state, for a quote from an earlier day. None on a live row, whose price is of this
 * moment (a quote stamped just before midnight must not read as yesterday's), and none after a closed label, which
 * carries its own date.
 */
export function rowDate(quote, fresh, now, lang) {
  return fresh.state === "live" || CLOSED_STATES.has(fresh.state) ? "" : formatStaleDate(quote, now, lang);
}

/**
 * The state the band's dot is drawn for at `now`: the row's freshness, except that an inferred day without trades
 * ("noTrades", which may be a stuck feed) draws the hollow stalled dot. The band shows no label, so no dot there would
 * pass for a closed market.
 */
export function bandState(quote, now) {
  const { state } = freshness(quote, sessionOf(quote, now), now);
  return state === "noTrades" ? "stalled" : state;
}

// After the close, how long a price still belongs to the session: 90 minutes, for TWSE's after-close fixed-price
// trades.
const AFTER_CLOSE_MS = 90 * MINUTE_MS;

/**
 * A quote's limit as drawn: "up", "down" or null (priceLimit), only while it still holds.
 * - Lit while live, and once the market is not open (closed, holiday, noTrades, post) for a price from the regular
 *   session its periods describe. A future's price belongs to its periods only up to their end; a stock's also
 *   through the after-close window.
 * - Lit in a call auction for a price from today; not for one from an earlier day (the morning's trial match).
 * - Never while stalled (the lock may have opened since), unconfirmed, or before the open. Yahoo gives Taiwan no
 *   pre-market period, so only the price's time tells a price at 08:45 apart.
 * - Never for a cached price: nothing confirms the lock still holds.
 */
export function shownLimit(quote, session, now) {
  if (quote.cached) return null;
  const { state } = freshness(quote, session, now);
  const regular = quote.periods?.regular;
  const end = regular && regular[1] + (kindOf(quote.symbol) === "future" ? 0 : AFTER_CLOSE_MS);
  const traded = Boolean(regular) && quote.timestamp >= regular[0] && quote.timestamp <= end;
  const closed = CLOSED_STATES.has(state) || state === "post";
  const heldToday = state === "auction" && taipeiDay(quote.tradeTime ?? quote.timestamp) === taipeiDay(now);
  return state === "live" || (closed && traded) || heldToday ? priceLimit(quote) : null;
}
