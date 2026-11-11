// Days in Taipei: the calendar day and a future's trading day, for every module that needs one. No Herdr imports.
import { MINUTE_MS, TAIFEX_HOURS, kindOf, localDay, weekdayOf } from "./markets.js";

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
