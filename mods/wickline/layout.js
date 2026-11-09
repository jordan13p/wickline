// Which layout Wickline draws at a size, and which table columns fit a width.
// No Herdr imports, so tests run it under Node.

// Below this height: the one-line band.
export const BAND_MAX_HEIGHT = 72;
// From this width: the table; below it, the three-line sidebar rows.
export const TABLE_MIN_WIDTH = 720;
// The table never grows wider; a wider pane centers it.
export const TABLE_MAX_WIDTH = 1280;
// A row's left gutter holds the drag handle. Its right inset holds the remove × column, then the lane the
// list's scrollbar sits in, outside the rows. Every region (header, add field, filter row, table head, rows,
// footer) keeps the same gutter and inset, so they all end on one edge.
export const GUTTER = 20;
export const REMOVE_W = 16;
export const SCROLL_LANE = 12;
export const RIGHT_INSET = REMOVE_W + SCROLL_LANE;
export const COLUMN_GAP = 12;
// A sidebar row's price column: the number, then a slot for its currency. The table's price header
// leaves the same slot.
export const NUMBER_W = 72;
export const CODE_W = 34;
// The room a sidebar row's left lines keep before its day line grows past its narrowest.
export const NAME_ROOM = 150;
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

/** The content width in px of column `id`; null for the flexible name. */
export const columnWidth = (id) => TABLE_COLUMNS.find((column) => column.id === id).width;

// First to go when the width cannot hold every column; the others never drop.
export const DROP_ORDER = ["prevClose", "low", "high", "change", "line", "name"];

/** "band" below BAND_MAX_HEIGHT, else "sidebar" below TABLE_MIN_WIDTH, else "table"; null (not laid out yet): "sidebar". */
export function layoutFor(size) {
  if (!size) return "sidebar";
  if (size.height < BAND_MAX_HEIGHT) return "band";
  return size.width < TABLE_MIN_WIDTH ? "sidebar" : "table";
}

// The sidebar line's narrowest width.
export const SPARK_MIN = 32;

/**
 * A sidebar row's day line in px for a copy `width` px wide: SPARK_MIN, growing with the pane to 120 only once the
 * left lines keep NAME_ROOM beside the gutter, the right inset, the price column and the gaps on each side
 * of the line. SPARK_MIN before the copy is laid out.
 */
export function sparkWidth(width) {
  if (!(width > 0)) return SPARK_MIN;
  const room = width - GUTTER - RIGHT_INSET - (NUMBER_W + CODE_W) - 2 * COLUMN_GAP - NAME_ROOM;
  return Math.max(SPARK_MIN, Math.min(120, room));
}

/**
 * A layout block that docks Wickline beside Herdr's own side panels asks for their rounded, bordered
 * card with `"props": {"card": true}`. Only `true` counts; panes and tabs never ask (Herdr frames them).
 */
export const wantsCard = (props) => props?.card === true;

// The width `ids` need: their fixed widths, the name at its minimum, the gaps, the gutter and the right inset.
function needed(ids) {
  const widths = ids.map((id) => columnWidth(id) ?? NAME_MIN_WIDTH);
  return widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * (ids.length - 1) + GUTTER + RIGHT_INSET;
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
