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

/**
 * The filters to offer: `all` with the list's length, then each market on the list in the order it first
 * appears, with its count (so the counts add up to `all`). Empty below the thresholds.
 */
export function marketFilters(symbols) {
  const counts = new Map();
  for (const symbol of symbols) {
    const market = marketOf(symbol);
    counts.set(market, (counts.get(market) ?? 0) + 1);
  }
  if (symbols.length < FILTER_MIN_SYMBOLS || counts.size < FILTER_MIN_MARKETS) return [];
  return [{ id: "all", count: symbols.length }, ...[...counts].map(([id, count]) => ({ id, count }))];
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
