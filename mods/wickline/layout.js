// Which layout Wickline draws at a size, and which table columns fit a width.
import { kindOf, marketOf } from "./markets.js";
import { misEnabled, yahootwEnabled } from "./settings.js";

// Below this height: the one-line band.
export const BAND_MAX_HEIGHT = 72;
// From this width: the table; below it, the three-line sidebar rows.
export const TABLE_MIN_WIDTH = 720;
// The table never grows wider; a wider pane centers it.
export const TABLE_MAX_WIDTH = 1280;
// A row's left gutter holds the drag handle. Its right inset holds the remove × column, then the scrollbar's lane.
// Every region (header, add field, filter row, table head, rows, footer) keeps the same gutter and inset, so they
// all end on one edge.
export const GUTTER = 20;
export const REMOVE_W = 16;
export const SCROLL_LANE = 12;
export const RIGHT_INSET = REMOVE_W + SCROLL_LANE;
export const COLUMN_GAP = 12;
// A sidebar row's price column: the number, then a slot for its currency. The table's price header
// leaves the same slot.
export const NUMBER_W = 68;
// 8px of it before the code, so a price lit at its limit (4px past its digits) keeps 4px clear of it.
export const CODE_W = 38;
// The room a sidebar row's left lines keep before its day line grows past its narrowest.
const NAME_ROOM = 110;
// The name takes what the fixed columns leave, within these bounds; below the minimum it drops.
export const NAME_MIN_WIDTH = 120;
export const NAME_MAX_WIDTH = 320;

/**
 * The table's columns in display order. `width` is the content width in px, null for the flexible name.
 * The price column holds the number and a fixed slot for the currency.
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

/** The layout for a copy's size: "band" when short, "table" when wide, else "sidebar" (also before layout). */
export function layoutFor(size) {
  if (!size) return "sidebar";
  if (size.height < BAND_MAX_HEIGHT) return "band";
  return size.width < TABLE_MIN_WIDTH ? "sidebar" : "table";
}

// The sidebar line's narrowest width.
export const SPARK_MIN = 32;

/**
 * The width of a sidebar row's day line for a copy `width` px wide. It stays at SPARK_MIN until the left lines have
 * NAME_ROOM beside the fixed parts, then grows with the pane up to 120.
 */
export function sparkWidth(width) {
  if (!(width > 0)) return SPARK_MIN;
  const room = width - GUTTER - RIGHT_INSET - (NUMBER_W + CODE_W) - 2 * COLUMN_GAP - NAME_ROOM;
  return Math.max(SPARK_MIN, Math.min(120, room));
}

/**
 * Whether a copy draws Herdr's rounded, bordered card. A layout block docked beside Herdr's side panels asks with
 * `"props": {"card": true}`. Panes and tabs never ask: Herdr frames them.
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

// The detail dialog's widths: one column, or two for a quote that can carry a book (canCarryBook).
export const DETAIL_WIDTH = 440;
export const DETAIL_WIDE_WIDTH = 720;

/**
 * Whether a detail opened now can carry a book, so it opens in two columns and keeps them while open. That is a
 * Taiwan stock with TWSE MIS or Yahoo 奇摩股市 on, or a future with Yahoo 奇摩股市 on (MIS has no futures).
 */
export function canCarryBook(quote, settings) {
  const kind = kindOf(quote.symbol);
  if (kind === "future") return yahootwEnabled(settings);
  return kind === "stock" && marketOf(quote.symbol) === "tw" && (misEnabled(settings) || yahootwEnabled(settings));
}
