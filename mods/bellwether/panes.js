// Pane and tab navigation: where a Bellwether tab goes back to, and when it can get a tab of its own.
// `panes` is what Herdr's panes() gives. No Herdr imports, so tests run it under Node.

/**
 * Where the copy in its own tab goes back to: a pane of the tab it was opened from (that tab's focused
 * pane, else its first terminal, else any), else the focused pane, else any terminal. Never a
 * Bellwether pane, and never a pane of `ownTab` (the tab about to lose this copy): a shell the person
 * split in there is not a place to go back beside. `panes` as panes() gives them, `focused` as
 * focused(); null: nowhere to go.
 */
export function returnPane(panes, fromTab, focused, ownTab = null) {
  const others = panes.filter((p) => p.mod !== "bellwether" && p.tab !== ownTab);
  const home = others.filter((p) => p.tab === fromTab);
  const there = home.find((p) => p.focused) ?? home.find((p) => p.terminal) ?? home[0];
  if (there) return there.pane;
  const focusedPane = focused?.pane && others.find((p) => p.pane === focused.pane);
  return (focusedPane ?? others.find((p) => p.terminal))?.pane ?? null;
}

// Another pane shares `pane`'s tab.
const hasCompany = (panes, pane) => panes.some((p) => p.tab === pane.tab && p.pane !== pane.pane);

/** A Bellwether pane in the shown `tab` has another pane beside it: only then can it get a tab of its own. */
export function canOpenOwnTab(panes, tab) {
  return panes.some((p) => p.mod === "bellwether" && p.tab === tab && hasCompany(panes, p));
}

/**
 * The Bellwether pane to move to its own tab: the focused one (clicking a mod pane focuses it), when it
 * is not alone in its tab. Null otherwise, also for a docked block, which is not a pane.
 */
export function ownTabSource(panes) {
  const me = panes.find((p) => p.mod === "bellwether" && p.focused);
  return me && hasCompany(panes, me) ? me : null;
}

/**
 * The Bellwether pane in `after` that `before` did not have (in `tab`, when given): the new copy is
 * open, so the old one may close. Null: the command did nothing visible, so nothing closes.
 */
export function newBellwether(before, after, tab = null) {
  const old = new Set(before.map((p) => p.pane));
  return after.find((p) => p.mod === "bellwether" && !old.has(p.pane) && (tab === null || p.tab === tab)) ?? null;
}
