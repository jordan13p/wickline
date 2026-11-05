// node --test tests/  (layout.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  BAND_MAX_HEIGHT, COLUMN_GAP, DROP_ORDER, GUTTER, NAME_MAX_WIDTH, NAME_MIN_WIDTH, TABLE_COLUMNS, TABLE_MAX_WIDTH, TABLE_MIN_WIDTH,
  layoutFor, nameWidth, returnPane, tableColumns,
} from "../mods/bellwether/layout.js";

const ALL = ["symbol", "name", "state", "line", "price", "change", "changePct", "high", "low", "prevClose"];
const KEPT = ["symbol", "state", "price", "changePct"];
const width = (id) => TABLE_COLUMNS.find((column) => column.id === id).width;
// What `ids` take with the name at its minimum, the gaps and both gutters.
const needed = (ids) => ids.reduce((sum, id) => sum + (width(id) ?? NAME_MIN_WIDTH), 0) + COLUMN_GAP * (ids.length - 1) + 2 * GUTTER;

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
  assert.deepEqual(DROP_ORDER, ["prevClose", "low", "high", "change", "line", "name"]);
});

test("a wide table shows every column", () => {
  assert.deepEqual(tableColumns(1100), ALL);
  assert.deepEqual(tableColumns(2000), ALL);
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
    assert.ok(fixed <= Math.min(w, TABLE_MAX_WIDTH) - 2 * GUTTER, `${w}`);
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

// Panes as panes() gives them: Bellwether's own tab "t9", opened from "t1".
const pane = (id, tab, extra = {}) => ({ pane: id, tab, terminal: `term-${id}`, focused: false, ...extra });
const mine = { pane: "p9", tab: "t9", terminal: null, mod: "bellwether", focused: true };

test("back beside the terminal: a pane of the tab it came from", () => {
  const panes = [pane("p1", "t1", { terminal: null, mod: "notes" }), pane("p2", "t1"), pane("p3", "t1", { focused: true }), mine];
  // That tab's focused pane first.
  assert.equal(returnPane(panes, "t1", null), "p3");
  // Else its first terminal pane.
  panes[2].focused = false;
  assert.equal(returnPane(panes, "t1", null), "p2");
  // Else any other pane there.
  assert.equal(returnPane([pane("p1", "t1", { terminal: null, mod: "notes" }), mine], "t1", null), "p1");
});

test("back beside the terminal: never beside another Bellwether or in its own tab", () => {
  const other = { pane: "p4", tab: "t1", terminal: null, mod: "bellwether", focused: false };
  assert.equal(returnPane([other, pane("p5", "t1"), mine], "t1", null), "p5");
  // The tab it came from is gone: the focused pane, unless it is Bellwether's own.
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p6", tab: "t2" }), "p6");
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p9", tab: "t9" }), "p6");
  assert.equal(returnPane([mine], "t1", { pane: "p9", tab: "t9" }), null);
  assert.equal(returnPane([mine], "t1", null), null);
  assert.equal(returnPane([other, mine], "t1", null), null);
});
