// node --test tests/  (panes.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { canOpenOwnTab, closeOnceOpened, newBellwether, ownTabSource, returnPane } from "../mods/wickline/panes.js";

// Panes as panes() gives them: Bellwether's own tab "t9", opened from "t1".
const pane = (id, tab, extra = {}) => ({ pane: id, tab, terminal: `term-${id}`, focused: false, ...extra });
const mine = { pane: "p9", tab: "t9", terminal: null, mod: "wickline", focused: true };

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
  const other = { pane: "p4", tab: "t1", terminal: null, mod: "wickline", focused: false };
  assert.equal(returnPane([other, pane("p5", "t1"), mine], "t1", null), "p5");
  // The tab it came from is gone: the focused pane, unless it is Bellwether's own.
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p6", tab: "t2" }), "p6");
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p9", tab: "t9" }), "p6");
  assert.equal(returnPane([mine], "t1", { pane: "p9", tab: "t9" }), null);
  assert.equal(returnPane([mine], "t1", null), null);
  assert.equal(returnPane([other, mine], "t1", null), null);
});

test("back beside the terminal: never a pane of its own tab", () => {
  // A shell the person split into the Bellwether tab: not a place to go back beside.
  const shell = pane("p8", "t9", { focused: false });
  assert.equal(returnPane([shell, mine], "t1", { pane: "p8", tab: "t9" }, "t9"), null);
  assert.equal(returnPane([shell, pane("p6", "t2"), mine], "t1", { pane: "p8", tab: "t9" }, "t9"), "p6");
  assert.equal(returnPane([shell, pane("p2", "t1"), mine], "t1", null, "t9"), "p2");
});

test("own tab: only a Bellwether pane that shares its tab", () => {
  const term = pane("p1", "t1");
  const bw = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  assert.equal(canOpenOwnTab([term, bw], "t1"), true);
  assert.equal(ownTabSource([term, bw]), bw);
  // A lone pane: its tab already is its own.
  assert.equal(canOpenOwnTab([bw, pane("p3", "t2")], "t1"), false);
  assert.equal(ownTabSource([{ ...bw }, pane("p3", "t2")]), null);
  // No Bellwether pane in the shown tab (a docked block only): nothing to move.
  assert.equal(canOpenOwnTab([term, pane("p3", "t1")], "t1"), false);
  assert.equal(canOpenOwnTab([term, bw], "t2"), false);
  // Not focused: not the copy that was clicked.
  assert.equal(ownTabSource([term, { ...bw, focused: false }]), null);
});

test("the old copy closes only once the new one is seen", () => {
  const before = [pane("p1", "t1"), { pane: "p2", tab: "t1", terminal: null, mod: "wickline" }];
  // The command did nothing: no new Bellwether pane.
  assert.equal(newBellwether(before, before), null);
  // A new pane that is not Bellwether does not count.
  assert.equal(newBellwether(before, [...before, pane("p3", "t3")]), null);
  const opened = { pane: "p4", tab: "t4", terminal: null, mod: "wickline" };
  assert.equal(newBellwether(before, [...before, opened]), opened);
  // Back beside: it must be in the target's tab.
  assert.equal(newBellwether(before, [...before, opened], "t1"), null);
  assert.equal(newBellwether(before, [...before, { ...opened, tab: "t1" }], "t1").pane, "p4");
});

// Herdr shows a new pane in panes() a little after run() returns: a fake host whose panes() lists the
// new copy only from its `shownAt`-th call on (never, when null), and records sleeps and closes.
function fakeHost(before, opened, shownAt) {
  const host = { reads: 0, sleeps: [], closed: [] };
  host.panes = () => (++host.reads, shownAt !== null && host.reads >= shownAt ? [...before, opened] : before);
  host.sleep = async (ms) => { host.sleeps.push(ms); };
  host.close = (pane) => { host.closed.push(pane); };
  return host;
}

test("the old copy closes once the new one shows up, even a few polls after the command", async () => {
  const me = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  const before = [pane("p1", "t1"), me];
  const opened = { pane: "p4", tab: "t4", terminal: null, mod: "wickline" };
  const host = fakeHost(before, opened, 4);
  assert.equal(await closeOnceOpened(before, me, host), true);
  // Its own pane only, and only once the new copy was seen.
  assert.deepEqual(host.closed, ["p2"]);
  assert.equal(host.reads, 4);
  assert.equal(host.sleeps.length, 3);
  assert.ok(host.sleeps.every((ms) => ms === 50));
});

test("back beside: the new copy must show up in the target's tab", async () => {
  const me = { pane: "p9", tab: "t9", terminal: null, mod: "wickline", focused: true };
  const before = [pane("p1", "t1"), me];
  const elsewhere = fakeHost(before, { pane: "p4", tab: "t4", terminal: null, mod: "wickline" }, 1);
  assert.equal(await closeOnceOpened(before, me, elsewhere, "t1"), false);
  assert.deepEqual(elsewhere.closed, []);
  const beside = fakeHost(before, { pane: "p4", tab: "t1", terminal: null, mod: "wickline" }, 2);
  assert.equal(await closeOnceOpened(before, me, beside, "t1"), true);
  assert.deepEqual(beside.closed, ["p9"]);
});

test("a new copy that never shows up: nothing closes, and the wait is bounded", async () => {
  const me = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  const before = [pane("p1", "t1"), me];
  const host = fakeHost(before, null, null);
  assert.equal(await closeOnceOpened(before, me, host), false);
  assert.deepEqual(host.closed, []);
  // About 1.5 s of 50 ms polls, then it gives up.
  const waited = host.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 1000 && waited <= 2000, `waited ${waited} ms`);
});

test("own tab: a new Bellwether pane in the moving copy's own tab is not the moved copy", async () => {
  const me = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  const before = [pane("p1", "t1"), me];
  // A copy split in beside it (by hand, or another copy's move) shows up in the same tab: nothing closes.
  const sameTab = fakeHost(before, { pane: "p5", tab: "t1", terminal: null, mod: "wickline" }, 1);
  assert.equal(await closeOnceOpened(before, me, sameTab), false);
  assert.deepEqual(sameTab.closed, []);
});
