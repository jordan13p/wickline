// Days in Taipei: the calendar day, a future's trading day, and the days TWSE lists as closed, for every module that
// needs one. No Herdr imports.
import { DAY_MS, MINUTE_MS, TAIFEX_HOURS, TWSE_HOURS, kindOf, localDay, weekdayOf } from "./markets.js";
import { cleanText } from "./quotes.js";

// The open of the TAIFEX session that runs past midnight (the night's, 15:00) is the next day's 00:00 once this is
// added.
const NIGHT_TO_NEXT_DAY_MS = (24 * 60 - TAIFEX_HOURS.sessions.find(({ to }) => to > 24 * 60).from) * MINUTE_MS;

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
  while (!TAIFEX_HOURS.weekdays.includes(weekdayOf(day))) day++;
  return day;
}

/** A symbol's trading day of a time in ms, its kind read once: for a decoder that asks it for many times. */
export const dayOf = (symbol) => (kindOf(symbol) === "future" ? futuresDay : taipeiDay);

// TWSE's published holiday schedule (open data, GET, no key).
export const HOLIDAYS_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule";
// The Republic of China's year 1 is 1912.
const ROC_YEAR_OFFSET = 1911;
// A schedule row whose name ends so is a notice of a trading day (國曆新年開始交易日, 農曆春節前最後交易日), not a closure.
const TRADING_DAY_NOTICE = "交易日";

const [DAY_SESSION, NIGHT_SESSION] = TAIFEX_HOURS.sessions;
// When the night session running past midnight ends, in Taipei minutes since midnight (05:00).
const NIGHT_END_MIN = NIGHT_SESSION.to - 24 * 60;

const isWeekday = (day) => TAIFEX_HOURS.weekdays.includes(weekdayOf(day));
// Minutes since Taipei midnight of a time in ms.
const taipeiMinute = (ms) => Math.floor((ms - taipeiDay(ms) * DAY_MS + TAIFEX_HOURS.offsetMin * MINUTE_MS) / MINUTE_MS);
// `minute` (Taipei, since midnight) of Taipei day `day`, in ms.
const taipeiAt = (day, minute) => day * DAY_MS + (minute - TAIFEX_HOURS.offsetMin) * MINUTE_MS;

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
 * The schedule's closed weekdays, Taipei day number → its name (cleanText, as given). A row whose name ends in 交易日
 * is a notice and is left out; so is a Saturday or Sunday date, and a row without a valid date or name. Any other
 * name is a closure (市場無交易，僅辦理結算交割作業 included). null when `text` is not a JSON array.
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
    const name = cleanText(row?.Name);
    const day = rocDay(row?.Date);
    if (name && day !== null && !name.endsWith(TRADING_DAY_NOTICE) && isWeekday(day)) days[day] = name;
  }
  return days;
}

/**
 * The open (ms) of the session of `market` that `now` belongs to, or null: "stock" 09:00 Taipei on a weekday
 * from 09:00 to midnight; "future" 08:45 from 08:45 to 15:00, 15:00 from 15:00 to midnight, and the day before's
 * 15:00 from 00:00 to 05:00 — each only when the session's own date is a weekday.
 */
export function currentOpen(market, now) {
  const today = taipeiDay(now);
  const minute = taipeiMinute(now);
  const open = (day, from) => (isWeekday(day) ? taipeiAt(day, from) : null);
  if (market === "stock") return minute >= TWSE_HOURS.from ? open(today, TWSE_HOURS.from) : null;
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

// Each kind of answer in an observation, in the order that names a closure, with its deadline after the open.
const INFER_DEADLINES = [["realtime", INFER_REALTIME_MS], ["delayed", INFER_DELAYED_MS]];

/**
 * The answer that lets the session opened at `open` read as having no trades at `now`, or null: none once it traded;
 * else the first answer (the real-time list first, each list in its own order) that is recent at its kind's deadline
 * while `now` is at or past that deadline (see INFER_RECENT_MS).
 */
function quietAnswer(observation, open, now) {
  if (!observation || observation.traded) return null;
  for (const [kind, after] of INFER_DEADLINES) {
    const deadline = open + after;
    const answer = now >= deadline && observation[kind].find(({ at }) => at >= deadline - INFER_RECENT_MS);
    if (answer) return answer;
  }
  return null;
}

/**
 * The next inference deadline after `now` of `market`'s current session (currentOpen), or null: the open plus a
 * kind's delay, for each kind with an answer (`seen`, as closureOf reads it), while the session has no trade.
 */
export function deadlineOf(market, now, seen) {
  const open = currentOpen(market, now);
  const observation = open === null ? undefined : seen(market, open);
  if (!observation || observation.traded) return null;
  const ahead = INFER_DEADLINES.filter(([kind, after]) => observation[kind].length && open + after > now)
    .map(([, after]) => open + after);
  return ahead.length ? Math.min(...ahead) : null;
}

/**
 * The closure of a Taiwan `market` ("stock" | "future") at `now`: the one place a quote's closure is decided, as one
 * value, null or `{ kind, reason?, source? }`:
 * - "listed": a day the schedule lists (`reason`, its name);
 * - "noTrades": a day without trades, inferred (`source`, the source of the answer that counts);
 * - "nightRemoved": a night a listed day removed;
 * - "nightNoTrades": a night without trades after a day that traded, inferred (`source` as above).
 * `listed(day)` gives the schedule's reason or null; `seen(market, open)` the observation of that market's session that
 * opened at `open`, or undefined: `{ traded, newest, realtime, delayed }`, whether a trade came at or after the open,
 * the newest trade time the answers carried, and each source's latest answer since the open by kind
 * (`[{ at, source }]`, in the order that names a closure). A trade seen since the current session's open comes first
 * and clears every closure, the removed night's included. Then the first matching row, T being today in Taipei:
 * 1. a stock on a listed T: listed;
 * 2. a stock from 09:00 on a weekday T, its session quiet (quietAnswer) and no future traded since 08:45 T (the veto):
 *    noTrades;
 * 3–5. a future from 00:00 to 05:00: after a T-1 that is not a weekday, listed on a listed T, else none; after a
 *    listed T-1 (its night removed), listed on a listed T, else nightRemoved; after an unlisted weekday, only with
 *    the night of T-1 quiet: listed on a listed T, else the night's reading of T-1 (below);
 * 6. a future from 05:00 on a listed T: listed;
 * 7. a future from 08:45 to 15:00 on a weekday T, its day session quiet and no stock traded since 09:00 T: noTrades;
 * 8. a future from 15:00 on a weekday T, its night session quiet: the night's reading of T;
 * 8b. else, while T has not traded, its day session's reading carries on: noTrades;
 * 9. otherwise none.
 * A night's reading of day D: after a day that traded (its day session, the night's newest trade since 08:45 D, or a
 * stock since 09:00 D), the night is closed and says it has no trades yet (nightNoTrades); after a day without trades,
 * the whole day has none (noTrades).
 */
export function closureOf(market, now, listed, seen) {
  const open = currentOpen(market, now);
  if (open !== null && seen(market, open)?.traded) return null;
  const today = taipeiDay(now);
  const minute = taipeiMinute(now);
  const reason = listed(today);
  const closedToday = reason ? { kind: "listed", reason } : null;
  // The source that says the session of `market` that opened at `start` has no trade, or null.
  const quietSince = (start) => quietAnswer(seen(market, start), start, now)?.source ?? null;
  const tradedSince = (other, start) => Boolean(seen(other, start)?.traded);
  const dayOpen = (day) => taipeiAt(day, DAY_SESSION.from);
  const dayTraded = (day) => tradedSince("future", dayOpen(day))
    || seen("future", taipeiAt(day, NIGHT_SESSION.from))?.newest >= dayOpen(day)
    || tradedSince("stock", taipeiAt(day, TWSE_HOURS.from));
  const noTrades = (source) => ({ kind: "noTrades", source });
  const nightReading = (day, source) => (dayTraded(day) ? { kind: "nightNoTrades", source } : noTrades(source));
  if (market === "stock") {
    if (closedToday) return closedToday;                                                     // 1
    const source = open !== null && !tradedSince("future", dayOpen(today)) && quietSince(open);
    return source ? noTrades(source) : null;                                                 // 2, else 9
  }
  if (minute < NIGHT_END_MIN) {
    const before = today - 1;
    if (!isWeekday(before)) return closedToday ?? null;                                      // 5
    if (listed(before)) return closedToday ?? { kind: "nightRemoved" };                      // 3
    const source = quietSince(open);
    return source ? closedToday ?? nightReading(before, source) : null;                      // 4, else 9
  }
  if (closedToday) return closedToday;                                                       // 6
  if (open === null) return null;                                                            // 9
  if (minute < NIGHT_SESSION.from) {
    const source = !tradedSince("stock", taipeiAt(today, TWSE_HOURS.from)) && quietSince(open);
    return source ? noTrades(source) : null;                                                 // 7, else 9
  }
  const night = quietSince(open);
  if (night) return nightReading(today, night);                                              // 8
  const day = !dayTraded(today) && quietSince(dayOpen(today));
  return day ? noTrades(day) : null;                                                         // 8b, else 9
}
