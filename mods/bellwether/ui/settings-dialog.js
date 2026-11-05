// The settings dialog: a copy whose props carry `settings` draws only this. The draft, its inputs and
// Save live on the view (inputs are made outside render, and saving writes Herdr's storage).
import { div } from "gpui-kit";
import { h_flex, v_flex, Checkbox, Input } from "gpui-base";
import { LANGUAGES, LANGUAGE_LABELS } from "../i18n.js";
import { MIS_CONSENT_VERSION } from "../providers/mis.js";
import { finnhubCap } from "../providers/finnhub.js";
import { button, card, note, segmented } from "./parts.js";

export const SETTINGS_TABS = ["sources", "display", "disclaimer"];
// Each tab's drawing, by its name in SETTINGS_TABS.
const TABS = { sources: sourcesTab, display: displayTab, disclaimer: disclaimerTab };
const COLOR_CHOICES = [["auto", "display.colors.auto"], ["red-up", "display.colors.redUp"], ["green-up", "display.colors.greenUp"]];

// Tabs on the left, the tab on the right, Cancel / Save below.
export function settingsView(view, t) {
  const errors = view.draftErrors();
  const invalid = Object.keys(errors).length > 0 || !view.keyLoaded || view.saving;
  const tabs = v_flex().flex_none().w(168).p(10).gap(2).border_r(1).border_color(t.border)
    .child(div().px(8).pb(8).text_size(13).font_semibold().text_color(t.foreground).child(view.tx("settings.title")))
    .children(SETTINGS_TABS.map((tab) => h_flex().id(`bw-tab-${tab}`).px(8).h(28).items_center().rounded(5).cursor_pointer()
      .text_color(tab === view.tab ? t.foreground : t.muted).when(tab === view.tab, (el) => el.bg(t.hover).font_semibold())
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { view.tab = tab; cx.notify(); }).child(view.tx(`settings.tab.${tab}`))));
  const pane = v_flex().id("bw-settings-pane").flex_1().min_w(0).min_h(0).p(18).gap(14).overflow_y_scrollbar()
    .child(TABS[view.tab](view, t, errors));
  const save = h_flex().id("bw-settings-save").flex_none().h(28).px(14).items_center().rounded(5).font_semibold()
    .when(invalid, (el) => el.bg(t.hover).text_color(t.dim))
    .when(!invalid, (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click((_e, cx) => view.saveDraft(cx)))
    .child(view.tx("settings.save"));
  const footer = h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.ansi1)
      .child(view.error ? view.say(view.error) : ""))
    .child(h_flex().id("bw-settings-cancel").flex_none().h(28).px(14).items_center().rounded(5).border_1().border_color(t.border)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => view.closeDialog()).child(view.tx("settings.cancel")))
    .child(save);
  return v_flex().id("bw-settings").size_full().text_color(t.foreground).text_size(12.5)
    // h_flex centers its children; stretch lets the tab column and the pane both fill the height.
    .child(h_flex().flex_1().min_h(0).items_stretch().child(tabs).child(pane))
    .child(footer);
}

// The source's problem when the dialog opened, if it had one.
function healthLine(view, t, provider) {
  const problem = view.health.find((entry) => entry.provider === provider);
  return problem ? div().text_size(11.5).text_color(t.blocked).child(view.say(problem)) : null;
}

// A labeled input of the settings dialog, red while its value is refused.
function field(view, t, label, state, focused, error) {
  return [
    div().text_size(11).text_color(t.muted).child(label),
    Input.new(state).h(30).px(8).rounded(6).border_1().border_color(error ? t.ansi1 : focused ? t.accent : t.input)
      .bg(t.background).text_size(12).text_color(t.foreground),
    error ? div().text_size(11.5).text_color(t.ansi1).child(view.tx(error)) : null,
  ];
}

// US: Yahoo, or Finnhub with the person's key, address and per-minute budget.
function usCard(view, t, errors) {
  const us = view.draft.sources.us;
  const chosen = us.provider === "finnhub";
  const keyError = errors["sources.us.key"];
  const budgetError = errors["sources.us.budgetPerMinute"];
  const key = h_flex().gap(6).items_center()
    .child(Input.new(view.keyInput).flex_1().min_w(0).h(30).px(8).rounded(6).border_1()
      .border_color(keyError ? t.ansi1 : view.keyFocused ? t.accent : t.input)
      .bg(t.background).text_size(12).text_color(t.foreground))
    .child(button(t, "bw-key-show", view.tx(view.keyShown ? "sources.us.hide" : "sources.us.show"), (cx) => {
      view.keyShown = !view.keyShown;
      view.keyInput.set_masked(!view.keyShown);
      cx.notify();
    }));
  const finnhubParts = chosen ? [
    div().text_size(11).text_color(t.muted).child(view.tx("sources.us.key")),
    key,
    keyError ? div().text_size(11.5).text_color(t.ansi1).child(view.tx(keyError)) : null,
    note(t, view.tx("sources.us.keyNote")),
    ...field(view, t, view.tx("sources.us.url"), view.finnhubUrlInput, view.finnhubUrlFocused, errors["sources.us.finnhubUrl"]),
    ...field(view, t, view.tx("sources.us.budget"), view.budgetInput, view.budgetFocused, budgetError),
    budgetError ? null : note(t, view.tx("sources.us.cap", { cap: finnhubCap(us.budgetPerMinute) })),
    note(t, view.tx("sources.us.copies")),
  ] : view.savedKey ? [
    // Yahoo keeps a saved key; clearing the field and saving removes it.
    div().text_size(11).text_color(t.muted).child(view.tx("sources.us.key")),
    key,
    note(t, view.tx("sources.us.keyRemove")),
  ] : [];
  return card(t, view.tx("sources.us.title"), view.tx(chosen ? "sources.us.finnhubSource" : "sources.us.yahooSource"),
    segmented(t, "bw-us", [["yahoo", view.tx("src.yahoo")], ["finnhub", view.tx("src.finnhub")]], us.provider,
      (provider) => { us.provider = provider; }),
    ...finnhubParts,
    view.keyWarning ? div().text_size(11.5).text_color(t.blocked).child(view.say(view.keyWarning)) : null,
    healthLine(view, t, "finnhub"));
}

// Taiwan: Yahoo, or TWSE MIS once its statement is read and the box ticked (Save waits for it).
function taiwanCard(view, t, errors) {
  const tw = view.draft.sources.tw;
  const chosen = tw.provider === "mis";
  const agreed = tw.misAck?.version === MIS_CONSENT_VERSION;
  const urlError = errors["sources.tw.misUrl"];
  const consent = Checkbox.new("bw-mis-consent").checked(agreed).cursor_pointer()
    .on_change((checked, cx) => { tw.misAck = checked ? { version: MIS_CONSENT_VERSION } : null; cx.notify(); })
    .child(h_flex().gap(8).items_start()
      .child(div().flex_none().mt(2).w(14).h(14).rounded(3).border_1().border_color(agreed ? t.accent : t.border)
        .flex().items_center().justify_center().text_size(10).text_color(t.background)
        .when(agreed, (el) => el.bg(t.accent).child("✓")))
      .child(div().flex_1().min_w(0).font_semibold().child(view.tx("mis.consent"))));
  return card(t, view.tx("sources.tw.title"), view.tx(chosen ? "sources.tw.misSource" : "sources.tw.yahooSource"),
    segmented(t, "bw-tw", [["yahoo", view.tx("src.yahoo")], ["mis", view.tx("src.mis")]], tw.provider,
      (provider) => { tw.provider = provider; }),
    ...(chosen ? field(view, t, view.tx("sources.tw.url"), view.misUrlInput, view.misUrlFocused, urlError) : []),
    // The statement in the reader's language; the Traditional Chinese text prevails.
    chosen && div().text_size(11.5).text_color(t.muted).child(view.tx("mis.statement")),
    chosen && note(t, view.tx("mis.prevails")),
    chosen && consent,
    chosen && !agreed ? note(t, view.tx("mis.consentNeeded")) : null,
    healthLine(view, t, "mis"));
}

function sourcesTab(view, t, errors) {
  return v_flex().gap(12)
    .child(usCard(view, t, errors))
    .child(taiwanCard(view, t, errors))
    .child(card(t, view.tx("sources.other.title"), view.tx("sources.other.body"), healthLine(view, t, "yahoo")))
    .child(card(t, view.tx("sources.crypto.title"), view.tx("sources.crypto.source"),
      ...field(view, t, view.tx("sources.crypto.url"), view.urlInput, view.urlFocused, errors["sources.crypto.binanceUrl"]),
      note(t, view.tx("sources.crypto.region")),
      healthLine(view, t, "binance")));
}

// The interface language, then the gain and loss colors, then Herdr's own appearance settings.
function displayTab(view, t) {
  return v_flex().gap(12)
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
  const paragraph = (key) => div().text_color(t.muted).child(view.tx(key));
  return v_flex().gap(10)
    .child(div().font_semibold().child(view.tx("disclaimer.title")))
    .children(["disclaimer.data", "disclaimer.advice", "disclaimer.sources", "disclaimer.direct", "disclaimer.key"].map(paragraph))
    .child(note(t, view.tx("disclaimer.prevails")))
    .child(div().mt(8).font_semibold().child(view.tx("disclaimer.sourcesTitle")))
    .children(["disclaimer.sourcesStocks", "disclaimer.sourcesCrypto"].map(paragraph))
    .child(div().mt(8).font_semibold().child(view.tx("privacy.title")))
    .children(["privacy.hosts", "privacy.programs", "privacy.storage", "privacy.finnhub"].map(paragraph));
}
