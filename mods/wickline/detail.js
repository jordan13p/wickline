// The detail dialog's view model: its cells (activity, inner/outer, book, second row), its times and 交易時段, its
// sources, when it dims, and when an open detail must redraw.
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
import { BOOK_LEVELS, changePercent, hasLimits, isCryptoPair, positive } from "./quotes.js";
import { localWindow } from "./time.js";

/** The day's amplitude in percent; null without high, low and previous close. */
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
 * The two-column detail's activity, always four cells: volume, previous volume, turnover (compact: `920.47 億`,
 * `92.05B`) and the last trade's size. A value the quote does not carry reads `—`.
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
 * The inner/outer line: the `left` and `right` texts (`內盤 39.1% 15,147`, `外盤 60.9% 23,585`) and each side's share
 * as a fraction, for the bar. null when the quote does not carry both, or both are 0.
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
 * What the two-column detail's book area shows, as `{ title, book, line }`; `title` and `line` are string keys. The
 * quote's book shows only when it has a level and is an auction book exactly when the detail reads `試撮中`.
 * Otherwise one line says why there is none.
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

// A level as a ladder rung, with its change % against `previousClose`. A market order has no price, so no change,
// and is marked.
const rung = (level, previousClose) =>
  level && {
    price: level.price,
    size: level.size,
    change: level.price !== null ? changePercent(level.price, previousClose) : null,
    ...(level.price === null && { market: true }),
  };

/**
 * The ladder's rows, best first, at most BOOK_LEVELS, each `{ bid, ask }`; a side without a level at that row is null.
 * A rung is `{ price, size, change }`, with `change` the % against `previousClose`. A market order has a null change
 * and carries `market: true`.
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
 * The detail's second row of price levels, a cell `{ label, value, unit }` per column of the first row (3 for a pair,
 * else 4). The limits go under high and low. In one column (`wide` false) the volume goes under open; in two, the
 * average price under open and the amplitude under previous close.
 * In two columns every place is drawn, `—` without a value. In one, a place without a value is null so it keeps its
 * column, and the row is null when every place is empty.
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
 * The detail dialog's times, to the second: the quote's (dated when not today), the last trade's when it differs
 * (Yahoo 奇摩股市 times a quiet stock by the feed), and the fetch's.
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
 * The detail's 交易時段 for `quote` at `now`, as data tagged by `kind` for sessionTimesParts; null with nothing to
 * show. Times are in ms, regular session only. A future's `night` is null while it is closed; `nightNoTrades` then
 * says it is for want of trades rather than removed. A Taiwan stock or index takes TWSE's hours whatever periods it
 * carries, as a TW-only index priced on an earlier day carries a zero-length period.
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

// The only language that shows a listed closure's reason: the schedule gives it in Traditional Chinese.
const REASON_LANG = "zh-TW";

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
 * The 交易時段 line's parts for a sessionTimes value, joined with " · " by segments(); [] for null. The first part
 * carries the "detail.sessionTimes" label.
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

// A detail line's keys: one with a state, and one for the source alone when the state has no word (unconfirmed).
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

// The line's own quote (chartQuote) when the line has a reading of its own: a real-time source other than the
// price's. Else null: no line, the price's own, or a delayed one, which reads by its exchange's delay.
function lineReading(quote) {
  if (!quote.chartSource || quote.chartSource === quote.source) return null;
  const chart = chartQuote(quote);
  return isRealtime(chart) ? chart : null;
}

// The open detail sleeps at most this long at a time, then rereads the clock. A machine that slept, or a clock that
// moved, costs at most this much lateness.
export const DETAIL_WAKE_CAP_MS = 600_000;

// The moment the open detail's quote turns stale (staleAt), or null when it already reads stalled; it stays so until
// an edge. A cached price reads stalled at once; an unconfirmed one still at the previous close still turns.
const readStaleAt = (quote, session, now) =>
  freshness(quote, session, now).state === "stalled" ? null : staleAt(quote, session, now);

/**
 * The next moment after `now` at which the open detail can read differently, or null. It is the earliest of its
 * row's next edge, its mark's end and the stale moments of what it shows a state for. Only a real-time price that is
 * not a pair shows one (a delayed stock prints its delay, a pair no state), and a line that is another source's
 * real-time quote.
 * Each counts only when strictly later than `now`, so a wait cut at it is never zero.
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
 * The open detail's one task: a data timer, not animation. It fetches nothing; its row hands it newer quotes.
 * - It sleeps to the quote's next reading change (detailWakeAt), at most DETAIL_WAKE_CAP_MS at a time, and calls
 *   `changed()` (a redraw) only once a wake is reached, so a wake hours away costs one redraw.
 * - `detail` is a getter, read at each wake. `woken()` gives a promise that settles when a handed quote was adopted;
 *   the wake is then recomputed at once.
 * - Every real quote has an edge ahead, so the `null` branch is a guard: it waits for `woken()` rather than ending.
 * - Each early wake leaves its sleep pending, at most DETAIL_WAKE_CAP_MS long; they end with the dialog's `cx`.
 * The copy's `cx` ends the task: a cancelled sleep rejects, and so does this.
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
 * The detail dialog's sources as lines, each a list of parts joined with ` · `; `tx` translates. A real-time price
 * names its state and source (`Price: Live · TWSE MIS`). Its line follows on a line of its own, read by the line's own
 * quote (`Line: delayed 20 min · Yahoo Finance`). A delayed stock reads as one line with its exchange's delay.
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
 * Whether the detail dims its price, activity, inner/outer volume and book: when the price is kept from before a
 * failed refresh (`cached`) or reads stalled, nothing beside it should look current. Rows keep their own look.
 */
export function detailDimmed(quote, session, now) {
  return Boolean(quote.cached) || freshness(quote, session, now).state === "stalled";
}
