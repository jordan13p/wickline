// Bellwether: stock and crypto quotes beside your agents. A watchlist panel with an
// add field and a line per ticker; docked as a short strip (top or bottom), it
// draws one line of quotes. A row opens the ticker's day as a dialog, and the
// settings button opens the settings: the same mod, given the quote or `settings` in its props.
import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, Checkbox, InputState, Input } from "gpui-base";
import { appHome, closeOverlay, focused, nextCommand, openOverlay, panes, props, run, setShared, shared, theme } from "herdr";
import * as fs from "fs/promises";
import { Watchlist, WATCHLIST_KEY } from "./watchlist.js";
import {
  QuoteError, chartGeometry, displayName, formatBandPrice, formatChange, formatPrice, formatStaleDate, formatTime, isCryptoPair, rowMeta,
} from "./quotes.js";
import { detailSource, freshness, sessionOf } from "./freshness.js";
import { LANGUAGES, LANGUAGE_LABELS, t as translate } from "./i18n.js";
import {
  DEFAULT_BINANCE_URL, SECRET_KEY_FINNHUB, SETTINGS_KEY, keyChange, mergeSettings, readSettings, upIsRed, validateSettings,
} from "./settings.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "./providers/mis.js";
import { FINNHUB_URL, finnhubCap } from "./providers/finnhub.js";
import {
  COLUMN_GAP, GUTTER, TABLE_COLUMNS, TABLE_MAX_WIDTH, canOpenOwnTab, layoutFor, nameWidth, newBellwether, ownTabSource, returnPane, tableColumns,
} from "./layout.js";

// Freshness states drawn with a hollow dot: the price may not be current.
const HOLLOW = ["unconfirmed", "stalled", "delayed"];
const ICON = "mods/bellwether/icon.svg";
const icon = (name) => `mods/bellwether/icons/${name}.svg`;
// Sidebar rows: the day's line, then the price column (the number, then a slot for its currency).
// The right group keeps this width, so a wider pane gives its room to the name.
const SPARK = { width: 56, height: 20 };
const TABLE_SPARK = { width: 120, height: 20 };
const NUMBER_W = 72;
const CODE_W = 34;
// Below this panel width the footer shows the short disclaimer.
const SHORT_FOOTER_WIDTH = 480;
const SETTINGS_TABS = ["sources", "display", "disclaimer"];
const COLOR_CHOICES = [["auto", "display.colors.auto"], ["red-up", "display.colors.redUp"], ["green-up", "display.colors.greenUp"]];

// The Finnhub key, in plaintext, in Bellwether's folder under Herdr's data folder: localStorage is per
// copy, so the dialog could not hand it to the panel there, and shared state is no place for a key.
const secretsDir = () => `${appHome()}/data/bellwether`;
const secretsFile = () => `${secretsDir()}/secrets.json`;

// `{}` when there is no file yet; rejects when the file cannot be read or is not a JSON object.
async function readSecrets() {
  if (!(await fs.exists(secretsFile()))) return {};
  const value = JSON.parse(await fs.readFile(secretsFile(), "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value;
}

async function loadSecret(name) {
  const value = (await readSecrets())[name];
  return typeof value === "string" ? value : null;
}

// A file that cannot be read is replaced by one holding only this key.
async function saveSecret(name, value) {
  let secrets = {};
  try { secrets = await readSecrets(); } catch { /* Replaced below. */ }
  await fs.mkdir(secretsDir(), { recursive: true });
  await fs.writeFile(secretsFile(), `${JSON.stringify({ ...secrets, [name]: value }, null, 2)}\n`);
}

// The file is written again without this key; an unreadable file rejects, so nothing is taken as removed.
async function removeSecret(name) {
  if (!(await fs.exists(secretsFile()))) return;
  const { [name]: _removed, ...rest } = await readSecrets();
  await fs.writeFile(secretsFile(), `${JSON.stringify(rest, null, 2)}\n`);
}

export default class Bellwether extends View {
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
    this.makeInput();

    this.watch = new Watchlist({
      load: () => shared(WATCHLIST_KEY),
      save: (preferences) => setShared(WATCHLIST_KEY, preferences),
      settings: () => shared(SETTINGS_KEY),
      // Read-only GETs to Yahoo Finance and Binance (or the Binance address the person set), and to
      // TWSE MIS (or the MIS address the person set) only once the person turned it on and consented,
      // and Finnhub (or the Finnhub address the person set) only once chosen with a key saved.
      fetch: (url, headers) => fetch(url, { headers }),
      // Read again by each copy when keyRev changes in the shared settings.
      loadSecret,
      now: () => Date.now(),
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
    // `bellwether.refresh` and `bellwether.pause` (bind them in keys.json if you like).
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
    this.urlFocused = false;
    this.urlInput = InputState.new({ placeholder: DEFAULT_BINANCE_URL, value: this.draft.sources.crypto.binanceUrl });
    // Redraw on every keystroke: the field's error and the Save button follow the draft.
    this.urlInput.on("change", (_e, cx) => { this.draft.sources.crypto.binanceUrl = this.urlInput.value(); cx.notify(); });
    this.urlInput.on("focus", (_e, cx) => { this.urlFocused = true; cx.notify(); });
    this.urlInput.on("blur", (_e, cx) => { this.urlFocused = false; cx.notify(); });
    this.misUrlFocused = false;
    this.misUrlInput = InputState.new({ placeholder: MIS_URL, value: this.draft.sources.tw.misUrl });
    this.misUrlInput.on("change", (_e, cx) => { this.draft.sources.tw.misUrl = this.misUrlInput.value(); cx.notify(); });
    this.misUrlInput.on("focus", (_e, cx) => { this.misUrlFocused = true; cx.notify(); });
    this.misUrlInput.on("blur", (_e, cx) => { this.misUrlFocused = false; cx.notify(); });
  }

  // The key input starts empty and masked; the saved key fills it once read. Save waits for that read,
  // so an unchanged key is never written again and a missing one is never taken for a cleared one.
  initFinnhubDraft(cx) {
    this.savedKey = null;
    this.keyLoaded = false;
    this.keyShown = false;
    this.keyInput = InputState.new({ placeholder: this.tx("sources.us.key") });
    this.keyInput.set_masked(true);
    this.keyInput.on("change", (_e, cx) => cx.notify());
    this.keyFocused = false;
    this.keyInput.on("focus", (_e, cx) => { this.keyFocused = true; cx.notify(); });
    this.keyInput.on("blur", (_e, cx) => { this.keyFocused = false; cx.notify(); });
    this.finnhubUrlFocused = false;
    this.finnhubUrlInput = InputState.new({ placeholder: FINNHUB_URL, value: this.draft.sources.us.finnhubUrl });
    this.finnhubUrlInput.on("change", (_e, cx) => { this.draft.sources.us.finnhubUrl = this.finnhubUrlInput.value(); cx.notify(); });
    this.finnhubUrlInput.on("focus", (_e, cx) => { this.finnhubUrlFocused = true; cx.notify(); });
    this.finnhubUrlInput.on("blur", (_e, cx) => { this.finnhubUrlFocused = false; cx.notify(); });
    this.budgetFocused = false;
    this.budgetInput = InputState.new({ value: String(this.draft.sources.us.budgetPerMinute) });
    // A whole number once it reads as one; until then the text, which validation refuses.
    this.budgetInput.on("change", (_e, cx) => {
      const typed = this.budgetInput.value().trim();
      this.draft.sources.us.budgetPerMinute = /^\d+$/.test(typed) ? Number(typed) : typed;
      cx.notify();
    });
    this.budgetInput.on("focus", (_e, cx) => { this.budgetFocused = true; cx.notify(); });
    this.budgetInput.on("blur", (_e, cx) => { this.budgetFocused = false; cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        this.savedKey = await loadSecret(SECRET_KEY_FINNHUB);
      } catch {
        // Unreadable: the card shows the panel's problem; a key saved now replaces the file.
        this.savedKey = null;
      }
      if (this.savedKey) this.keyInput.set_value(this.savedKey);
      this.keyLoaded = true;
      cx.notify();
    });
  }

  // The input's placeholder is fixed when it is made, so a new language needs a new input
  // (made in init, an event handler or a spawned task, never in render).
  makeInput() {
    this.input?.release();
    this.inputLang = this.lang;
    this.inputFocused = false;
    this.input = InputState.new({ placeholder: this.tx("input.placeholder"), value: this.typed });
    this.input.on("change", () => { this.typed = this.input.value(); });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
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
      mod: "bellwether", kind: "dialog", width: 440,
      props: { detail: { ...quote, error: this.watch.errors[symbol] ?? null, fallback: this.watch.overlayErrors[symbol] ?? null } },
    });
  }

  openSettings(tab) {
    openOverlay({
      mod: "bellwether", kind: "dialog", modal: true, width: 640, height: 520,
      // `health`: each source's current problem, `{ provider, code, params }`.
      props: { settings: { tab, health: this.watch.problems() } },
    });
  }

  render() {
    const t = theme();
    this.readSettings();
    if (this.detail) return this.detailView(t);
    if (this.draft) return this.settingsView(t);
    // Herdr re-renders every copy when shared state changes: adopt another copy's edit now.
    this.watch.sync();
    if (this.inputLang !== this.lang) this.wakeInput?.();
    const layout = layoutFor(this.size);
    const root = (layout === "band" ? h_flex() : v_flex())
      // `background`, as Herdr's terminals and other panes: Bellwether sits beside them as one more pane.
      .id("bw").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    if (layout === "band") return this.band(root, t);
    return layout === "table" ? this.table(root, t) : this.sidebar(root, t);
  }

  // Red-up or green-up, by the color setting (automatic: red-up in every language but English).
  changeColor(t, change) {
    if (change === null || change === undefined) return t.dim;
    const [up, down] = upIsRed(this.settings) ? [t.ansi1, t.ansi2] : [t.ansi2, t.ansi1];
    return change >= 0 ? up : down;
  }

  // The day's line, scaled to its box; the previous close is a dashed rule.
  chart(quote, color, t, { width, height, fill }) {
    const box = div().relative().flex_none().h(height);
    const sized = width === "full" ? box.w_full() : box.w(width);
    const g = chartGeometry(quote.series, quote.previousClose);
    if (!g) return sized;
    const layer = (path, paint) => window.paint_path(path, paint).absolute().top(0).left(0).size_full();
    let line = PathBuilder.stroke(fill ? 2 : 1.25);
    g.points.forEach(([x, y], i) => { line = i ? line.line_to(`${x}%`, `${y}%`) : line.move_to(`${x}%`, `${y}%`); });
    return sized
      .when(g.reference !== null, (el) => el.child(layer(
        PathBuilder.stroke(1).dash_array([3, 3]).move_to("0%", `${g.reference}%`).line_to("100%", `${g.reference}%`).build(),
        t.border)))
      .when(Boolean(fill), (el) => {
        let area = PathBuilder.fill().move_to("0%", "100%");
        for (const [x, y] of g.points) area = area.line_to(`${x}%`, `${y}%`);
        return el.child(layer(area.line_to("100%", "100%").close().build(),
          Background.solid(color).opacity(0.16)));
      })
      .child(layer(line.build(), color));
  }

  // 6px: filled for a live quote, a 1px ring when the price may not be current, none for a session.
  dot(t, state) {
    const dot = div().flex_none().w(6).h(6).rounded_full();
    if (state === "live") return dot.bg(t.foreground);
    return HOLLOW.includes(state) ? dot.border_1().border_color(t.dim) : null;
  }

  // `a · b · c` that wraps only between parts: each part stays whole, the `·` ends the line it is on.
  segments(t, parts) {
    const shown = parts.filter(Boolean);
    return h_flex().flex_wrap().gap_x(4).text_size(11).text_color(t.dim)
      .children(shown.map((part, i) => div().whitespace_nowrap().child(i < shown.length - 1 ? `${part} ·` : part)));
  }

  // The source for a real-time price, the delay for Yahoo's, or the session when it is not trading.
  freshnessLabel(quote, fresh, now) {
    switch (fresh.state) {
      case "live":
      case "unconfirmed":
        return this.tx(`src.${quote.source}`);
      case "stalled":
        return this.tx("freshness.stalled", { time: formatTime(fresh.stoppedAt) });
      case "delayed":
        return fresh.delayMinutes === null ? this.tx("freshness.delayed")
          : this.tx("freshness.delayedMinutes", { minutes: fresh.delayMinutes });
      case "closed": {
        const date = formatStaleDate(quote.timestamp, now, this.lang);
        return `${this.tx("session.closed")} · ${date ? `${date} ` : ""}${formatTime(quote.timestamp)}`;
      }
      default:
        return this.tx(`session.${fresh.state}`);
    }
  }

  // One line: Bellwether, then as many quotes as fit.
  band(root, t) {
    const w = this.watch;
    const symbols = w.preferences.symbols;
    const now = Date.now();
    return root.px(12).gap(14).items_center().overflow_hidden()
      .child(h_flex().flex_none().gap(6).items_center()
        .child(svg(ICON).w(14).h(14).text_color(t.foreground))
        .child(div().text_color(t.foreground).font_semibold().child("Bellwether")))
      .when(w.preferences.paused, (el) => el.child(div().flex_none().text_color(t.blocked).child(this.tx("band.paused"))))
      .when(!symbols.length, (el) => el.child(div().text_color(t.dim).truncate().child(this.tx("band.empty"))))
      .children(symbols.map((symbol) => {
        const quote = w.shown(symbol);
        const failed = Boolean(w.errors[symbol]);
        const dot = quote && this.dot(t, freshness(quote, sessionOf(quote, now), now).state);
        return h_flex().flex_none().gap(5).items_center().whitespace_nowrap()
          .child(div().font_semibold().child(symbol))
          .when(Boolean(dot), (el) => el.child(dot))
          .child(div().text_color(quote && !failed ? t.foreground : t.dim).child(quote ? formatBandPrice(quote) : failed ? this.tx("band.unavailable") : "…"))
          .when(Boolean(quote), (el) => el.child(div().text_color(this.changeColor(t, quote.changePercent)).child(formatChange(quote.changePercent))))
          .when(Boolean(quote) && failed, (el) => el.child(div().text_color(t.dim).child(this.tx("band.cached"))));
      }));
  }

  button(t, id, label, onClick) {
    return h_flex().id(id).flex_none().h(22).px(8).items_center().rounded(5).border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  // Until answered: `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`. A label switches and
  // dismisses; × only dismisses, and sits beside the labels, not inside one.
  languagePrompt(t) {
    const link = (id, label, onClick) => div().id(id).flex_none().text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
    const choices = LANGUAGES.flatMap((language, i) => [
      ...(i ? [div().flex_none().text_color(t.dim).child("·")] : []),
      link(`bw-lang-${language}`, LANGUAGE_LABELS[language], (cx) => this.chooseLanguage(cx, language)),
    ]);
    return h_flex().items_center().gap(6).text_size(11)
      .child(div().flex_none().text_color(t.dim).child(this.tx("prompt.language")))
      .child(h_flex().flex_1().min_w(0).items_center().gap(5).overflow_hidden().children(choices))
      .child(link("bw-lang-dismiss", "×", (cx) => this.act(cx, () => this.saveSettings({ languagePromptDismissed: true }), "error.saveSettings")));
  }

  // The text for the header's count: `8 tickers`.
  countText() {
    const count = this.watch.preferences.symbols.length;
    return this.tx(count === 1 ? "header.tickers.one" : "header.tickers.other", { count });
  }

  // `Auto-refresh on · Updated 14:05` (the newest fetch among the rows), or `… · Refreshing quotes…` during a Refresh.
  statusText() {
    const w = this.watch;
    const state = this.tx(w.preferences.paused ? "status.paused" : "status.on");
    // Only for a refresh the person asked for: automatic rounds would flip the line every few seconds.
    if (w.refreshing) return `${state} · ${this.tx("status.refreshing")}`;
    const fetched = Math.max(0, ...w.preferences.symbols.map((symbol) => w.shown(symbol)?.fetchedAt ?? 0));
    return fetched ? `${state} · ${this.tx("status.updated", { time: formatTime(fetched) })}` : state;
  }

  // The mark and the name in the text color, the mark's middle candle in the accent: two single-color
  // layers, since an svg takes one tint. Otherwise the accent is kept for focus, the drop line and links.
  brand(t) {
    return h_flex().flex_none().items_center().gap(8)
      .child(div().relative().flex_none().w(16).h(16)
        .child(svg(icon("mark-sides")).absolute().top(0).left(0).w(16).h(16).text_color(t.foreground))
        .child(svg(icon("mark-center")).absolute().top(0).left(0).w(16).h(16).text_color(t.accent)))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Bellwether"));
  }

  // A header action: a 16 px single-color icon in a 28 × 28 target, named by its tooltip.
  iconButton(t, id, name, label, onClick) {
    return h_flex().id(id).flex_none().w(28).h(28).items_center().justify_center().rounded(6)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label).on_click((_e, cx) => onClick(cx))
      .child(svg(icon(name)).w(16).h(16));
  }

  // A pane copy that shares its tab offers its own tab; the copy in that tab offers the way back, when
  // there is a pane to go back beside. Dialog copies draw neither (they never reach the header).
  // Clicking a mod pane focuses it, so the focused Bellwether pane is the one clicked; each click
  // checks again. Commands apply as run() returns: the old copy closes only once panes() shows the
  // new one, and only its own pane, never a shell the person split in beside it.
  ownTabAction() {
    const all = panes();
    const shownTab = focused()?.tab ?? null;
    if (!this.from) {
      if (!canOpenOwnTab(all, shownTab)) return null;
      return {
        icon: "zoom", label: "button.ownTab",
        go: () => {
          const before = panes();
          const me = ownTabSource(before);
          if (!me) return;
          run("tab.new", { mod: "bellwether", name: "Bellwether", props: { from: me.tab } });
          if (newBellwether(before, panes())) run("pane.close", { pane: me.pane });
        },
      };
    }
    if (!returnPane(all, this.from, focused(), shownTab)) return null;
    return {
      icon: "restore", label: "button.backBeside",
      go: () => {
        const before = panes();
        const me = before.find((p) => p.mod === "bellwether" && p.focused && p.tab !== this.from);
        const target = me && returnPane(before, this.from, focused(), me.tab);
        if (!target) return;
        run("pane.split", { pane: target, direction: "right", mod: "bellwether" });
        const targetTab = before.find((p) => p.pane === target).tab;
        if (newBellwether(before, panes(), targetTab)) run("pane.close", { pane: me.pane });
      },
    };
  }

  // Refresh, pause or resume, settings, own tab or back; the glyphs' right edge lines up with the content's.
  headerIcons(t) {
    const { paused } = this.watch.preferences;
    const own = this.ownTabAction();
    return h_flex().flex_none().items_center().mr(-6)
      .child(this.iconButton(t, "bw-refresh", "refresh", this.tx("button.refresh"), (cx) => { this.watch.refreshNow(); cx.notify(); }))
      .child(this.iconButton(t, "bw-pause", paused ? "play" : "pause", this.tx(paused ? "button.resume" : "button.pause"),
        (cx) => this.act(cx, () => this.togglePause())))
      .child(this.iconButton(t, "bw-settings", "settings", this.tx("button.settings"), () => this.openSettings("sources")))
      .when(Boolean(own), (el) => el.child(this.iconButton(t, "bw-own-tab", own.icon, this.tx(own.label), () => own.go())));
  }

  // Filled and borderless at rest; the accent border marks focus. The border is always 1 px, so focus never moves
  // the text. `selected` is one step off the panel's `background` in light and dark themes alike, and a step
  // past `hover`, so the field never looks like a hovered row.
  addField(t) {
    return Input.new(this.input).h(32).px(10).rounded(6).border_1()
      .border_color(this.inputFocused ? t.accent : t.selected).bg(t.selected).text_size(12.5).text_color(t.foreground);
  }

  // What the last edit said, under the add field.
  messages(t) {
    if (this.error) return [div().text_size(11).text_color(t.ansi1).child(this.say(this.error))];
    return this.notice ? [div().text_size(11).text_color(t.dim).child(this.say(this.notice))] : [];
  }

  // One line per source with a problem: rate limited, unreachable, timed out, refused.
  problemLines(t) {
    return this.watch.problems().map((problem) => div().text_size(11).text_color(t.blocked).child(this.say(problem)));
  }

  // What a row shows, whichever layout draws it.
  rowData(t, symbol, now) {
    const w = this.watch;
    const quote = w.shown(symbol);
    const fresh = quote && freshness(quote, sessionOf(quote, now), now);
    // A closed label carries its own date; any other quote from an earlier day gets one.
    const stale = quote && fresh.state !== "closed" ? formatStaleDate(quote.timestamp, now, this.lang) : "";
    return {
      quote,
      failed: w.errors[symbol],
      // The real-time source failed for this symbol: the base quote shows, with the reason.
      fallback: w.overlayErrors[symbol],
      // A US row past Finnhub's budget stays on Yahoo and says so.
      overCap: w.overCap(symbol),
      label: quote ? this.freshnessLabel(quote, fresh, now) : "",
      date: stale ? this.tx("quote.asOf", { date: stale }) : "",
      name: quote ? displayName(quote, this.lang) : null,
      dot: quote && this.dot(t, fresh.state),
      color: quote ? this.changeColor(t, quote.changePercent) : t.dim,
    };
  }

  // Under a row: a cached quote's reason, a real-time source's fallback, Finnhub's budget.
  rowNotes(t, { quote, failed, fallback, overCap }) {
    return [
      failed && div().text_size(11).text_color(t.blocked).child(quote ? this.tx("quote.cached", { reason: this.say(failed) }) : this.say(failed)),
      fallback && div().text_size(11).text_color(t.blocked).child(quote ? this.fallbackText(quote, fallback) : this.say(fallback)),
      overCap && div().text_size(11).text_color(t.dim).child(this.tx("finnhub.overCap", { cap: finnhubCap(this.settings.sources.us.budgetPerMinute) })),
    ].filter(Boolean);
  }

  // `value` (the price by default) without its currency, for a fixed right-aligned column.
  number(quote, value = quote.price) {
    return typeof value === "number" && value > 0 ? formatPrice({ ...quote, price: value, currency: null }) : "—";
  }

  // The day's change in the price's own units: `+3.58`, `-1,234.56`.
  signed(quote) {
    if (!(quote.previousClose > 0)) return "—";
    const change = quote.price - quote.previousClose;
    const size = Math.abs(change) > 0 ? formatPrice({ ...quote, price: Math.abs(change), currency: null }) : "0.00";
    return `${change >= 0 ? "+" : "-"}${size}`;
  }

  // Before the first quote: why there is none yet.
  waiting(row) {
    return this.tx(row.failed ? "row.unavailable" : this.watch.preferences.paused ? "row.notFetched" : "row.waiting");
  }

  // The price over the change, both right-aligned on the number; the currency hangs in its own slot.
  priceStack(t, row) {
    const { quote, failed, color } = row;
    if (!quote) return div().flex_none().w(NUMBER_W + CODE_W).pr(CODE_W).text_right().text_size(11).text_color(t.dim).child(this.waiting(row));
    return v_flex().flex_none().gap(2)
      .child(h_flex().items_baseline()
        .child(div().flex_none().w(NUMBER_W).text_right().whitespace_nowrap().text_color(failed ? t.dim : t.foreground).child(this.number(quote)))
        .child(div().flex_none().w(CODE_W).pl(4).text_size(11).text_color(t.dim).child(quote.currency ?? "")))
      .child(div().flex_none().w(NUMBER_W).text_right().text_size(11).text_color(color).child(formatChange(quote.changePercent)));
  }

  // A row: the drag handle in the left gutter and × in the right one, both only under the pointer; between
  // them the body, which opens the ticker's day. Hairlines between rows span the body only.
  rowFrame(t, symbol, index, symbols, body, clickable) {
    const dragged = this.drag?.symbol === symbol;
    const next = symbols[index + 1] ?? null;
    const controls = dragged || (!this.drag && this.hovered === symbol);
    const moving = Boolean(this.drag) && !this.dropsInPlace();
    return h_flex().id(`bw-line-${symbol}`).relative().items_stretch()
      .when(dragged, (el) => el.bg(t.raised))
      .when(!this.drag, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((hovered, cx) => {
        if (hovered) this.hovered = symbol;
        else if (this.hovered === symbol) this.hovered = null;
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag || !e.bounds) return;
        // Upper half: in front of this row; lower half: in front of the next one.
        const before = e.local_position.y < e.bounds.height / 2 ? symbol : next;
        if (before === this.drag.before) return;
        this.drag.before = before;
        cx.notify();
      })
      // Where the dragged row would land: a 2 px accent line in front of `before`, or after the last row.
      .when(moving && this.drag?.before === symbol, (el) => el.child(this.dropBar(t).top(0)))
      .when(moving && this.drag?.before === null && next === null, (el) => el.child(this.dropBar(t).bottom(0)))
      .when(dragged, (el) => el.child(div().absolute().top(0).left(0).right(0).bottom(0).border_1().border_color(t.border)))
      // The handle fills its gutter for the row's whole height, so it is easy to grab; the slot stays when hidden.
      .child(div().id(`bw-handle-${symbol}`).flex_none().w(GUTTER).flex().items_center().justify_center().text_color(t.dim)
        .when(controls, (el) => el
          .hover((s) => s.text_color(t.foreground))
          .when(dragged, (h) => h.text_color(t.foreground).cursor_grabbing())
          .when(!dragged, (h) => h.cursor_grab())
          .on_mouse_down("left", (_e, cx) => {
            cx.stop_propagation();
            this.drag = { symbol, before: symbol };
            cx.notify();
          })
          .child(svg(icon("grip")).w(14).h(14))))
      .child(body.id(`bw-row-${symbol}`).flex_1().min_w(0)
        .when(next !== null, (el) => el.border_b(1).border_color(t.border))
        .when(clickable, (el) => el.cursor_pointer())
        .on_click(() => this.openDetail(symbol)))
      // × sits beside the body, not inside it.
      .child(div().id(`bw-remove-${symbol}`).flex_none().w(GUTTER).flex().items_center().justify_center().text_color(t.dim)
        .when(controls && !dragged, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip(this.tx("button.remove"))
          .on_click((_e, cx) => this.act(cx, () => this.watch.remove(symbol)))
          .child(svg(icon("close")).w(12).h(12))));
  }

  // The scrolling rows. No pointer capture: a release outside the list never arrives, so leaving it cancels a drag.
  list(t, rows) {
    return v_flex().id("bw-list").flex_1().min_h(0).overflow_y_scrollbar()
      .on_hover((hovered, cx) => {
        if (hovered || !this.drag) return;
        this.drag = null;
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const drag = this.drag;
        if (!drag) return;
        const inPlace = this.dropsInPlace();
        this.drag = null;
        // A drop where the row already is changes nothing, and leaves the current notice be.
        if (inPlace) cx.notify();
        else this.act(cx, () => this.watch.move(drag.symbol, drag.before));
      })
      .when(!rows.length, (el) => el.child(div().px(GUTTER).py(8).text_color(t.dim).child(this.tx("list.empty"))))
      .children(rows);
  }

  // One line: the disclaimer, which opens the settings' disclaimer tab.
  footer(t) {
    const short = this.size && this.size.width < SHORT_FOOTER_WIDTH;
    return div().flex_none().px(GUTTER)
      .child(div().id("bw-disclaimer").py(10).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => this.openSettings("disclaimer"))
        .child(this.tx(short ? "footer.short" : "footer.long")));
  }

  // Below TABLE_MIN_WIDTH: the header, the status line, the add field, two-line rows, the footer.
  sidebar(root, t) {
    const { symbols } = this.watch.preferences;
    const now = Date.now();
    const header = v_flex().flex_none().px(GUTTER).pt(10).gap(2)
      .child(h_flex().h(28).items_center().gap(8)
        .child(this.brand(t))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.countText()))
        .child(this.headerIcons(t)))
      .child(div().truncate().text_size(11).text_color(t.dim).child(this.statusText()))
      .children(this.problemLines(t));
    const field = v_flex().flex_none().px(GUTTER).pt(12).gap(6)
      .when(!this.settings.languagePromptDismissed, (el) => el.child(this.languagePrompt(t)))
      .child(this.addField(t))
      .children(this.messages(t));
    const rows = symbols.map((symbol, index) => this.sidebarRow(t, symbol, index, symbols, now));
    return root.child(header).child(field).child(this.list(t, rows).pt(8)).child(this.footer(t));
  }

  // Symbol over freshness and name on the left; the line, then the price over the change, at a fixed
  // width on the right, so a wider pane gives its room to the name.
  sidebarRow(t, symbol, index, symbols, now) {
    const row = this.rowData(t, symbol, now);
    const meta = row.quote ? rowMeta(symbol, [row.label, row.date, row.name]).join(" · ") : "";
    const body = v_flex().py(8).gap(2)
      .child(h_flex().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().font_semibold().truncate().child(symbol))
          .when(Boolean(meta), (el) => el.child(h_flex().gap(6).items_center()
            .when(Boolean(row.dot), (line) => line.child(row.dot))
            .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(meta)))))
        .child(row.quote ? this.chart(row.quote, row.color, t, SPARK) : div().flex_none().w(SPARK.width).h(SPARK.height))
        .child(this.priceStack(t, row)))
      .children(this.rowNotes(t, row));
    return this.rowFrame(t, symbol, index, symbols, body, Boolean(row.quote));
  }

  // A table cell at its column's width.
  cell(id, nameW) {
    return div().flex_none().w(id === "name" ? nameW : TABLE_COLUMNS.find((column) => column.id === id).width);
  }

  // From TABLE_MIN_WIDTH: one header line, column labels that stay while the rows scroll, 36 px rows. At most
  // TABLE_MAX_WIDTH wide, centered; columns drop by DROP_ORDER when the width cannot hold them.
  table(root, t) {
    const { symbols } = this.watch.preferences;
    const now = Date.now();
    const width = Math.min(this.size.width, TABLE_MAX_WIDTH);
    const columns = tableColumns(width);
    const nameW = nameWidth(width, columns);
    const notes = [
      ...(this.settings.languagePromptDismissed ? [] : [this.languagePrompt(t)]),
      ...this.messages(t),
      ...this.problemLines(t),
    ];
    const header = h_flex().flex_none().px(GUTTER).pt(10).gap(12).items_center()
      .child(this.brand(t))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${this.countText()} · ${this.statusText()}`))
      .child(div().flex_none().w(320).child(this.addField(t)))
      .child(this.headerIcons(t));
    const rows = symbols.map((symbol, index) => this.tableRow(t, symbol, index, symbols, columns, nameW, now));
    const frame = v_flex().w(width).flex_1().min_h(0)
      .child(header)
      .when(notes.length > 0, (el) => el.child(v_flex().flex_none().px(GUTTER).pt(8).gap(4).children(notes)))
      .child(this.tableHead(t, columns, nameW))
      .child(this.list(t, rows))
      .child(this.footer(t));
    return root.items_center().child(frame);
  }

  tableHead(t, columns, nameW) {
    const labels = {
      symbol: "table.symbol", name: "table.name", state: "table.state", line: "table.line", price: "table.price",
      change: "table.change", changePct: "table.changePct", high: "detail.high", low: "detail.low", prevClose: "detail.prevClose",
    };
    return div().flex_none().px(GUTTER).pt(12)
      .child(h_flex().h(28).items_center().gap(COLUMN_GAP).border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .children(columns.map((id) => {
          const right = TABLE_COLUMNS.find((column) => column.id === id).align === "right";
          // Over the number, not the currency slot; over the state's text, past its dot.
          return this.cell(id, nameW).truncate().when(right, (el) => el.text_right())
            .when(id === "price", (el) => el.pr(CODE_W)).when(id === "state", (el) => el.pl(12))
            .child(this.tx(labels[id]));
        })));
  }

  tableRow(t, symbol, index, symbols, columns, nameW, now) {
    const row = this.rowData(t, symbol, now);
    const { quote, color } = row;
    // As the sidebar's line: a name that begins with the label (a pair's "Binance Spot") replaces it.
    const named = row.name && row.name !== symbol ? row.name : "";
    const merged = Boolean(named && row.label && named.startsWith(row.label));
    const state = [merged ? named : row.label, row.date].filter(Boolean).join(" · ");
    const cell = (id) => this.cell(id, nameW);
    const figure = (id, value) => cell(id).text_right().whitespace_nowrap().text_color(t.muted).child(quote ? this.number(quote, value) : "");
    const cells = {
      symbol: () => cell("symbol").font_semibold().truncate().child(symbol),
      name: () => cell("name").text_color(t.muted).truncate().child(merged ? "" : named),
      state: () => h_flex().flex_none().w(TABLE_COLUMNS.find((column) => column.id === "state").width).gap(6).items_center()
        .child(div().flex_none().w(6).h(6).when(Boolean(row.dot), (el) => el.child(row.dot)))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(state)),
      line: () => (quote ? this.chart(quote, color, t, TABLE_SPARK) : cell("line")),
      price: () => (quote
        ? h_flex().flex_none().w(TABLE_COLUMNS.find((column) => column.id === "price").width).items_baseline()
          .child(div().flex_1().min_w(0).text_right().whitespace_nowrap().text_color(row.failed ? t.dim : t.foreground).child(this.number(quote)))
          .child(div().flex_none().w(CODE_W).pl(4).text_size(11).text_color(t.dim).child(quote.currency ?? ""))
        : cell("price").pr(CODE_W).text_right().text_size(11).text_color(t.dim).child(this.waiting(row))),
      change: () => cell("change").text_right().whitespace_nowrap().text_color(color).child(quote ? this.signed(quote) : ""),
      changePct: () => cell("changePct").text_right().whitespace_nowrap().text_color(color).child(quote ? formatChange(quote.changePercent) : ""),
      high: () => figure("high", quote?.high),
      low: () => figure("low", quote?.low),
      // A pair's reference is the price 24 hours back, not a close: left out here, as in the detail.
      prevClose: () => figure("prevClose", quote && !isCryptoPair(symbol) ? quote.previousClose : null),
    };
    const notes = this.rowNotes(t, row);
    const body = v_flex()
      .child(h_flex().h(36).items_center().gap(COLUMN_GAP).children(columns.map((id) => cells[id]())))
      .when(notes.length > 0, (el) => el.child(v_flex().pb(8).gap(2).children(notes)));
    return this.rowFrame(t, symbol, index, symbols, body, Boolean(quote));
  }

  // The drag would put the row where it already is: in front of itself or of the row after it.
  dropsInPlace() {
    const { symbols } = this.watch.preferences;
    const { symbol, before } = this.drag;
    return before === symbol || before === (symbols[symbols.indexOf(symbol) + 1] ?? null);
  }

  dropBar(t) {
    return div().absolute().left(GUTTER).right(GUTTER).h(2).bg(t.accent);
  }

  // "Showing Yahoo · <reason>": a real-time price was dropped, so the row shows its base quote.
  fallbackText(quote, error) {
    return this.tx("quote.fallback", { source: this.tx(`src.${quote.source}`), reason: this.say(error) });
  }

  // The dialog a row opens: the day's chart, its range and the session.
  detailView(t) {
    const q = this.detail;
    const now = Date.now();
    const color = this.changeColor(t, q.changePercent);
    const session = sessionOf(q, now);
    const value = (price) => (price ? formatBandPrice({ ...q, price }) : "—");
    const stale = formatStaleDate(q.timestamp, now, this.lang);
    const source = detailSource(q, session, now, (key, params) => this.tx(key, params));
    const times = [this.tx("detail.quoted", { time: `${stale ? `${stale} ` : ""}${formatTime(q.timestamp, true)}` }),
      this.tx("detail.fetched", { time: formatTime(q.fetchedAt, true) })];
    const stat = (label, price) => v_flex().flex_1().gap(2)
      .child(div().text_size(10.5).text_color(t.dim).child(this.tx(label)))
      .child(div().font_semibold().child(value(price)));

    return v_flex().id("bw-detail").w_full().p(18).gap(14).text_color(t.foreground).text_size(12.5)
      .child(h_flex().items_center().gap(10)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(16).font_semibold().truncate().child(q.symbol))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child(displayName(q, this.lang) ?? "")))
        // The session as plain text: a filled dot means a live quote, everywhere.
        .child(div().flex_none().text_size(11).text_color(t.muted).child(this.tx(`session.${session}`)))
        .child(div().id("bw-detail-close").flex_none().w(18).text_right().text_size(14).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click(() => closeOverlay(this.overlay)).child("×")))
      .child(h_flex().gap(10).items_end()
        .child(div().text_size(26).font_semibold().child(formatPrice(q)))
        .child(div().pb(4).text_size(13).font_semibold().text_color(color).child(formatChange(q.changePercent))))
      .child(q.series?.length > 1
        ? this.chart(q, color, t, { width: "full", height: 140, fill: true })
        : div().h(60).flex().items_center().justify_center().text_color(t.dim).child(this.tx("detail.noLine")))
      .child(isCryptoPair(q.symbol)
        ? h_flex().gap(12).child(stat("detail.open24h", q.open)).child(stat("detail.high24h", q.high))
          .child(stat("detail.low24h", q.low))
        : h_flex().gap(12).child(stat("detail.open", q.open)).child(stat("detail.high", q.high)).child(stat("detail.low", q.low))
          .child(stat("detail.prevClose", q.previousClose)))
      .child(v_flex().gap(2).child(this.segments(t, source)).child(this.segments(t, times)))
      .when(Boolean(q.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.tx("quote.cached", { reason: this.say(q.error) }))))
      .when(Boolean(q.fallback), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.fallbackText(q, q.fallback))));
  }

  // The settings dialog: tabs on the left, the tab on the right, Cancel / Save below.
  // What stops a save, the key the dialog holds included (it is never in the draft).
  draftErrors() {
    return validateSettings(this.draft, { finnhubKey: this.keyInput.value() });
  }

  settingsView(t) {
    const errors = this.draftErrors();
    const invalid = Object.keys(errors).length > 0 || !this.keyLoaded || this.saving;
    const tabs = v_flex().flex_none().w(168).p(10).gap(2).border_r(1).border_color(t.border)
      .child(div().px(8).pb(8).text_size(13).font_semibold().text_color(t.foreground).child(this.tx("settings.title")))
      .children(SETTINGS_TABS.map((tab) => h_flex().id(`bw-tab-${tab}`).px(8).h(28).items_center().rounded(5).cursor_pointer()
        .text_color(tab === this.tab ? t.foreground : t.muted).when(tab === this.tab, (el) => el.bg(t.hover).font_semibold())
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = tab; cx.notify(); }).child(this.tx(`settings.tab.${tab}`))));
    const pane = v_flex().id("bw-settings-pane").flex_1().min_w(0).min_h(0).p(18).gap(14).overflow_y_scrollbar()
      .child(this[`${this.tab}Tab`](t, errors));
    const save = h_flex().id("bw-settings-save").flex_none().h(28).px(14).items_center().rounded(5).font_semibold()
      .when(invalid, (el) => el.bg(t.hover).text_color(t.dim))
      .when(!invalid, (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click((_e, cx) => this.saveDraft(cx)))
      .child(this.tx("settings.save"));
    const footer = h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.ansi1)
        .child(this.error ? this.say(this.error) : ""))
      .child(h_flex().id("bw-settings-cancel").flex_none().h(28).px(14).items_center().rounded(5).border_1().border_color(t.border)
        .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(this.overlay)).child(this.tx("settings.cancel")))
      .child(save);
    return v_flex().id("bw-settings").size_full().text_color(t.foreground).text_size(12.5)
      // h_flex centers its children; stretch lets the tab column and the pane both fill the height.
      .child(h_flex().flex_1().min_h(0).items_stretch().child(tabs).child(pane))
      .child(footer);
  }

  // Writes only what the dialog edits, over what is saved now: a newer copy's other keys stay. A new
  // Finnhub key goes to the secrets file first (or, cleared with Yahoo chosen, leaves it), then keyRev + 1
  // tells every copy to read it again.
  saveDraft(cx) {
    if (Object.keys(this.draftErrors()).length || !this.keyLoaded || this.saving) return;
    const { language, colors, sources } = this.draft;
    const key = this.keyInput.value().trim();
    const change = keyChange({ provider: sources.us.provider, typed: key, saved: this.savedKey });
    this.saving = true;
    this.error = null;
    cx.spawn(async (cx) => {
      if (change) {
        try {
          if (change === "write") await saveSecret(SECRET_KEY_FINNHUB, key);
          else await removeSecret(SECRET_KEY_FINNHUB);
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
      closeOverlay(this.overlay);
    });
  }

  // One group of choices: the chosen one filled, the rest muted.
  segmented(t, id, choices, current, onPick) {
    return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(choices.map(([value, label]) => h_flex().id(`${id}-${value}`).h(28).px(12).items_center().cursor_pointer()
        .text_color(value === current ? t.foreground : t.muted).when(value === current, (el) => el.bg(t.hover).font_semibold())
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { onPick(value); cx.notify(); }).child(label)));
  }

  // A source's card: its name and kind, then whatever it lets the person set.
  card(t, title, source, ...children) {
    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).font_semibold().child(title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(source)))
      .children(children.filter(Boolean));
  }

  note(t, text) {
    return div().text_size(11.5).text_color(t.dim).child(text);
  }

  // The source's problem when the dialog opened, if it had one.
  healthLine(t, provider) {
    const problem = this.health.find((entry) => entry.provider === provider);
    return problem ? div().text_size(11.5).text_color(t.blocked).child(this.say(problem)) : null;
  }

  // A labeled input of the settings dialog, red while its value is refused.
  field(t, label, state, focused, error) {
    return [
      div().text_size(11).text_color(t.muted).child(label),
      Input.new(state).h(30).px(8).rounded(6).border_1().border_color(error ? t.ansi1 : focused ? t.accent : t.input)
        .bg(t.background).text_size(12).text_color(t.foreground),
      error ? div().text_size(11.5).text_color(t.ansi1).child(this.tx(error)) : null,
    ];
  }

  // US: Yahoo, or Finnhub with the person's key, address and per-minute budget.
  usCard(t, errors) {
    const us = this.draft.sources.us;
    const chosen = us.provider === "finnhub";
    const keyError = errors["sources.us.key"];
    const budgetError = errors["sources.us.budgetPerMinute"];
    const key = h_flex().gap(6).items_center()
      .child(Input.new(this.keyInput).flex_1().min_w(0).h(30).px(8).rounded(6).border_1()
        .border_color(keyError ? t.ansi1 : this.keyFocused ? t.accent : t.input)
        .bg(t.background).text_size(12).text_color(t.foreground))
      .child(this.button(t, "bw-key-show", this.tx(this.keyShown ? "sources.us.hide" : "sources.us.show"), (cx) => {
        this.keyShown = !this.keyShown;
        this.keyInput.set_masked(!this.keyShown);
        cx.notify();
      }));
    const finnhubParts = chosen ? [
      div().text_size(11).text_color(t.muted).child(this.tx("sources.us.key")),
      key,
      keyError ? div().text_size(11.5).text_color(t.ansi1).child(this.tx(keyError)) : null,
      this.note(t, this.tx("sources.us.keyNote")),
      ...this.field(t, this.tx("sources.us.url"), this.finnhubUrlInput, this.finnhubUrlFocused, errors["sources.us.finnhubUrl"]),
      ...this.field(t, this.tx("sources.us.budget"), this.budgetInput, this.budgetFocused, budgetError),
      budgetError ? null : this.note(t, this.tx("sources.us.cap", { cap: finnhubCap(us.budgetPerMinute) })),
      this.note(t, this.tx("sources.us.copies")),
    ] : this.savedKey ? [
      // Yahoo keeps a saved key; clearing the field and saving removes it.
      div().text_size(11).text_color(t.muted).child(this.tx("sources.us.key")),
      key,
      this.note(t, this.tx("sources.us.keyRemove")),
    ] : [];
    return this.card(t, this.tx("sources.us.title"), this.tx(chosen ? "sources.us.finnhubSource" : "sources.us.yahooSource"),
      this.segmented(t, "bw-us", [["yahoo", this.tx("src.yahoo")], ["finnhub", this.tx("src.finnhub")]], us.provider,
        (provider) => { us.provider = provider; }),
      ...finnhubParts,
      this.healthLine(t, "finnhub"));
  }

  // Taiwan: Yahoo, or TWSE MIS once its statement is read and the box ticked (Save waits for it).
  taiwanCard(t, errors) {
    const tw = this.draft.sources.tw;
    const chosen = tw.provider === "mis";
    const agreed = tw.misAck?.version === MIS_CONSENT_VERSION;
    const urlError = errors["sources.tw.misUrl"];
    const consent = Checkbox.new("bw-mis-consent").checked(agreed).cursor_pointer()
      .on_change((checked, cx) => { tw.misAck = checked ? { version: MIS_CONSENT_VERSION } : null; cx.notify(); })
      .child(h_flex().gap(8).items_start()
        .child(div().flex_none().mt(2).w(14).h(14).rounded(3).border_1().border_color(agreed ? t.accent : t.border)
          .flex().items_center().justify_center().text_size(10).text_color(t.background)
          .when(agreed, (el) => el.bg(t.accent).child("✓")))
        .child(div().flex_1().min_w(0).font_semibold().child(this.tx("mis.consent"))));
    return this.card(t, this.tx("sources.tw.title"), this.tx(chosen ? "sources.tw.misSource" : "sources.tw.yahooSource"),
      this.segmented(t, "bw-tw", [["yahoo", this.tx("src.yahoo")], ["mis", this.tx("src.mis")]], tw.provider,
        (provider) => { tw.provider = provider; }),
      chosen && div().text_size(11).text_color(t.muted).child(this.tx("sources.tw.url")),
      chosen && Input.new(this.misUrlInput).h(30).px(8).rounded(6).border_1()
        .border_color(urlError ? t.ansi1 : this.misUrlFocused ? t.accent : t.input)
        .bg(t.background).text_size(12).text_color(t.foreground),
      chosen && urlError ? div().text_size(11.5).text_color(t.ansi1).child(this.tx(urlError)) : null,
      // The statement in the reader's language; the Traditional Chinese text prevails.
      chosen && div().text_size(11.5).text_color(t.muted).child(this.tx("mis.statement")),
      chosen && this.note(t, this.tx("mis.prevails")),
      chosen && consent,
      chosen && !agreed ? this.note(t, this.tx("mis.consentNeeded")) : null,
      this.healthLine(t, "mis"));
  }

  sourcesTab(t, errors) {
    const field = "sources.crypto.binanceUrl";
    return v_flex().gap(12)
      .child(this.usCard(t, errors))
      .child(this.taiwanCard(t, errors))
      .child(this.card(t, this.tx("sources.other.title"), this.tx("sources.other.body"), this.healthLine(t, "yahoo")))
      .child(this.card(t, this.tx("sources.crypto.title"), this.tx("sources.crypto.source"),
        div().text_size(11).text_color(t.muted).child(this.tx("sources.crypto.url")),
        Input.new(this.urlInput).h(30).px(8).rounded(6).border_1()
          .border_color(errors[field] ? t.ansi1 : this.urlFocused ? t.accent : t.input)
          .bg(t.background).text_size(12).text_color(t.foreground),
        errors[field] ? div().text_size(11.5).text_color(t.ansi1).child(this.tx(errors[field])) : null,
        this.note(t, this.tx("sources.crypto.region")),
        this.healthLine(t, "binance")));
  }

  // The interface language, then the gain and loss colors, then Herdr's own appearance settings.
  displayTab(t) {
    return v_flex().gap(12)
      .child(div().font_semibold().child(this.tx("display.language")))
      .child(this.segmented(t, "bw-language", LANGUAGES.map((language) => [language, LANGUAGE_LABELS[language]]), this.draft.language,
        (language) => { this.draft.language = language; }))
      .child(this.note(t, this.tx("display.languageHint")))
      .child(div().mt(8).font_semibold().child(this.tx("display.colors")))
      .child(this.segmented(t, "bw-colors", COLOR_CHOICES.map(([value, key]) => [value, this.tx(key)]), this.draft.colors,
        (colors) => { this.draft.colors = colors; }))
      .child(this.note(t, this.tx("display.colorsHint")))
      .child(h_flex().mt(8).child(this.button(t, "bw-appearance", this.tx("display.appearance"), () => {
        closeOverlay(this.overlay);
        run("app.settings", { section: "look" });
      })))
      .child(this.note(t, this.tx("display.appearanceHint")));
  }

  disclaimerTab(t) {
    const paragraph = (key) => div().text_color(t.muted).child(this.tx(key));
    return v_flex().gap(10)
      .child(div().font_semibold().child(this.tx("disclaimer.title")))
      .children(["disclaimer.data", "disclaimer.advice", "disclaimer.sources", "disclaimer.direct", "disclaimer.key"].map(paragraph))
      .child(this.note(t, this.tx("disclaimer.prevails")))
      .child(div().mt(8).font_semibold().child(this.tx("disclaimer.sourcesTitle")))
      .children(["disclaimer.sourcesStocks", "disclaimer.sourcesCrypto"].map(paragraph))
      .child(div().mt(8).font_semibold().child(this.tx("privacy.title")))
      .children(["privacy.hosts", "privacy.programs", "privacy.storage", "privacy.finnhub"].map(paragraph));
  }
}
