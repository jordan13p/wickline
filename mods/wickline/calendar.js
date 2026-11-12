// Days in Taipei: the calendar day, a future's trading day, and the days TWSE lists as closed, for every module that
// needs one. No Herdr imports.
import {
  DAY_MS, DAY_SESSION, MINUTE_MS, NIGHT_SESSION, TAIFEX_HOURS, TWSE_HOURS, dayStart, kindOf, localDay, tradesOn,
} from "./markets.js";
import { cleanText } from "./quotes.js";

// The open of the TAIFEX session that runs past midnight (the night's, 15:00) is the next day's 00:00 once this is
// added.
const NIGHT_TO_NEXT_DAY_MS = (24 * 60 - NIGHT_SESSION.from) * MINUTE_MS;

/** The day number in Taipei (UTC+8, no daylight saving; Taipei's clock is TAIFEX's) of a time in ms. */
export const taipeiDay = (ms) => localDay(TAIFEX_HOURS.offsetMin, ms);

/**
 * A symbol's trading day number. A future's starts at 15:00 Taipei and belongs to the next trading weekday:
 * taipeiDay(ms + 9 h), moved past the days TAIFEX does not trade (a Saturday or a Sunday) to the Monday after, so
 * Friday's night session (Saturday 00:00–05:00 included) is Monday's. Holidays are not known. Any other symbol's is
 * its Taipei day.
 */
export function tradingDay(symbol, ms) {
  return dayOf(symbol)(ms);
}

/** A future's trading day (see tradingDay). */
export function futuresDay(ms) {
  let day = taipeiDay(ms + NIGHT_TO_NEXT_DAY_MS);
  while (!tradesOn(TAIFEX_HOURS, day)) day++;
  return day;
}

/** A symbol's trading day of a time in ms, its kind read once: for a decoder that asks it for many times. */
export const dayOf = (symbol) => (kindOf(symbol) === "future" ? futuresDay : taipeiDay);

// TWSE's published holiday schedule (open data, GET, no key).
export const HOLIDAYS_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule";
// The Republic of China's year 1 is 1912.
const ROC_YEAR_OFFSET = 1911;
// A schedule row whose name says so is a notice of a trading day (國曆新年開始交易日, 農曆春節前最後交易日, 農曆春節後開始交易日
// in 2024 and 2026), not a closure. Loose on purpose: a closure taken for a notice falls back to inference, which
// shows, while a notice taken for a closure hides a trading morning.
const TRADING_DAY_NOTICE = /交易日|開始交易|最後交易/;

// When the night session running past midnight ends, in Taipei minutes since midnight (05:00).
const NIGHT_END_MIN = NIGHT_SESSION.to - 24 * 60;

const isWeekday = (day) => tradesOn(TAIFEX_HOURS, day);
/** Minutes since Taipei midnight of a time in ms. */
export const taipeiMinute = (ms) => Math.floor((ms - taipeiDay(ms) * DAY_MS + TAIFEX_HOURS.offsetMin * MINUTE_MS) / MINUTE_MS);
/** `minute` (Taipei, since midnight) of Taipei day `day`, in ms. */
export const taipeiAt = (day, minute) => dayStart(TAIFEX_HOURS.offsetMin, day) + minute * MINUTE_MS;

/** A ROC date ("1151225": year 115 + 1911, month, day) as a Taipei day number; null when malformed. */
export function rocDay(value) {
  const match = typeof value === "string" ? value.match(/^(\d{3})(\d{2})(\d{2})$/) : null;
  if (!match) return null;
  const [year, month, date] = [Number(match[1]) + ROC_YEAR_OFFSET, Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, date);
  const back = new Date(ms);
  return back.getUTCMonth() === month - 1 && back.getUTCDate() === date ? ms / DAY_MS : null;
}

/**
 * The schedule's closed weekdays, Taipei day number → its name (cleanText, trimmed). A row whose name holds 交易日,
 * 開始交易 or 最後交易 (TRADING_DAY_NOTICE) is a notice and is left out; so is a Saturday or Sunday date, and a row
 * without a valid date or name. Any other name is a closure (市場無交易，僅辦理結算交割作業 included). null when `text` is
 * not a JSON array.
 */
export function parseHolidays(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const days = {};
  for (const row of rows) {
    const name = cleanText(row?.Name)?.trim();
    const day = rocDay(row?.Date);
    if (name && day !== null && !TRADING_DAY_NOTICE.test(name) && isWeekday(day)) days[day] = name;
  }
  return days;
}

// The calendar year of a Taipei day number.
const yearOf = (day) => new Date(day * DAY_MS).getUTCFullYear();

/**
 * Whether `days` (parseHolidays) list a closed weekday of the Taipei year of `now`. A list without one (empty, or only
 * another year's) is no schedule for this year: TWSE closes some weekdays every year.
 */
export function listsYearOf(days, now) {
  const year = yearOf(taipeiDay(now));
  return Object.keys(days).some((day) => yearOf(Number(day)) === year);
}

/**
 * The open (ms) of the session of `market` that `now` belongs to, or null: "stock" 09:00 Taipei on a weekday
 * from 09:00 to midnight; "future" 08:45 from 08:45 to 15:00, 15:00 from 15:00 to midnight, and the day before's
 * 15:00 from 00:00 to 05:00 — each only when the session's own date is a weekday.
 */
export function currentOpen(market, now) {
  const today = taipeiDay(now);
  const minute = taipeiMinute(now);
  const open = (day, from, hours = TAIFEX_HOURS) => (tradesOn(hours, day) ? taipeiAt(day, from) : null);
  if (market === "stock") return minute >= TWSE_HOURS.from ? open(today, TWSE_HOURS.from, TWSE_HOURS) : null;
  if (minute >= NIGHT_SESSION.from) return open(today, NIGHT_SESSION.from);
  if (minute >= DAY_SESSION.from) return open(today, DAY_SESSION.from);
  return minute < NIGHT_END_MIN ? open(today - 1, NIGHT_SESSION.from) : null;
}

// A session with answers but no trade since its open reads as having none (今日無成交, never 休市: the answers cannot tell
// a closed market from a stuck feed) from its open + INFER_REALTIME_MS with an answer from a real-time source, or
// + INFER_DELAYED_MS with one from Yahoo Finance (20 minutes late). A deadline counts only with that kind's latest answer
// at or after it − INFER_RECENT_MS, so a source that answered once near the open and then went quiet never does.
export const INFER_REALTIME_MS = 600_000;
export const INFER_DELAYED_MS = 1_800_000;
export const INFER_RECENT_MS = 120_000;

// An answer's deadline after the open, by whether its source is real time.
const INFER_DEADLINES = new Map([[true, INFER_REALTIME_MS], [false, INFER_DELAYED_MS]]);

// The answers that may yet name a closure of a session: none once it traded (see closureOf).
const quietAnswers = (observation) => (!observation || observation.traded ? [] : observation.answers);

/** The Taiwan market a symbol trades in, as closureOf names it: TAIFEX's futures, else TWSE/TPEx's stocks and indices. */
export const twMarket = (symbol) => (kindOf(symbol) === "future" ? "future" : "stock");

/**
 * What a Taiwan `market` ("stock" | "future") reads at `now`, from one observation of its current session (currentOpen):
 * `{ closure, deadline, until }`, its closure and when that reading ends without a new answer (closureRule; both null
 * once a trade came since that session's open, which clears every closure, the removed night's included), and the next
 * moment the reading can change: the earliest of that session's inference deadlines (see INFER_REALTIME_MS) and `until`.
 * `listed` and `seen` as closureRule reads them.
 */
export function closureOf(market, now, listed, seen) {
  const open = currentOpen(market, now);
  const observation = open === null ? undefined : seen(market, open);
  const { closure, until } = observation?.traded ? { closure: null, until: null } : closureRule(market, now, open, listed, seen);
  // The open plus an answer's delay, for each answer, while the session has no trade; and the mark's end, which no
  // answer of its own announces.
  const ahead = quietAnswers(observation).map(({ realtime }) => open + INFER_DEADLINES.get(realtime)).filter((at) => at > now);
  if (until !== null && until > now) ahead.push(until);
  return { closure, deadline: ahead.length ? Math.min(...ahead) : null, until };
}

/**
 * `quote` with its Taiwan market's reading (closureOf): `closure`, the deadline as `noTradesDeadline` (freshness.js
 * nextEdge wakes the row there) and the mark's end as `closureUntil` (heldMarks: the open detail, which fetches nothing
 * and so never learns a new reading, drops the mark there), each when there is one.
 */
export const withClosure = (quote, { closure, deadline, until }) => ({
  ...quote, closure, ...(deadline !== null && { noTradesDeadline: deadline }), ...(until !== null && { closureUntil: until }),
});

/**
 * `quote` as the open detail reads it at `now`: itself while its mark holds (`closureUntil` unset, or still ahead);
 * from that moment a copy without the mark (`closure` and `closureUntil` null, no `noTradesDeadline`), so the detail
 * reads its session from its periods and TAIFEX's table again rather than a closure that is over.
 */
export function heldMarks(quote, now) {
  if (quote.closureUntil == null || now < quote.closureUntil) return quote;
  const { noTradesDeadline: _deadline, ...rest } = quote;
  return { ...rest, closure: null, closureUntil: null };
}

/**
 * The closure of a Taiwan `market` at `now` while its current session (opened at `open`, or null) has not traded: the
 * one place a quote's closure is decided, as `{ closure, until }`: `closure` one value, null or `{ kind, reason?, source? }`,
 * `until` the moment that reading ends when no new answer arrives (null without a closure):
 * - "listed": a day the schedule lists (`reason`, its name);
 * - "noTrades": a day without trades, inferred (`source`, the source of the answer that counts);
 * - "nightRemoved": a night a listed day removed;
 * - "nightNoTrades": a night without trades after a day that traded, inferred (`source` as above).
 * `listed(day)` gives the schedule's reason or null; `seen(market, open)` the observation of that market's session that
 * opened at `open`, or undefined: `{ traded, newest, answers }`, whether a trade came at or after the open, the newest
 * trade time the answers carried, and each source's latest answer since the open, `[{ at, source, realtime }]`, in the
 * order that names a closure (real-time sources first). The first matching row, T being today in Taipei:
 * 1. a stock on a listed T: listed;
 * 2. a stock from 09:00 on a weekday T, its session quiet (quietSince) and T not traded (the veto: dayTraded, so a
 *    futures trade since 08:45 T, the night's answers' included): noTrades;
 * 3–5. a future from 00:00 to 05:00: after a T-1 that is not a weekday, listed on a listed T, else none; after a
 *    listed T-1 (its night removed), listed on a listed T, else nightRemoved; after an unlisted weekday, only with
 *    the night of T-1 quiet: listed on a listed T, else the night's reading of T-1 (below);
 * 6. a future from 05:00 on a listed T: listed;
 * 7. a future from 08:45 to 15:00 on a weekday T, its day session quiet and no stock traded since 09:00 T: noTrades;
 * 8. a future from 15:00 on a weekday T, its night session quiet: the night's reading of T;
 * 8b. else, until the night's deadline (its open + INFER_REALTIME_MS: only real-time sources price futures) and while
 *    T has not traded, its day session's reading carries on: noTrades (after it, a night source that went quiet
 *    leaves the existing reading); the reading ends at that cap (15:10:00) with no night answer at all;
 * 9. otherwise none.
 * Each reading's end: a stock's, and any listed day's, the next 00:00 (it lasts the Taipei day); a future's read
 * before 05:00, 05:00 (the night's end); its day's (7, 8b), the cap at 15:10; its night's from 15:10 (8), the next 05:00.
 * A night's reading of day D: after a day that traded (its day session, the night's newest trade since 08:45 D, or a
 * stock since 09:00 D), the night is closed and says it has no trades yet (nightNoTrades); after a day without trades,
 * the whole day has none (noTrades).
 */
function closureRule(market, now, open, listed, seen) {
  const today = taipeiDay(now);
  const before = today - 1;
  const minute = taipeiMinute(now);
  const reason = listed(today);
  // The source that says the session of `market` that opened at `start` has no trade, or null: the first answer that is
  // recent (INFER_RECENT_MS) at its deadline while `now` is at or past it.
  const quietSince = (start) => quietAnswers(seen(market, start)).find(({ at, realtime }) => {
    const deadline = start + INFER_DEADLINES.get(realtime);
    return now >= deadline && at >= deadline - INFER_RECENT_MS;
  })?.source ?? null;
  const tradedSince = (other, start) => Boolean(seen(other, start)?.traded);
  const dayOpen = (day) => taipeiAt(day, DAY_SESSION.from);
  const dayTraded = (day) => tradedSince("future", dayOpen(day))
    || seen("future", taipeiAt(day, NIGHT_SESSION.from))?.newest >= dayOpen(day)
    || tradedSince("stock", taipeiAt(day, TWSE_HOURS.from));
  // Where each row's reading ends (see above); the cap is the night's deadline (its open + INFER_REALTIME_MS: only
  // real-time sources price futures).
  const midnight = taipeiAt(today + 1, 0);
  const nightEnd = taipeiAt(today, NIGHT_END_MIN);
  const cap = taipeiAt(today, NIGHT_SESSION.from) + INFER_REALTIME_MS;
  const ruled = (closure, until) => ({ closure, until: closure ? until : null });
  const noTrades = (source) => ({ kind: "noTrades", source });
  const nightReading = (day, source) => (dayTraded(day) ? { kind: "nightNoTrades", source } : noTrades(source));
  // From 00:00 to 05:00, the night of an unlisted weekday T-1 runs on: until it reads quiet, not even a listed T
  // closes it.
  const runningNight = market === "future" && minute < NIGHT_END_MIN && isWeekday(before) && !listed(before);
  const nightSource = runningNight ? quietSince(open) : null;
  if (runningNight && !nightSource) return ruled(null);                                       // 4, else 9
  if (reason) return ruled({ kind: "listed", reason }, midnight);                             // 1, 3–5, 6
  if (market === "stock") {
    const source = open !== null && !dayTraded(today) && quietSince(open);
    return ruled(source ? noTrades(source) : null, midnight);                                 // 2, else 9
  }
  if (minute < NIGHT_END_MIN) {
    if (runningNight) return ruled(nightReading(before, nightSource), nightEnd);              // 4
    return ruled(isWeekday(before) ? { kind: "nightRemoved" } : null, nightEnd);              // 3, 5
  }
  if (open === null) return ruled(null);                                                      // 9
  if (minute < NIGHT_SESSION.from) {
    const source = !dayTraded(today) && quietSince(open);
    return ruled(source ? noTrades(source) : null, cap);                                      // 7, else 9
  }
  const night = quietSince(open);
  if (night) return ruled(nightReading(today, night), taipeiAt(today + 1, NIGHT_END_MIN));    // 8
  const day = now < cap && !dayTraded(today) && quietSince(dayOpen(today));
  return ruled(day ? noTrades(day) : null, cap);                                              // 8b, else 9
}
