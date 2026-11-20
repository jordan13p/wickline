// The market filter: the filters a list offers, the rows each shows, and its choice after an edit.
import { marketOrder } from "./markets.js";

// The filter row shows only for a list long enough, and mixed enough, to be worth narrowing.
export const FILTER_MIN_SYMBOLS = 8;
export const FILTER_MIN_MARKETS = 2;

/**
 * The filters to offer: `all` with the list's length, then each listed market with its count, in `lang`'s order.
 * Empty below the thresholds. Here and below, `marketFor` gives a symbol's market (main.js passes resolvedMarket).
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

/** Whether `symbol` is in the market `filter` names; every symbol is in `all`. */
export const inFilter = (symbol, filter, marketFor) => filter === "all" || marketFor(symbol) === filter;

/** The symbols a filter shows, in list order. `all`, an unknown filter or a market not on the list shows everything. */
export function visibleSymbols(symbols, filter, marketFor) {
  if (filter === "all") return symbols;
  const shown = symbols.filter((symbol) => inFilter(symbol, filter, marketFor));
  return shown.length ? shown : symbols;
}

/**
 * The market filter for one render: the `filters` to offer, the `chosen` one and the symbols it shows (`shown`).
 * `chosen` is the stored `filter` while it is offered, otherwise All.
 */
export function readFilter(symbols, filter, marketFor, lang = "en") {
  const filters = marketFilters(symbols, marketFor, lang);
  const chosen = filters.some(({ id }) => id === filter) ? filter : "all";
  return { filters, chosen, shown: visibleSymbols(symbols, chosen, marketFor) };
}

/** The symbol after `symbol` in `list`, or null after the last one. */
export const nextOf = (list, symbol) => list[list.indexOf(symbol) + 1] ?? null;

/**
 * Where a drop in the filtered list lands in the full list, as `watch.move`'s `before` (null for the end).
 * It lands in front of the visible row it was dropped on. Dropped after the last visible row, it lands in front of
 * that row's successor in the full list.
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
 * The filter after a remove left `symbols`: All when the chosen market has no symbol left and none is `pending`.
 * A pending symbol is an index waiting for its first quote, so its market is not known yet.
 */
export function filterAfterRemove(symbols, filter, marketFor, pending) {
  return symbols.some((symbol) => inFilter(symbol, filter, marketFor) || pending(symbol)) ? filter : "all";
}

/**
 * Whether a remove kept `filter` only for a pending index, with no symbol in its market. The index may resolve to
 * another market, so the choice settles once no index is pending.
 */
export function heldFilter(symbols, filter, marketFor, pending) {
  return (
    filter !== "all" &&
    filterAfterRemove(symbols, filter, marketFor, pending) === filter &&
    !symbols.some((symbol) => inFilter(symbol, filter, marketFor))
  );
}

// The key under which a copy keeps its market filter in its own localStorage.
export const FILTER_STORAGE_KEY = "wickline.filter";

/**
 * The filter a copy opens with: its stored choice, else `prop` (the one it was opened with), else All.
 * Storage that cannot be read counts as nothing stored.
 * It writes nothing. The props are saved with the tab and seed the copy on every start until the user picks a
 * filter there; only that choice is stored. A write here would leave a storage file behind for every moved copy.
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
