// node --test tests/  (layout.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  BAND_MAX_HEIGHT, COLUMN_GAP, DROP_ORDER, GUTTER, NAME_MAX_WIDTH, NAME_MIN_WIDTH, RIGHT_INSET, TABLE_COLUMNS, TABLE_MAX_WIDTH, TABLE_MIN_WIDTH,
  columnWidth, layoutFor, nameWidth, sparkWidth, tableColumns, wantsCard,
} from "../mods/wickline/layout.js";

const ALL = ["symbol", "name", "state", "line", "price", "change", "changePct", "high", "low", "prevClose"];
const KEPT = ["symbol", "state", "price", "changePct"];
const width = (id) => TABLE_COLUMNS.find((column) => column.id === id).width;
// What `ids` take with the name at its minimum, the gaps, the left gutter and the right inset.
const needed = (ids) => ids.reduce((sum, id) => sum + (width(id) ?? NAME_MIN_WIDTH), 0) + COLUMN_GAP * (ids.length - 1) + GUTTER + RIGHT_INSET;

test("the limits the spec names", () => {
  assert.equal(BAND_MAX_HEIGHT, 72);
  assert.equal(TABLE_MIN_WIDTH, 720);
  assert.equal(TABLE_MAX_WIDTH, 1280);
  assert.equal(NAME_MAX_WIDTH, 320);
});

test("the layout follows the size", () => {
  assert.equal(layoutFor({ width: 400, height: 600 }), "sidebar");
  assert.equal(layoutFor({ width: 1100, height: 600 }), "table");
  assert.equal(layoutFor({ width: 1100, height: 60 }), "band");
  assert.equal(layoutFor({ width: 400, height: 71 }), "band");
  assert.equal(layoutFor({ width: 400, height: 72 }), "sidebar");
  // Not laid out yet.
  assert.equal(layoutFor(null), "sidebar");
  assert.equal(layoutFor({ width: 719, height: 600 }), "sidebar");
  assert.equal(layoutFor({ width: 720, height: 600 }), "table");
});

test("the columns, in display order, with the name the only flexible one", () => {
  assert.deepEqual(TABLE_COLUMNS.map((column) => column.id), ALL);
  for (const column of TABLE_COLUMNS) {
    if (column.id === "name") assert.equal(column.width, null);
    else assert.ok(column.width > 0, column.id);
  }
  for (const id of ["price", "change", "changePct", "high", "low", "prevClose"]) {
    assert.equal(TABLE_COLUMNS.find((column) => column.id === id).align, "right", id);
  }
  for (const id of ALL) assert.equal(columnWidth(id), width(id), id);
  assert.deepEqual(DROP_ORDER, ["prevClose", "low", "high", "change", "line", "name"]);
});

test("a wide table shows every column", () => {
  assert.deepEqual(tableColumns(1100), ALL);
  assert.deepEqual(tableColumns(2000), ALL);
  assert.equal(tableColumns(1100).length, 10);
  assert.ok(tableColumns(1099).length < 10);
});

test("previous close is the first to go", () => {
  const allButOne = needed(ALL) - 1;
  assert.ok(allButOne >= needed(ALL.filter((id) => id !== "prevClose")));
  assert.deepEqual(tableColumns(allButOne), ALL.filter((id) => id !== "prevClose"));
  assert.deepEqual(tableColumns(needed(ALL)), ALL);
});

test("columns drop in order and the kept four never drop", () => {
  let expected = [...ALL];
  for (const drop of DROP_ORDER) {
    const shown = tableColumns(needed(expected) - 1);
    expected = expected.filter((id) => id !== drop);
    assert.deepEqual(shown, expected, `below the room for ${drop}`);
  }
  for (const w of [TABLE_MIN_WIDTH, 400, 0]) {
    const shown = tableColumns(w);
    for (const id of KEPT) assert.ok(shown.includes(id), `${id} at ${w}`);
  }
});

test("the columns shown always fit", () => {
  for (let w = TABLE_MIN_WIDTH; w <= 2000; w += 7) {
    const shown = tableColumns(w);
    assert.ok(needed(shown) <= Math.min(w, TABLE_MAX_WIDTH), `${w}: ${shown}`);
    const fixed = shown.reduce((sum, id) => sum + (width(id) ?? 0), 0);
    assert.ok(fixed <= Math.min(w, TABLE_MAX_WIDTH) - GUTTER - RIGHT_INSET, `${w}`);
  }
});

test("the name takes the rest, within its bounds", () => {
  for (let w = TABLE_MIN_WIDTH; w <= 2000; w += 13) {
    const shown = tableColumns(w);
    if (!shown.includes("name")) continue;
    const name = nameWidth(w, shown);
    assert.ok(name >= NAME_MIN_WIDTH && name <= NAME_MAX_WIDTH, `${w}: ${name}`);
    assert.ok(needed(shown) - NAME_MIN_WIDTH + name <= Math.min(w, TABLE_MAX_WIDTH), `${w}`);
  }
  // A very wide pane: the table stops at 1280 and the name at its cap.
  assert.equal(nameWidth(2000, ALL), nameWidth(TABLE_MAX_WIDTH, ALL));
  assert.ok(nameWidth(TABLE_MAX_WIDTH, ALL) <= NAME_MAX_WIDTH);
});

test("the sidebar line leaves the lane and the name their room", () => {
  assert.equal(RIGHT_INSET, 28);
  assert.equal(sparkWidth(280), 32);
  assert.equal(sparkWidth(345), 32);
  assert.equal(sparkWidth(400), 72);
  assert.equal(sparkWidth(447), 119);
  assert.equal(sparkWidth(448), 120);
  assert.equal(sparkWidth(700), 120);
  // Not laid out yet.
  assert.equal(sparkWidth(null), 32);
  assert.equal(sparkWidth(undefined), 32);
});

test("a docked block asks for the card with card: true, and nothing else does", () => {
  assert.equal(wantsCard({ card: true }), true);
  for (const props of [{ card: "true" }, { card: 1 }, { card: false }, {}, null, undefined, { from: "tab-1" }]) {
    assert.equal(wantsCard(props), false, JSON.stringify(props));
  }
});
