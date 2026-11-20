// Pane and tab navigation: where a Wickline tab goes back to, and when it can get a tab of its own.
// `panes` is what Herdr's panes() gives.
import { wantsCard } from "./layout.js";

// The mod id: Herdr names a mod after its folder, and panes(), pane.split and openOverlay use it.
export const MOD_ID = "wickline";

/**
 * The pane the copy in its own tab goes back beside, or null for nowhere. In order of preference:
 * 1. a pane of the tab it was opened from: that tab's focused pane, its first terminal, or any;
 * 2. the focused pane;
 * 3. any terminal.
 * Never a Wickline pane, and never a pane of `ownTab`, the tab about to lose this copy: a shell split in there is not
 * a place to go back beside. `focused` is as focused() gives it.
 */
export function returnPane(panes, fromTab, focused, ownTab = null) {
  const others = panes.filter((p) => p.mod !== MOD_ID && p.tab !== ownTab);
  const home = others.filter((p) => p.tab === fromTab);
  const there = home.find((p) => p.focused) ?? home.find((p) => p.terminal) ?? home[0];
  if (there) return there.pane;
  const focusedPane = focused?.pane && others.find((p) => p.pane === focused.pane);
  return (focusedPane ?? others.find((p) => p.terminal))?.pane ?? null;
}

// Whether another pane shares `pane`'s tab.
const hasCompany = (panes, pane) => panes.some((p) => p.tab === pane.tab && p.pane !== pane.pane);

/** Whether a Wickline pane in the shown `tab` has another pane beside it; only then can it get a tab of its own. */
export function canOpenOwnTab(panes, tab) {
  return panes.some((p) => p.mod === MOD_ID && p.tab === tab && hasCompany(panes, p));
}

/**
 * The Wickline pane to move to its own tab: the focused one, when it is not alone in its tab (clicking a mod pane
 * focuses it). Null otherwise, also for a docked block, which is not a pane.
 */
export function ownTabSource(panes) {
  const me = panes.find((p) => p.mod === MOD_ID && p.focused);
  return me && hasCompany(panes, me) ? me : null;
}

/**
 * The Wickline pane in `after` that `before` did not have (in `tab`, when given): once the new copy is open, the old
 * one may close. Null when the command did nothing visible, so nothing closes.
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
  return newWickline(
    before,
    after.filter((p) => !tabs.has(p.tab)),
  );
}

// How often and how long a wait looks. Herdr lists a new pane in panes() a little after run() returns, and a
// layout click shows in layout() a little after its command.
const POLL_MS = 50;
const WAIT_MS = 1500;

/** Looks at `check()` every 50 ms for about 1.5 s: true once it holds, false when it never did. */
export async function waitUntil(check, host) {
  for (let waited = 0; ; waited += POLL_MS) {
    if (check()) return true;
    if (waited >= WAIT_MS) return false;
    await host.sleep(POLL_MS);
  }
}

/**
 * Closes `me`, the moving copy's own pane, once the new Wickline copy shows up in panes() (in `tab`, when given).
 * A copy in `me`'s own tab does not count: one split in beside it is not the moved one.
 * Resolves true once closed; false when the new copy never showed up, and then nothing closes.
 */
export async function closeOnceOpened(before, me, host, tab = null) {
  const opened = await waitUntil(
    () =>
      newWickline(
        before,
        host.panes().filter((p) => p.tab !== me.tab),
        tab,
      ),
    host,
  );
  if (opened) host.close(me.pane);
  return opened;
}

// The nodes from the root down to the first node `match` accepts, itself included; null when none does.
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
 * Where a docked Wickline block sits in layout()'s tree, as `{ block, stack, collapse }`, or null when there is none.
 * - `block`: the first block that runs `modId` and asks for the card (wantsCard).
 * - `stack`: its nearest stack, or null.
 * - `collapse`: the node to hide, so the rest of the layout stays: the stack, or the highest wrapper above it that
 *   holds only it, up to the first node with a sibling (the side panel). Null without a stack, or when every node up
 *   to the root is a lone child.
 */
export function dockOf(tree, modId) {
  const path = pathTo(tree, (n) => n.type === "block" && n.content?.mod === modId && wantsCard(n.content.props));
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

// The child a stack shows: its `active` one, else its first. Herdr's guide does not say which child a stack without
// `active` shows; assuming the first means such a stack never hides every child.
const shownChild = (stack) => stack.active ?? stack.children?.[0]?.id;

/**
 * Whether the docked block is on screen: nothing from the root down to it is hidden, and each stack on the way shows
 * the child on the way. False when the block is gone from the tree.
 */
export function isShown(tree, dock) {
  const path = pathTo(tree, (n) => n.id === dock.block);
  if (!path) return false;
  return path.every(
    (node, i) => node.hidden !== true && (node.type !== "stack" || shownChild(node) === path[i + 1]?.id),
  );
}

// Shared state: `{ tab }`, the tab a docked block moved Wickline to (see moves.js). Cleared as `{ tab: null }`,
// since Herdr keeps a value set to null.
export const DOCK_TAB_KEY = "wickline.dockTab";

/**
 * Whether a docked block steps aside: while a Wickline pane is still in `dockTab.tab`, the shared key's tab.
 * A record left by a closed tab names a tab with no Wickline in it, so it never makes the block yield.
 */
export function blockYields(dockTab, panes) {
  return typeof dockTab?.tab === "string" && panes.some((p) => p.mod === MOD_ID && p.tab === dockTab.tab);
}

/**
 * Whether the record names a tab that no longer holds a Wickline pane, and should be cleared. Otherwise a Wickline
 * pane opened there later another way would make the block yield. False for a cleared record, or none.
 */
export function staleDockTab(dockTab, panes) {
  return typeof dockTab?.tab === "string" && !blockYields(dockTab, panes);
}
