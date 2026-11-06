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

export function formatChange(value) {
  return value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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
 * twice: a name that begins with the label (a pair's "Binance Spot" after "Binance") replaces it,
 * and a name that only repeats the ticker is left out. A pair has no instrument name (its "name" is
 * the venue), so it never gets one of its own. `name` is "" when there is none to show.
 */
export function rowName(symbol, label, name) {
  const named = name && name !== symbol ? name : "";
  if (named && label && named.startsWith(label)) return { label: named, name: "" };
  return { label, name: isCryptoPair(symbol) ? "" : named };
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
