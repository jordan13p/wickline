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

/**
 * The closed-day marks of a Taiwan `market` ("stock" | "future") at `now`: the one place a quote's closure is decided.
 * `listed(day)` gives the schedule's reason or null; `seen(market, open)` the observation of that market's session
 * that opened at `open` ({ traded }), or undefined. Taking the market lets a later rule read the other one.
 * A trade seen since the current session's open comes first and clears every mark, the removed night's included.
 * Then, T being today in Taipei:
 * - a stock on a listed T, all day: closedDay;
 * - a future from 00:00 to 05:00: after an unlisted weekday nothing (its night session runs to 05:00); else
 *   (T-1 listed, so its night is removed, or not a weekday) closedDay on a listed T, else nightClosed after a listed
 *   T-1, else nothing;
 * - a future from 05:00 on a listed T: closedDay;
 * - otherwise nothing.
 */
export function closureOf(market, now, listed, seen) {
  const open = currentOpen(market, now);
  if (open !== null && seen(market, open)?.traded) return {};
  const today = taipeiDay(now);
  const reason = listed(today);
  const listedToday = reason ? { closedDay: { reason } } : {};
  if (market !== "future" || taipeiMinute(now) >= NIGHT_END_MIN) return listedToday;
  const before = today - 1;
  if (isWeekday(before) && !listed(before)) return {};
  return reason ? listedToday : isWeekday(before) ? { nightClosed: true } : {};
}
