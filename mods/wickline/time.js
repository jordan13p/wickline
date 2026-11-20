// Time on fixed-offset clocks: day numbers, weekdays, day starts, local windows, New York's offset. No Herdr imports.

// The UTC instant of the `nth` Sunday (1-based) of `month` (0-based, as Date.UTC) at `hourUtc`.
function nthSundayUtc(year, month, nth, hourUtc) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const date = 1 + ((7 - firstWeekday) % 7) + (nth - 1) * 7;
  return Date.UTC(year, month, date) + hourUtc * 60 * MINUTE_MS;
}

/**
 * New York's UTC offset at `ms`: -240 from the second Sunday in March 07:00 UTC to the first Sunday in November
 * 06:00 UTC (02:00 local both times), else -300. By hand: QuickJS has no Intl.
 */
export function usOffsetMin(ms) {
  const year = new Date(ms).getUTCFullYear();
  return ms >= nthSundayUtc(year, 2, 2, 7) && ms < nthSundayUtc(year, 10, 1, 6) ? -240 : -300;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The day number of `ms` on a clock at a fixed UTC offset of `offsetMin`; by hand, as QuickJS has no `Intl`. */
export const localDay = (offsetMin, ms) => Math.floor((ms + offsetMin * MINUTE_MS) / DAY_MS);

/** The weekday of a day number (days since 1970-01-01 on any fixed-offset clock), Sunday 0: day 0 was a Thursday. */
export const weekdayOf = (day) => (day + 4) % 7;

/** Whether an exchange's `hours` (with `weekdays`) trade on day number `day` of its clock, by weekday alone. */
export const tradesOn = (hours, day) => hours.weekdays.includes(weekdayOf(day));

/** The start of day number `day` on a clock at a fixed UTC offset of `offsetMin`, in ms. */
export const dayStart = (offsetMin, day) => day * DAY_MS - offsetMin * MINUTE_MS;

/**
 * A window of the local day around `now` (its from and to in local minutes since midnight), as [start, end) in ms, by
 * the clock's fixed UTC offset: a lunch break, a TAIFEX session, or an exchange's regular hours.
 */
export function localWindow({ offsetMin, from, to }, now) {
  const start = dayStart(offsetMin, localDay(offsetMin, now));
  return [start + from * MINUTE_MS, start + to * MINUTE_MS];
}
