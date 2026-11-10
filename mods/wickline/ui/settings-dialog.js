// The settings dialog: a copy whose props carry `settings` draws only this. The draft, its inputs and
// Save live on the view (inputs are made outside render, and saving writes Herdr's storage).
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { LANGUAGES, LANGUAGE_LABELS } from "../i18n.js";
import { TYPICAL_EXCHANGE, exchangeRule } from "../markets.js";
import { finnhubCap } from "../providers/finnhub.js";
import {
  CONSENTS, SETTINGS_MARKETS, consentCollapsed, consentGiven, firstDraftError, marketStatus, settingsMarkets,
} from "../settings.js";
import { button, checkbox, dot, link, note, segmented, toggle } from "./parts.js";

export const SETTINGS_TABS = [...SETTINGS_MARKETS, "display", "disclaimer"];
// Each tab's drawing, by its name in SETTINGS_TABS.
const TABS = { us: usPage, tw: taiwanPage, crypto: cryptoPage, other: otherPage, display: displayTab, disclaimer: disclaimerTab };
const COLOR_CHOICES = [["auto", "display.colors.auto"], ["red-up", "display.colors.redUp"], ["green-up", "display.colors.greenUp"]];

// The sidebar on the left (the market pages, then Display and Disclaimer & privacy), the page on the
// right, Cancel / Save below.
export function settingsView(view, t) {
  const errors = view.draftErrors();
  const invalid = Object.keys(errors).length > 0 || !view.keyLoaded || view.saving;
  const key = view.keyFields(errors);
  const statuses = Object.fromEntries(SETTINGS_MARKETS.map((market) => [market, shownStatus(view, market, key)]));
  const item = (tab, label, mark = null) => h_flex().id(`bw-tab-${tab}`).px(8).h(28).gap(6).items_center().rounded(5).cursor_pointer()
    .text_color(tab === view.tab ? t.foreground : t.muted).when(tab === view.tab, (el) => el.bg(t.hover).font_semibold())
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { view.tab = tab; view.maskKey(); cx.notify(); })
    .child(div().flex_1().min_w(0).truncate().when(firstDraftError(errors, [tab]) !== null, (el) => el.text_color(t.ansi1)).child(label))
    .when(mark !== null, (el) => el.child(mark));
  const tabs = v_flex().flex_none().w(184).p(10).gap(2).border_r(1).border_color(t.border)
    .child(div().px(8).pb(8).text_size(13).font_semibold().text_color(t.foreground).child(view.tx("settings.title")))
    .child(div().px(8).pb(2).text_size(11).text_color(t.muted).child(view.tx("settings.group.sources")))
    .children(settingsMarkets(view.lang).map((market) => {
      const status = statuses[market];
      return item(market, view.tx(`market.${market}`), h_flex().flex_none().gap(5).items_center()
        .child(dot(t, status.dotState))
        .child(div().text_size(11).text_color(status.problem ? t.blocked : t.dim).child(status.label)));
    }))
    .child(div().h(10))
    .child(item("display", view.tx("settings.tab.display")))
    .child(item("disclaimer", view.tx("settings.tab.disclaimer")));
  const pane = v_flex().id("bw-settings-pane").flex_1().min_w(0).min_h(0).p(18).gap(14).overflow_y_scrollbar()
    .child(TABS[view.tab](view, t, errors, statuses[view.tab]));
  const save = h_flex().id("bw-settings-save").flex_none().h(28).px(14).items_center().rounded(5).font_semibold()
    .when(invalid, (el) => el.bg(t.hover).text_color(t.dim))
    .when(!invalid, (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click((_e, cx) => view.saveDraft(cx)))
    .child(view.tx("settings.save"));
  // What blocks Save, also when it sits on another page, so Save is never disabled without a reason.
  const blocking = firstDraftError(errors, settingsMarkets(view.lang));
  const footer = h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
    .child(div().flex_1().min_w(0).max_h(32).line_height("16px").overflow_hidden().text_size(11.5).text_color(t.ansi1)
      .child(view.error ? view.say(view.error) : blocking ? view.tx(blocking) : ""))
    .child(h_flex().id("bw-settings-cancel").flex_none().h(28).px(14).items_center().rounded(5).border_1().border_color(t.border)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => view.closeDialog()).child(view.tx("settings.cancel")))
    .child(save);
  return v_flex().id("bw-settings").size_full().text_color(t.foreground).text_size(12.5)
    // h_flex centers its children; stretch lets the sidebar and the pane both fill the height.
    .child(h_flex().flex_1().min_h(0).items_stretch().child(tabs).child(pane))
    .child(footer);
}

// A market's status (marketStatus over the draft and the panel's health), with the dot and short label
// the sidebar and the page title show.
function shownStatus(view, market, key) {
  const status = marketStatus({ saved: view.settings, draft: view.draft, health: view.health, market, key });
  const dotState = status.problem ? "stalled" : status.live ? "live" : "delayed";
  const label = view.tx(status.problem ? "settings.problem" : status.live ? "freshness.live" : "settings.delayed");
  return { ...status, dotState, label };
}

// How late Yahoo Finance is for the market: the exchange table's rule for the market's typical exchange, else
// a plain "Delayed" (by exchange).
function delayText(view, market) {
  const { delayS } = exchangeRule(TYPICAL_EXCHANGE[market] ?? null, "");
  return delayS !== null ? view.tx("settings.delayedMinutes", { minutes: delayS / 60 }) : view.tx("settings.delayed");
}

// The market's name, and on the right the state and source the unsaved choices would use; a delay says how long.
function pageTitle(view, t, market, status) {
  const state = status.dotState === "delayed" ? delayText(view, market) : status.label;
  return h_flex().gap(6).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(view.tx(`sources.${market}.title`)))
    .child(dot(t, status.dotState))
    .child(div().flex_none().text_size(11.5).text_color(status.problem ? t.blocked : t.dim)
      .child(`${state} · ${view.tx(`src.${status.source}`)}`));
}

// A market's page: its title, then its parts (a part may be null).
function marketPage(view, t, market, status, ...parts) {
  return v_flex().w_full().min_w(0).gap(10).child(pageTitle(view, t, market, status)).children(parts.filter(Boolean));
}

function heading(view, t, key) {
  return div().mt(4).text_size(11).font_semibold().text_color(t.muted).child(view.tx(key));
}

// One source: its place in the order (none for the fallback), its name and kind, and its switch on the right.
function sourceRow(view, t, number, source, kind, control) {
  return h_flex().gap(8).items_center().min_h(24)
    .child(div().flex_none().w(10).text_size(11).text_color(t.dim).child(number))
    .child(div().flex_none().font_semibold().child(view.tx(`src.${source}`)))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(kind))
    .child(control);
}

function alwaysOn(view, t) {
  return div().flex_none().text_size(11).text_color(t.dim).child(view.tx("settings.alwaysOn"));
}

// What sits under a source's row, lined up with its name; nothing when there is nothing to show.
function details(...children) {
  const shown = children.filter(Boolean);
  return shown.length ? v_flex().w_full().min_w(0).pl(18).gap(8).children(shown) : null;
}

// The source's problem when the dialog opened, if it had one.
function healthLine(view, t, provider) {
  const problem = view.health.find((entry) => entry.provider === provider);
  return problem ? div().w_full().min_w(0).text_size(11.5).text_color(t.blocked).child(view.say(problem)) : null;
}

// A labeled input of the settings dialog, red while its value is refused.
function field(view, t, label, state, focused, error) {
  return [
    div().text_size(11).text_color(t.muted).child(label),
    Input.new(state).h(30).px(8).rounded(6).border_1().border_color(error ? t.ansi1 : focused ? t.accent : t.input)
      .bg(t.background).text_size(12).text_color(t.foreground),
    error ? div().w_full().min_w(0).text_size(11.5).text_color(t.ansi1).child(view.tx(error)) : null,
  ];
}

// "When none works": Yahoo Finance and its delay, always on. Crypto has none.
function fallback(view, t, market) {
  if (market === "crypto") return [note(t, view.tx("settings.noFallback"))];
  return [
    heading(view, t, "settings.fallback"),
    sourceRow(view, t, "", "yahoo", delayText(view, market), alwaysOn(view, t)),
    details(healthLine(view, t, "yahoo")),
  ];
}

// The page's address fields, folded away until the person opens them. A refused address holds them open,
// its header dimmed and not clickable meanwhile; typing in a field keeps them open after (main.js), so
// fixing an address never hides the field being typed in.
function advanced(view, t, market, fields, error) {
  const forced = Boolean(error);
  const open = view.advancedOpen.has(market) || forced;
  const header = h_flex().id(`bw-${market}-advanced`).gap(6).items_center().text_size(11).font_semibold().text_color(t.muted)
    .when(!forced, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => {
      if (open) view.advancedOpen.delete(market);
      else view.advancedOpen.add(market);
      cx.notify();
    }))
    .child(div().flex_none().w(10).when(forced, (el) => el.text_color(t.dim)).child(open ? "⌄" : "›"))
    .child(view.tx("settings.advanced"));
  return [header, ...(open ? fields : [])];
}

// A Taiwan source switched on: once consent to its current statement is saved, one line, "✓ Consented ·
// View", whose link reads Hide in the same place while the statement shows below it; until then the
// statement, which text prevails and the box (Save waits for it). The statements show in full in the
// reader's language, wrapped to the page, which scrolls; the Traditional Chinese text prevails.
function consentParts(view, t, source) {
  const tw = view.draft.sources.tw;
  const [ack, version] = CONSENTS[source];
  const agreed = consentGiven(tw, source);
  const collapsible = consentCollapsed(view.settings, view.draft, source);
  const open = !collapsible || view.statementOpen.has(source);
  const consented = collapsible ? h_flex().w_full().min_w(0).gap(4).items_center().text_size(11.5)
    .child(div().flex_none().text_color(t.muted).child(`✓ ${view.tx("settings.consented")} ·`))
    .child(link(t, `bw-${source}-statement-link`, view.tx(open ? "settings.hideStatement" : "settings.viewStatement"), (cx) => {
      if (open) view.statementOpen.delete(source);
      else view.statementOpen.add(source);
      cx.notify();
    })) : null;
  if (!open) return [consented];
  return [
    consented,
    div().w_full().min_w(0).text_size(11.5).text_color(t.muted).child(view.tx(`${source}.statement`)),
    note(t, view.tx(`${source}.prevails`)),
    checkbox(t, `bw-${source}-consent`, agreed, view.tx(`${source}.consent`), (on) => { tw[ack] = on ? { version } : null; }),
    agreed ? null : note(t, view.tx(`${source}.consentNeeded`)),
  ];
}

// Taiwan: Yahoo 奇摩股市, then TWSE MIS, each used once switched on and consented to; Yahoo Finance otherwise.
function taiwanPage(view, t, errors, status) {
  const tw = view.draft.sources.tw;
  const misUrlError = errors["sources.tw.misUrl"];
  return marketPage(view, t, "tw", status,
    heading(view, t, "settings.realtime"),
    sourceRow(view, t, "1", "yahootw", view.tx("settings.unofficial"),
      toggle(t, "bw-yahootw", tw.yahootw, view.tx("src.yahootw"), (on) => { tw.yahootw = on; })),
    details(healthLine(view, t, "yahootw"), ...(tw.yahootw ? consentParts(view, t, "yahootw") : [])),
    sourceRow(view, t, "2", "mis", view.tx("settings.unofficial"),
      toggle(t, "bw-mis", tw.mis, view.tx("src.mis"), (on) => { tw.mis = on; })),
    details(healthLine(view, t, "mis"), ...(tw.mis ? consentParts(view, t, "mis") : [])),
    ...fallback(view, t, "tw"),
    ...(tw.mis ? advanced(view, t, "tw",
      field(view, t, view.tx("sources.tw.url"), view.misUrlInput, view.misUrlFocused, misUrlError), misUrlError) : []),
  );
}

// The Finnhub key: a saved one is never drawn, only its last four characters and Remove (applied on Save).
function savedKey(view, t) {
  if (view.keyEnding === null) return null;
  return h_flex().gap(6).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(12)
      .text_color(view.keyRemoving ? t.dim : t.muted)
      .child(view.tx(view.keyRemoving ? "sources.us.keyRemoving" : "sources.us.keySaved", { ending: view.keyEnding })))
    .child(button(t, "bw-key-remove", view.tx(view.keyRemoving ? "sources.us.keyKeep" : "sources.us.keyRemoveButton"), (cx) => {
      view.keyRemoving = !view.keyRemoving;
      cx.notify();
    }));
}

// Finnhub switched on: the person's key and per-minute budget.
function finnhubParts(view, t, errors) {
  const keyError = errors["sources.us.key"];
  const budgetError = errors["sources.us.budgetPerMinute"];
  const saved = savedKey(view, t);
  const key = h_flex().gap(6).items_center()
    .child(Input.new(view.keyInput).flex_1().min_w(0).h(30).px(8).rounded(6).border_1()
      .border_color(keyError ? t.ansi1 : view.keyFocused ? t.accent : t.input)
      .bg(t.background).text_size(12).text_color(t.foreground))
    .child(button(t, "bw-key-show", view.tx(view.keyShown ? "sources.us.hide" : "sources.us.show"), (cx) => {
      view.keyShown = !view.keyShown;
      view.keyInput.set_masked(!view.keyShown);
      cx.notify();
    }));
  return [
    div().text_size(11).text_color(t.muted).child(view.tx("sources.us.key")),
    saved,
    key,
    keyError ? div().w_full().min_w(0).text_size(11.5).text_color(t.ansi1).child(view.tx(keyError)) : null,
    saved && note(t, view.tx(view.keyRemoving ? "sources.us.keyRemoveHint" : "sources.us.keyReplace")),
    note(t, view.tx("sources.us.keyNote")),
    ...field(view, t, view.tx("sources.us.budget"), view.budgetInput, view.budgetFocused, budgetError),
    budgetError ? null : note(t, view.tx("sources.us.cap", { cap: finnhubCap(view.draft.sources.us.budgetPerMinute) })),
    note(t, view.tx("sources.us.copies")),
  ];
}

// United States: Finnhub with the person's key, else Yahoo Finance. With Finnhub off, a saved key stays
// until Remove and Save, so its line stays too.
function usPage(view, t, errors, status) {
  const us = view.draft.sources.us;
  const on = us.provider === "finnhub";
  const urlError = errors["sources.us.finnhubUrl"];
  const saved = on ? null : savedKey(view, t);
  return marketPage(view, t, "us", status,
    heading(view, t, "settings.realtime"),
    sourceRow(view, t, "1", "finnhub", view.tx("settings.ownKey"),
      toggle(t, "bw-finnhub", on, view.tx("src.finnhub"), (value) => { us.provider = value ? "finnhub" : "yahoo"; })),
    details(
      healthLine(view, t, "finnhub"),
      view.keyWarning ? div().w_full().min_w(0).text_size(11.5).text_color(t.blocked).child(view.say(view.keyWarning)) : null,
      ...(on ? finnhubParts(view, t, errors) : saved ? [
        div().text_size(11).text_color(t.muted).child(view.tx("sources.us.key")),
        saved,
        note(t, view.tx("sources.us.keyRemove")),
      ] : []),
    ),
    ...fallback(view, t, "us"),
    ...(on ? advanced(view, t, "us",
      field(view, t, view.tx("sources.us.url"), view.finnhubUrlInput, view.finnhubUrlFocused, urlError), urlError) : []),
  );
}

// Crypto: Binance Spot only, always on, at the address the person may change.
function cryptoPage(view, t, errors, status) {
  const urlError = errors["sources.crypto.binanceUrl"];
  return marketPage(view, t, "crypto", status,
    heading(view, t, "settings.realtime"),
    // "Spot" is part of the product's name (Binance Spot), the same in every language.
    sourceRow(view, t, "1", "binance", "Spot", alwaysOn(view, t)),
    details(healthLine(view, t, "binance"), note(t, view.tx("sources.crypto.region"))),
    ...fallback(view, t, "crypto"),
    ...advanced(view, t, "crypto", field(view, t, view.tx("sources.crypto.url"), view.urlInput, view.urlFocused, urlError), urlError),
  );
}

// Every other market: Yahoo Finance alone, nothing to set.
function otherPage(view, t, _errors, status) {
  return marketPage(view, t, "other", status, ...fallback(view, t, "other"), note(t, view.tx("sources.other.body")));
}

// The interface language, then the gain and loss colors, then Herdr's own appearance settings.
function displayTab(view, t) {
  return v_flex().w_full().min_w(0).gap(12)
    .child(div().font_semibold().child(view.tx("display.language")))
    .child(segmented(t, "bw-language", LANGUAGES.map((language) => [language, LANGUAGE_LABELS[language]]), view.draft.language,
      (language) => { view.draft.language = language; }))
    .child(note(t, view.tx("display.languageHint")))
    .child(div().mt(8).font_semibold().child(view.tx("display.colors")))
    .child(segmented(t, "bw-colors", COLOR_CHOICES.map(([value, key]) => [value, view.tx(key)]), view.draft.colors,
      (colors) => { view.draft.colors = colors; }))
    .child(note(t, view.tx("display.colorsHint")))
    .child(h_flex().mt(8).child(button(t, "bw-appearance", view.tx("display.appearance"), () => view.openAppearance())))
    .child(note(t, view.tx("display.appearanceHint")));
}

function disclaimerTab(view, t) {
  const paragraph = (key) => div().w_full().min_w(0).text_color(t.muted).child(view.tx(key));
  return v_flex().w_full().min_w(0).gap(10)
    .child(div().font_semibold().child(view.tx("disclaimer.title")))
    .children(["disclaimer.data", "disclaimer.advice", "disclaimer.sources", "disclaimer.direct", "disclaimer.key"].map(paragraph))
    .child(note(t, view.tx("disclaimer.prevails")))
    .child(div().mt(8).font_semibold().child(view.tx("disclaimer.sourcesTitle")))
    .children(["disclaimer.sourcesStocks", "disclaimer.sourcesCrypto"].map(paragraph))
    .child(div().mt(8).font_semibold().child(view.tx("privacy.title")))
    .children(["privacy.hosts", "privacy.programs", "privacy.storage", "privacy.finnhub"].map(paragraph));
}
