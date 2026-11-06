// What a row does when the person adds, removes or drops it, apart from drawing it. No Herdr imports.
import { chosenFilter, marketOf, visibleSymbols } from "./markets.js";

// Every row motion: fade in, fade out and collapse, slide into place.
export const ROW_MOTION_MS = 150;
// A transition animates only later target changes, so a row renders once at its start value and flips
// to the end value after this long (spike: 32 ms is enough for the first frame to be drawn).
export const MOTION_GAP_MS = 32;
// After the flip, the time to let the transition finish before the state is dropped.
export const MOTION_END_MS = ROW_MOTION_MS + 50;

/**
 * The rows to draw: the shown symbols in order, with each row that is leaving (a ghost, `{ symbol,
 * before }`, `before` being the symbol that followed it in the full list, null for the end) where it
 * was. A ghost whose `before` is itself leaving sits in front of that ghost, so rows taken one after
 * another keep their order. A ghost is left out when the market filter would not show it, or when
 * nothing it was anchored to is on the list any more. `filter` is the copy's choice, read as the rows
 * read it.
 * @returns {{ symbol: string, ghost: object|null }[]}
 */
export function rowsWithGhosts(symbols, filter, ghosts) {
  const chosen = chosenFilter(symbols, filter);
  const shown = new Set(visibleSymbols(symbols, chosen));
  const leaving = new Map(ghosts.map((g) => [g.symbol, g]));
  const live = new Set(symbols);
  // Each ghost joins the group of the live symbol it ends up in front of, after the ghosts in front of it.
  const groups = new Map();
  ghosts.forEach((ghost, order) => {
    if (chosen !== "all" && marketOf(ghost.symbol) !== chosen) return;
    let anchor = ghost.before;
    let hops = 0;
    while (anchor !== null && !live.has(anchor)) {
      anchor = hops < ghosts.length ? leaving.get(anchor)?.before : undefined;
      if (anchor === undefined) return;
      hops += 1;
    }
    groups.set(anchor, [...(groups.get(anchor) ?? []), { ghost, hops, order }]);
  });
  const ghostsIn = (anchor) => (groups.get(anchor) ?? [])
    .sort((a, b) => b.hops - a.hops || b.order - a.order)
    .map(({ ghost }) => ({ symbol: ghost.symbol, ghost }));
  return [
    ...symbols.flatMap((symbol) => [...ghostsIn(symbol), ...(shown.has(symbol) ? [{ symbol, ghost: null }] : [])]),
    ...ghostsIn(null),
  ];
}

/**
 * How far above (positive: below) its new place a dropped row starts, so it slides there: the old
 * distance from the top of the list minus the new one, from the rows' measured heights. Null when it
 * stays put on screen or a height is not known (then it just lands).
 */
export function settleOffset(before, after, symbol, heights) {
  const top = (order) => {
    let sum = 0;
    for (const other of order) {
      if (other === symbol) return sum;
      if (!(heights[other] > 0)) return null;
      sum += heights[other];
    }
    return null;
  };
  const from = top(before);
  const to = top(after);
  return from === null || to === null || from === to ? null : from - to;
}
