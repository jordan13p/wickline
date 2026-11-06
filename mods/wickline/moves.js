// Moving Wickline between a pane, a tab of its own and a docked block, and whether a docked block is on
// screen. No Herdr imports, so tests run it under Node: main.js hands in `host`, Herdr's functions
// `{ panes, layout, run, shared, setShared, focused }`, and the view, whose move state these read and
// set: `card`, `dock`, `yielding`, `dockShown`, `fromDock`, `moving`, `filter` and the tab a pane copy came
// from (view.from).
// `cx` is the click's; each wait runs in a task spawned from it that owns its own cx.
import {
  DOCK_TAB_KEY, MOD_ID, blockYields, canOpenOwnTab, closeOnceOpened, dockOf, isShown, newWicklineTab, ownTabSource, returnPane, staleDockTab,
  waitUntil,
} from "./panes.js";

/**
 * Where a docked block sits and whether it is on screen, `{ dock, yielding, shown }`: it is on screen while
 * its panel is open and its tab is the stack's active one, and draws quotes unless it yields to its own tab
 * (then it fetches nothing either). A copy that is not a card is not docked and always on screen. Reads the
 * layout each time, as the person may move the block or switch layouts. On the way it clears a dock tab
 * record left stale, from the loops too: a hidden block never renders, and the record must be gone before
 * a Wickline pane opened another way in that tab could make the block yield.
 */
function readDock(host, card) {
  const tree = card ? host.layout() : null;
  // The first card block in the layout is taken to be this copy: Wickline is docked once, as the
  // office layout does, and panes() cannot tell copies apart anyway.
  const dock = tree && dockOf(tree, MOD_ID);
  if (!dock) return { dock: null, yielding: false, shown: true };
  const dockTab = host.shared(DOCK_TAB_KEY);
  const all = host.panes();
  // Written only while stale, so the write (which re-renders every copy) happens once.
  if (staleDockTab(dockTab, all)) host.setShared(DOCK_TAB_KEY, { tab: null });
  const yielding = blockYields(dockTab, all);
  return { dock, yielding, shown: isShown(tree, dock) && !yielding };
}

/** The loops' check: this copy is on screen. It leaves the view as it is; render keeps it (syncDock). */
export function onScreen(host, view) {
  return readDock(host, view.card).shown;
}

/** On render: sets `view.dock`, `view.yielding` and `view.dockShown`, which that render's drawing and clicks read. */
export function syncDock(host, view) {
  const { dock, yielding, shown } = readDock(host, view.card);
  view.dock = dock;
  view.yielding = yielding;
  view.dockShown = shown;
}

// What a moved copy is handed in its props besides where it came from: this copy's market filter.
const carried = (view) => ({ filter: view.filter });

/**
 * The header's own-tab icon, `{ icon, label, go(cx) }`, or null. A pane copy that shares its tab offers
 * its own tab; the copy in that tab offers the way back, when there is a pane to go back beside. A docked
 * block offers its own tab while it is shown, and its tab copy offers the way back to the panel. Dialog
 * copies draw neither (they never reach the header). Clicking a mod pane focuses it, so the focused
 * Wickline pane is the one clicked; each click checks again. panes() lists the new copy a little after
 * run() returns, so a task looks for it (closeOnceOpened) and only then closes the old copy's own pane,
 * never a shell the person split in beside it. Clicks while a move is under way do nothing, so copies
 * never pile up.
 */
export function ownTabAction(host, view) {
  if (view.fromDock) {
    if (!dockOf(host.layout(), MOD_ID)) return null;
    return {
      icon: "restore", label: "button.backToPanel",
      go: (cx) => backToPanel(host, view, cx, host.panes().find((p) => p.mod === MOD_ID && p.focused), true),
    };
  }
  if (view.dock) return dockTabAction(host, view);
  const all = host.panes();
  const shownTab = host.focused()?.tab ?? null;
  if (!view.from) {
    if (!canOpenOwnTab(all, shownTab)) return null;
    return {
      icon: "zoom", label: "button.ownTab",
      go: (cx) => {
        if (view.moving) return;
        const before = host.panes();
        const me = ownTabSource(before);
        if (!me) return;
        host.run("tab.new", { mod: MOD_ID, name: "Wickline", props: { from: me.tab, ...carried(view) } });
        finishMove(host, view, cx, before, me);
      },
    };
  }
  if (!returnPane(all, view.from, host.focused(), shownTab)) return null;
  return {
    icon: "restore", label: "button.backBeside",
    go: (cx) => {
      if (view.moving) return;
      const before = host.panes();
      const me = before.find((p) => p.mod === MOD_ID && p.focused && p.tab !== view.from);
      const target = me && returnPane(before, view.from, host.focused(), me.tab);
      if (!target) return;
      host.run("pane.split", { pane: target, direction: "right", mod: MOD_ID, props: carried(view) });
      finishMove(host, view, cx, before, me, before.find((p) => p.pane === target).tab);
    },
  };
}

/**
 * The block's own tab: opens it, and only once panes() shows it records the tab (so the block yields
 * if the panel is opened again) and collapses the panel. The block's copy stays, so the button works
 * again afterwards; when the tab never shows up, nothing collapses.
 */
function dockTabAction(host, view) {
  if (!view.dockShown) return null;
  return {
    icon: "zoom", label: "button.ownTab",
    go: (cx) => {
      if (view.moving) return;
      const before = host.panes();
      const { collapse } = view.dock;
      host.run("tab.new", { mod: MOD_ID, name: "Wickline", props: { dock: true, ...carried(view) } });
      runMove(view, cx, async (cx) => {
        let tab = null;
        const opened = await waitUntil(() => (tab = newWicklineTab(before, host.panes())), { sleep: (ms) => cx.sleep(ms) });
        if (!opened) return false;
        host.setShared(DOCK_TAB_KEY, { tab: tab.tab });
        if (collapse) host.run("layout.hide", { id: collapse });
        return false;
      });
    },
  };
}

/**
 * Reopens the panel on the Wickline block, and only once it is shown closes `pane`, the Wickline pane
 * of the tab (never the tab, so a shell split in beside it stays), and forgets the tab. The tab's own
 * copy passes the focused Wickline pane; the block's yield view, which is not focused, the dock tab's.
 * With the panel already open, select and show change nothing. The block is found again in the
 * layout: the person may have moved it since. No pane, nothing happens: never close one unseen.
 * `leaving`: `pane` is this copy's own (the tab copy), so the move keeps further clicks out for good;
 * the block's yield view closes another copy's pane and stays, so its buttons keep working.
 */
function backToPanel(host, view, cx, pane, leaving) {
  if (view.moving) return;
  const dock = dockOf(host.layout(), MOD_ID);
  if (!dock || !pane) return;
  runMove(view, cx, async (cx) => {
    if (dock.stack) host.run("layout.select", { stack: dock.stack, child: dock.block });
    if (dock.collapse) host.run("layout.show", { id: dock.collapse });
    if (!await waitUntil(() => isShown(host.layout(), dock), { sleep: (ms) => cx.sleep(ms) })) return false;
    host.setShared(DOCK_TAB_KEY, { tab: null });
    host.run("pane.close", { pane: pane.pane });
    return leaving;
  });
}

/** The yield view's button: the Wickline pane of the tab the block moved to (not the focused one). */
export function backFromYield(host, view, cx) {
  const dockTab = host.shared(DOCK_TAB_KEY);
  backToPanel(host, view, cx, host.panes().find((p) => p.mod === MOD_ID && p.tab === dockTab?.tab), false);
}

/**
 * Runs `step(cx)` as a move, in a spawned task that owns its cx. Further clicks do nothing meanwhile.
 * `step` resolves true once this copy is going away (its pane closed), which keeps them out for good;
 * false, or a throw, leaves everything as it was and the button works again.
 */
function runMove(view, cx, step) {
  view.moving = true;
  cx.spawn(async (cx) => {
    let leaving = false;
    try {
      leaving = await step(cx);
    } catch {
      // Nothing to undo: a step closes only after it has seen what it waited for.
    } finally {
      if (!leaving) view.moving = false;
    }
  });
}

/** Closes `me` once the new copy is seen (in `tab`, when given). */
function finishMove(host, view, cx, before, me, tab = null) {
  runMove(view, cx, (cx) => closeOnceOpened(before, me, {
    panes: host.panes, sleep: (ms) => cx.sleep(ms), close: (pane) => host.run("pane.close", { pane }),
  }, tab));
}
