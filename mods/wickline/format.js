// How a quote is written and drawn as text and numbers, by hand: Herdr's QuickJS runtime has no Intl.
// No Herdr imports, so tests run it under Node.
import { hasLimits, isCryptoPair, positive, timedByTrade } from "./quotes.js";
import { nextTaipeiMidnight, taipeiDay } from "./calendar.js";
import { HOUR_MS, resolvedMarket } from "./markets.js";

/**
 * The line through `series`, scaled into its box as [x%, y%] points spread over `extent` of its width (null: all of
 * it; freshness.js chartLayout), where the reference price (the previous close) falls whenever it is positive, and
 * `dot` ({ x, price }: x a share of the width) as [x%, y%], or null. The y range holds all three. null when nothing
 * would be drawn: no reference, no dot and fewer than two points (a line needs two).
 */
export function chartGeometry(series, reference, { extent, dot } = {}) {
  const points = Array.isArray(series) ? series : [];
  const rule = positive(reference) ? reference : null;
  if (points.length < 2 && rule === null && !dot) return null;
  let min = Infinity;
  let max = -Infinity;
  const widen = (value) => { min = Math.min(min, value); max = Math.max(max, value); };
  for (const value of points) widen(value);
  if (rule !== null) widen(rule);
  if (dot) widen(dot.price);
  if (max - min < max * 1e-9) { min -= 1; max += 1; }
  // 8% headroom keeps the stroke inside the box.
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;
  const pct = (share) => Math.round(share * 10000) / 100;
  const y = (value) => pct(1 - (value - min) / (max - min));
  const width = extent ?? 1;
  const last = points.length - 1;
  return {
    points: points.map((value, index) => [last ? pct(index / last * width) : 0, y(value)]),
    reference: rule === null ? null : y(rule),
    dot: dot ? [pct(dot.x), y(dot.price)] : null,
  };
}

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function significant(price) {
  // Below 1, keep 2 to 4 significant digits: 0.00000441 must not round to 0.000004.
  const places = Math.min(20, 3 - Math.floor(Math.log10(price)));
  let text = price.toFixed(places);
  const count = (s) => s.replace(".", "").replace(/^0+/, "").length;
  while (text.endsWith("0") && count(text) > 2) text = text.slice(0, -1);
  return text;
}

export function formatPrice(quote) {
  const [whole, fraction] = (quote.price < 1 ? significant(quote.price) : quote.price.toFixed(2)).split(".");
  const price = group(whole) + (fraction === undefined ? "" : "." + fraction);
  return quote.currency ? `${price} ${quote.currency}` : price;
}

/** The currency the compact band names: none for USD or a pair's own quote currency. */
export function bandCurrency(quote) {
  return !quote.currency || quote.currency === "USD" || quote.symbol.endsWith(`/${quote.currency}`) ? null : quote.currency;
}

// `value` (the price by default) without its currency, for a fixed right-aligned column.
export function number(quote, value = quote.price) {
  return typeof value === "number" && value > 0 ? formatPrice({ ...quote, price: value, currency: null }) : "—";
}

// The sign follows the rounded text, so a change too small to show reads `0.00`, never `+0.00` or `-0.00`.
const withSign = (value, size) => (/[1-9]/.test(size) ? `${value >= 0 ? "+" : "-"}${size}` : size);

// The day's change in the price's own units and precision: `+3.58`, `-1,234.56`; below 1, the price's
// significant digits (`+0.00000012`). From 1 up it is 2 decimals like the price, so float noise in a
// source's price (227.52000427 against 227.52) reads `0.00`, never `+0.000004272`.
export function signed(quote) {
  if (!(quote.previousClose > 0)) return "—";
  const change = quote.price - quote.previousClose;
  const size = Math.abs(change);
  if (quote.price < 1) return withSign(change, size > 0 ? significant(size) : "0.00");
  const [whole, fraction] = size.toFixed(2).split(".");
  return withSign(change, `${group(whole)}.${fraction}`);
}

export function formatChange(value) {
  return value === null || value === undefined ? "—" : `${withSign(value, Math.abs(value).toFixed(2))}%`;
}

/** A change % that reads `0.00%`: neither a gain nor a loss, whatever its sign before rounding. */
export const isFlat = (percent) => formatChange(percent) === "0.00%";

/** How a change % is colored: "none" without one, "flat" when it reads `0.00%`, else "up" or "down". */
export function changeTone(percent) {
  if (percent === null || percent === undefined) return "none";
  if (isFlat(percent)) return "flat";
  return percent >= 0 ? "up" : "down";
}

/** A count rounded to a whole number and grouped: `42269` is `42,269`. */
export const formatCount = (n) => group(String(Math.round(n)));

/** An amount grouped, at most 2 decimals, without trailing zeros: `1234.5` is `1,234.5`. */
export function formatAmount(n) {
  const [whole, fraction] = n.toFixed(2).split(".");
  const kept = fraction.replace(/0+$/, "");
  return group(whole) + (kept ? `.${kept}` : "");
}

// Large numbers by language, largest unit first: English counts by thousands (inline), the others by 10,000.
const COMPACT_UNITS = {
  en: { step: 1_000, units: [["B", 1e9], ["M", 1e6], ["K", 1e3]] },
  "zh-TW": { step: 10_000, units: [["億", 1e8], ["萬", 1e4]] },
  "zh-CN": { step: 10_000, units: [["亿", 1e8], ["万", 1e4]] },
  ja: { step: 10_000, units: [["億", 1e8], ["万", 1e4]] },
  ko: { step: 10_000, units: [["억", 1e8], ["만", 1e4]] },
};

/**
 * A large number in its language's units: English `48.2M` (`places` decimals, the unit inline, so `unit` is ""), the
 * others `4,821.35` with `萬`/`万`/`만` or `億`/`亿`/`억` as `unit`, always 2 decimals. Below 1,000 (English) or 10,000
 * it is a plain count. A value that rounds up to 1,000 (English) or 10,000 of its unit moves up one unit.
 */
export function compact(n, lang, places = 1) {
  const rule = COMPACT_UNITS[lang] ?? COMPACT_UNITS.en;
  const { step, units } = rule;
  const inline = rule === COMPACT_UNITS.en;
  const digits = inline ? places : 2;
  let i = units.findIndex(([, size]) => n >= size);
  if (i === -1) return { value: formatCount(n), unit: "" };
  // The unit just above, when this one's rounded value reaches a full step of it.
  if (i > 0 && Number((n / units[i][1]).toFixed(digits)) >= step) i -= 1;
  const [name, size] = units[i];
  const [whole, fraction] = (n / size).toFixed(digits).split(".");
  const value = group(whole) + (fraction === undefined ? "" : `.${fraction}`);
  return inline ? { value: value + name, unit: "" } : { value, unit: name };
}

// A base asset's amount from here up is compact: below it, a pair's volume keeps its decimals (`1,234.5 BTC`).
const AMOUNT_COMPACT_FROM = 1e6;

/**
 * A size with its unit as `{ value, unit }`: lots and contracts as counts in the language's own unit (singular for 1),
 * shares compact, anything else a base asset's amount with its code, compact from AMOUNT_COMPACT_FROM (`1.0B DOGE`,
 * `10.12 億 DOGE`).
 */
export function formatSize(n, sizeUnit, lang, tx) {
  if (sizeUnit === "lot" || sizeUnit === "contract") {
    return { value: formatCount(n), unit: tx(`unit.${sizeUnit}.${n === 1 ? "one" : "other"}`) };
  }
  if (sizeUnit === "share") return compact(n, lang);
  if (n < AMOUNT_COMPACT_FROM) return { value: formatAmount(n), unit: sizeUnit };
  const { value, unit } = compact(n, lang);
  return { value, unit: unit ? `${unit} ${sizeUnit}` : sizeUnit };
}

/** A share as an unsigned percentage, `places` decimals: `39.1%`, `2.76%` (never formatChange's signed `+2.76%`). */
export const formatShare = (percent, places = 1) => `${percent.toFixed(places)}%`;

/** The day's amplitude in percent, (high − low) / previous close × 100; null without all three. */
export function amplitude(quote) {
  return positive(quote.high) && positive(quote.low) && positive(quote.previousClose)
    ? (quote.high - quote.low) / quote.previousClose * 100 : null;
}

// A count the quote carries as a cell in its size unit, or null without one.
const sizeCell = (quote, key, n, lang, tx) => (positive(n) ? { label: tx(key), ...formatSize(n, quote.sizeUnit, lang, tx) } : null);

// A two-column detail's place with no value keeps its label and reads `—`.
const emptyCell = (key, tx) => ({ label: tx(key), value: "—", unit: "" });

/**
 * The two-column detail's activity, always four cells in this order: volume, previous volume, turnover (compact, 2
 * decimals: `920.47 億`, `92.05B`) and the last trade's size; a value the quote does not carry reads `—`.
 */
export function activityCells(quote, lang, tx) {
  const turnover = positive(quote.turnover) ? { label: tx("detail.turnover"), ...compact(quote.turnover, lang, 2) } : null;
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
  return { left: side("detail.inner", inner, innerShare), right: side("detail.outer", outer, outerShare), innerShare, outerShare };
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
  if (matches && levelCount(book) > 0) return { title: auction ? "detail.auctionBook" : "detail.book", book, line: null };
  const reason = quote.fallback ?? (quote.cached ? quote.error : null);
  return { title: "detail.book", book: null, line: reason ? "reason" : matches ? "detail.bookEmpty" : "detail.bookNone" };
}

// A level as a ladder rung, with its change % against `previousClose`; a market order (no price) has none and is marked.
const rung = (level, previousClose) => level && {
  price: level.price,
  size: level.size,
  change: level.price !== null && positive(previousClose) ? (level.price - previousClose) / previousClose * 100 : null,
  ...(level.price === null && { market: true }),
};

/**
 * The ladder's rows, best first, at most 5: each `{ bid, ask }`, a side without a level at that row null. A rung is
 * `{ price, size, change }`, `change` the % against `previousClose` (null without one or for a market order, which
 * also carries `market: true`).
 */
export function ladder(book, previousClose) {
  const rows = [];
  for (let i = 0; i < Math.min(5, Math.max(book.bids.length, book.asks.length)); i++) {
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

/** A count with its sign, grouped: `+1,584`, `-12`, `0`. */
export function formatSignedCount(n) {
  const text = formatCount(Math.abs(n));
  return text === "0" ? text : `${n > 0 ? "+" : "-"}${text}`;
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
    ? (positive(quote.avgPrice) ? plain("detail.avgPrice", number(quote, quote.avgPrice)) : null)
    : sizeCell(quote, pair ? "detail.volume24h" : "detail.volume", quote.volume, lang, tx);
  const limit = (label, value) => (hasLimits(quote.limitUp, quote.limitDown) ? plain(label, number(quote, value)) : null);
  const places = [first, limit("detail.limitUpPrice", quote.limitUp), limit("detail.limitDownPrice", quote.limitDown)];
  if (!pair) places.push(wide && swing !== null ? plain("detail.amplitude", formatShare(swing, 2)) : null);
  if (wide) {
    const keys = ["detail.avgPrice", "detail.limitUpPrice", "detail.limitDownPrice", "detail.amplitude"];
    return places.map((cell, i) => cell ?? emptyCell(keys[i], tx));
  }
  return places.some(Boolean) ? places : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The local calendar date of a time in ms as a comparable day key (year·10000 + month·100 + date).
function localDate(ms) {
  const date = new Date(ms);
  return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
}

/**
 * The row's and the detail's failure note for `quote` after `error` (its Yahoo Finance or sole source's reason): null
 * without an error; the string key for what is cached, the price first ("quote.cached"), else the line
 * ("quote.chartCached"); null when the line shown is the price source's own (the failure touches nothing shown); else
 * "reason", the reason alone, so a row priced by another source without its Yahoo Finance quote never loses why.
 */
export function failureNote(quote, error) {
  if (!error) return null;
  if (quote.cached) return "quote.cached";
  if (quote.chartCached) return "quote.chartCached";
  return quote.chartSource === quote.source ? null : "reason";
}

/**
 * A quote from an earlier day than `now`'s, by its own day (dayFor), gets its date, so a closed market never reads as
 * today's: "Oct 31" in English, "10/31" in the other languages.
 */
export function formatStaleDate(quote, now, lang = "en") {
  const day = dayFor(quote);
  return day(quote.timestamp) === day(now) ? "" : formatDate(quote.timestamp, lang);
}

/**
 * The day function a quote's "is it today" uses: taipeiDay for a Taiwan quote (resolvedMarket(symbol, exchange)
 * === "tw": stocks, futures, TAI/TWO/TFE indices), else the local date. The date and time still print in local time.
 */
export function dayFor(quote) {
  return resolvedMarket(quote.symbol, quote.exchange) === "tw" ? taipeiDay : localDate;
}

/**
 * The next moment after `now` at which a row's day (dayFor) turns, in ms: Taipei midnight for a Taiwan quote, else the
 * next local midnight. A turn that lands early (at or before `now`, or still on `now`'s date) steps on by the hour
 * until the date has turned. That is defense for a runtime whose Date resolves a midnight that way (QuickJS); no
 * tested case enters it.
 */
export function nextDayTurn(quote, now) {
  const day = dayFor(quote);
  if (day === taipeiDay) return nextTaipeiMidnight(now);
  const from = new Date(now);
  let turn = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1).getTime();
  for (let guard = 0; guard < 25 && (turn <= now || day(turn) === day(now)); guard++) {
    turn += HOUR_MS;
  }
  return turn;
}

/** A local date as a row prints it: "Oct 31" in English, "10/31" in the other languages. */
export function formatDate(timestamp, lang = "en") {
  const date = new Date(timestamp);
  return lang === "en" ? `${MONTHS[date.getMonth()]} ${date.getDate()}` : `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * What a row shows as its freshness label and its name, so nothing on the row says the same thing
 * twice: a name that only repeats the ticker is left out. A pair has no instrument name (its "name" is
 * the venue), so it never gets one of its own. The label always stays whole, also beside a name that
 * begins with it ("Live" beside "Live Nation Entertainment"). `name` is "" when there is none to show.
 */
export function rowName(symbol, label, name) {
  const named = name && name !== symbol && !isCryptoPair(symbol) ? name : "";
  return { label, name: named };
}

// The interfaces that read a Taiwan stock's Chinese name; the others keep the base quote's name.
const LOCAL_NAME_LANGUAGES = ["zh-TW", "zh-CN"];

/** The instrument name a row shows: an overlay's local name (MIS) in Chinese, else the base's. */
export function displayName(quote, lang) {
  return LOCAL_NAME_LANGUAGES.includes(lang) && quote.localName ? quote.localName : quote.name ?? null;
}

const two = (n) => String(n).padStart(2, "0");

/** Local wall-clock time, 24-hour: "15:04", or "15:04:05" with seconds. */
export function formatTime(timestamp, seconds = false) {
  const date = new Date(timestamp);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${time}:${two(date.getSeconds())}` : time;
}

// A time (formatTime) after its `date` when there is one: "Oct 31 15:04", or "15:04" with "" for the date.
const stamp = (date, timestamp, seconds = false) => `${date ? `${date} ` : ""}${formatTime(timestamp, seconds)}`;

/**
 * A real-time price's state in words, for the row and the detail dialog alike: "Live", the stop time,
 * else the session; null for an unconfirmed one, which has no word (its source names it alone).
 * `tx(key, params)` translates.
 */
export function stateText(fresh, tx) {
  if (fresh.state === "live") return tx("freshness.live");
  if (fresh.state === "stalled") return tx("freshness.stalled", { time: formatTime(fresh.stoppedAt) });
  if (fresh.state === "unconfirmed") return null;
  return tx(`session.${fresh.state}`);
}

/**
 * A row's freshness label: the state for a real-time price ("Live"), its source only while unconfirmed,
 * the stop time, the delay, or the session when it is not trading. Closed, and a listed closed day ("holiday"),
 * carry the last trade's time, with its date when not today; a day without trades ("noTrades") always with its date,
 * so an inference never hides how old its price is. A price not timed by a trade (timedByTrade) gives any of the three
 * no time, since its time is no trade, but still its date when it is from an earlier day (formatStaleDate), so a feed
 * stuck since then never hides its age.
 * `tx(key, params)` translates.
 */
export function freshnessLabel(quote, fresh, now, lang, tx) {
  switch (fresh.state) {
    case "unconfirmed":
      return tx(`src.${quote.source}`);
    case "delayed":
      return fresh.delayMinutes === null ? tx("freshness.delayed")
        : tx("freshness.delayedMinutes", { minutes: fresh.delayMinutes });
    case "closed":
    case "holiday":
    case "noTrades": {
      const word = tx(`session.${fresh.state}`);
      const traded = timedByTrade(quote);
      const date = traded && fresh.state === "noTrades" ? formatDate(quote.timestamp, lang) : formatStaleDate(quote, now, lang);
      if (!traded) return date ? `${word} · ${date}` : word;
      return `${word} · ${stamp(date, quote.timestamp)}`;
    }
    default:
      return stateText(fresh, tx);
  }
}

/**
 * The detail dialog's times, to the second: the quote's (with its date when not today, as in formatStaleDate), the
 * last trade when it is not the quote's own time (Yahoo 奇摩股市 times a quiet stock at the feed), the fetch.
 */
export function detailTimes(quote, now, lang, tx) {
  const date = formatStaleDate(quote, now, lang);
  const lastTrade = quote.tradeTime && quote.tradeTime !== quote.timestamp
    ? [tx("detail.lastTrade", { time: formatTime(quote.tradeTime, true) })] : [];
  return [tx("detail.quoted", { time: stamp(date, quote.timestamp, true) }), ...lastTrade,
    tx("detail.fetched", { time: formatTime(quote.fetchedAt, true) })];
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
      const night = times.night ? tx("detail.nightSession", { times: timeRange(times.night) })
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

/** A row with no price whose fetch failed: it will not price soon, so it gives up its empty lines. */
export function collapsedRow(row) {
  return !row.quote && Boolean(row.failed);
}
