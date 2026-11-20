// How a quote is written and drawn as text and numbers, by hand: Herdr's QuickJS runtime has no Intl.
// No Herdr imports, so tests run it under Node.
import { isCryptoPair, timedByTrade } from "./quotes.js";
import { nextTaipeiMidnight, taipeiDay } from "./calendar.js";
import { resolvedMarket } from "./markets.js";
import { HOUR_MS } from "./time.js";

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
  const price = group(whole) + (fraction === undefined ? "" : `.${fraction}`);
  return quote.currency ? `${price} ${quote.currency}` : price;
}

/** The currency the compact band names: none for USD or a pair's own quote currency. */
export function bandCurrency(quote) {
  return !quote.currency || quote.currency === "USD" || quote.symbol.endsWith(`/${quote.currency}`)
    ? null
    : quote.currency;
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
  en: {
    step: 1_000,
    units: [
      ["B", 1e9],
      ["M", 1e6],
      ["K", 1e3],
    ],
  },
  "zh-TW": {
    step: 10_000,
    units: [
      ["億", 1e8],
      ["萬", 1e4],
    ],
  },
  "zh-CN": {
    step: 10_000,
    units: [
      ["亿", 1e8],
      ["万", 1e4],
    ],
  },
  ja: {
    step: 10_000,
    units: [
      ["億", 1e8],
      ["万", 1e4],
    ],
  },
  ko: {
    step: 10_000,
    units: [
      ["억", 1e8],
      ["만", 1e4],
    ],
  },
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

/** A count with its sign, grouped: `+1,584`, `-12`, `0`. */
export function formatSignedCount(n) {
  const text = formatCount(Math.abs(n));
  return text === "0" ? text : `${n > 0 ? "+" : "-"}${text}`;
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

/**
 * The date the detail writes under its chart's left end, like the start of a time axis: its first point's local date
 * ("Nov 19" in English, "11/19" in the other languages), for every timed line, so the layout holds still from the
 * open and a line across midnight (a US index) reads from its start. "" when the line has fewer than two points or
 * not exactly one time per point, since its first point's day is then not known.
 */
export function lineDate(quote, lang) {
  const series = Array.isArray(quote.series) ? quote.series : [];
  const timed = Array.isArray(quote.times) && quote.times.length === series.length;
  return series.length >= 2 && timed ? formatDate(quote.times[0], lang) : "";
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
  return LOCAL_NAME_LANGUAGES.includes(lang) && quote.localName ? quote.localName : (quote.name ?? null);
}

const two = (n) => String(n).padStart(2, "0");

/** Local wall-clock time, 24-hour: "15:04", or "15:04:05" with seconds. */
export function formatTime(timestamp, seconds = false) {
  const date = new Date(timestamp);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${time}:${two(date.getSeconds())}` : time;
}

// A time (formatTime) after its `date` when there is one: "Oct 31 15:04", or "15:04" with "" for the date.
export const stamp = (date, timestamp, seconds = false) => `${date ? `${date} ` : ""}${formatTime(timestamp, seconds)}`;

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
      return fresh.delayMinutes === null
        ? tx("freshness.delayed")
        : tx("freshness.delayedMinutes", { minutes: fresh.delayMinutes });
    case "closed":
    case "holiday":
    case "noTrades": {
      const word = tx(`session.${fresh.state}`);
      const traded = timedByTrade(quote);
      const date =
        traded && fresh.state === "noTrades" ? formatDate(quote.timestamp, lang) : formatStaleDate(quote, now, lang);
      if (!traded) return date ? `${word} · ${date}` : word;
      return `${word} · ${stamp(date, quote.timestamp)}`;
    }
    default:
      return stateText(fresh, tx);
  }
}

/** A row with no price whose fetch failed: it will not price soon, so it gives up its empty lines. */
export function collapsedRow(row) {
  return !row.quote && Boolean(row.failed);
}
