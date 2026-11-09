// How a quote is written and drawn as text and numbers, by hand: Herdr's QuickJS runtime has no Intl.
// No Herdr imports, so tests run it under Node.
import { isCryptoPair, positive } from "./quotes.js";

/**
 * The line through `series`, scaled into its box as [x%, y%] points, and where
 * the reference price (the previous close) falls, or null when it is outside.
 * Fewer than two points draw nothing.
 */
export function chartGeometry(series, reference) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const values = positive(reference) ? [...series, reference] : series;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < max * 1e-9) { min -= 1; max += 1; }
  // 8% headroom keeps the stroke inside the box.
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;
  const y = (value) => Math.round((1 - (value - min) / (max - min)) * 10000) / 100;
  const last = series.length - 1;
  return {
    points: series.map((value, index) => [Math.round(index / last * 10000) / 100, y(value)]),
    reference: positive(reference) ? y(reference) : null,
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

/** The compact band leaves out USD and a pair's own quote currency. */
export function formatBandPrice(quote) {
  const named = quote.currency === "USD" || quote.symbol.endsWith(`/${quote.currency}`);
  return formatPrice(named ? { ...quote, currency: null } : quote);
}

// `value` (the price by default) without its currency, for a fixed right-aligned column.
export function number(quote, value = quote.price) {
  return typeof value === "number" && value > 0 ? formatPrice({ ...quote, price: value, currency: null }) : "—";
}

// The sign follows the rounded text, so a change too small to show reads `0.00`, never `+0.00` or `-0.00`.
const withSign = (value, size) => (/[1-9]/.test(size) ? `${value >= 0 ? "+" : "-"}${size}` : size);

// The day's change in the price's own units: `+3.58`, `-1,234.56`.
export function signed(quote) {
  if (!(quote.previousClose > 0)) return "—";
  const change = quote.price - quote.previousClose;
  return withSign(change, Math.abs(change) > 0 ? formatPrice({ ...quote, price: Math.abs(change), currency: null }) : "0.00");
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A quote from an earlier local day gets its date, so a closed market never reads as today's:
 * "Oct 31" in English, "10/31" in the other languages.
 */
export function formatStaleDate(timestamp, now, lang = "en") {
  const quoted = new Date(timestamp);
  const today = new Date(now);
  if (quoted.getFullYear() === today.getFullYear() && quoted.getMonth() === today.getMonth()
    && quoted.getDate() === today.getDate()) return "";
  return lang === "en" ? `${MONTHS[quoted.getMonth()]} ${quoted.getDate()}` : `${quoted.getMonth() + 1}/${quoted.getDate()}`;
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

/**
 * A real-time price's state in words, for the row and the detail dialog alike: "Live", the stop time,
 * else the session (an unconfirmed one reads as unknown). `tx(key, params)` translates.
 */
export function stateText(fresh, tx) {
  if (fresh.state === "live") return tx("freshness.live");
  if (fresh.state === "stalled") return tx("freshness.stalled", { time: formatTime(fresh.stoppedAt) });
  return tx(`session.${fresh.state === "unconfirmed" ? "unknown" : fresh.state}`);
}

/**
 * A row's freshness label: the state for a real-time price ("Live"), its source only while the session
 * is not known, the stop time, the delay, or the session when it is not trading.
 * `tx(key, params)` translates.
 */
export function freshnessLabel(quote, fresh, now, lang, tx) {
  switch (fresh.state) {
    case "unconfirmed":
      return tx(`src.${quote.source}`);
    case "delayed":
      return fresh.delayMinutes === null ? tx("freshness.delayed")
        : tx("freshness.delayedMinutes", { minutes: fresh.delayMinutes });
    case "closed": {
      const date = formatStaleDate(quote.timestamp, now, lang);
      return `${tx("session.closed")} · ${date ? `${date} ` : ""}${formatTime(quote.timestamp)}`;
    }
    default:
      return stateText(fresh, tx);
  }
}

/**
 * The detail dialog's times, to the second: the quote's (with its date when not today), the last
 * trade when it is not the quote's own time (Yahoo 奇摩股市 times a quiet stock at the feed), the fetch.
 */
export function detailTimes(quote, now, lang, tx) {
  const date = formatStaleDate(quote.timestamp, now, lang);
  const lastTrade = quote.tradeTime && quote.tradeTime !== quote.timestamp
    ? [tx("detail.lastTrade", { time: formatTime(quote.tradeTime, true) })] : [];
  return [tx("detail.quoted", { time: `${date ? `${date} ` : ""}${formatTime(quote.timestamp, true)}` }), ...lastTrade,
    tx("detail.fetched", { time: formatTime(quote.fetchedAt, true) })];
}
