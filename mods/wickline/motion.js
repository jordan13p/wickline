// Row motion when the user adds, removes or drops a row (the timing and order, not the drawing).
// Also how long the refresh icon turns and how long Undo stays.
import { inFilter } from "./filter.js";

// Every row motion: fade in, fade out and collapse, slide into place.
export const ROW_MOTION_MS = 150;
// A transition animates only later target changes, so a row renders once at its start value and flips
// to the end value after this long. 32 ms was enough for the first frame to be drawn.
export const MOTION_GAP_MS = 32;
// After the flip, the time to let the transition finish before the state is dropped.
export const MOTION_END_MS = ROW_MOTION_MS + 50;

// One turn of the refresh icon.
export const SPIN_MS = 900;

// How long Undo stays after a row is removed.
export const UNDO_MS = 10_000;

/**
 * The whole turns, counted from the first press, that a spin running for `elapsedMs` must reach so a press made now
 * gets a whole turn of its own. The icon then always stops upright.
 */
export const spinTurnsFor = (elapsedMs, turnMs) => Math.ceil((elapsedMs + turnMs) / turnMs);

/**
 * The rows to draw, `{ symbol, ghost }`: the shown symbols in order, and each leaving row (a ghost) where it was.
 * A ghost is `{ symbol, before }`; `before` is the symbol that followed it in the full list, null at the end.
 * A ghost whose `before` is leaving too sits in front of that ghost, so rows removed one after another keep their
 * order. A ghost is left out when the market filter hides it or nothing it was anchored to is listed any more.
 * The second argument is readFilter's `{ chosen, shown }`.
 */
export function rowsWithGhosts(symbols, { chosen, shown }, ghosts, marketFor) {
  if (!ghosts.length) return shown.map((symbol) => ({ symbol, ghost: null }));
  const showing = new Set(shown);
  const leaving = new Map(ghosts.map((g) => [g.symbol, g]));
  const live = new Set(symbols);
  // Each ghost joins the group of the live symbol it ends up in front of, after the ghosts in front of it.
  const groups = new Map();
  ghosts.forEach((ghost, order) => {
    if (!inFilter(ghost.symbol, chosen, marketFor)) return;
    let anchor = ghost.before;
    let hops = 0;
    while (anchor !== null && !live.has(anchor)) {
      anchor = hops < ghosts.length ? leaving.get(anchor)?.before : undefined;
      if (anchor === undefined) return;
      hops += 1;
    }
    groups.set(anchor, [...(groups.get(anchor) ?? []), { ghost, hops, order }]);
  });
  const ghostsIn = (anchor) =>
    (groups.get(anchor) ?? [])
      .sort((a, b) => b.hops - a.hops || b.order - a.order)
      .map(({ ghost }) => ({ symbol: ghost.symbol, ghost }));
  return [
    ...symbols.flatMap((symbol) => [...ghostsIn(symbol), ...(showing.has(symbol) ? [{ symbol, ghost: null }] : [])]),
    ...ghostsIn(null),
  ];
}

/**
 * How far from its new place a dropped row starts, so it slides there: the old distance from the top of the list
 * minus the new one, from the rows' measured heights. Positive is below. Null when the row stays put on screen or a
 * height is not known; the row then just lands.
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
