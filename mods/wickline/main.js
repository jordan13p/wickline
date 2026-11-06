// Wickline: stock and crypto quotes beside your agents. A watchlist panel with an
// add field and a line per ticker; docked as a short strip (top or bottom), it
// draws one line of quotes. A row opens the ticker's day as a dialog, and the
// settings button opens the settings: the same mod, given the quote or `settings` in its props.
import { View } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  appHome, closeOverlay, exec, focused, layout, nextCommand, openOverlay, panes, props, run, setShared, shared, theme, window as appWindow,
} from "herdr";
import * as fs from "fs/promises";
import { Watchlist, WATCHLIST_KEY } from "./watchlist.js";
import * as secrets from "./secrets.js";
import { QuoteError } from "./quotes.js";
import { t as translate } from "./i18n.js";
import {
  SECRET_KEY_FINNHUB, SETTINGS_KEY, keyChange, mergeSettings, readSettings, upIsRed, validateSettings,
} from "./settings.js";
import { BINANCE_URL } from "./providers/binance.js";
import { MIS_URL } from "./providers/mis.js";
import { FINNHUB_URL } from "./providers/finnhub.js";
import { layoutFor, wantsCard } from "./layout.js";
import {
  DOCK_TAB_KEY, MOD_ID, blockYields, canOpenOwnTab, closeOnceOpened, dockOf, isShown, newWicklineTab, ownTabSource, returnPane, waitUntil,
} from "./panes.js";
import { band, sidebar, table, yieldView } from "./ui/panel.js";
import { detailView } from "./ui/detail-dialog.js";
import { SETTINGS_TABS, settingsView } from "./ui/settings-dialog.js";

// The key file lives in Herdr's data folder (see secrets.js); `appHome()` is called per use, never at the top level.
const secretsDir = () => `${appHome()}/data/wickline`;
// The one program Wickline runs: `chmod 600` on that file after each write, on macOS and Linux
// (secrets.js decides). Both are called per use, never at the top level.
const system = { platform: () => appWindow().platform, chmod: (path) => exec("chmod", ["600", path]) };
const loadSecret = (name) => secrets.loadSecret(fs, secretsDir(), name);
// The dialog reads only what it may show of a saved key, never the key.
const loadSecretEnding = (name) => secrets.loadSecretEnding(fs, secretsDir(), name);
// Both resolve false when the file could not be made owner-only (it is written all the same).
const saveSecret = (name, value) => secrets.saveSecret(fs, system, secretsDir(), name, value);
const removeSecret = (name) => secrets.removeSecret(fs, system, secretsDir(), name);

export default class Wickline extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.readSettings();
    if (given.detail) {
      this.detail = given.detail;
      this.overlay = given.overlay;
      return;
    }
    if (given.settings) {
      this.overlay = given.overlay;
      this.tab = SETTINGS_TABS.includes(given.settings.tab) ? given.settings.tab : "sources";
      // Each source's problem as the panel saw it when it opened the dialog.
      this.health = Array.isArray(given.settings.health) ? given.settings.health : [];
      this.initDraft(cx);
      return;
    }
    this.size = null;
    // The row under the pointer (shows its drag handle) and a drag in progress: `{ symbol, before }`,
    // `before` being the symbol the dragged one would land in front of (null: at the end).
    this.hovered = null;
    this.drag = null;
    this.typed = "";
    // `{ code, params }` or null, translated when drawn.
    this.notice = null;
    this.error = null;
    // The tab this copy's own tab was opened from (props().from), or null for a pane or block copy.
    this.from = typeof given.from === "string" ? given.from : null;
    // Docked beside Herdr's Files and Changes, it draws their card (see wantsCard).
    this.card = wantsCard(given);
    // Where that block sits in the layout (set by onScreen), or null for a copy that is not docked.
    this.dock = null;
    // The block's tab holds a Wickline pane (set by onScreen): the block shows only a way back.
    this.yielding = false;
    // This copy is the own tab a docked block moved to (props().dock), so it goes back to that block.
    this.fromDock = given.dock === true;
    // A move to or from the own tab is waiting for the new copy (see finishMove).
    this.moving = false;
    this.makeInput();

    this.watch = new Watchlist({
      load: () => shared(WATCHLIST_KEY),
      save: (preferences) => setShared(WATCHLIST_KEY, preferences),
      settings: () => shared(SETTINGS_KEY),
      // Read-only GETs to Yahoo Finance and Binance (or the Binance address the person set), and to
      // TWSE MIS (or the MIS address the person set) only once the person turned it on and consented,
      // and finnhub.io (the Finnhub path the person set) only once chosen with a key saved.
      fetch: (url, headers) => fetch(url, { headers }),
      // Read again by each copy when keyRev changes in the shared settings.
      loadSecret,
      now: () => Date.now(),
      // A docked block that is not on screen sends nothing.
      shown: () => this.onScreen(),
    });
    // One loop per source, so a slow source never holds up another. Each owns the cx of its own
    // spawn for its whole life: sleeping and redrawing go through it.
    for (const id of this.watch.providerIds()) {
      cx.spawn(async (cx) => {
        await this.watch.runProvider(id, { sleep: (ms) => cx.sleep(ms), changed: () => cx.notify() });
      });
    }
    // A language chosen in another copy reaches this one on render, where no input can be made: render
    // wakes this loop, which remakes the input at once, keeping what was typed and the focus.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wakeInput = resolve; });
        if (this.inputLang === this.lang) continue;
        const hadFocus = this.inputFocused;
        this.makeInput();
        if (hadFocus) this.input.focus();
        cx.notify();
      }
    });
    // `wickline.refresh` and `wickline.pause` (bind them in keys.json if you like).
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.watch.refreshNow();
        else if (command === "pause") this.togglePause();
        cx.notify();
      }
    });
  }

  close() {
    this.watch?.stop();
  }

  // Shared by every copy; the language is the person's choice, never the market's or the system's.
  readSettings() {
    this.settings = readSettings(shared(SETTINGS_KEY));
    this.lang = this.settings.language;
  }

  saveSettings(change) {
    setShared(SETTINGS_KEY, mergeSettings(shared(SETTINGS_KEY), change));
    this.readSettings();
  }

  // Edits to the settings wait in a copy until Save: Cancel, Esc or closing drops it.
  initDraft(cx) {
    this.draft = JSON.parse(JSON.stringify(this.settings));
    this.error = null;
    this.saving = false;
    this.initFinnhubDraft(cx);
    this.urlInput = InputState.new({ placeholder: BINANCE_URL, value: this.draft.sources.crypto.binanceUrl });
    // Redraw on every keystroke: the field's error and the Save button follow the draft.
    this.urlInput.on("change", (_e, cx) => { this.draft.sources.crypto.binanceUrl = this.urlInput.value(); cx.notify(); });
    this.trackFocus(this.urlInput, "urlFocused");
    this.misUrlInput = InputState.new({ placeholder: MIS_URL, value: this.draft.sources.tw.misUrl });
    this.misUrlInput.on("change", (_e, cx) => { this.draft.sources.tw.misUrl = this.misUrlInput.value(); cx.notify(); });
    this.trackFocus(this.misUrlInput, "misUrlFocused");
  }

  // `this[flag]` follows whether `input` has the focus, redrawing on each change: a field's border shows it.
  trackFocus(input, flag) {
    this[flag] = false;
    input.on("focus", (_e, cx) => { this[flag] = true; cx.notify(); });
    input.on("blur", (_e, cx) => { this[flag] = false; cx.notify(); });
  }

  // The key input is for a new key only: it starts empty and masked, and a saved key is shown as its last
  // four characters (keyEnding; null: none saved). Save waits for that read, so a missing key is never
  // taken for a saved one.
  initFinnhubDraft(cx) {
    this.keyEnding = null;
    this.keyLoaded = false;
    this.keyShown = false;
    // Remove was pressed: the saved key goes on Save; Cancel drops it with the rest of the draft.
    this.keyRemoving = false;
    // `{ code, params }` once the key was saved but could not be made owner-only.
    this.keyWarning = null;
    this.keyInput = InputState.new({ placeholder: this.tx("sources.us.key") });
    this.keyInput.set_masked(true);
    this.keyInput.on("change", (_e, cx) => cx.notify());
    // Shown text is masked again as soon as the field loses the focus.
    this.keyFocused = false;
    this.keyInput.on("focus", (_e, cx) => { this.keyFocused = true; cx.notify(); });
    this.keyInput.on("blur", (_e, cx) => { this.keyFocused = false; this.maskKey(); cx.notify(); });
    this.finnhubUrlInput = InputState.new({ placeholder: FINNHUB_URL, value: this.draft.sources.us.finnhubUrl });
    this.finnhubUrlInput.on("change", (_e, cx) => { this.draft.sources.us.finnhubUrl = this.finnhubUrlInput.value(); cx.notify(); });
    this.trackFocus(this.finnhubUrlInput, "finnhubUrlFocused");
    this.budgetInput = InputState.new({ value: String(this.draft.sources.us.budgetPerMinute) });
    // A whole number once it reads as one; until then the text, which validation refuses.
    this.budgetInput.on("change", (_e, cx) => {
      const typed = this.budgetInput.value().trim();
      this.draft.sources.us.budgetPerMinute = /^\d+$/.test(typed) ? Number(typed) : typed;
      cx.notify();
    });
    this.trackFocus(this.budgetInput, "budgetFocused");
    cx.spawn(async (cx) => {
      await this.readKeyEnding();
      this.keyLoaded = true;
      cx.notify();
    });
  }

  async readKeyEnding() {
    try {
      this.keyEnding = await loadSecretEnding(SECRET_KEY_FINNHUB);
    } catch {
      // Unreadable: the card shows the panel's problem; a key saved now replaces the file.
      this.keyEnding = null;
    }
  }

  maskKey() {
    this.keyShown = false;
    this.keyInput.set_masked(true);
  }

  // The input's placeholder is fixed when it is made, so a new language needs a new input
  // (made in init, an event handler or a spawned task, never in render).
  makeInput() {
    this.input?.release();
    this.inputLang = this.lang;
    this.input = InputState.new({ placeholder: this.tx("input.placeholder"), value: this.typed });
    this.input.on("change", () => { this.typed = this.input.value(); });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.trackFocus(this.input, "inputFocused");
  }

  chooseLanguage(cx, language) {
    this.act(cx, () => {
      this.saveSettings({ language, languagePromptDismissed: true });
      if (this.inputLang !== this.lang) this.makeInput();
    }, "error.saveSettings");
  }

  // The text for `key` in this copy's language.
  tx(key, params) {
    return translate(this.lang, key, params);
  }

  // A `{ code, params }` notice or error as text; a `source` param is a provider id, shown by name.
  say(coded) {
    const source = coded.params?.source;
    return this.tx(coded.code, source ? { ...coded.params, source: this.tx(`src.${source}`) } : coded.params);
  }

  // `failure` names what could not be saved: the watchlist, or the settings for the prompt.
  act(cx, action, failure = "error.save") {
    this.error = null;
    try { this.notice = action() ?? null; } catch (cause) {
      this.notice = null;
      // Anything but a bad symbol is the store failing.
      this.error = cause instanceof QuoteError ? { code: cause.code, params: cause.params } : { code: failure, params: {} };
    }
    cx.notify();
  }

  add(cx) {
    this.act(cx, () => {
      const notice = this.watch.add(this.typed);
      this.input.set_value("");
      this.typed = "";
      return notice;
    });
    // A first add answers the language prompt too: it stays English.
    if (this.notice?.code !== "notice.added" || this.settings.languagePromptDismissed) return;
    try { this.saveSettings({ languagePromptDismissed: true }); } catch {
      this.error = { code: "error.saveSettings", params: {} };
    }
  }

  togglePause() {
    return this.watch.pause(!this.watch.preferences.paused);
  }

  openDetail(symbol) {
    const quote = this.watch.shown(symbol);
    if (!quote) return;
    openOverlay({
      mod: MOD_ID, kind: "dialog", width: 440,
      props: { detail: { ...quote, error: this.watch.errors[symbol] ?? null, fallback: this.watch.overlayErrors[symbol] ?? null } },
    });
  }

  openSettings(tab) {
    openOverlay({
      mod: MOD_ID, kind: "dialog", modal: true, width: 640, height: 520,
      // `health`: each source's current problem, `{ provider, code, params }`.
      props: { settings: { tab, health: this.watch.problems() } },
    });
  }

  // A docked block is on screen while its panel is open and its tab is the stack's active one, and
  // draws quotes unless it yields to its own tab (then it fetches nothing either). Reads the layout
  // each time, as the person may move the block or switch layouts.
  onScreen() {
    const tree = this.card ? layout() : null;
    // The first card block in the layout is taken to be this copy: Wickline is docked once, as the
    // office layout does, and panes() cannot tell copies apart anyway.
    this.dock = tree && dockOf(tree, MOD_ID);
    this.yielding = Boolean(this.dock) && blockYields(shared(DOCK_TAB_KEY), panes());
    return !this.dock || (isShown(tree, this.dock) && !this.yielding);
  }

  render() {
    const t = theme();
    this.readSettings();
    if (this.detail) return detailView(this, t);
    if (this.draft) return settingsView(this, t);
    // Herdr re-renders every copy when shared state changes: adopt another copy's edit now.
    this.watch.sync();
    // A hidden docked block never renders, so this render means it was just shown: run the rounds it skipped.
    if (this.card) {
      this.onScreen();
      if (!this.yielding) this.watch.wakeMissed();
    }
    if (this.inputLang !== this.lang) this.wakeInput?.();
    const form = layoutFor(this.size);
    const root = (form === "band" ? h_flex() : v_flex())
      // `background`, as Herdr's terminals and other panes: Wickline sits beside them as one more pane.
      .id("bw").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .when(this.card, (el) => el.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    if (this.yielding) return yieldView(this, root, t, form === "band");
    if (form === "band") return band(this, root, t);
    return form === "table" ? table(this, root, t) : sidebar(this, root, t);
  }

  // Red-up or green-up, by the color setting (automatic: red-up in every language but English).
  changeColor(t, change) {
    if (change === null || change === undefined) return t.dim;
    const [up, down] = upIsRed(this.settings) ? [t.ansi1, t.ansi2] : [t.ansi2, t.ansi1];
    return change >= 0 ? up : down;
  }

  // A pane copy that shares its tab offers its own tab; the copy in that tab offers the way back, when
  // there is a pane to go back beside. A docked block offers its own tab while it is shown, and its tab
  // copy offers the way back to the panel. Dialog copies draw neither (they never reach the header).
  // Clicking a mod pane focuses it, so the focused Wickline pane is the one clicked; each click
  // checks again. panes() lists the new copy a little after run() returns, so a task looks for it
  // (closeOnceOpened) and only then closes the old copy's own pane, never a shell the person split in
  // beside it. Clicks while a move is under way do nothing, so copies never pile up.
  ownTabAction() {
    if (this.fromDock) {
      if (!dockOf(layout(), MOD_ID)) return null;
      return {
        icon: "restore", label: "button.backToPanel",
        go: (cx) => this.backToPanel(cx, panes().find((p) => p.mod === MOD_ID && p.focused), true),
      };
    }
    if (this.dock) return this.dockTabAction();
    const all = panes();
    const shownTab = focused()?.tab ?? null;
    if (!this.from) {
      if (!canOpenOwnTab(all, shownTab)) return null;
      return {
        icon: "zoom", label: "button.ownTab",
        go: (cx) => {
          if (this.moving) return;
          const before = panes();
          const me = ownTabSource(before);
          if (!me) return;
          run("tab.new", { mod: MOD_ID, name: "Wickline", props: { from: me.tab } });
          this.finishMove(cx, before, me);
        },
      };
    }
    if (!returnPane(all, this.from, focused(), shownTab)) return null;
    return {
      icon: "restore", label: "button.backBeside",
      go: (cx) => {
        if (this.moving) return;
        const before = panes();
        const me = before.find((p) => p.mod === MOD_ID && p.focused && p.tab !== this.from);
        const target = me && returnPane(before, this.from, focused(), me.tab);
        if (!target) return;
        run("pane.split", { pane: target, direction: "right", mod: MOD_ID });
        this.finishMove(cx, before, me, before.find((p) => p.pane === target).tab);
      },
    };
  }

  // The block's own tab: opens it, and only once panes() shows it records the tab (so the block yields
  // if the panel is opened again) and collapses the panel. This copy stays, so the button works again
  // afterwards; when the tab never shows up, nothing collapses.
  dockTabAction() {
    if (this.yielding || !isShown(layout(), this.dock)) return null;
    return {
      icon: "zoom", label: "button.ownTab",
      go: (cx) => {
        if (this.moving) return;
        const before = panes();
        const { collapse } = this.dock;
        run("tab.new", { mod: MOD_ID, name: "Wickline", props: { dock: true } });
        this.runMove(cx, async (cx) => {
          let tab = null;
          const opened = await waitUntil(() => (tab = newWicklineTab(before, panes())), { sleep: (ms) => cx.sleep(ms) });
          if (!opened) return false;
          setShared(DOCK_TAB_KEY, { tab: tab.tab });
          if (collapse) run("layout.hide", { id: collapse });
          return false;
        });
      },
    };
  }

  // Reopens the panel on the Wickline block, and only once it is shown closes `pane`, the Wickline pane
  // of the tab (never the tab, so a shell split in beside it stays), and forgets the tab. The tab's own
  // copy passes the focused Wickline pane; the block's yield view, which is not focused, the dock tab's.
  // With the panel already open, select and show change nothing. The block is found again in the
  // layout: the person may have moved it since. No pane, nothing happens: never close one unseen.
  // `leaving`: `pane` is this copy's own (the tab copy), so the move keeps further clicks out for good;
  // the block's yield view closes another copy's pane and stays, so its buttons keep working.
  backToPanel(cx, pane, leaving) {
    if (this.moving) return;
    const dock = dockOf(layout(), MOD_ID);
    if (!dock || !pane) return;
    this.runMove(cx, async (cx) => {
      if (dock.stack) run("layout.select", { stack: dock.stack, child: dock.block });
      if (dock.collapse) run("layout.show", { id: dock.collapse });
      if (!await waitUntil(() => isShown(layout(), dock), { sleep: (ms) => cx.sleep(ms) })) return false;
      setShared(DOCK_TAB_KEY, null);
      run("pane.close", { pane: pane.pane });
      return leaving;
    });
  }

  // The yield view's button: the Wickline pane of the tab the block moved to (not the focused one).
  backFromYield(cx) {
    const dockTab = shared(DOCK_TAB_KEY);
    this.backToPanel(cx, panes().find((p) => p.mod === MOD_ID && p.tab === dockTab?.tab), false);
  }

  // Runs `step(cx)` as a move, in a spawned task that owns its cx. Further clicks do nothing meanwhile.
  // `step` resolves true once this copy is going away (its pane closed), which keeps them out for good;
  // false, or a throw, leaves everything as it was and the button works again.
  runMove(cx, step) {
    this.moving = true;
    cx.spawn(async (cx) => {
      let leaving = false;
      try {
        leaving = await step(cx);
      } catch {
        // Nothing to undo: a step closes only after it has seen what it waited for.
      } finally {
        if (!leaving) this.moving = false;
      }
    });
  }

  // Closes `me` once the new copy is seen (in `tab`, when given).
  finishMove(cx, before, me, tab = null) {
    this.runMove(cx, (cx) => closeOnceOpened(before, me, {
      panes, sleep: (ms) => cx.sleep(ms), close: (pane) => run("pane.close", { pane }),
    }, tab));
  }

  // The dialogs' close: Herdr names the overlay in the props it opened the copy with.
  closeDialog() {
    closeOverlay(this.overlay);
  }

  // Herdr's own appearance settings, in place of this dialog.
  openAppearance() {
    closeOverlay(this.overlay);
    run("app.settings", { section: "look" });
  }

  // "Showing Yahoo · <reason>": a real-time price was dropped, so the row shows its base quote.
  fallbackText(quote, error) {
    return this.tx("quote.fallback", { source: this.tx(`src.${quote.source}`), reason: this.say(error) });
  }

  // What stops a save, the key the dialog holds included (it is never in the draft).
  draftErrors() {
    return validateSettings(this.draft, { finnhubKey: this.keyInput.value(), keySaved: this.keyEnding !== null && !this.keyRemoving });
  }

  // Writes only what the dialog edits, over what is saved now: a newer copy's other keys stay. A new
  // Finnhub key goes to the secrets file first (or, after Remove, leaves it), then keyRev + 1
  // tells every copy to read it again.
  saveDraft(cx) {
    if (Object.keys(this.draftErrors()).length || !this.keyLoaded || this.saving) return;
    const { language, colors, sources } = this.draft;
    const key = this.keyInput.value().trim();
    const change = keyChange({ provider: sources.us.provider, typed: key, saved: this.keyEnding !== null, removing: this.keyRemoving });
    this.saving = true;
    this.error = null;
    cx.spawn(async (cx) => {
      let ownerOnly = true;
      if (change) {
        try {
          ownerOnly = change === "write" ? await saveSecret(SECRET_KEY_FINNHUB, key) : await removeSecret(SECRET_KEY_FINNHUB);
        } catch {
          this.saving = false;
          this.error = { code: "error.saveKey", params: {} };
          cx.notify();
          return;
        }
      }
      try {
        const saved = shared(SETTINGS_KEY);
        setShared(SETTINGS_KEY, mergeSettings(saved, {
          language, colors, sources,
          // Picking a language answers the language prompt too.
          ...(language !== this.settings.language && { languagePromptDismissed: true }),
          ...(change && { keyRev: readSettings(saved).keyRev + 1 }),
        }));
      } catch {
        this.saving = false;
        this.error = { code: "error.saveSettings", params: {} };
        cx.notify();
        return;
      }
      if (!ownerOnly) {
        // Saved, but other accounts may read the file: the dialog stays open to say so, and Save closes it.
        this.saving = false;
        this.keyInput.set_value("");
        this.keyRemoving = false;
        await this.readKeyEnding();
        this.keyWarning = { code: "finnhub.keyUnprotected", params: {} };
        this.tab = "sources";
        cx.notify();
        return;
      }
      closeOverlay(this.overlay);
    });
  }
}
