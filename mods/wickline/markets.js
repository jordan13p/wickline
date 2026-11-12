// Which market a symbol trades on: from its form, or for an index from the exchange its source reports.
// No Herdr imports.
import { isCryptoPair, isFutureForm } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/**
 * "pair", "index" (a leading ^), "future" (letters then & or @: a TAIFEX code at Yahoo 奇摩股市), "other" (has =: a
 * currency or a Yahoo future such as ES=F) or "stock".
 */
export function kindOf(symbol) {
  if (isCryptoPair(symbol)) return "pair";
  if (symbol.startsWith("^")) return "index";
  if (isFutureForm(symbol)) return "future";
  return symbol.includes("=") ? "other" : "stock";
}

/**
 * "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other" (indices, currencies, other exchanges), by form alone. A
 * future is TAIFEX's: "tw".
 */
export function marketOf(symbol) {
  const kind = kindOf(symbol);
  if (kind === "pair") return "crypto";
  if (kind === "future") return "tw";
  if (kind !== "stock") return "other";
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "us";
  return SUFFIXES[symbol.slice(dot + 1)] ?? "other";
}

/** An index of Taiwan form (^TW…): Yahoo 奇摩股市 may know one that Yahoo Finance does not. */
export const isTaiwanForm = (symbol) => symbol.startsWith("^TW");

// The exchanges a source reports (Yahoo's exchangeName, Yahoo 奇摩股市's exchange) whose market is known.
// Closed on purpose: any other exchange leaves an index under "other", never a guess.
const EXCHANGES = {
  us: ["DJI", "SNP", "NIM", "NMS", "NYQ", "PCX", "CXI", "NYS", "WCB"],
  tw: ["TAI", "TWO", "TFE"],
  hk: ["HKG"],
  cn: ["SHH", "SHZ"],
  jp: ["JPX", "OSA"],
  kr: ["KSC", "KOE"],
};
const EXCHANGE_MARKET = Object.fromEntries(Object.entries(EXCHANGES).flatMap(([market, codes]) => codes.map((code) => [code, market])));

/** The market an exchange code belongs to, or null. */
export const exchangeMarket = (exchange) => EXCHANGE_MARKET[exchange] ?? null;

/**
 * A symbol's market: its form's, except an index, which takes its source's reported `exchange` (other until
 * one is reported, or when it is not in the table). A currency or a Yahoo future (=) stays other.
 */
export function resolvedMarket(symbol, exchange) {
  return symbol.startsWith("^") ? exchangeMarket(exchange) ?? "other" : marketOf(symbol);
}

// Lunch breaks in local minutes since midnight; `offsetMin` is the exchange clock's fixed UTC offset (no DST).
const TOKYO_LUNCH = { offsetMin: 540, from: 690, to: 750 };
const HONG_KONG_LUNCH = { offsetMin: 480, from: 720, to: 780 };
const CHINA_LUNCH = { offsetMin: 480, from: 690, to: 780 };

// TAIFEX's published hours (Taipei, +8 h, no DST), in minutes since midnight; each session opens Monday to
// Friday (Sunday 0). The night session runs past midnight into the next day. Holidays follow the data only.
export const TAIFEX_HOURS = Object.freeze({ offsetMin: 480, weekdays: [1, 2, 3, 4, 5], sessions: [
  { from: 525, to: 825 },   // day, 08:45–13:45
  { from: 900, to: 1740 },  // night, 15:00–05:00 the next day
] });
export const DAY_SESSION = TAIFEX_HOURS.sessions[0];
export const NIGHT_SESSION = TAIFEX_HOURS.sessions[1];

// Regular hours used only for a Taiwan or US quote with no trading periods yet; exchange-local minutes.
export const TWSE_HOURS = Object.freeze({ offsetMin: 480, weekdays: [1, 2, 3, 4, 5], from: 540, to: 810 }); // 09:00–13:30 Taipei, TWSE and TPEx
export const US_HOURS = Object.freeze({ weekdays: [1, 2, 3, 4, 5], from: 570, to: 960 });                  // 09:30–16:00 New York

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

const LIVE = { realtime: true, delayS: null };
const late = (delayS, lunch = null) => ({ delayS, lunch });

// How Yahoo Finance serves each exchange it reports. Closed on purpose: any other code reads as a delay not
// provided, never a guess. It mixes Yahoo's facts (realtime, delayS) with the exchange's own (lunch, fx), and
// stays here rather than in a provider, since the view reads both together.
const RULES = {
  NMS: LIVE, NYQ: LIVE, PCX: LIVE, // measured 2026-11-09, lag 1–16 s
  NGM: LIVE, NCM: LIVE, ASE: LIVE, BTS: LIVE, // measured 2026-11-10 in a US session: NGM, NCM, ASE and BTS real time (0–34 s)
  SNP: LIVE, DJI: LIVE, NIM: LIVE, // measured 2026-11-09
  CCY: { ...LIVE, fx: true }, // measured 2026-11-10, lag 2–31 s; indicative quotes
  TAI: late(1200), TWO: late(1200), // measured 2026-11-10, 1198–1220 s
  KSC: late(1200), KOE: late(1200), // measured 2026-11-10, 1197–1210 s
  JPX: late(900, TOKYO_LUNCH), OSA: late(900, TOKYO_LUNCH), // measured 2026-11-10 (899–901 s, after lunch); Yahoo help says 20
  HKG: late(900, HONG_KONG_LUNCH), // measured 2026-11-10, 896–907 s
  SHH: late(900, CHINA_LUNCH), SHZ: late(900, CHINA_LUNCH), // measured 2026-11-10, 898–901 s (help says 30)
  CXI: late(1200), // measured 2026-11-09, 1117 s (over 15 min)
  PNK: late(900), NYS: late(900), WCB: late(900), // Yahoo help (SLN2310)
  CME: { ...late(600), futures: true }, NYM: { ...late(600), futures: true }, CMX: { ...late(600), futures: true }, // measured 2026-11-10, 592–611 s
  CBT: { ...late(600), futures: true }, // CME Group, as CME; not measured
};

// Every rule in full, built once and shared by every caller, so frozen.
const NONE = Object.freeze({ realtime: false, delayS: null, lunch: null, futures: false, fx: false });
const FULL = new Map(Object.entries(RULES).map(([code, rule]) => [code, Object.freeze({ ...NONE, ...rule })]));
const FUTURE_BY_FORM = Object.freeze({ ...NONE, futures: true });
const FX_BY_FORM = Object.freeze({ ...NONE, ...LIVE, fx: true });

// A Taiwan stock's suffix, which keeps TAI's 20 min when Yahoo reports no exchange or one not in the table.
const TAIWAN_SUFFIX = /\.TWO?$/;

/**
 * How fresh Yahoo Finance's quotes are for `exchange`: `realtime`, else `delayS` (null: not provided), the
 * exchange's `lunch` break or null, and whether it trades `futures` or `fx`. A `.TW`/`.TWO` symbol whose
 * exchange is missing or not in the table takes TAI's rule. Only without a reported exchange does any other
 * form decide: `=F` is a future with no delay known, `=X` real-time FX.
 */
export function exchangeRule(exchange, symbol) {
  const listed = exchange ? FULL.get(exchange) : undefined;
  if (listed) return listed;
  if (TAIWAN_SUFFIX.test(symbol)) return FULL.get("TAI");
  if (exchange) return NONE;
  if (symbol.endsWith("=F")) return FUTURE_BY_FORM;
  if (symbol.endsWith("=X")) return FX_BY_FORM;
  return NONE;
}

// The exchange a settings page's Yahoo fallback describes for its market.
export const TYPICAL_EXCHANGE = { us: "NMS", tw: "TAI" };

// The filter row shows only for a list long enough, and mixed enough, to be worth narrowing.
export const FILTER_MIN_SYMBOLS = 8;
export const FILTER_MIN_MARKETS = 2;

// The order of the filters, fixed per interface language so it never depends on what the list holds or how
// it is ordered: Japanese and Korean put their own market first, both Chinese put Taiwan first, and English
// starts with the US.
const MARKET_ORDER = {
  en: ["us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-TW": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-CN": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  ja: ["jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"],
  ko: ["kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"],
};

/** Every market in `lang`'s fixed order; a language without its own order takes English's. */
export const marketOrder = (lang) => MARKET_ORDER[lang] ?? MARKET_ORDER.en;

/**
 * The filters to offer: `all` with the list's length, then each market on the list in `lang`'s fixed order,
 * with its count (so the counts add up to `all`). Empty below the thresholds. `marketFor` gives a symbol's
 * market (main.js passes the resolved one, see resolvedMarket), as in every filter function below.
 */
export function marketFilters(symbols, marketFor, lang = "en") {
  const counts = {};
  for (const symbol of symbols) {
    const market = marketFor(symbol);
    counts[market] = (counts[market] ?? 0) + 1;
  }
  const listed = marketOrder(lang).filter((id) => counts[id]);
  if (symbols.length < FILTER_MIN_SYMBOLS || listed.length < FILTER_MIN_MARKETS) return [];
  return [{ id: "all", count: symbols.length }, ...listed.map((id) => ({ id, count: counts[id] }))];
}

/** `symbol` is in the market `filter` names; every symbol is in `all`. */
export const inFilter = (symbol, filter, marketFor) => filter === "all" || marketFor(symbol) === filter;

/** The symbols a filter shows, in list order. `all`, an unknown filter or a market not on the list shows everything. */
export function visibleSymbols(symbols, filter, marketFor) {
  if (filter === "all") return symbols;
  const shown = symbols.filter((symbol) => inFilter(symbol, filter, marketFor));
  return shown.length ? shown : symbols;
}

/**
 * The market filter as a copy reads it, for one render: the `filters` to offer (marketFilters), the
 * `chosen` one (the stored `filter` while the row offers it, otherwise All) and the symbols it shows (`shown`).
 */
export function readFilter(symbols, filter, marketFor, lang = "en") {
  const filters = marketFilters(symbols, marketFor, lang);
  const chosen = filters.some(({ id }) => id === filter) ? filter : "all";
  return { filters, chosen, shown: visibleSymbols(symbols, chosen, marketFor) };
}

/** The symbol after `symbol` in `list`, or null (also for the last one). */
export const nextOf = (list, symbol) => list[list.indexOf(symbol) + 1] ?? null;

/**
 * Where a drop in the filtered list lands in the full list, as `watch.move`'s `before` (null: the end):
 * in front of the visible row it was dropped on, or, after the last visible row, in front of that row's
 * successor in the full list.
 */
export function dropBefore(full, visible, before) {
  if (before !== null) return before;
  return nextOf(full, visible[visible.length - 1]);
}

/** The filter after `symbol` was added (or found already listed) in `symbols`: All when it would hide that symbol. */
export function filterAfterAdd(symbols, filter, symbol, marketFor) {
  return readFilter(symbols, filter, marketFor).shown.includes(symbol) ? filter : "all";
}

/**
 * The filter after a remove left `symbols`: All when the chosen market has no symbol left and no symbol is
 * `pending` (an index still waiting for its first quote, whose market is not known yet).
 */
export function filterAfterRemove(symbols, filter, marketFor, pending) {
  return symbols.some((symbol) => inFilter(symbol, filter, marketFor) || pending(symbol)) ? filter : "all";
}

/**
 * The remove kept `filter` only for a `pending` index: no symbol is in its market. The index may resolve
 * elsewhere, so the choice settles (filterAfterRemove with nothing pending) once no index is pending.
 */
export function heldFilter(symbols, filter, marketFor, pending) {
  return filter !== "all" && filterAfterRemove(symbols, filter, marketFor, pending) === filter
    && !symbols.some((symbol) => inFilter(symbol, filter, marketFor));
}

// The key under which a copy keeps its market filter in its own storage (see main.js).
export const FILTER_STORAGE_KEY = "wickline.filter";

/**
 * The filter a copy opens with: its stored choice, else `prop` (the one it was opened with), else All.
 * It writes nothing: the props are saved with the tab, so they seed the copy on every start until the
 * person picks a filter there, and only that choice is stored (a write here would leave a storage file
 * behind for every moved copy). `storage`: the copy's own, with `getItem`; one that cannot be read reads
 * as nothing stored.
 */
export function openFilter(storage, prop) {
  let stored = null;
  try {
    stored = storage.getItem(FILTER_STORAGE_KEY) || null;
  } catch {
    // Unreadable: as if nothing were stored.
  }
  return stored ?? (typeof prop === "string" ? prop : "all");
}
