// node --test tests/  (moves.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { DOCK_TAB_KEY } from "../mods/wickline/panes.js";
import { backFromYield, onScreen, ownTabAction } from "../mods/wickline/moves.js";

// The office layout, ids only: Wickline docked as one tab of the collapsible panel's stack.
const block = (id, content) => ({ id, type: "block", content });
const office = ({ hidden = false, active = "wickline" } = {}) => ({
  id: "root", type: "row", children: [
    { id: "work-body", type: "row", children: [
      block("main", { tab: "active" }),
      { id: "panel", type: "column", hidden, children: [
        { id: "panel-body", type: "stack", active, children: [
          block("files", { mod: "files" }),
          block("wickline", { mod: "wickline", props: { card: true } }),
        ] },
      ] },
    ] },
  ],
});
const byId = (node, id) => node.id === id ? node : (node.children ?? []).map((c) => byId(c, id)).find(Boolean);

// Herdr as moves.js sees it: the layout, the panes, the shared store, and every command run, in order.
// `later(n, change)` applies `change` on the n-th look at panes() or layout() from now: Herdr shows the
// result of a command a little after run() returns.
function fakeHost({ tree = office(), panes = [] } = {}) {
  const host = { tree, list: panes, store: {}, ran: [], looks: 0, pending: [] };
  const look = () => {
    host.looks++;
    host.pending = host.pending.filter(({ at, change }) => (host.looks >= at ? (change(), false) : true));
  };
  host.later = (n, change) => host.pending.push({ at: host.looks + n, change });
  host.layout = () => (look(), host.tree);
  host.panes = () => (look(), host.list);
  host.shared = (key) => host.store[key];
  host.setShared = (key, value) => { host.ran.push(["setShared", key, value]); host.store[key] = value; };
  host.focused = () => ({ tab: "t1", pane: "p1" });
  host.run = (command, args) => host.ran.push([command, args]);
  return host;
}

// A click's cx: spawn starts the task at once (as Herdr does) and keeps it; sleep lets other work run.
function fakeCx() {
  const cx = { tasks: [], sleeps: 0 };
  cx.spawn = (task) => { cx.tasks.push(task(cx)); };
  cx.sleep = async () => { cx.sleeps++; await new Promise((r) => setImmediate(r)); };
  cx.done = () => Promise.all(cx.tasks);
  return cx;
}

const view = (extra = {}) => ({ card: false, dock: null, yielding: false, fromDock: false, from: null, moving: false, filter: "all", ...extra });
const commands = (host) => host.ran.map(([name]) => name);

test("onScreen: a docked block is shown with its panel open and its tab active, unless it yields", () => {
  const host = fakeHost();
  const v = view({ card: true });
  assert.equal(onScreen(host, v), true);
  assert.deepEqual(v.dock, { block: "wickline", stack: "panel-body", collapse: "panel" });
  byId(host.tree, "panel").hidden = true;
  assert.equal(onScreen(host, v), false);
  byId(host.tree, "panel").hidden = false;
  host.store[DOCK_TAB_KEY] = { tab: "t7" };
  host.list = [{ pane: "p7", tab: "t7", mod: "wickline" }];
  assert.equal(onScreen(host, v), false);
  assert.equal(v.yielding, true);
  // A copy that is not a card never reads the layout and is always on screen.
  const pane = view();
  assert.equal(onScreen(host, pane), true);
  assert.equal(pane.dock, null);
});

test("⤢ from a block: waits for the new tab, then records it and hides the panel", async () => {
  const host = fakeHost({ panes: [{ pane: "p1", tab: "t1", terminal: "term-1" }] });
  const v = view({ card: true, filter: "tw" });
  onScreen(host, v);
  const action = ownTabAction(host, v);
  assert.equal(action.label, "button.ownTab");
  const cx = fakeCx();
  action.go(cx);
  assert.deepEqual(host.ran, [["tab.new", { mod: "wickline", name: "Wickline", props: { dock: true, filter: "tw" } }]]);
  // The tab shows up in panes() a few looks later; until then nothing is recorded and nothing hides.
  host.later(3, () => { host.list = [...host.list, { pane: "p9", tab: "t9", mod: "wickline" }]; });
  await cx.sleep();
  assert.deepEqual(commands(host), ["tab.new"]);
  await cx.done();
  assert.deepEqual(host.ran.slice(1), [["setShared", DOCK_TAB_KEY, { tab: "t9" }], ["layout.hide", { id: "panel" }]]);
  assert.ok(cx.sleeps >= 2);
  // The block stays, so the icon works again.
  assert.equal(v.moving, false);
});

test("⤢ from a block: a tab that never shows up records nothing and hides nothing", async () => {
  const host = fakeHost({ panes: [{ pane: "p1", tab: "t1", terminal: "term-1" }] });
  const v = view({ card: true });
  onScreen(host, v);
  const cx = fakeCx();
  ownTabAction(host, v).go(cx);
  await cx.done();
  assert.deepEqual(commands(host), ["tab.new"]);
  assert.equal(v.moving, false);
});

test("back to the panel: waits until the block is shown before closing the tab's pane", async () => {
  const tab = { pane: "p9", tab: "t9", mod: "wickline", focused: true };
  const host = fakeHost({ tree: office({ hidden: true, active: "files" }), panes: [{ pane: "p1", tab: "t1" }, tab] });
  host.store[DOCK_TAB_KEY] = { tab: "t9" };
  const v = view({ fromDock: true });
  const action = ownTabAction(host, v);
  assert.equal(action.label, "button.backToPanel");
  const cx = fakeCx();
  action.go(cx);
  assert.deepEqual(host.ran, [
    ["layout.select", { stack: "panel-body", child: "wickline" }],
    ["layout.show", { id: "panel" }],
  ]);
  // The panel opens on Wickline a few looks later.
  host.later(3, () => { host.tree = office(); });
  await cx.sleep();
  assert.equal(commands(host).includes("pane.close"), false);
  await cx.done();
  assert.deepEqual(host.ran.slice(2), [["setShared", DOCK_TAB_KEY, null], ["pane.close", { pane: "p9" }]]);
  // The tab copy is going away: its icon stays out for good.
  assert.equal(v.moving, true);
});

test("back to the panel: a panel that never shows closes nothing", async () => {
  const tab = { pane: "p9", tab: "t9", mod: "wickline", focused: true };
  const host = fakeHost({ tree: office({ hidden: true }), panes: [tab] });
  host.store[DOCK_TAB_KEY] = { tab: "t9" };
  const v = view({ fromDock: true });
  const cx = fakeCx();
  ownTabAction(host, v).go(cx);
  await cx.done();
  assert.deepEqual(commands(host), ["layout.select", "layout.show"]);
  assert.deepEqual(host.store[DOCK_TAB_KEY], { tab: "t9" });
  // Nothing happened, so the icon works again.
  assert.equal(v.moving, false);
});

test("a click while a move waits does nothing", async () => {
  const host = fakeHost({ panes: [{ pane: "p1", tab: "t1", terminal: "term-1" }] });
  const v = view({ card: true });
  onScreen(host, v);
  const action = ownTabAction(host, v);
  const cx = fakeCx();
  action.go(cx);
  assert.equal(v.moving, true);
  action.go(cx);
  action.go(cx);
  assert.deepEqual(commands(host), ["tab.new"]);
  await cx.done();
  assert.equal(v.moving, false);
});

test("the yield view's way back closes the dock tab's pane and keeps the block's buttons working", async () => {
  const tab = { pane: "p9", tab: "t9", mod: "wickline", focused: false };
  const host = fakeHost({ tree: office({ hidden: true }), panes: [{ pane: "p1", tab: "t1", focused: true }, tab] });
  host.store[DOCK_TAB_KEY] = { tab: "t9" };
  const v = view({ card: true });
  host.later(2, () => { host.tree = office(); });
  const cx = fakeCx();
  backFromYield(host, v, cx);
  await cx.done();
  assert.deepEqual(host.ran.at(-1), ["pane.close", { pane: "p9" }]);
  assert.equal(v.moving, false);
});

test("a pane copy moves to its own tab and closes its pane only once the new copy is seen", async () => {
  const me = { pane: "p2", tab: "t1", mod: "wickline", focused: true };
  const host = fakeHost({ panes: [{ pane: "p1", tab: "t1", terminal: "term-1" }, me] });
  const v = view({ filter: "us" });
  const action = ownTabAction(host, v);
  const cx = fakeCx();
  action.go(cx);
  assert.deepEqual(host.ran, [["tab.new", { mod: "wickline", name: "Wickline", props: { from: "t1", filter: "us" } }]]);
  host.later(3, () => { host.list = [...host.list, { pane: "p4", tab: "t4", mod: "wickline" }]; });
  await cx.done();
  assert.deepEqual(host.ran.at(-1), ["pane.close", { pane: "p2" }]);
  assert.equal(v.moving, true);
});
