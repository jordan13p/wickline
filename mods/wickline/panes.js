// Pane and tab navigation: where a Wickline tab goes back to, and when it can get a tab of its own.
// `panes` is what Herdr's panes() gives. No Herdr imports, so tests run it under Node.

// The mod id: Herdr names a mod after its folder, and panes(), pane.split and openOverlay use it.
export const MOD_ID = "wickline";

/**
 * Where the copy in its own tab goes back to: a pane of the tab it was opened from (that tab's focused
 * pane, else its first terminal, else any), else the focused pane, else any terminal. Never a
 * Wickline pane, and never a pane of `ownTab` (the tab about to lose this copy): a shell the person
 * split in there is not a place to go back beside. `panes` as panes() gives them, `focused` as
 * focused(); null: nowhere to go.
 */
export function returnPane(panes, fromTab, focused, ownTab = null) {
  const others = panes.filter((p) => p.mod !== MOD_ID && p.tab !== ownTab);
  const home = others.filter((p) => p.tab === fromTab);
  const there = home.find((p) => p.focused) ?? home.find((p) => p.terminal) ?? home[0];
  if (there) return there.pane;
  const focusedPane = focused?.pane && others.find((p) => p.pane === focused.pane);
  return (focusedPane ?? others.find((p) => p.terminal))?.pane ?? null;
}

// Another pane shares `pane`'s tab.
const hasCompany = (panes, pane) => panes.some((p) => p.tab === pane.tab && p.pane !== pane.pane);

/** A Wickline pane in the shown `tab` has another pane beside it: only then can it get a tab of its own. */
export function canOpenOwnTab(panes, tab) {
  return panes.some((p) => p.mod === MOD_ID && p.tab === tab && hasCompany(panes, p));
}

/**
 * The Wickline pane to move to its own tab: the focused one (clicking a mod pane focuses it), when it
 * is not alone in its tab. Null otherwise, also for a docked block, which is not a pane.
 */
export function ownTabSource(panes) {
  const me = panes.find((p) => p.mod === MOD_ID && p.focused);
  return me && hasCompany(panes, me) ? me : null;
}

/**
 * The Wickline pane in `after` that `before` did not have (in `tab`, when given): the new copy is
 * open, so the old one may close. Null: the command did nothing visible, so nothing closes.
 */
export function newWickline(before, after, tab = null) {
  const old = new Set(before.map((p) => p.pane));
  return after.find((p) => p.mod === MOD_ID && !old.has(p.pane) && (tab === null || p.tab === tab)) ?? null;
}

/**
 * The Wickline pane of a tab that `before` did not have: the tab a command just opened. A Wickline pane
 * split into an existing tab (`ctrl-alt-b`) never counts, so it cannot be taken for the docked block's tab.
 */
export function newWicklineTab(before, after) {
  const tabs = new Set(before.map((p) => p.tab));
  return newWickline(before, after.filter((p) => !tabs.has(p.tab)));
}

// How often and how long a wait looks: Herdr lists a new pane in panes() a little after run() returns,
// not at once, and a layout click shows in layout() a little after its command.
const POLL_MS = 50;
const WAIT_MS = 1500;

/**
 * Looks at `check()` every 50 ms for about 1.5 s. True once it holds, false when it never did.
 * `host`: `{ sleep(ms) }`.
 */
export async function waitUntil(check, host) {
  for (let waited = 0; ; waited += POLL_MS) {
    if (check()) return true;
    if (waited >= WAIT_MS) return false;
    await host.sleep(POLL_MS);
  }
}

/**
 * Closes `me` (the moving copy's own pane) once the new Wickline copy shows up in panes() (in `tab`,
 * when given, and never in `me`'s own tab: a copy split in beside it is not the moved one), looking
 * every 50 ms for about 1.5 s. `host`: `{ panes, sleep(ms), close(pane) }`.
 * True once closed; false when the new copy never showed up, and then nothing closes.
 */
export async function closeOnceOpened(before, me, host, tab = null) {
  const opened = await waitUntil(() => newWickline(before, host.panes().filter((p) => p.tab !== me.tab), tab), host);
  if (opened) host.close(me.pane);
  return opened;
}

// The nodes from the root down to the first node `match` accepts (itself included); null: none does.
function pathTo(node, match) {
  if (!node || typeof node !== "object") return null;
  if (match(node)) return [node];
  for (const child of node.children ?? []) {
    const path = pathTo(child, match);
    if (path) return [node, ...path];
  }
  return null;
}

/**
 * Where a docked Wickline block sits in the layout tree that layout() gives: the first block that
 * runs `modId` with the `card` prop, its nearest stack, and the node to collapse: the stack itself, or
 * the wrapper it is the only child of, up to the first node that has a sibling (the side panel that
 * holds the stack), so hiding it leaves the rest of the layout. The tree need not carry `hidden` on
 * it. Null: this copy is not a docked block, or the tree has none. `stack` is null when absent;
 * `collapse` too, and when every node from the stack up to the root is a lone child.
 */
export function dockOf(tree, modId) {
  const path = pathTo(tree, (n) => n.type === "block" && n.content?.mod === modId && n.content.props?.card === true);
  if (!path) return null;
  const above = path.slice(0, -1);
  const stackAt = above.map((n) => n.type).lastIndexOf("stack");
  let collapse = null;
  for (let i = stackAt; i > 0; i--) {
    if ((above[i - 1].children ?? []).length >= 2) {
      collapse = above[i].id;
      break;
    }
  }
  return { block: path[path.length - 1].id, stack: above[stackAt]?.id ?? null, collapse };
}

// The child a stack shows: its `active` one, else its first (Herdr's guide does not say which child a
// stack without `active` shows; the first is assumed, so such a stack never hides every child).
const shownChild = (stack) => stack.active ?? stack.children?.[0]?.id;

/**
 * The docked block is on screen: nothing from the root down to it is hidden, and each stack on the way
 * shows the way's child. False when the block is gone from the tree.
 */
export function isShown(tree, dock) {
  const path = pathTo(tree, (n) => n.id === dock.block);
  if (!path) return false;
  return path.every((node, i) => node.hidden !== true && (node.type !== "stack" || shownChild(node) === path[i + 1]?.id));
}

// Shared state: `{ tab }`, the tab a docked block moved Wickline to (see main.js), or null.
export const DOCK_TAB_KEY = "wickline.dockTab";

/**
 * A docked block steps aside while a Wickline pane is still in `dockTab.tab`. A record left behind by a
 * tab the person closed names a tab with no Wickline in it, so it never makes the block yield; a pane
 * opened another way (`ctrl-alt-b`) is in some other tab. `dockTab`: what the shared key holds.
 */
export function blockYields(dockTab, panes) {
  return typeof dockTab?.tab === "string" && panes.some((p) => p.mod === MOD_ID && p.tab === dockTab.tab);
}
