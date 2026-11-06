// Which market a symbol trades on, from its form alone. No Herdr imports.
import { isCryptoPair } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/** "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other" (indices, currencies, other exchanges). */
export function marketOf(symbol) {
  if (isCryptoPair(symbol)) return "crypto";
  // Indices start with ^, currencies and futures contain =.
  if (/^\^|=/.test(symbol)) return "other";
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "us";
  return SUFFIXES[symbol.slice(dot + 1)] ?? "other";
}

// The filter row shows only for a list long enough, and mixed enough, to be worth narrowing.
export const FILTER_MIN_SYMBOLS = 8;
export const FILTER_MIN_MARKETS = 2;

// The order of the filters: the language's home market first, then the rest as everywhere else, so it never
// depends on what the list holds or how it is ordered.
const MARKET_ORDER = {
  en: ["us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-TW": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-CN": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  ja: ["jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"],
  ko: ["kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"],
};

/**
 * The filters to offer: `all` with the list's length, then each market on the list in `lang`'s fixed order,
 * with its count (so the counts add up to `all`). Empty below the thresholds.
 */
export function marketFilters(symbols, lang = "en") {
  const counts = {};
  for (const symbol of symbols) {
    const market = marketOf(symbol);
    counts[market] = (counts[market] ?? 0) + 1;
  }
  const listed = (MARKET_ORDER[lang] ?? MARKET_ORDER.en).filter((id) => counts[id]);
  if (symbols.length < FILTER_MIN_SYMBOLS || listed.length < FILTER_MIN_MARKETS) return [];
  return [{ id: "all", count: symbols.length }, ...listed.map((id) => ({ id, count: counts[id] }))];
}

/** The symbols a filter shows, in list order. `all`, an unknown filter or a market not on the list shows everything. */
export function visibleSymbols(symbols, filter) {
  if (filter === "all") return symbols;
  const shown = symbols.filter((symbol) => marketOf(symbol) === filter);
  return shown.length ? shown : symbols;
}

/** A stored choice counts only while the row offers it; otherwise the list reads as All. */
export function chosenFilter(symbols, filter) {
  return marketFilters(symbols).some(({ id }) => id === filter) ? filter : "all";
}

/** The filter after `symbol` was added (or found already listed) in `symbols`: All when it would hide that symbol. */
export function filterAfterAdd(symbols, filter, symbol) {
  return visibleSymbols(symbols, chosenFilter(symbols, filter)).includes(symbol) ? filter : "all";
}

/** The filter after a remove left `symbols`: All when the chosen market has no symbol left. */
export function filterAfterRemove(symbols, filter) {
  return filter === "all" || symbols.some((symbol) => marketOf(symbol) === filter) ? filter : "all";
}

// The key under which a copy keeps its market filter in its own storage (see main.js).
export const FILTER_STORAGE_KEY = "wickline.filter";

/**
 * The filter a copy opens with: its stored choice, else `prop` (the one it was opened with), else All.
 * Nothing stored and given a market, it stores that once. `storage`: the copy's own, with `getItem` and
 * `setItem`; one that cannot be read reads as nothing stored, and a failed write is only not remembered.
 */
export function openFilter(storage, prop) {
  let stored = null;
  try {
    stored = storage.getItem(FILTER_STORAGE_KEY) || null;
  } catch {
    // Unreadable: as if nothing were stored.
  }
  const filter = stored ?? (typeof prop === "string" ? prop : "all");
  if (stored === null && filter !== "all") {
    try {
      storage.setItem(FILTER_STORAGE_KEY, filter);
    } catch {
      // Not remembered after a restart; the copy keeps using it.
    }
  }
  return filter;
}
