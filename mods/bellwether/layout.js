// Which layout Bellwether draws at a size, and which table columns fit a width.
// No Herdr imports, so tests run it under Node.

// Below this height: the one-line band.
export const BAND_MAX_HEIGHT = 72;
// From this width: the table; below it, the two-line sidebar rows.
export const TABLE_MIN_WIDTH = 720;
// The table never grows wider; a wider pane centers it.
export const TABLE_MAX_WIDTH = 1280;
// Each side of a row keeps a gutter: the drag handle on the left, × on the right. The header,
// the add field and the footer line up with the content between the gutters.
export const GUTTER = 20;
export const COLUMN_GAP = 12;
// The name takes what the fixed columns leave, within these bounds; below the minimum it drops.
export const NAME_MIN_WIDTH = 120;
export const NAME_MAX_WIDTH = 320;

/**
 * In display order. `width` is the content width in px (`null`: the flexible name). Numbers align
 * right; the price column holds the number and a fixed slot for the currency.
 */
export const TABLE_COLUMNS = [
  { id: "symbol", width: 88, align: "left" },
  { id: "name", width: null, align: "left" },
  { id: "state", width: 128, align: "left" },
  { id: "line", width: 120, align: "left" },
  { id: "price", width: 112, align: "right" },
  { id: "change", width: 72, align: "right" },
  { id: "changePct", width: 64, align: "right" },
  { id: "high", width: 80, align: "right" },
  { id: "low", width: 80, align: "right" },
  { id: "prevClose", width: 80, align: "right" },
];

// First to go when the width cannot hold every column; the others never drop.
export const DROP_ORDER = ["prevClose", "low", "high", "change", "line", "name"];

/** "band" below BAND_MAX_HEIGHT, else "sidebar" below TABLE_MIN_WIDTH, else "table"; null (not laid out yet): "sidebar". */
export function layoutFor(size) {
  if (!size) return "sidebar";
  if (size.height < BAND_MAX_HEIGHT) return "band";
  return size.width < TABLE_MIN_WIDTH ? "sidebar" : "table";
}

// The width `ids` need: their fixed widths, the name at its minimum, the gaps and both gutters.
function needed(ids) {
  const widths = ids.map((id) => TABLE_COLUMNS.find((column) => column.id === id).width ?? NAME_MIN_WIDTH);
  return widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * (ids.length - 1) + 2 * GUTTER;
}

/** The column ids that fit `width` (capped at TABLE_MAX_WIDTH), in display order. */
export function tableColumns(width) {
  const room = Math.min(width, TABLE_MAX_WIDTH);
  let ids = TABLE_COLUMNS.map((column) => column.id);
  for (const drop of DROP_ORDER) {
    if (needed(ids) <= room) break;
    ids = ids.filter((id) => id !== drop);
  }
  return ids;
}

/** The name column's width for `ids` at `width`: the room the others leave, within its bounds. */
export function nameWidth(width, ids) {
  const room = Math.min(width, TABLE_MAX_WIDTH);
  return Math.max(NAME_MIN_WIDTH, Math.min(NAME_MAX_WIDTH, room - needed(ids) + NAME_MIN_WIDTH));
}

/**
 * Where the copy in its own tab goes back to: a pane of the tab it was opened from (that tab's focused
 * pane, else its first terminal, else any), else the focused pane, else any terminal. Never a
 * Bellwether pane, and never a pane of `ownTab` (the tab about to lose this copy): a shell the person
 * split in there is not a place to go back beside. `panes` as panes() gives them, `focused` as
 * focused(); null: nowhere to go.
 */
export function returnPane(panes, fromTab, focused, ownTab = null) {
  const others = panes.filter((p) => p.mod !== "bellwether" && p.tab !== ownTab);
  const home = others.filter((p) => p.tab === fromTab);
  const there = home.find((p) => p.focused) ?? home.find((p) => p.terminal) ?? home[0];
  if (there) return there.pane;
  const focusedPane = focused?.pane && others.find((p) => p.pane === focused.pane);
  return (focusedPane ?? others.find((p) => p.terminal))?.pane ?? null;
}

// Another pane shares `pane`'s tab.
const hasCompany = (panes, pane) => panes.some((p) => p.tab === pane.tab && p.pane !== pane.pane);

/** A Bellwether pane in the shown `tab` has another pane beside it: only then can it get a tab of its own. */
export function canOpenOwnTab(panes, tab) {
  return panes.some((p) => p.mod === "bellwether" && p.tab === tab && hasCompany(panes, p));
}

/**
 * The Bellwether pane to move to its own tab: the focused one (clicking a mod pane focuses it), when it
 * is not alone in its tab. Null otherwise, also for a docked block, which is not a pane.
 */
export function ownTabSource(panes) {
  const me = panes.find((p) => p.mod === "bellwether" && p.focused);
  return me && hasCompany(panes, me) ? me : null;
}

/**
 * The Bellwether pane in `after` that `before` did not have (in `tab`, when given): the new copy is
 * open, so the old one may close. Null: the command did nothing visible, so nothing closes.
 */
export function newBellwether(before, after, tab = null) {
  const old = new Set(before.map((p) => p.pane));
  return after.find((p) => p.mod === "bellwether" && !old.has(p.pane) && (tab === null || p.tab === tab)) ?? null;
}
