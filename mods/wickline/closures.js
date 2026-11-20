// A Taiwan market's closure, listed or inferred from quiet answers, and when its reading ends.
import { isWeekday, nextTaipeiMidnight, taipeiAt, taipeiDay, taipeiMinute } from "./calendar.js";
import { DAY_SESSION, NIGHT_SESSION, TAIFEX_HOURS, TWSE_HOURS, kindOf } from "./markets.js";
import { tradesOn } from "./time.js";

// When the night session running past midnight ends, in Taipei minutes since midnight (05:00).
const NIGHT_END_MIN = NIGHT_SESSION.to - 24 * 60;

/**
 * The open (ms) of the session of `market` that `now` belongs to, or null. In Taipei time:
 * - "stock": 09:00, from 09:00 to midnight;
 * - "future": 08:45 from 08:45 to 15:00, 15:00 from 15:00 to midnight, and the day before's 15:00 from 00:00 to 05:00.
 * Each counts only when the session's own date is a weekday.
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

// A session with answers but no trade since its open reads as having no trades (今日無成交). Never as closed (休市):
// the answers cannot tell a closed market from a stuck feed. The reading starts at the open + INFER_REALTIME_MS with
// an answer from a real-time source, or + INFER_DELAYED_MS with one from Yahoo Finance (20 minutes late).
// A deadline counts only when that kind's latest answer came at most INFER_RECENT_MS before it, so a source that
// answered once near the open and then went quiet never counts.
export const INFER_REALTIME_MS = 600_000;
export const INFER_DELAYED_MS = 1_800_000;
export const INFER_RECENT_MS = 120_000;

// An answer's deadline after the open, by whether its source is real time.
const INFER_DEADLINES = new Map([
  [true, INFER_REALTIME_MS],
  [false, INFER_DELAYED_MS],
]);

// The answers that may yet name a closure of a session: none once it traded (see closureOf).
const quietAnswers = (observation) => (!observation || observation.traded ? [] : observation.answers);

/** The Taiwan market a symbol trades in, as closureOf names it: "future" for TAIFEX, else "stock" (TWSE and TPEx). */
export const twMarket = (symbol) => (kindOf(symbol) === "future" ? "future" : "stock");

/**
 * What a Taiwan `market` ("stock" or "future") reads at `now`, as `{ closure, deadline, until }`.
 * `closure` and `until` come from closureRule; both are null once the current session has traded, which clears every
 * closure. `deadline` is the next moment the reading can change: the earliest of the session's inference deadlines
 * and `until`. `listed` and `seen` are as closureRule reads them.
 */
export function closureOf(market, now, listed, seen) {
  const open = currentOpen(market, now);
  const observation = open === null ? undefined : seen(market, open);
  const { closure, until } = observation?.traded
    ? { closure: null, until: null }
    : closureRule(market, now, open, listed, seen);
  // Each answer's deadline while the session has no trade, and the mark's end, which no answer announces.
  const ahead = quietAnswers(observation)
    .map(({ realtime }) => open + INFER_DEADLINES.get(realtime))
    .filter((at) => at > now);
  if (until !== null && until > now) ahead.push(until);
  return { closure, deadline: ahead.length ? Math.min(...ahead) : null, until };
}

/**
 * `quote` with its Taiwan market's reading from closureOf: `closure`, plus `closureDeadline` and `closureUntil` when
 * there is one. nextEdge wakes the row at the deadline; heldMarks drops the mark at `closureUntil`.
 */
export const withClosure = (quote, { closure, deadline, until }) => ({
  ...quote,
  closure,
  ...(deadline !== null && { closureDeadline: deadline }),
  ...(until !== null && { closureUntil: until }),
});

/**
 * `quote` as the open detail reads it at `now`. The detail learns a new reading only from its row's hand-over, so it
 * keeps the quote while its mark holds and drops the mark once `closureUntil` has passed. It then reads its session
 * from its periods and TAIFEX's hours again, not from a closure that is over.
 */
export function heldMarks(quote, now) {
  if (quote.closureUntil == null || now < quote.closureUntil) return quote;
  const { closureDeadline: _deadline, ...rest } = quote;
  return { ...rest, closure: null, closureUntil: null };
}

/**
 * The closure of a Taiwan `market` at `now` while its current session has not traded, as `{ closure, until }`.
 * This is the one place a quote's closure is decided.
 * - `open`: the current session's open, or null.
 * - `listed(day)`: the schedule's name for a closed day, or null.
 * - `seen(market, open)`: that market's session opened at `open`, or undefined: `{ traded, newest, answers }`.
 *   `traded`: a trade came at or after the open. `newest`: the newest trade time the answers carried. `answers`: each
 *   source's latest answer since the open, `[{ at, source, realtime }]`, real-time sources first.
 * `closure` is null or `{ kind, reason?, source? }`. `until` is when the reading ends if no new answer arrives.
 * - "listed": a day the schedule lists (`reason`, its name).
 * - "noTrades": a day without trades, inferred (`source`, the source whose answer counts).
 * - "nightRemoved": a night removed by a listed day.
 * - "nightNoTrades": a night without trades after a day that traded, inferred (`source` as above).
 *
 * The first matching row wins; T is today in Taipei.
 * 1. A stock on a listed T: listed.
 * 2. A stock from 09:00 on a weekday T, its session quiet (quietSince) and T not traded (dayTraded, which also counts
 *    futures trades since 08:45 T, the night's answers included): noTrades.
 * 3. A future from 00:00 to 05:00 after a T-1 that is not a weekday: listed on a listed T, else none.
 * 4. The same after an unlisted weekday T-1, once the night of T-1 is quiet: listed on a listed T, else the night's
 *    reading of T-1.
 * 5. The same after a listed T-1, whose night is removed: listed on a listed T, else nightRemoved.
 * 6. A future from 05:00 on a listed T: listed.
 * 7. A future from 08:45 to 15:00 on a weekday T, its day session quiet and no stock traded since 09:00 T: noTrades.
 * 8. A future from 15:00 on a weekday T, its night session quiet: the night's reading of T.
 * 8b. Otherwise, before the cap and while T has not traded, the day session's reading carries on: noTrades. The cap
 *    (15:10) is the night's deadline, its open + INFER_REALTIME_MS, as only real-time sources price futures. With no
 *    night answer at all the reading ends at the cap; after the cap, a night source that went quiet leaves the reading
 *    as it is.
 * 9. Otherwise none.
 *
 * When each reading ends:
 * - a stock's, a listed day included: the next 00:00;
 * - a future's listed day: 05:00 the next day, when the night it removes ends;
 * - a future's before 05:00 (3–5): 05:00;
 * - a future's day reading (7, 8b): the cap;
 * - a future's night reading (8, from 15:10 on): the next 05:00.
 *
 * A night's reading of day D: if D traded (its day session, the night's newest trade since 08:45 D, or a stock since
 * 09:00 D), the night has no trades yet (nightNoTrades). Otherwise the whole day has none (noTrades).
 */
function closureRule(market, now, open, listed, seen) {
  const today = taipeiDay(now);
  const before = today - 1;
  const minute = taipeiMinute(now);
  const reason = listed(today);
  // The source that says the session of `market` opened at `start` has no trade, or null: the first answer still
  // recent at its deadline (INFER_RECENT_MS), once `now` is past that deadline.
  const quietSince = (start) =>
    quietAnswers(seen(market, start)).find(({ at, realtime }) => {
      const deadline = start + INFER_DEADLINES.get(realtime);
      return now >= deadline && at >= deadline - INFER_RECENT_MS;
    })?.source ?? null;
  const tradedSince = (other, start) => Boolean(seen(other, start)?.traded);
  const dayOpen = (day) => taipeiAt(day, DAY_SESSION.from);
  const dayTraded = (day) =>
    tradedSince("future", dayOpen(day)) ||
    seen("future", taipeiAt(day, NIGHT_SESSION.from))?.newest >= dayOpen(day) ||
    tradedSince("stock", taipeiAt(day, TWSE_HOURS.from));
  // Where each row's reading ends (see above).
  const midnight = nextTaipeiMidnight(now);
  const nightEnd = taipeiAt(today, NIGHT_END_MIN);
  // A future's listed mark outlasts the day: the night from 15:00 on T to 05:00 on T+1 is removed too.
  const listedEnd = market === "future" ? taipeiAt(today + 1, NIGHT_END_MIN) : midnight;
  const cap = taipeiAt(today, NIGHT_SESSION.from) + INFER_REALTIME_MS;
  const ruled = (closure, until) => ({ closure, until: closure ? until : null });
  const noTrades = (source) => ({ kind: "noTrades", source });
  const nightReading = (day, source) => (dayTraded(day) ? { kind: "nightNoTrades", source } : noTrades(source));
  // From 00:00 to 05:00, the night of an unlisted weekday T-1 runs on. Until it reads quiet, not even a listed T
  // closes it.
  const runningNight = market === "future" && minute < NIGHT_END_MIN && isWeekday(before) && !listed(before);
  const nightSource = runningNight ? quietSince(open) : null;
  if (runningNight && !nightSource) return ruled(null); // 4, else 9
  if (reason) return ruled({ kind: "listed", reason }, listedEnd); // 1, 3–5, 6
  if (market === "stock") {
    const source = open !== null && !dayTraded(today) && quietSince(open);
    return ruled(source ? noTrades(source) : null, midnight); // 2, else 9
  }
  if (minute < NIGHT_END_MIN) {
    if (runningNight) return ruled(nightReading(before, nightSource), nightEnd); // 4
    return ruled(isWeekday(before) ? { kind: "nightRemoved" } : null, nightEnd); // 3, 5
  }
  if (open === null) return ruled(null); // 9
  if (minute < NIGHT_SESSION.from) {
    const source = !dayTraded(today) && quietSince(open);
    return ruled(source ? noTrades(source) : null, cap); // 7, else 9
  }
  const night = quietSince(open);
  if (night) return ruled(nightReading(today, night), taipeiAt(today + 1, NIGHT_END_MIN)); // 8
  const day = now < cap && !dayTraded(today) && quietSince(dayOpen(today));
  return ruled(day ? noTrades(day) : null, cap); // 8b, else 9
}
