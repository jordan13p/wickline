// node --test tests/  (motion.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { rowsWithGhosts, settleOffset } from "../mods/wickline/motion.js";

const ghost = (symbol, before) => ({ symbol, before });
const names = (entries) => entries.map(({ symbol, ghost: g }) => (g ? `~${symbol}` : symbol));

test("a ghost sits where its row was: in front of the symbol that followed it", () => {
  const symbols = ["AAPL", "NVDA", "MSFT"];
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [ghost("TSLA", "NVDA")])), ["AAPL", "~TSLA", "NVDA", "MSFT"]);
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [ghost("TSLA", null)])), ["AAPL", "NVDA", "MSFT", "~TSLA"]);
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [])), symbols);
});

test("two rows removed in a row keep their order, whichever way they were taken", () => {
  // A B C D E: C goes (before D), then D goes (before E): the list is A B E.
  const symbols = ["A", "B", "E"];
  const ghosts = [ghost("C", "D"), ghost("D", "E")];
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", ghosts)), ["A", "B", "~C", "~D", "E"]);
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [...ghosts].reverse())), ["A", "B", "~C", "~D", "E"]);
  // D goes first (before E), then C, which was above it (before E too): C stays above D.
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [ghost("D", "E"), ghost("C", "E")])), ["A", "B", "~C", "~D", "E"]);
  // The last two: D (before E), then E (before null).
  assert.deepEqual(names(rowsWithGhosts(["A"], "all", [ghost("D", "E"), ghost("E", null)])), ["A", "~D", "~E"]);
});

test("a ghost whose place is gone is not drawn", () => {
  assert.deepEqual(names(rowsWithGhosts(["A", "B"], "all", [ghost("X", "Z")])), ["A", "B"]);
});

test("a ghost is drawn only when its market is the one shown", () => {
  const symbols = ["AAPL", "NVDA", "2330.TW", "0050.TW", "BTC/USDT", "ETH/USDT", "MSFT", "TSLA"];
  const ghosts = [ghost("GOOG", "NVDA"), ghost("2317.TW", "0050.TW")];
  assert.deepEqual(names(rowsWithGhosts(symbols, "us", ghosts)), ["AAPL", "~GOOG", "NVDA", "MSFT", "TSLA"]);
  assert.deepEqual(names(rowsWithGhosts(symbols, "tw", ghosts)), ["2330.TW", "~2317.TW", "0050.TW"]);
  // A choice the list no longer offers reads as All, as the rows do.
  assert.equal(rowsWithGhosts(symbols, "hk", ghosts).length, 10);
});

test("the row that took the market's last symbol away is drawn once the filter is All again", () => {
  const symbols = ["AAPL", "NVDA", "BTC/USDT"];
  assert.deepEqual(names(rowsWithGhosts(symbols, "all", [ghost("2330.TW", "BTC/USDT")])), ["AAPL", "NVDA", "~2330.TW", "BTC/USDT"]);
});

test("the offset a dropped row starts from is how far it moved, by the rows' heights", () => {
  const heights = { A: 50, B: 60, C: 70, D: 80 };
  // C from third to first: it was 110 px down, now 0.
  assert.equal(settleOffset(["A", "B", "C", "D"], ["C", "A", "B", "D"], "C", heights), 110);
  // A from first to last: it was at 0, now 210: starts 210 above.
  assert.equal(settleOffset(["A", "B", "C", "D"], ["B", "C", "D", "A"], "A", heights), -210);
});

test("no settle when the row stays put on screen, or a height is not known", () => {
  assert.equal(settleOffset(["A", "B"], ["A", "B"], "A", { A: 50, B: 60 }), null);
  assert.equal(settleOffset(["A", "B", "C"], ["C", "A", "B"], "C", { A: 50, C: 70 }), null);
  assert.equal(settleOffset(["A", "B"], ["B", "A"], "A", { A: 50, B: 0 }), null);
  assert.equal(settleOffset(["A", "B"], ["B"], "A", { A: 50, B: 60 }), null);
});
