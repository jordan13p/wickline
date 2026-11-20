// The panel's header pieces: the brand, the count and status lines, the header's icons, the add field, the
// language prompt, and the edit's notice and the sources' problem lines under it. Drawn from the view; every
// Herdr call goes back through it.
import { div, svg } from "gpui-kit";
import { h_flex, Input } from "gpui-base";
import { formatTime } from "../format.js";
import { LANGUAGES, LANGUAGE_LABELS } from "../i18n.js";
import { blockedNote, icon, iconButton, link } from "./parts.js";

// Until answered: `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`. A label switches and
// dismisses; × only dismisses, and sits beside the labels, not inside one.
export function languagePrompt(view, t) {
  const choices = LANGUAGES.flatMap((language, i) => [
    ...(i ? [div().flex_none().text_color(t.dim).child("·")] : []),
    link(t, `bw-lang-${language}`, LANGUAGE_LABELS[language], (cx) => view.chooseLanguage(cx, language)),
  ]);
  return h_flex()
    .items_center()
    .gap(6)
    .text_size(11)
    .child(div().flex_none().text_color(t.dim).child(view.tx("prompt.language")))
    .child(h_flex().flex_1().min_w(0).items_center().gap(5).overflow_hidden().children(choices))
    .child(
      link(t, "bw-lang-dismiss", "×", (cx) =>
        view.act(cx, () => view.saveSettings({ languagePromptDismissed: true }), "error.saveSettings"),
      ),
    );
}

// The text for the header's count: `8 tickers`.
export function countText(view) {
  const count = view.watch.preferences.symbols.length;
  return view.tx(count === 1 ? "header.tickers.one" : "header.tickers.other", { count });
}

// `Auto-refresh on · Updated 14:05` (the newest fetch among the rows), or `… · Refreshing quotes…` during a Refresh.
export function statusText(view, now) {
  const w = view.watch;
  const state = view.tx(w.preferences.paused ? "status.paused" : "status.on");
  // Only for a refresh the person asked for: automatic rounds would flip the line every few seconds.
  if (w.refreshing) return `${state} · ${view.tx("status.refreshing")}`;
  const fetched = Math.max(0, ...w.preferences.symbols.map((symbol) => w.shown(symbol, now)?.fetchedAt ?? 0));
  return fetched ? `${state} · ${view.tx("status.updated", { time: formatTime(fetched) })}` : state;
}

// The mark and the name in the text color, the mark's middle candle in the accent: two single-color
// layers, since an svg takes one tint. Otherwise the accent is kept for focus, the drop line and links.
export function brand(t) {
  return h_flex()
    .flex_none()
    .items_center()
    .gap(8)
    .child(
      div()
        .relative()
        .flex_none()
        .w(16)
        .h(16)
        .child(svg(icon("mark-sides")).absolute().top(0).left(0).w(16).h(16).text_color(t.foreground))
        .child(svg(icon("mark-center")).absolute().top(0).left(0).w(16).h(16).text_color(t.accent)),
    )
    .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Wickline"));
}

// Refresh, pause or resume, settings, own tab or back; the glyphs' right edge lines up with the content's.
export function headerIcons(view, t) {
  const { paused } = view.watch.preferences;
  const own = view.ownTabAction();
  return h_flex()
    .flex_none()
    .items_center()
    .mr(-6)
    .child(
      iconButton(
        t,
        "bw-refresh",
        "refresh",
        view.tx("button.refresh"),
        (cx) => {
          view.refresh(cx);
          cx.notify();
        },
        view.spin !== null,
      ),
    )
    .child(
      iconButton(t, "bw-pause", paused ? "play" : "pause", view.tx(paused ? "button.resume" : "button.pause"), (cx) =>
        view.act(cx, () => view.togglePause()),
      ),
    )
    .child(iconButton(t, "bw-settings", "settings", view.tx("button.settings"), () => view.openSettings()))
    .when(Boolean(own), (el) =>
      el.child(iconButton(t, "bw-own-tab", own.icon, view.tx(own.label), (cx) => own.go(cx))),
    );
}

// Filled and borderless at rest; the accent border marks focus. The border is always 1 px, so focus never moves
// the text. `selected` is one step off the panel's `background` in light and dark themes alike, and a step
// past `hover`, so the field never looks like a hovered row.
export function addField(view, t) {
  return Input.new(view.input)
    .h(32)
    .px(10)
    .rounded(6)
    .border_1()
    .border_color(view.inputFocused ? t.accent : t.selected)
    .bg(t.selected)
    .text_size(12.5)
    .text_color(t.foreground);
}

// What the last edit said, under the add field. A removal's notice offers Undo right after its text
// (`Removed 2330.TW.  Undo`, no separator after its full stop), which wraps at its natural width rather than pushing the link to the edge.
export function messages(view, t) {
  if (view.error) return [div().text_size(11).text_color(t.ansi1).child(view.say(view.error))];
  if (!view.notice) return [];
  const text = div().text_size(11).text_color(t.dim).child(view.say(view.notice));
  if (!view.notice.undo) return [text];
  return [
    h_flex()
      .items_start()
      .gap(6)
      .text_size(11)
      .child(text.flex_initial().min_w(0))
      .child(link(t, "bw-undo", view.tx("notice.undo"), (cx) => view.undoRemove(cx))),
  ];
}

// One line per source with a problem (rate limited, unreachable, timed out, refused), then one per source whose Taiwan
// answers carry no trade today (the rows read 今日無成交: the market may be closed, or the source may be stuck).
export function problemLines(view, t) {
  return [...view.watch.problems(), ...view.watch.notes()].map((line) => blockedNote(t, view.say(line)));
}
