// The detail dialog's view model: its cells (activity, inner/outer, book, second row), its times and 交易時段, its
// sources, when it dims, and when an open detail must redraw (detailWakeAt, followDetail). No Herdr imports, so tests
// run it under Node.
import { regularSpans } from "./chart.js";
import { heldMarks } from "./closures.js";
import {
  compact,
  formatCount,
  formatShare,
  formatSize,
  formatStaleDate,
  formatTime,
  number,
  stamp,
  stateText,
} from "./format.js";
import {
  delayMinutes,
  freshness,
  hoursWindow,
  isRealtime,
  nextEdge,
  nightClosed,
  sessionOf,
  staleAt,
} from "./freshness.js";
import { DAY_SESSION, NIGHT_SESSION, TAIFEX_HOURS, exchangeRule, kindOf, resolvedMarket } from "./markets.js";
import { BOOK_LEVELS, hasLimits, isCryptoPair, positive } from "./quotes.js";
import { localWindow } from "./time.js";

/** The day's amplitude in percent, (high − low) / previous close × 100; null without all three. */
export function amplitude(quote) {
  return positive(quote.high) && positive(quote.low) && positive(quote.previousClose)
    ? ((quote.high - quote.low) / quote.previousClose) * 100
    : null;
}

// A count the quote carries as a cell in its size unit, or null without one.
const sizeCell = (quote, key, n, lang, tx) =>
  positive(n) ? { label: tx(key), ...formatSize(n, quote.sizeUnit, lang, tx) } : null;

// A two-column detail's place with no value keeps its label and reads `—`.
const emptyCell = (key, tx) => ({ label: tx(key), value: "—", unit: "" });

/**
 * The two-column detail's activity, always four cells in this order: volume, previous volume, turnover (compact, 2
 * decimals: `920.47 億`, `92.05B`) and the last trade's size; a value the quote does not carry reads `—`.
 */
export function activityCells(quote, lang, tx) {
  const turnover = positive(quote.turnover)
    ? { label: tx("detail.turnover"), ...compact(quote.turnover, lang, 2) }
    : null;
  return [
    sizeCell(quote, "detail.volume", quote.volume, lang, tx) ?? emptyCell("detail.volume", tx),
    sizeCell(quote, "detail.previousVolume", quote.previousVolume, lang, tx) ?? emptyCell("detail.previousVolume", tx),
    turnover ?? emptyCell("detail.turnover", tx),
    sizeCell(quote, "detail.lastSize", quote.lastSize, lang, tx) ?? emptyCell("detail.lastSize", tx),
  ];
}

/**
 * The inner/outer line: `{ left, right }` texts (`內盤 39.1% 15,147`, `外盤 60.9% 23,585`) and each side's share of their
 * sum as a fraction, for the bar. null when the quote does not carry both, or both are 0.
 */
export function innerOuter(quote, tx) {
  const { inner, outer } = quote;
  if (typeof inner !== "number" || typeof outer !== "number" || !(inner + outer > 0)) return null;
  const innerShare = inner / (inner + outer);
  const outerShare = outer / (inner + outer);
  const side = (key, n, share) => `${tx(key)} ${formatShare(share * 100)} ${formatCount(n)}`;
  return {
    left: side("detail.inner", inner, innerShare),
    right: side("detail.outer", outer, outerShare),
    innerShare,
    outerShare,
  };
}

const levelCount = (book) => book.bids.length + book.asks.length;

/**
 * What the two-column detail's book area shows, `{ title, book, line }` (title and line are string keys): the quote's
 * book, when it has a level and is an auction book exactly when the detail reads `試撮中` (`auction`), under
 * "detail.auctionBook" in an auction, else "detail.book"; otherwise no book, "detail.book", and one line: "reason" when
 * the price has a failure to name (its fallback, else a cached price's error), else "detail.bookEmpty" when the source
 * answered with no level, else "detail.bookNone".
 */
export function detailBook(quote, auction) {
  const book = quote.book ?? null;
  const matches = book !== null && Boolean(book.auction) === auction;
  if (matches && levelCount(book) > 0)
    return { title: auction ? "detail.auctionBook" : "detail.book", book, line: null };
  const reason = quote.fallback ?? (quote.cached ? quote.error : null);
  return {
    title: "detail.book",
    book: null,
    line: reason ? "reason" : matches ? "detail.bookEmpty" : "detail.bookNone",
  };
}

// A level as a ladder rung, with its change % against `previousClose`; a market order (no price) has none and is marked.
const rung = (level, previousClose) =>
  level && {
    price: level.price,
    size: level.size,
    change:
      level.price !== null && positive(previousClose) ? ((level.price - previousClose) / previousClose) * 100 : null,
    ...(level.price === null && { market: true }),
  };

/**
 * The ladder's rows, best first, at most 5: each `{ bid, ask }`, a side without a level at that row null. A rung is
 * `{ price, size, change }`, `change` the % against `previousClose` (null without one or for a market order, which
 * also carries `market: true`).
 */
export function ladder(book, previousClose) {
  const rows = [];
  for (let i = 0; i < Math.min(BOOK_LEVELS, Math.max(book.bids.length, book.asks.length)); i++) {
    rows.push({ bid: rung(book.bids[i] ?? null, previousClose), ask: rung(book.asks[i] ?? null, previousClose) });
  }
  return rows;
}

const sizes = (levels) => levels.reduce((sum, level) => sum + level.size, 0);

/** The book's totals: each side's sum, bids minus asks, and bids over asks (null without asks). */
export function bookTotals(book) {
  const bids = sizes(book.bids);
  const asks = sizes(book.asks);
  return { bids, asks, diff: bids - asks, ratio: asks > 0 ? bids / asks : null };
}

/**
 * The detail's second row of price levels, a cell per column of the first row (3 for a pair, else 4): the limits under
 * high and low; in one column (`wide` false) the volume under open, in two the average price under open and the
 * amplitude under previous close. A cell is `{ label, value, unit }`. In two columns every place is drawn, one without a
 * value reading `—` (emptyCell). In one, a place without a value is null, so it keeps its column, and the row is null
 * when every place is empty.
 */
export function secondRow(quote, wide, lang, tx) {
  const pair = isCryptoPair(quote.symbol);
  const plain = (label, value) => ({ label: tx(label), value, unit: "" });
  const swing = amplitude(quote);
  const first = wide
    ? positive(quote.avgPrice)
      ? plain("detail.avgPrice", number(quote, quote.avgPrice))
      : null
    : sizeCell(quote, pair ? "detail.volume24h" : "detail.volume", quote.volume, lang, tx);
  const limit = (label, value) =>
    hasLimits(quote.limitUp, quote.limitDown) ? plain(label, number(quote, value)) : null;
  const places = [first, limit("detail.limitUpPrice", quote.limitUp), limit("detail.limitDownPrice", quote.limitDown)];
  if (!pair) places.push(wide && swing !== null ? plain("detail.amplitude", formatShare(swing, 2)) : null);
  if (wide) {
    const keys = ["detail.avgPrice", "detail.limitUpPrice", "detail.limitDownPrice", "detail.amplitude"];
    return places.map((cell, i) => cell ?? emptyCell(keys[i], tx));
  }
  return places.some(Boolean) ? places : null;
}

/**
 * The detail dialog's times, to the second: the quote's (with its date when not today, as in formatStaleDate), the
 * last trade when it is not the quote's own time (Yahoo 奇摩股市 times a quiet stock at the feed), the fetch.
 */
export function detailTimes(quote, now, lang, tx) {
  const date = formatStaleDate(quote, now, lang);
  const lastTrade =
    quote.tradeTime && quote.tradeTime !== quote.timestamp
      ? [tx("detail.lastTrade", { time: formatTime(quote.tradeTime, true) })]
      : [];
  return [
    tx("detail.quoted", { time: stamp(date, quote.timestamp, true) }),
    ...lastTrade,
    tx("detail.fetched", { time: formatTime(quote.fetchedAt, true) }),
  ];
}

/**
 * The detail's 交易時段 for `quote` at `now`, as data (sessionTimesParts writes it) tagged by `kind`; times in ms, regular
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
 *   hoursWindow's, split around the exchange's lunch when it has one (regularSpans);
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
      kind: "futures",
      day: localWindow({ offsetMin, ...DAY_SESSION }, now),
      night: nightClosed(quote) ? null : localWindow({ offsetMin, ...NIGHT_SESSION }, now),
      nightNoTrades: closure === "nightNoTrades",
    };
  }
  const spans = (list) => ({ kind: "spans", spans: list });
  if (resolvedMarket(quote.symbol, quote.exchange) === "tw") return spans([hoursWindow(quote, now).regular]);
  const regular = quote.periods?.regular ?? hoursWindow(quote, now)?.regular;
  return regular ? spans(regularSpans(quote, regular)) : null;
}

const timeRange = ([start, end]) => `${formatTime(start)}–${formatTime(end)}`;

// The language that names a listed closure's reason: the schedule gives it in Traditional Chinese only.
const REASON_LANG = "zh-TW";

// The 交易時段 line's parts for one sessionTimes value, by its kind (see sessionTimesParts).
function hoursParts(times, lang, tx) {
  switch (times.kind) {
    case "allDay":
      return [tx("detail.allDay")];
    case "closedToday":
      return [tx("detail.closedToday"), ...(lang === REASON_LANG ? [times.reason] : [])];
    case "noTradesToday":
      return [tx("detail.noTradesToday")];
    case "futures": {
      const night = times.night
        ? tx("detail.nightSession", { times: timeRange(times.night) })
        : tx(times.nightNoTrades ? "detail.nightNoTrades" : "detail.nightNotHeld");
      return [tx("detail.daySession", { times: timeRange(times.day) }), night];
    }
    default: // "spans"
      return times.spans.map(timeRange);
  }
}

/**
 * The 交易時段 line's parts (see sessionTimes), for segments() (joined with " · "): the first part carries
 * tx("detail.sessionTimes", { times }); each range is `${formatTime(start)}–${formatTime(end)}`; [] for null. A
 * listed closed day reads 今日休市 (translated), then the schedule's reason in `lang` zh-TW only; a removed night
 * reads 夜盤休市. A day without trades reads 今日尚無成交，可能休市, and a night without trades 夜盤尚無成交.
 */
export function sessionTimesParts(times, lang, tx) {
  if (!times) return [];
  const [first, ...rest] = hoursParts(times, lang, tx);
  return [tx("detail.sessionTimes", { times: first }), ...rest];
}

// A delayed quote's lateness in words: its exchange's minutes, else that the delay is not provided.
function delayWords(quote, tx) {
  const late = delayMinutes(quote);
  return late === null ? tx("freshness.delayUnknown") : tx("freshness.delayedMinutes", { minutes: late });
}

// A detail line's keys: with a state, and for the source alone when the state has no word (unconfirmed).
const PRICE_KEYS = { from: "detail.priceFrom", alone: "detail.priceSource" };
const LINE_KEYS = { from: "detail.lineFrom", alone: "detail.lineSource" };
const sourceText = (keys, state, source, tx) =>
  state === null ? tx(keys.alone, { source }) : tx(keys.from, { state, source });

/** A row's line as a quote of its own source: its times and cached flag (`chartCached`), not the price's. */
export function chartQuote(quote) {
  return {
    ...quote,
    source: quote.chartSource,
    timestamp: quote.chartTimestamp,
    fetchedAt: quote.chartFetchedAt,
    cached: quote.chartCached,
  };
}

// The line's own quote (chartQuote) when the line has a reading of its own: another source's than the price's, real
// time; else null (no line, the price's own, or a delayed one, which reads by its exchange's delay).
function lineReading(quote) {
  if (!quote.chartSource || quote.chartSource === quote.source) return null;
  const chart = chartQuote(quote);
  return isRealtime(chart) ? chart : null;
}

// The open detail sleeps at most this long at a time, then rereads the clock: a machine that slept, or a clock that
// moved, costs at most this much lateness.
export const DETAIL_WAKE_CAP_MS = 600_000;

// A stale moment the open detail reads (staleAt), or null: none for a quote that already reads stalled, which stays so
// until an edge (a cached price reads stalled at once; one still at the previous close, unconfirmed, still turns).
const readStaleAt = (quote, session, now) =>
  freshness(quote, session, now).state === "stalled" ? null : staleAt(quote, session, now);

/**
 * The next moment after `now` at which the open detail of `quote`, with its marks as held at `now` (heldMarks), can
 * read differently, in ms, or null: the earliest of its row's next edge (nextEdge), its mark's end (`closureUntil`),
 * and the stale moments (readStaleAt, in the session it reads) of what the detail shows a state for: a real-time
 * price that is not a pair (a delayed stock prints its delay, a pair no state), and a line that is another source's
 * real-time quote (lineReading). Each counts only when strictly later than `now`, so a wait cut at it is never zero.
 */
export function detailWakeAt(detail, now) {
  const quote = heldMarks(detail, now);
  const session = sessionOf(quote, now);
  const moments = [nextEdge(quote, now), quote.closureUntil];
  if (isRealtime(quote) && !isCryptoPair(quote.symbol)) moments.push(readStaleAt(quote, session, now));
  const line = lineReading(quote);
  if (line) moments.push(readStaleAt(line, session, now));
  const ahead = moments.filter((at) => at != null && at > now);
  return ahead.length ? Math.min(...ahead) : null;
}

/**
 * The open detail's one task: a data timer, not animation. It fetches nothing (its row hands it newer quotes, see
 * main.js adoptDetail); one wake at a time, it sleeps to the quote's next reading change (detailWakeAt, from its marks
 * as held then), at most DETAIL_WAKE_CAP_MS per sleep before it rereads the clock, and calls `changed()` (a redraw)
 * only once a wake is reached, so a wake hours away costs one redraw. `detail` is a getter, read at each wake;
 * `woken()` gives a promise that settles when a handed quote was adopted, and the wake recomputes at once from it.
 * Every real quote has an edge ahead (a day edge at least), so the `null` branch is a guard: it waits for `woken()`
 * rather than ending. Each wake leaves the abandoned `sleep` pending (at most DETAIL_WAKE_CAP_MS, so about 60 at a 10 s
 * pace); they cost little and end with the dialog's `cx`, not a leak. The copy's `cx` ends it: a cancelled sleep rejects, and so does this.
 */
export async function followDetail(detail, { now, sleep, changed, woken }) {
  for (;;) {
    const time = now();
    const wake = detailWakeAt(detail(), time);
    const signal = woken();
    if (wake === null) {
      await signal;
      continue;
    }
    const reached = await Promise.race([
      sleep(Math.min(wake - time, DETAIL_WAKE_CAP_MS)).then(() => true),
      signal.then(() => false),
    ]);
    if (reached && now() >= wake) changed();
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
    if (quote.chartSource === quote.source)
      return [[price], [sourceText(LINE_KEYS, own, tx(`src.${quote.source}`), tx)]];
    const line = lineReading(quote);
    const state = line ? stateText(freshness(line, session, now), tx) : delayWords(chartQuote(quote), tx);
    return [[price], [sourceText(LINE_KEYS, state, tx(`src.${quote.chartSource}`), tx)]];
  }
  if (isCryptoPair(quote.symbol)) return [[tx("detail.sourceCrypto")]];
  return [[tx("detail.sourceStock"), delayWords(quote, tx)]];
}

/**
 * Whether the detail dims its price with its activity, inner/outer volume and book: its price is kept through a failed
 * refresh (`cached`) or reads stalled, so nothing beside it looks current. Rows keep their own look.
 */
export function detailDimmed(quote, session, now) {
  return Boolean(quote.cached) || freshness(quote, session, now).state === "stalled";
}
