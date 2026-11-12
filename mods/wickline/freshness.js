// How fresh a quote is, as the view draws it: a filled dot only for a real-time price
// that is recent while its market trades; and when an open detail must redraw (detailWakeAt,
// followDetail). No Herdr imports, so tests run it under Node.
import { heldMarks, taipeiMinute } from "./calendar.js";
import { formatStaleDate, nextDayTurn, stateText } from "./format.js";
import {
  DAY_MS, DAY_SESSION, MINUTE_MS, NIGHT_SESSION, TAIFEX_HOURS, TWSE_HOURS, US_HOURS, dayStart, exchangeRule, kindOf, localDay,
  localWindow, resolvedMarket, tradesOn, usOffsetMin, weekdayOf,
} from "./markets.js";
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

// When a Yahoo Finance quote's age is taken: at its fetch, but now for a `cached` one (its last fetch failed,
// see Watchlist.shown), so cached data never looks fresh; the line's quote (chartQuote) carries the line's flag.
// One without a fetch time (every provider sets it) counts as fetched now, so its age still grows rather than
// reading NaN, which would never stall.
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

// The clock on which the FX weekend is whole days: UTC+2.
const FX_WEEK_OFFSET_MIN = 120;

// From Friday 22:00 to Sunday 22:00 UTC, when the FX week is over: two hours later (on a UTC+2 clock) it is
// Saturday or Sunday.
function fxWeekend(now) {
  const weekday = weekdayOf(localDay(FX_WEEK_OFFSET_MIN, now));
  return weekday === 6 || weekday === 0;
}

// TAIFEX's sessions as [start, end) in ms that open on the Taipei day of `now` or the day before (a night session
// still running past midnight), on the weekdays it trades.
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

// A quote whose night session is closed (see calendar.js closureOf): removed by a listed day, or without trades.
const nightClosed = (quote) => quote.closure?.kind === "nightRemoved" || quote.closure?.kind === "nightNoTrades";

/**
 * The session a future trades in at `now`: "day" or "night", or null between sessions. Its segments are
 * quote.periods.segments when given, else TAIFEX_HOURS around `now`; a closed night (nightClosed) is none of them. A
 * segment starting at or after 12:00 Taipei is the night session. A segment holds [start, end).
 */
export function futuresSegment(quote, now) {
  const segments = quote.periods?.segments ?? taifexSegments(now);
  const segment = segments.find((span) => now >= span[0] && now < span[1] && !(nightClosed(quote) && isNight(span)));
  if (!segment) return null;
  return isNight(segment) ? "night" : "day";
}

// The exchange's lunch break (exchangeRule(...).lunch) on the local day of `at`, as [start, end] in ms, when it falls
// strictly inside `regular` ([start, end]; null: wherever it falls); else null, also for an exchange without one.
function lunchWithin(quote, regular, at) {
  const { lunch } = exchangeRule(quote.exchange, quote.symbol);
  if (!lunch) return null;
  const [start, end] = localWindow(lunch, at);
  return !regular || (start > regular[0] && end < regular[1]) ? [start, end] : null;
}

const edge = (at) => ({ at, opening: false });
const opening = (at) => ({ at, opening: true });

// The next start after `now` of `weekday` (Sunday 0) on a clock at `offsetMin`: a week on when today is that weekday.
function nextDayStart(offsetMin, weekday, now) {
  const today = localDay(offsetMin, now);
  return dayStart(offsetMin, today + ((weekday - weekdayOf(today) + 7) % 7 || 7));
}

/**
 * The moments around `now` at which sessionOf can change for `quote`, along its own branches; an opening is a
 * moment the market starts trading again. A pair has none. A future: each segment's start (an opening) and end,
 * its line's and TAIFEX's table's both, since the row turns from the first to the second at its trading day's 15:00
 * (ownPeriods), a moment only the table holds.
 * Without a regular period: a Taiwan or US quote's hoursWindow on a trading weekday, its start an opening. FX: the
 * weekend's start and end (fxWeekend's Friday and Sunday 22:00 UTC; its periods, the UTC day, are not read), the
 * end an opening. Any other: its periods' pre, regular and post bounds, the regular start an opening, and its
 * exchange's lunch inside the regular period, the lunch's end an opening.
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

// The next turn of the row's own day (format.js nextDayTurn): Taipei midnight for a Taiwan row, else local midnight.
// Never an opening: it only redraws.
function dayEdges(quote, now) {
  return [edge(nextDayTurn(quote, now))];
}

// A Taiwan row's next inference deadline (`noTradesDeadline`, set by Watchlist#marked from calendar.js closureOf), where
// its closure may turn to "noTrades" or, for a future's night, to "nightNoTrades".
const deadlineEdges = (quote) => (quote.noTradesDeadline ? [edge(quote.noTradesDeadline)] : []);

// Every source of a row's edges: what it reads (sessionOf, its day) changes only at one of them.
const EDGE_SOURCES = [sessionEdges, dayEdges, deadlineEdges];

/**
 * The next moment after `now` at which `quote`'s row reads differently (EDGE_SOURCES), in ms, or null; with
 * `{ openings: true }`, only a moment its market starts trading again. A quote on a listed closed day (closure "listed")
 * has no opening from any source: its sessions that day never open. Always later than `now`, so a wait cut at it is
 * never zero.
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
 * A Taiwan or US quote's (resolvedMarket "tw" / "us") regular window from its exchange's hours, on the exchange's
 * date of `now` whatever the weekday, and whether that date is a trading weekday; null for any other quote.
 */
export function hoursWindow(quote, now) {
  const market = resolvedMarket(quote.symbol, quote.exchange);
  const hours = market === "tw" ? TWSE_HOURS : market === "us" ? { ...US_HOURS, offsetMin: usOffsetMin(now) } : null;
  if (!hours) return null;
  return { regular: localWindow(hours, now), weekday: tradesOn(hours, localDay(hours.offsetMin, now)) };
}

/**
 * The detail's 交易時段 for `quote` at `now`, as data (format.js writes it) tagged by `kind`; times in ms, regular
 * session only:
 * - "allDay" for a pair or FX (exchangeRule(...).fx; its regular period, the UTC day, is not shown);
 * - "closedToday" with the schedule's `reason` on a listed closed day (closure "listed");
 * - "noTradesToday" while a Taiwan quote reads as having no trades today (closure "noTrades");
 * - "futures" with `day` and `night` as [start, end] for a TAIFEX future, from TAIFEX_HOURS on the Taipei date of
 *   `now`; night null while it is closed (nightClosed), then `nightNoTrades` says whether it is for want of trades
 *   (closure "nightNoTrades") rather than removed;
 * - "spans" with `spans: [[start, end]]` from TWSE_HOURS (hoursWindow) for a Taiwan stock or index, whatever periods
 *   it carries (a TW-only index priced from an earlier day carries a zero-length period);
 * - "spans" with `spans: [[start, end], …]` from periods.regular (a `=F` future's as Yahoo gives it), else
 *   hoursWindow's, split around the exchange's lunch (exchangeRule(...).lunch, via localWindow taken at regular[0], so
 *   a Saturday detail with Friday's periods still splits) when it has one;
 * - null with nothing to show.
 */
export function sessionTimes(quote, now) {
  if (isCryptoPair(quote.symbol) || exchangeRule(quote.exchange, quote.symbol).fx) return { kind: "allDay" };
  const closure = quote.closure?.kind;
  if (closure === "listed") return { kind: "closedToday", reason: quote.closure.reason };
  if (closure === "noTrades") return { kind: "noTradesToday" };
  if (kindOf(quote.symbol) === "future") {
    const { offsetMin } = TAIFEX_HOURS;
    return {
      kind: "futures", day: localWindow({ offsetMin, ...DAY_SESSION }, now),
      night: nightClosed(quote) ? null : localWindow({ offsetMin, ...NIGHT_SESSION }, now), nightNoTrades: closure === "nightNoTrades",
    };
  }
  const spans = (list) => ({ kind: "spans", spans: list });
  if (resolvedMarket(quote.symbol, quote.exchange) === "tw") return spans([hoursWindow(quote, now).regular]);
  const regular = quote.periods?.regular ?? hoursWindow(quote, now)?.regular;
  if (!regular) return null;
  const [start, end] = regular;
  const lunch = lunchWithin(quote, regular, start);
  return spans(lunch ? [[start, lunch[0]], [lunch[1], end]] : [[start, end]]);
}

/**
 * "holiday" on a Taiwan quote's listed closed day (closure "listed", see calendar.js closureOf), whatever its periods
 * say; "noTrades" while it reads as having no trades today (closure "noTrades", an inference; a night without trades
 * after a traded day is "nightNoTrades" instead, so a future reads "closed" then). Else "open", "pre", "post" or "closed" from the
 * quote's trading periods, and "lunch" while open inside its
 * exchange's lunch break (Yahoo's regular period runs through it); FX reads its week only, "closed" over the weekend
 * and "open" otherwise, whatever its period says (the UTC day, not a session: its last minute is no close). A
 * pair trades "24h"; a future (WTX&) is "open" inside a segment (futuresSegment), else "closed", also with no
 * periods yet. A quote without a regular session (no Yahoo quote yet) reads its
 * exchange's hours (hoursWindow) when it is a Taiwan or US one, "open" or "closed"; any other is "unknown".
 */
export function sessionOf(quote, now) {
  if (isCryptoPair(quote.symbol)) return "24h";
  const closure = quote.closure?.kind;
  if (closure === "listed") return "holiday";
  if (closure === "noTrades") return "noTrades";
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
  // marketSession read the regular period already: inside the lunch break is "lunch", wherever the break falls.
  const lunch = lunchWithin(quote, null, now);
  return lunch && now >= lunch[0] && now < lunch[1] ? "lunch" : "open";
}

const result = (state, delayMinutes = null, stoppedAt = null) => ({ state, delayMinutes, stoppedAt });

// A price whose session sessionOf read from its exchange's hours (no periods; not a future) that is from today's
// session and was already past its stale limit at the close: the hours say the market closed, not when this feed
// stopped, so it stopped before the close and is never taken for it. From the next day's open window it is an earlier
// day's trade and reads closed with its date.
function stoppedBeforeClose(quote, now) {
  if (quote.periods?.regular || kindOf(quote.symbol) === "future") return false;
  const hours = hoursWindow(quote, now);
  const limit = staleAfterMs(quote);
  if (!hours?.weekday || limit === null) return false;
  const [start, end] = hours.regular;
  return now >= end && quote.timestamp >= start && quote.timestamp < end - limit;
}

// Sessions a quote reads as, never stale: the market is not trading (regular-session prices only).
const PAUSED = new Set(["closed", "holiday", "noTrades", "pre", "post", "lunch"]);

/**
 * How long until a quote turns stale in `session`, in ms: at least 1 while it has not yet, 0 or less once it
 * has (older than staleAfterMs by quoteAgeMs, or a Yahoo Finance quote not fetched for FETCH_MAX_AGE_MS).
 * null when it never will this session: a delayed quote's or a future's (WTX&) session is not open, or it is a
 * Yahoo future (`=F`) or from an exchange without a delay. A real-time quote counts in every session, also while
 * closed or "unknown": freshness reads it by its session then, but its moment is when pickOverlay (by the same
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
 * as new) and not cached (a kept price after a failed refresh reads stalled at once). unconfirmed: real time in
 * an "unknown" session (no periods, and no exchange hours to read), or a real-time Yahoo quote still at the
 * previous close after today's open (beforeOpen), until today's first trade or the fetch guard. stalled: past
 * its msUntilStale, real time or delayed. delayed: any other quote, with its exchange's minutes when the table
 * holds them; a Yahoo future (`=F`) or an exchange without a delay never stalls. closed / holiday / noTrades /
 * pre / post / lunch: the session, except a closed one read from the hours after a price that had stalled by the
 * close (stoppedBeforeClose): stalled.
 */
export function freshness(quote, session, now) {
  if (session === "closed" && stoppedBeforeClose(quote, now)) return result("stalled", null, quote.timestamp);
  if (PAUSED.has(session)) return result(session);
  const realtime = isRealtime(quote);
  if (realtime && session === "unknown") return result("unconfirmed");
  const left = msUntilStale(quote, session, now);
  if (left !== null && left <= 0) return result("stalled", null, quote.timestamp);
  if (beforeOpen(quote)) return result("unconfirmed");
  if (!realtime) return result("delayed", delayMinutes(quote));
  // A kept price is no longer being refreshed, so its age says nothing about whether the feed still runs: it stops
  // at its own time from the first failure instead of passing for live until the age limit.
  return quote.cached ? result("stalled", null, quote.timestamp) : result("live");
}

/** The states of a market closed for the rest of the day (a row's label carries its date): closed, 休市, 今日無成交. */
export const CLOSED_STATES = new Set(["closed", "holiday", "noTrades"]);

/**
 * The date a row adds after its state: none on a live row (its price is of this moment, and a quote stamped just
 * before local midnight must not read as yesterday's) and none after a closed label (which carries its own date);
 * any other quote from an earlier local day gets it.
 */
export function rowDate(quote, fresh, now, lang) {
  return fresh.state === "live" || CLOSED_STATES.has(fresh.state) ? "" : formatStaleDate(quote, now, lang);
}

/**
 * The state the band's dot is drawn for, at `now`: the row's freshness, except that a day without trades by inference
 * ("noTrades", which may be a stuck feed) draws the hollow stalled dot. The band shows no label, so no dot there would
 * pass for a closed market; a listed day ("holiday") draws none, as closed does.
 */
export function bandState(quote, now) {
  const { state } = freshness(quote, sessionOf(quote, now), now);
  return state === "noTrades" ? "stalled" : state;
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
 * a future's price belongs to its periods only up to their end. A listed closed day ("holiday") and a day without
 * trades ("noTrades") count as closed.
 */
export function shownLimit(quote, session, now) {
  const { state } = freshness(quote, session, now);
  const regular = quote.periods?.regular;
  const end = regular && regular[1] + (kindOf(quote.symbol) === "future" ? 0 : AFTER_CLOSE_MS);
  const traded = Boolean(regular) && quote.timestamp >= regular[0] && quote.timestamp <= end;
  const closed = CLOSED_STATES.has(state) || state === "post";
  return state === "live" || (closed && traded) ? priceLimit(quote) : null;
}

// A delayed quote's lateness in words: its exchange's minutes, else that the delay is not provided.
function delayWords(quote, tx) {
  const late = delayMinutes(quote);
  return late === null ? tx("freshness.delayUnknown") : tx("freshness.delayedMinutes", { minutes: late });
}

// A detail line's keys: with a state, and for the source alone when the state has no word (unconfirmed).
const PRICE_KEYS = { from: "detail.priceFrom", alone: "detail.priceSource" };
const LINE_KEYS = { from: "detail.lineFrom", alone: "detail.lineSource" };
const sourceText = (keys, state, source, tx) => (state === null ? tx(keys.alone, { source }) : tx(keys.from, { state, source }));

/** A row's line as a quote of its own source: its times and cached flag (`chartCached`), not the price's. */
export function chartQuote(quote) {
  return {
    ...quote, source: quote.chartSource, timestamp: quote.chartTimestamp, fetchedAt: quote.chartFetchedAt,
    cached: quote.chartCached,
  };
}

// The open detail sleeps at most this long at a time, then rereads the clock: a machine that slept, or a clock that
// moved, costs at most this much lateness.
export const DETAIL_WAKE_CAP_MS = 600_000;

/**
 * The next moment after `now` at which the open detail of `quote` (already heldMarks at `now`) can read differently,
 * in ms, or null: the earliest of its row's next edge (nextEdge), its price's stale moment (msUntilStale, in the
 * session it reads), its line's when the line is another source's real-time quote (chartQuote), and its mark's end
 * (`closureUntil`). Each counts only when strictly later than `now`, so a wait cut at it is never zero.
 */
export function detailWakeAt(quote, now) {
  const session = sessionOf(quote, now);
  const staleAt = (q) => {
    const left = msUntilStale(q, session, now);
    return left !== null && left > 0 ? now + left : null;
  };
  const moments = [nextEdge(quote, now), staleAt(quote)];
  if (quote.chartSource && quote.chartSource !== quote.source) {
    const chart = chartQuote(quote);
    if (isRealtime(chart)) moments.push(staleAt(chart));
  }
  if (quote.closureUntil != null) moments.push(quote.closureUntil);
  const ahead = moments.filter((at) => at !== null && at > now);
  return ahead.length ? Math.min(...ahead) : null;
}

/**
 * The open detail's one task: a data timer, not animation. It fetches nothing; one wake at a time, it sleeps to the
 * quote's next reading change (detailWakeAt, from its marks as held then), at most DETAIL_WAKE_CAP_MS per sleep before
 * it rereads the clock, and calls `changed()` (a redraw) only once a wake is reached, so a wake hours away costs one
 * redraw. It returns when nothing is ahead. The copy's `cx` ends it: a cancelled sleep rejects, and so does this.
 */
export async function followDetail(detail, { now, sleep, changed }) {
  for (;;) {
    const time = now();
    const wake = detailWakeAt(heldMarks(detail, time), time);
    if (wake === null) return;
    await sleep(Math.min(wake - time, DETAIL_WAKE_CAP_MS));
    if (now() >= wake) changed();
  }
}

/**
 * The detail dialog's sources as lines, each a list of parts (joined with ` · `). A real-time price
 * names its state and source on one line: `Price: Live · TWSE MIS`, or its source alone while unconfirmed
 * (`Price: Yahoo Finance`); its line follows on its own, as the same state when the line is the price's own
 * source (Yahoo 奇摩股市), else as the line's own quote reads (`chartTimestamp`, `chartFetchedAt`; see
 * mergeOverlay): its state when that source is real time (stalled once that quote is, its source alone while
 * unconfirmed), else its exchange's delay: `Line: delayed 20 min · Yahoo Finance`. A delayed stock keeps its
 * plain wording as one line of two parts, with its exchange's delay in every session; a pair is one part.
 * `tx(key, params)` translates; a `src.<id>` key names a provider.
 */
export function detailSource(quote, session, now, tx) {
  if (isRealtime(quote) && !isCryptoPair(quote.symbol)) {
    const own = stateText(freshness(quote, session, now), tx);
    const price = sourceText(PRICE_KEYS, own, tx(`src.${quote.source}`), tx);
    if (!quote.chartSource) return [[price]];
    if (quote.chartSource === quote.source) return [[price], [sourceText(LINE_KEYS, own, tx(`src.${quote.source}`), tx)]];
    const chart = chartQuote(quote);
    const state = isRealtime(chart) ? stateText(freshness(chart, session, now), tx) : delayWords(chart, tx);
    return [[price], [sourceText(LINE_KEYS, state, tx(`src.${quote.chartSource}`), tx)]];
  }
  if (isCryptoPair(quote.symbol)) return [[tx("detail.sourceCrypto")]];
  return [[tx("detail.sourceStock"), delayWords(quote, tx)]];
}
