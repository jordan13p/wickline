// Days in Taipei: the calendar day, a future's trading day, and the days TWSE lists as closed, for every module that
// needs one. No Herdr imports.
import { NIGHT_SESSION, TAIFEX_HOURS, kindOf } from "./markets.js";
import { cleanText } from "./quotes.js";
import { DAY_MS, MINUTE_MS, dayStart, localDay, tradesOn } from "./time.js";

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

export const isWeekday = (day) => tradesOn(TAIFEX_HOURS, day);
/** Minutes since Taipei midnight of a time in ms. */
export const taipeiMinute = (ms) =>
  Math.floor((ms - taipeiDay(ms) * DAY_MS + TAIFEX_HOURS.offsetMin * MINUTE_MS) / MINUTE_MS);
/** `minute` (Taipei, since midnight) of Taipei day `day`, in ms. */
export const taipeiAt = (day, minute) => dayStart(TAIFEX_HOURS.offsetMin, day) + minute * MINUTE_MS;
/** The Taipei midnight after `now`, in ms. */
export const nextTaipeiMidnight = (now) => taipeiAt(taipeiDay(now) + 1, 0);

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
