// Which market a symbol trades on: from its form, or for an index from the exchange its source reports.
// No Herdr imports.
import { isCryptoPair } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/** "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other" (indices, currencies, other exchanges), by form alone. */
export function marketOf(symbol) {
  if (isCryptoPair(symbol)) return "crypto";
  // Indices start with ^, currencies and futures contain =.
  if (/^\^|=/.test(symbol)) return "other";
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "us";
  return SUFFIXES[symbol.slice(dot + 1)] ?? "other";
}

/** "pair", "index" (a leading ^), "other" (a currency or future: it has =) or "stock". */
export function kindOf(symbol) {
  if (isCryptoPair(symbol)) return "pair";
  if (symbol.startsWith("^")) return "index";
  return symbol.includes("=") ? "other" : "stock";
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
 * one is reported, or when it is not in the table). A currency or future stays other.
 */
export function resolvedMarket(symbol, exchange) {
  return symbol.startsWith("^") ? exchangeMarket(exchange) ?? "other" : marketOf(symbol);
}

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

/** The filter after a remove left `symbols`: All when the chosen market has no symbol left. */
export function filterAfterRemove(symbols, filter, marketFor) {
  return symbols.some((symbol) => inFilter(symbol, filter, marketFor)) ? filter : "all";
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
