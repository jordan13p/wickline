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
import { changeTone, number } from "./format.js";
import { sessionOf, shownLimit } from "./freshness.js";
import { FILTER_STORAGE_KEY, dropBefore, filterAfterAdd, filterAfterRemove, nextOf, openFilter, readFilter, resolvedMarket } from "./markets.js";
import { MOTION_END_MS, MOTION_GAP_MS, SPIN_MS, UNDO_MS, settleOffset, spinTurnsFor } from "./motion.js";
import { t as translate } from "./i18n.js";
import {
  SECRET_KEY_FINNHUB, SETTINGS_KEY, currentHealth, keyChange, mergeSettings, readSettings, settingsMarkets, upIsRed,
  validateSettings,
} from "./settings.js";
import { BINANCE_URL } from "./providers/binance.js";
import { MIS_URL } from "./providers/mis.js";
import { FINNHUB_URL } from "./providers/finnhub.js";
import { layoutFor, wantsCard } from "./layout.js";
import { MOD_ID } from "./panes.js";
import * as moves from "./moves.js";
import { band, sidebar, table, yieldView } from "./ui/panel.js";
import { detailView } from "./ui/detail-dialog.js";
import { SETTINGS_TABS, settingsView } from "./ui/settings-dialog.js";

// The key file lives in Herdr's data folder (see secrets.js); `appHome()` is called per use, never at the top level.
const secretsDir = () => `${appHome()}/data/wickline`;
// The one program Wickline runs: `chmod 600` on that file after each write, on macOS and Linux
// (secrets.js decides). Both are called per use, never at the top level.
const system = { platform: () => appWindow().platform, chmod: (path) => exec("chmod", ["600", path]) };
// This copy's market filter lives in its own localStorage (per copy in Herdr 0.1.12, which is the point:
// the side panel and a pane keep separate choices). Nothing else goes there. Read per use, inside a try.
const filterStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
const loadSecret = (name) => secrets.loadSecret(fs, secretsDir(), name);
// The dialog reads only what it may show of a saved key, never the key.
const loadSecretEnding = (name) => secrets.loadSecretEnding(fs, secretsDir(), name);
// Both resolve false when the file could not be made owner-only (it is written all the same).
const saveSecret = (name, value) => secrets.saveSecret(fs, system, secretsDir(), name, value);
const removeSecret = (name) => secrets.removeSecret(fs, system, secretsDir(), name);
// What the moves between a pane, a tab and a docked block use of Herdr (see moves.js).
const moveHost = { panes, layout, run, shared, setShared, focused };

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
      // No tab (the settings button) opens the first market page in the person's language.
      this.tab = SETTINGS_TABS.includes(given.settings.tab) ? given.settings.tab : settingsMarkets(this.lang)[0];
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
    // Row motion, only for what this copy's person just did (see playRow). Rows from a first load, the
    // starter list or another copy's edit never move. `added`: symbol -> "new" (drawn transparent) then
    // "shown"; `leaving`: removed rows still on screen, `{ symbol, before, row, height, gone }`; `settle`: the
    // dropped row, `{ symbol, from }` (px it starts from, then 0); `rowHeights`: each row's measured height.
    this.added = new Map();
    this.leaving = [];
    this.settle = null;
    this.rowHeights = {};
    // The market filter: this copy's stored choice, else the one it was opened with (props; Herdr keeps them
    // with the tab, so they must never override a later choice), else "all". Only a choice made here is
    // stored. Rows and the filter row read it through filterState, so a market no longer on the list reads as All.
    this.filter = openFilter(filterStorage, given.filter);
    // A symbol's market for the filter and the fading rows: the watchlist's (an index's from the exchange its
    // quote reports), or, for a row still fading out (its quote already dropped), the one its row was drawn with.
    this.marketFor = (symbol) => {
      const exchange = this.watch.exchangeOf(symbol);
      const ghost = exchange === null ? this.leaving.find((g) => g.symbol === symbol) : null;
      return resolvedMarket(symbol, ghost ? ghost.row.quote?.exchange ?? null : exchange);
    };
    // The pill's geometry: each filter label's width, reported by the label itself (see ui/panel.js).
    this.filterWidths = {};
    this.typed = "";
    // `{ code, params }` or null, translated when drawn.
    this.notice = null;
    this.error = null;
    // The tab this copy's own tab was opened from (props().from; from a pane or a block), or null.
    this.from = typeof given.from === "string" ? given.from : null;
    // Docked beside Herdr's Files and Changes, it draws their card (see wantsCard).
    this.card = wantsCard(given);
    // Where that block sits in the layout (set on render by syncDock), or null for a copy that is not docked.
    this.dock = null;
    // The block's tab holds a Wickline pane (set by syncDock): the block shows only a way back.
    this.yielding = false;
    // The block is on screen and not yielding (set by syncDock): it offers its own tab.
    this.dockShown = false;
    // This copy is the own tab a docked block moved to (props().dock), so it goes back to that block.
    this.fromDock = given.dock === true;
    // A move to or from the own tab is waiting for the new copy (see finishMove).
    this.moving = false;
    // The refresh icon's turn (see refresh): null at rest, else `{ start, needed }`, turning since `start` (ms)
    // until `needed` whole turns are done.
    this.spin = null;
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
        if (command === "refresh") this.refresh(cx);
        else if (command === "pause") this.act(cx, () => this.togglePause());
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

  // The caller redraws. A failed write costs only the memory across restarts, not this choice.
  setFilter(id) {
    this.filter = id;
    try {
      filterStorage.setItem(FILTER_STORAGE_KEY, id);
    } catch {
      // Not remembered after a restart; the copy keeps using it.
    }
  }

  resetFilter(id) {
    if (id !== this.filter) this.setFilter(id);
  }

  // The market filter as this copy reads it: `{ filters, chosen, shown }` (see readFilter in markets.js).
  filterState() {
    return readFilter(this.watch.preferences.symbols, this.filter, this.marketFor, this.lang);
  }

  // A filter that would hide `symbol` (just added, or already listed) goes back to All, so the person sees it.
  revealSymbol(symbol) {
    this.resetFilter(filterAfterAdd(this.watch.preferences.symbols, this.filter, symbol, this.marketFor));
  }

  // The row motions start their state inside the action, before `act` redraws, so the first draw is the start.
  removeSymbol(cx, symbol) {
    // Taken before the remove, which drops the row's quote at once: the fading row draws from this copy.
    const symbols = this.watch.preferences.symbols;
    const ghost = {
      symbol, before: nextOf(symbols, symbol), row: this.rowSource(symbol), height: this.rowHeights[symbol], gone: false,
    };
    this.act(cx, () => {
      const notice = this.watch.remove(symbol);
      // An index still waiting for its first quote may belong to the chosen market: keep the choice until it reports.
      // Otherwise the chosen market's last symbol went: back to All for good, so the filter does not come back the
      // day the market does.
      this.resetFilter(filterAfterRemove(this.watch.preferences.symbols, this.filter, this.marketFor,
        (symbol) => this.watch.pendingIndex(symbol)));
      if (notice.code === "notice.removed" && ghost.height > 0) {
        this.added.delete(symbol);
        this.leaving.push(ghost);
        this.playRow(cx, () => { ghost.gone = true; }, () => { this.leaving = this.leaving.filter((g) => g !== ghost); });
      }
      return notice;
    });
  }

  // A removal's notice offers Undo for UNDO_MS, then keeps its text without it. One sleep in a task of its
  // own, not a poll; a newer notice (any later edit) has ended the Undo already, so it leaves that alone.
  expireUndo(cx) {
    const held = this.notice;
    if (!held?.undo) return;
    cx.spawn(async (cx) => {
      await cx.sleep(UNDO_MS);
      if (this.watch.stopped || this.notice !== held) return;
      const { undo, ...plain } = held;
      this.notice = plain;
      cx.notify();
    });
  }

  // Puts the last removed symbol back where it was, in every copy. Read before `act` replaces the notice,
  // so a second click on a stale Undo does nothing. Listed again already (another copy added it): `restore`
  // gives null and the notice line clears.
  undoRemove(cx) {
    const undo = this.notice?.undo;
    if (!undo) return;
    this.act(cx, () => {
      const notice = this.watch.restore(undo.symbol, undo.index);
      if (notice) {
        this.revealSymbol(undo.symbol);
        this.fadeIn(cx, undo.symbol);
      }
      return notice;
    });
  }

  // A symbol this copy's person just added fades in: its first draw is transparent.
  fadeIn(cx, symbol) {
    // Added again while its old row is still fading out: that row goes at once.
    this.leaving = this.leaving.filter((g) => g.symbol !== symbol);
    this.added.set(symbol, "new");
    this.playRow(cx, () => { if (this.added.has(symbol)) this.added.set(symbol, "shown"); }, () => this.added.delete(symbol));
  }

  // Drops `drag.symbol` in front of `drag.before`. A move that changed the order slides the row from where
  // it was to where it landed (the distance, from the rows' measured heights).
  dropRow(cx, drag) {
    const symbols = this.watch.preferences.symbols;
    const was = this.filterState().shown;
    this.act(cx, () => {
      const notice = this.watch.move(drag.symbol, dropBefore(symbols, was, drag.before));
      const from = notice && settleOffset(was, this.filterState().shown, drag.symbol, this.rowHeights);
      if (from) {
        const settle = { symbol: drag.symbol, from };
        this.settle = settle;
        this.playRow(cx, () => { if (this.settle === settle) settle.from = 0; }, () => { if (this.settle === settle) this.settle = null; });
      }
      return notice;
    });
  }

  /**
   * One row motion, from a click or a drop and never from a round. The row has just been given its start
   * state (the caller redraws), `flip` moves it to the end state a frame later, which the row's
   * `transition` animates, and `clear` drops the state once that is done, also when a step throws. One
   * sleep per step in a task of its own, not a timer: it ends with the copy.
   */
  playRow(cx, flip, clear) {
    cx.spawn(async (cx) => {
      try {
        await cx.sleep(MOTION_GAP_MS);
        flip();
        cx.notify();
        await cx.sleep(MOTION_END_MS);
      } finally {
        clear();
        if (!this.watch.stopped) cx.notify();
      }
    });
  }

  // Edits to the settings wait in a copy until Save: Cancel, Esc or closing drops it.
  initDraft(cx) {
    this.draft = JSON.parse(JSON.stringify(this.settings));
    this.error = null;
    this.saving = false;
    // Which consented statements are shown again, and which pages' Advanced is open: the dialog's own, never saved.
    this.statementOpen = new Set();
    this.advancedOpen = new Set();
    this.initFinnhubDraft(cx);
    this.urlInput = InputState.new({ placeholder: BINANCE_URL, value: this.draft.sources.crypto.binanceUrl });
    // Redraw on every keystroke: the field's error and the Save button follow the draft. A field typed in
    // keeps its page's Advanced open, also once an error that opened it is fixed.
    this.urlInput.on("change", (_e, cx) => {
      this.draft.sources.crypto.binanceUrl = this.urlInput.value();
      this.advancedOpen.add("crypto");
      cx.notify();
    });
    this.trackFocus(this.urlInput, "urlFocused");
    this.misUrlInput = InputState.new({ placeholder: MIS_URL, value: this.draft.sources.tw.misUrl });
    this.misUrlInput.on("change", (_e, cx) => {
      this.draft.sources.tw.misUrl = this.misUrlInput.value();
      this.advancedOpen.add("tw");
      cx.notify();
    });
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
    this.finnhubUrlInput.on("change", (_e, cx) => {
      this.draft.sources.us.finnhubUrl = this.finnhubUrlInput.value();
      this.advancedOpen.add("us");
      cx.notify();
    });
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
      // Unreadable: the United States page shows the panel's problem; a key saved now replaces the file.
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
    // A removal's notice carries `undo`, whichever action gave it; it ends after UNDO_MS.
    this.expireUndo(cx);
  }

  // Every notice an add gives but the duplicate's means a new symbol, whatever it says about Finnhub's cap.
  add(cx) {
    this.act(cx, () => {
      const notice = this.watch.add(this.typed);
      this.input.set_value("");
      this.typed = "";
      this.revealSymbol(notice.params.symbol);
      if (notice.code !== "notice.duplicate") this.fadeIn(cx, notice.params.symbol);
      return notice;
    });
    // A first add that went through answers the language prompt too: it stays English.
    if (!this.notice || this.notice.code === "notice.duplicate" || this.settings.languagePromptDismissed) return;
    try { this.saveSettings({ languagePromptDismissed: true }); } catch {
      this.error = { code: "error.saveSettings", params: {} };
    }
  }

  /**
   * Asks every source for a round and turns the refresh icon until it ends, always a whole number of
   * turns so it stops upright, and at least one whole turn for each press (a round that ends at once
   * still turns once). One task per spin: a press while it runs adds a turn and starts no new round (a
   * round still out has already joined; one that just ended is under a second old), so a double click
   * costs one round per source. Its single sleep per turn is not a poll; it ends with the copy.
   */
  refresh(cx) {
    if (this.spin) {
      this.spin.needed = Math.max(this.spin.needed, spinTurnsFor(Date.now() - this.spin.start, SPIN_MS));
      return;
    }
    this.watch.refreshNow();
    const spin = { start: Date.now(), needed: spinTurnsFor(0, SPIN_MS) };
    this.spin = spin;
    let turned = 0;
    cx.spawn(async (cx) => {
      do {
        await cx.sleep(SPIN_MS);
        if (this.watch.stopped) return;
      } while (++turned < spin.needed || this.watch.refreshing);
      this.spin = null;
      cx.notify();
    });
  }

  togglePause() {
    return this.watch.pause(!this.watch.preferences.paused);
  }

  openDetail(symbol) {
    const quote = this.watch.shown(symbol);
    if (!quote) return;
    openOverlay({
      mod: MOD_ID, kind: "dialog", width: 440,
      props: { detail: { ...quote, error: this.watch.errors[symbol] ?? null, fallback: this.watch.overlayError(symbol) } },
    });
  }

  openSettings(tab) {
    openOverlay({
      mod: MOD_ID, kind: "dialog", modal: true, width: 640, height: 520,
      // `health`: each source's current problem, `{ provider, code, params }`.
      props: { settings: { tab, health: this.watch.problems() } },
    });
  }

  // Whether this copy is on screen, asked by the loops; it sets nothing (see moves.js).
  onScreen() {
    return moves.onScreen(moveHost, this);
  }

  // Sets this.dock, this.yielding and this.dockShown for the render under way (see moves.js).
  syncDock() {
    moves.syncDock(moveHost, this);
  }

  render() {
    const t = theme();
    this.readSettings();
    if (this.detail) return detailView(this, t);
    if (this.draft) return settingsView(this, t);
    // Herdr re-renders every copy when shared state changes: adopt another copy's edit now.
    this.watch.sync();
    // A hidden docked block never renders, so a render usually means it was just shown: run the rounds it
    // skipped. wakeMissed asks shown() itself, so a copy judged hidden or yielding wakes nothing.
    if (this.card) {
      this.syncDock();
      this.watch.wakeMissed();
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

  // What a row reads from the watchlist. A row being removed draws from the copy taken before its quote went.
  rowSource(symbol) {
    const w = this.watch;
    const now = Date.now();
    return {
      quote: w.shown(symbol, now),
      failed: w.errors[symbol],
      // The real-time source failed for this symbol: the base quote shows, with the reason.
      fallback: w.overlayError(symbol, now),
      // A US row past Finnhub's budget stays on Yahoo and says so.
      overCap: w.overCap(symbol),
    };
  }

  /**
   * A price at its own source's limit, as drawn: null for any other, for a price shown as cached (`failed`), and
   * for one no longer current (shownLimit: stalled, or a trial match before the open).
   * Its color is the gain or loss color by the limit's side, whatever the %: an ex-dividend day's limits are
   * set from a reference price, not the previous close.
   */
  limitMark(t, quote, failed, now) {
    const limit = !failed && shownLimit(quote, sessionOf(quote, now), now);
    if (!limit) return null;
    const up = limit === "up";
    // At its limit the price is the limit, so its own text names it.
    // The panel's background as ink keeps the block readable in light and dark themes alike.
    return {
      limit, color: this.changeColor(t, up ? 1 : -1), ink: t.background,
      tip: this.tx(up ? "quote.limitUp" : "quote.limitDown", { price: number(quote) }),
    };
  }

  // Red-up or green-up, by the color setting (automatic: red-up in every language but English). A day
  // that reads 0.00% is neither, in every view.
  changeColor(t, change) {
    const tone = changeTone(change);
    if (tone === "none") return t.dim;
    if (tone === "flat") return t.muted;
    const [up, down] = upIsRed(this.settings) ? [t.ansi1, t.ansi2] : [t.ansi2, t.ansi1];
    return tone === "up" ? up : down;
  }

  // The header's own-tab icon or null, and the yield view's button (see moves.js).
  ownTabAction() {
    return moves.ownTabAction(moveHost, this);
  }

  backFromYield(cx) {
    moves.backFromYield(moveHost, this, cx);
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

  // "Showing Yahoo Finance · <reason>": a real-time price was dropped, so the row shows its base quote.
  fallbackText(quote, error) {
    return this.tx("quote.fallback", { source: this.tx(`src.${quote.source}`), reason: this.say(error) });
  }

  // What stops a save, the key the dialog holds included (it is never in the draft).
  draftErrors() {
    return validateSettings(this.draft, { finnhubKey: this.keyInput.value(), keySaved: this.keyEnding !== null && !this.keyRemoving });
  }

  // The Finnhub key as the dialog holds it, given `errors` (draftErrors), for marketStatus: the dialog
  // reads the US market as live only with a key Finnhub would use after Save.
  keyFields(errors) {
    return {
      typed: this.keyInput.value().trim(), typedValid: !errors["sources.us.key"],
      saved: this.keyEnding !== null, removing: this.keyRemoving,
    };
  }

  // Writes only what the dialog edits, over what is saved now: a newer copy's other keys stay. A new
  // Finnhub key goes to the secrets file first (or, after Remove, leaves it), then keyRev + 1
  // tells every copy to read it again.
  saveDraft(cx) {
    if (Object.keys(this.draftErrors()).length || !this.keyLoaded || this.saving) return;
    const { language, colors, sources } = this.draft;
    const key = this.keyInput.value().trim();
    const change = keyChange({ provider: sources.us.provider, typed: key, saved: this.keyEnding !== null, removing: this.keyRemoving });
    // Taken before the write, which re-renders this copy with the new settings.
    const before = this.settings;
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
        // Sources whose settings this save changed have not run with them yet: their old problems go.
        this.health = currentHealth({ health: this.health, saved: before, draft: this.draft, keyEdited: change !== null });
        this.keyInput.set_value("");
        this.keyRemoving = false;
        await this.readKeyEnding();
        this.keyWarning = { code: "finnhub.keyUnprotected", params: {} };
        this.tab = "us";
        cx.notify();
        return;
      }
      closeOverlay(this.overlay);
    });
  }
}
