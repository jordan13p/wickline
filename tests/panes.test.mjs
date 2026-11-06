// node --test tests/  (panes.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { DOCK_TAB_KEY, blockYields, canOpenOwnTab, closeOnceOpened, dockOf, isShown, newWickline, newWicklineTab, ownTabSource, returnPane } from "../mods/wickline/panes.js";

// Panes as panes() gives them: Wickline's own tab "t9", opened from "t1".
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

test("back beside the terminal: never beside another Wickline or in its own tab", () => {
  const other = { pane: "p4", tab: "t1", terminal: null, mod: "wickline", focused: false };
  assert.equal(returnPane([other, pane("p5", "t1"), mine], "t1", null), "p5");
  // The tab it came from is gone: the focused pane, unless it is Wickline's own.
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p6", tab: "t2" }), "p6");
  assert.equal(returnPane([pane("p6", "t2"), mine], "t1", { pane: "p9", tab: "t9" }), "p6");
  assert.equal(returnPane([mine], "t1", { pane: "p9", tab: "t9" }), null);
  assert.equal(returnPane([mine], "t1", null), null);
  assert.equal(returnPane([other, mine], "t1", null), null);
});

test("back beside the terminal: never a pane of its own tab", () => {
  // A shell the person split into the Wickline tab: not a place to go back beside.
  const shell = pane("p8", "t9", { focused: false });
  assert.equal(returnPane([shell, mine], "t1", { pane: "p8", tab: "t9" }, "t9"), null);
  assert.equal(returnPane([shell, pane("p6", "t2"), mine], "t1", { pane: "p8", tab: "t9" }, "t9"), "p6");
  assert.equal(returnPane([shell, pane("p2", "t1"), mine], "t1", null, "t9"), "p2");
});

test("own tab: only a Wickline pane that shares its tab", () => {
  const term = pane("p1", "t1");
  const bw = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  assert.equal(canOpenOwnTab([term, bw], "t1"), true);
  assert.equal(ownTabSource([term, bw]), bw);
  // A lone pane: its tab already is its own.
  assert.equal(canOpenOwnTab([bw, pane("p3", "t2")], "t1"), false);
  assert.equal(ownTabSource([{ ...bw }, pane("p3", "t2")]), null);
  // No Wickline pane in the shown tab (a docked block only): nothing to move.
  assert.equal(canOpenOwnTab([term, pane("p3", "t1")], "t1"), false);
  assert.equal(canOpenOwnTab([term, bw], "t2"), false);
  // Not focused: not the copy that was clicked.
  assert.equal(ownTabSource([term, { ...bw, focused: false }]), null);
});

test("the old copy closes only once the new one is seen", () => {
  const before = [pane("p1", "t1"), { pane: "p2", tab: "t1", terminal: null, mod: "wickline" }];
  // The command did nothing: no new Wickline pane.
  assert.equal(newWickline(before, before), null);
  // A new pane that is not Wickline does not count.
  assert.equal(newWickline(before, [...before, pane("p3", "t3")]), null);
  const opened = { pane: "p4", tab: "t4", terminal: null, mod: "wickline" };
  assert.equal(newWickline(before, [...before, opened]), opened);
  // Back beside: it must be in the target's tab.
  assert.equal(newWickline(before, [...before, opened], "t1"), null);
  assert.equal(newWickline(before, [...before, { ...opened, tab: "t1" }], "t1").pane, "p4");
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

test("own tab: a new Wickline pane in the moving copy's own tab is not the moved copy", async () => {
  const me = { pane: "p2", tab: "t1", terminal: null, mod: "wickline", focused: true };
  const before = [pane("p1", "t1"), me];
  // A copy split in beside it (by hand, or another copy's move) shows up in the same tab: nothing closes.
  const sameTab = fakeHost(before, { pane: "p5", tab: "t1", terminal: null, mod: "wickline" }, 1);
  assert.equal(await closeOnceOpened(before, me, sameTab), false);
  assert.deepEqual(sameTab.closed, []);
});

// The office layout, ids only: Wickline docked as one tab of the collapsible panel's stack.
const block = (id, content) => ({ id, type: "block", content });
const office = (wicklineProps = { card: true }) => ({
  id: "root", type: "row", children: [
    { id: "side", type: "column", children: [block("spaces", { mod: "spaces" })] },
    { id: "work", type: "column", children: [
      block("tabs", { mod: "tabs" }),
      { id: "work-body", type: "row", children: [
        block("main", { tab: "active" }),
        { id: "panel", type: "column", hidden: true, children: [
          { id: "panel-body", type: "stack", active: "files", children: [
            block("files", { mod: "files" }),
            block("changes", { mod: "changes" }),
            block("graph", { mod: "graph" }),
            block("wickline", { mod: "wickline", props: wicklineProps }),
          ] },
        ] },
      ] },
    ] },
  ],
});
const byId = (node, id) => node.id === id ? node : (node.children ?? []).map((c) => byId(c, id)).find(Boolean);

test("dockOf: the card block, its stack and the panel that collapses", () => {
  assert.deepEqual(dockOf(office(), "wickline"), { block: "wickline", stack: "panel-body", collapse: "panel" });
});

test("dockOf: the panel is found by structure, even when it carries no hidden key", () => {
  const tree = office();
  delete byId(tree, "panel").hidden;
  assert.deepEqual(dockOf(tree, "wickline"), { block: "wickline", stack: "panel-body", collapse: "panel" });
});

test("dockOf: a copy without the card prop is not a docked block", () => {
  assert.equal(dockOf(office({}), "wickline"), null);
  assert.equal(dockOf(office({ card: false }), "wickline"), null);
  assert.equal(dockOf(null, "wickline"), null);
});

test("isShown: the panel is open and Wickline is the stack's active child", () => {
  const tree = office();
  const dock = dockOf(tree, "wickline");
  // The panel is hidden.
  assert.equal(isShown(tree, dock), false);
  // Open, but another tab of the stack is active.
  byId(tree, "panel").hidden = false;
  assert.equal(isShown(tree, dock), false);
  byId(tree, "panel-body").active = "wickline";
  assert.equal(isShown(tree, dock), true);
  // Hiding any ancestor hides it again.
  byId(tree, "work-body").hidden = true;
  assert.equal(isShown(tree, dock), false);
});

test("a docked block yields while a Wickline pane is in the tab it opened", () => {
  assert.equal(DOCK_TAB_KEY, "wickline.dockTab");
  assert.equal(blockYields({ tab: "t2" }, [{ pane: "p1", tab: "t2", mod: "wickline" }]), true);
  // A stale id: the tab is gone, or holds no Wickline any more.
  assert.equal(blockYields({ tab: "t2" }, [{ pane: "p1", tab: "t9", mod: "wickline" }]), false);
  assert.equal(blockYields({ tab: "t2" }, [{ pane: "p1", tab: "t2", terminal: "term-p1" }]), false);
  assert.equal(blockYields({ tab: "t2" }, []), false);
  // No record, or a malformed one: never yields.
  assert.equal(blockYields(null, [{ pane: "p1", tab: "t2", mod: "wickline" }]), false);
  assert.equal(blockYields(undefined, [{ pane: "p1", tab: "t2", mod: "wickline" }]), false);
  assert.equal(blockYields({}, [{ pane: "p1", tab: undefined, mod: "wickline" }]), false);
});

test("the docked block's tab: a Wickline pane in a tab that was not there before", () => {
  const before = [pane("p1", "t1"), { pane: "p2", tab: "t1", mod: "wickline", focused: false }];
  // A pane split into an existing tab (ctrl-alt-b) never counts.
  assert.equal(newWicklineTab(before, [...before, { pane: "p3", tab: "t1", mod: "wickline" }]), null);
  assert.equal(newWicklineTab(before, [...before, { pane: "p3", tab: "t7", mod: "wickline" }]).pane, "p3");
  // Another new tab with no Wickline in it does not either; the opened one still does.
  const after = [...before, pane("p4", "t8"), { pane: "p5", tab: "t1", mod: "wickline" }, { pane: "p6", tab: "t9", mod: "wickline" }];
  assert.equal(newWicklineTab(before, after).pane, "p6");
  assert.equal(newWicklineTab(before, before), null);
});
