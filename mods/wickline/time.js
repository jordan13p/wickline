// Time on fixed-offset clocks: day numbers, weekdays, day starts, local windows, New York's offset.
// By hand, as QuickJS has no Intl.

// The UTC instant of the `nth` Sunday (1-based) of `month` (0-based, as Date.UTC) at `hourUtc`.
function nthSundayUtc(year, month, nth, hourUtc) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const date = 1 + ((7 - firstWeekday) % 7) + (nth - 1) * 7;
  return Date.UTC(year, month, date) + hourUtc * 60 * MINUTE_MS;
}

/**
 * New York's UTC offset in minutes at `ms`: -240 in daylight saving time, else -300. Daylight saving time runs from
 * 02:00 local on the second Sunday in March to 02:00 local on the first Sunday in November.
 */
export function usOffsetMin(ms) {
  const year = new Date(ms).getUTCFullYear();
  return ms >= nthSundayUtc(year, 2, 2, 7) && ms < nthSundayUtc(year, 10, 1, 6) ? -240 : -300;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The day number of `ms` on a clock at a fixed UTC offset of `offsetMin`. */
export const localDay = (offsetMin, ms) => Math.floor((ms + offsetMin * MINUTE_MS) / DAY_MS);

/** The weekday of a day number, Sunday 0. Day 0 (1 January 1970) was a Thursday. */
export const weekdayOf = (day) => (day + 4) % 7;

/** Whether an exchange's `hours` (with `weekdays`) trade on day number `day` of its clock, by weekday alone. */
export const tradesOn = (hours, day) => hours.weekdays.includes(weekdayOf(day));

/** The start of day number `day` on a clock at a fixed UTC offset of `offsetMin`, in ms. */
export const dayStart = (offsetMin, day) => day * DAY_MS - offsetMin * MINUTE_MS;

/**
 * A window of the local day around `now`, such as a lunch break or an exchange's hours, as [start, end) in ms.
 * Its from and to fields are local minutes since midnight.
 */
export function localWindow({ offsetMin, from, to }, now) {
  const start = dayStart(offsetMin, localDay(offsetMin, now));
  return [start + from * MINUTE_MS, start + to * MINUTE_MS];
}
