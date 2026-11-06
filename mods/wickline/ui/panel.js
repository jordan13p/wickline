// The panel: the band (a short docked strip), the sidebar and the table, with their rows, drag and drop
// and header actions. Everything that talks to Herdr (storage, requests, commands, panes) stays on the
// view in main.js; these functions draw from it and call back into it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { isCryptoPair } from "../quotes.js";
import { displayName, dropBefore, formatBandPrice, formatChange, formatPrice, formatStaleDate, formatTime, rowName } from "../format.js";
import { freshness, sessionOf } from "../freshness.js";
import { chosenFilter, marketFilters, visibleSymbols } from "../markets.js";
import { LANGUAGES, LANGUAGE_LABELS } from "../i18n.js";
import { finnhubCap } from "../providers/finnhub.js";
import { COLUMN_GAP, GUTTER, TABLE_COLUMNS, TABLE_MAX_WIDTH, columnWidth, nameWidth, tableColumns } from "../layout.js";
import { button, chart, dot, icon, iconButton } from "./parts.js";

const ICON = "mods/wickline/icon.svg";
// Sidebar rows: the day's line, then the price column (the number, then a slot for its currency).
// The right group keeps this width, so a wider pane gives its room to the name.
const SPARK = { width: 56, height: 20 };
const TABLE_SPARK = { width: columnWidth("line"), height: 20 };
const NUMBER_W = 72;
const CODE_W = 34;
// The filter row: 24 px labels with 2 px between them; the chosen one sits on a pill of the same height.
const FILTER_H = 24;
const FILTER_GAP = 2;
const FILTER_SLIDE = { duration: 180, easing: "ease-out" };
// Below this panel width the footer shows the short disclaimer.
const SHORT_FOOTER_WIDTH = 480;

// The source for a real-time price, the delay for Yahoo's, or the session when it is not trading.
function freshnessLabel(view, quote, fresh, now) {
  switch (fresh.state) {
    case "live":
    case "unconfirmed":
      return view.tx(`src.${quote.source}`);
    case "stalled":
      return view.tx("freshness.stalled", { time: formatTime(fresh.stoppedAt) });
    case "delayed":
      return fresh.delayMinutes === null ? view.tx("freshness.delayed")
        : view.tx("freshness.delayedMinutes", { minutes: fresh.delayMinutes });
    case "closed": {
      const date = formatStaleDate(quote.timestamp, now, view.lang);
      return `${view.tx("session.closed")} · ${date ? `${date} ` : ""}${formatTime(quote.timestamp)}`;
    }
    default:
      return view.tx(`session.${fresh.state}`);
  }
}

// One line: Wickline, then as many quotes as fit.
export function band(view, root, t) {
  const w = view.watch;
  const symbols = w.preferences.symbols;
  const now = Date.now();
  return root.px(12).gap(14).items_center().overflow_hidden()
    .child(h_flex().flex_none().gap(6).items_center()
      .child(svg(ICON).w(14).h(14).text_color(t.foreground))
      .child(div().text_color(t.foreground).font_semibold().child("Wickline")))
    .when(w.preferences.paused, (el) => el.child(div().flex_none().text_color(t.blocked).child(view.tx("band.paused"))))
    .when(!symbols.length, (el) => el.child(div().text_color(t.dim).truncate().child(view.tx("band.empty"))))
    .children(symbols.map((symbol) => {
      const quote = w.shown(symbol);
      const failed = Boolean(w.errors[symbol]);
      const mark = quote && dot(t, freshness(quote, sessionOf(quote, now), now).state);
      return h_flex().flex_none().gap(5).items_center().whitespace_nowrap()
        .child(div().font_semibold().child(symbol))
        .when(Boolean(mark), (el) => el.child(mark))
        .child(div().text_color(quote && !failed ? t.foreground : t.dim).child(quote ? formatBandPrice(quote) : failed ? view.tx("band.unavailable") : "…"))
        .when(Boolean(quote), (el) => el.child(div().text_color(view.changeColor(t, quote.changePercent)).child(formatChange(quote.changePercent))))
        .when(Boolean(quote) && failed, (el) => el.child(div().text_color(t.dim).child(view.tx("band.cached"))));
    }));
}

// Until answered: `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`. A label switches and
// dismisses; × only dismisses, and sits beside the labels, not inside one.
function languagePrompt(view, t) {
  const link = (id, label, onClick) => div().id(id).flex_none().text_color(t.muted).cursor_pointer()
    .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
  const choices = LANGUAGES.flatMap((language, i) => [
    ...(i ? [div().flex_none().text_color(t.dim).child("·")] : []),
    link(`bw-lang-${language}`, LANGUAGE_LABELS[language], (cx) => view.chooseLanguage(cx, language)),
  ]);
  return h_flex().items_center().gap(6).text_size(11)
    .child(div().flex_none().text_color(t.dim).child(view.tx("prompt.language")))
    .child(h_flex().flex_1().min_w(0).items_center().gap(5).overflow_hidden().children(choices))
    .child(link("bw-lang-dismiss", "×", (cx) => view.act(cx, () => view.saveSettings({ languagePromptDismissed: true }), "error.saveSettings")));
}

// The text for the header's count: `8 tickers`.
function countText(view) {
  const count = view.watch.preferences.symbols.length;
  return view.tx(count === 1 ? "header.tickers.one" : "header.tickers.other", { count });
}

// `Auto-refresh on · Updated 14:05` (the newest fetch among the rows), or `… · Refreshing quotes…` during a Refresh.
function statusText(view) {
  const w = view.watch;
  const state = view.tx(w.preferences.paused ? "status.paused" : "status.on");
  // Only for a refresh the person asked for: automatic rounds would flip the line every few seconds.
  if (w.refreshing) return `${state} · ${view.tx("status.refreshing")}`;
  const fetched = Math.max(0, ...w.preferences.symbols.map((symbol) => w.shown(symbol)?.fetchedAt ?? 0));
  return fetched ? `${state} · ${view.tx("status.updated", { time: formatTime(fetched) })}` : state;
}

// The mark and the name in the text color, the mark's middle candle in the accent: two single-color
// layers, since an svg takes one tint. Otherwise the accent is kept for focus, the drop line and links.
function brand(view, t) {
  return h_flex().flex_none().items_center().gap(8)
    .child(div().relative().flex_none().w(16).h(16)
      .child(svg(icon("mark-sides")).absolute().top(0).left(0).w(16).h(16).text_color(t.foreground))
      .child(svg(icon("mark-center")).absolute().top(0).left(0).w(16).h(16).text_color(t.accent)))
    .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Wickline"));
}

// Refresh, pause or resume, settings, own tab or back; the glyphs' right edge lines up with the content's.
function headerIcons(view, t) {
  const { paused } = view.watch.preferences;
  const own = view.ownTabAction();
  return h_flex().flex_none().items_center().mr(-6)
    .child(iconButton(t, "bw-refresh", "refresh", view.tx("button.refresh"), (cx) => { view.refresh(cx); cx.notify(); }, view.spinning))
    .child(iconButton(t, "bw-pause", paused ? "play" : "pause", view.tx(paused ? "button.resume" : "button.pause"),
      (cx) => view.act(cx, () => view.togglePause())))
    .child(iconButton(t, "bw-settings", "settings", view.tx("button.settings"), () => view.openSettings("sources")))
    .when(Boolean(own), (el) => el.child(iconButton(t, "bw-own-tab", own.icon, view.tx(own.label), (cx) => own.go(cx))));
}

// A docked block whose own tab is open: one line and the way back, no quotes. The band has one line of
// height, so it gets one row.
export function yieldView(view, root, t, inBand) {
  const notice = div().text_color(t.dim).child(view.tx("dock.openInTab"));
  const back = button(t, "bw-yield-back", view.tx("button.backToPanel"), (cx) => view.backFromYield(cx));
  if (inBand) return root.px(12).gap(14).items_center().overflow_hidden().child(notice.flex_1().min_w(0).truncate()).child(back);
  return root.child(v_flex().flex_none().px(GUTTER).py(10).gap(10).items_start().child(brand(view, t)).child(notice.text_size(11)).child(back));
}

// Filled and borderless at rest; the accent border marks focus. The border is always 1 px, so focus never moves
// the text. `selected` is one step off the panel's `background` in light and dark themes alike, and a step
// past `hover`, so the field never looks like a hovered row.
function addField(view, t) {
  return Input.new(view.input).h(32).px(10).rounded(6).border_1()
    .border_color(view.inputFocused ? t.accent : t.selected).bg(t.selected).text_size(12.5).text_color(t.foreground);
}

// What the last edit said, under the add field.
function messages(view, t) {
  if (view.error) return [div().text_size(11).text_color(t.ansi1).child(view.say(view.error))];
  return view.notice ? [div().text_size(11).text_color(t.dim).child(view.say(view.notice))] : [];
}

// One line per source with a problem: rate limited, unreachable, timed out, refused.
function problemLines(view, t) {
  return view.watch.problems().map((problem) => div().text_size(11).text_color(t.blocked).child(view.say(problem)));
}

// What a row shows, whichever layout draws it.
function rowData(view, t, symbol, now) {
  const w = view.watch;
  const quote = w.shown(symbol);
  const fresh = quote && freshness(quote, sessionOf(quote, now), now);
  // A closed label carries its own date; any other quote from an earlier day gets one.
  const stale = quote && fresh.state !== "closed" ? formatStaleDate(quote.timestamp, now, view.lang) : "";
  return {
    quote,
    failed: w.errors[symbol],
    // The real-time source failed for this symbol: the base quote shows, with the reason.
    fallback: w.overlayErrors[symbol],
    // A US row past Finnhub's budget stays on Yahoo and says so.
    overCap: w.overCap(symbol),
    label: quote ? freshnessLabel(view, quote, fresh, now) : "",
    date: stale ? view.tx("quote.asOf", { date: stale }) : "",
    name: quote ? displayName(quote, view.lang) : null,
    dot: quote && dot(t, fresh.state),
    color: quote ? view.changeColor(t, quote.changePercent) : t.dim,
  };
}

// Under a row: a cached quote's reason, a real-time source's fallback, Finnhub's budget.
function rowNotes(view, t, { quote, failed, fallback, overCap }) {
  return [
    failed && div().text_size(11).text_color(t.blocked).child(quote ? view.tx("quote.cached", { reason: view.say(failed) }) : view.say(failed)),
    fallback && div().text_size(11).text_color(t.blocked).child(quote ? view.fallbackText(quote, fallback) : view.say(fallback)),
    overCap && div().text_size(11).text_color(t.dim).child(view.tx("finnhub.overCap", { cap: finnhubCap(view.settings.sources.us.budgetPerMinute) })),
  ].filter(Boolean);
}

// `value` (the price by default) without its currency, for a fixed right-aligned column.
function number(quote, value = quote.price) {
  return typeof value === "number" && value > 0 ? formatPrice({ ...quote, price: value, currency: null }) : "—";
}

// The day's change in the price's own units: `+3.58`, `-1,234.56`.
function signed(quote) {
  if (!(quote.previousClose > 0)) return "—";
  const change = quote.price - quote.previousClose;
  const size = Math.abs(change) > 0 ? formatPrice({ ...quote, price: Math.abs(change), currency: null }) : "0.00";
  return `${change >= 0 ? "+" : "-"}${size}`;
}

// Before the first quote: why there is none yet.
function waiting(view, row) {
  return view.tx(row.failed ? "row.unavailable" : view.watch.preferences.paused ? "row.notFetched" : "row.waiting");
}

// The price over the change, both right-aligned on the number; the currency hangs in its own slot.
function priceStack(view, t, row) {
  const { quote, failed, color } = row;
  if (!quote) return div().flex_none().w(NUMBER_W + CODE_W).pr(CODE_W).text_right().text_size(11).text_color(t.dim).child(waiting(view, row));
  return v_flex().flex_none().gap(2)
    .child(h_flex().items_baseline()
      .child(div().flex_none().w(NUMBER_W).text_right().whitespace_nowrap().text_color(failed ? t.dim : t.foreground).child(number(quote)))
      .child(div().flex_none().w(CODE_W).pl(4).text_size(11).text_color(t.dim).child(quote.currency ?? "")))
    .child(div().flex_none().w(NUMBER_W).text_right().text_size(11).text_color(color).child(formatChange(quote.changePercent)));
}

// A row: the drag handle in the left gutter and × in the right one, both only under the pointer; between
// them the body, which opens the ticker's day. Hairlines between rows span the body only.
function rowFrame(view, t, symbol, index, symbols, body, clickable) {
  const dragged = view.drag?.symbol === symbol;
  const next = symbols[index + 1] ?? null;
  const controls = dragged || (!view.drag && view.hovered === symbol);
  const moving = Boolean(view.drag) && !dropsInPlace(view);
  return h_flex().id(`bw-line-${symbol}`).relative().items_stretch()
    .when(dragged, (el) => el.bg(t.raised))
    .when(!view.drag, (el) => el.hover((s) => s.bg(t.hover)))
    .on_hover((hovered, cx) => {
      if (hovered) view.hovered = symbol;
      else if (view.hovered === symbol) view.hovered = null;
      cx.notify();
    })
    .on_mouse_move((e, cx) => {
      if (!view.drag || !e.bounds) return;
      // Upper half: in front of this row; lower half: in front of the next one.
      const before = e.local_position.y < e.bounds.height / 2 ? symbol : next;
      if (before === view.drag.before) return;
      view.drag.before = before;
      cx.notify();
    })
    // Where the dragged row would land: a 2 px accent line in front of `before`, or after the last row.
    .when(moving && view.drag?.before === symbol, (el) => el.child(dropBar(t).top(0)))
    .when(moving && view.drag?.before === null && next === null, (el) => el.child(dropBar(t).bottom(0)))
    .when(dragged, (el) => el.child(div().absolute().top(0).left(0).right(0).bottom(0).border_1().border_color(t.border)))
    // The handle fills its gutter for the row's whole height, so it is easy to grab; the slot stays when hidden.
    .child(div().id(`bw-handle-${symbol}`).flex_none().w(GUTTER).flex().items_center().justify_center().text_color(t.dim)
      .when(controls, (el) => el
        .hover((s) => s.text_color(t.foreground))
        .when(dragged, (h) => h.text_color(t.foreground).cursor_grabbing())
        .when(!dragged, (h) => h.cursor_grab())
        .on_mouse_down("left", (_e, cx) => {
          cx.stop_propagation();
          view.drag = { symbol, before: symbol };
          cx.notify();
        })
        .child(svg(icon("grip")).w(14).h(14))))
    .child(body.id(`bw-row-${symbol}`).flex_1().min_w(0)
      .when(next !== null, (el) => el.border_b(1).border_color(t.border))
      .when(clickable, (el) => el.cursor_pointer())
      .on_click(() => view.openDetail(symbol)))
    // × sits beside the body, not inside it.
    .child(div().id(`bw-remove-${symbol}`).flex_none().w(GUTTER).flex().items_center().justify_center().text_color(t.dim)
      .when(controls && !dragged, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
        .tooltip(view.tx("button.remove"))
        .on_click((_e, cx) => view.removeSymbol(cx, symbol))
        .child(svg(icon("close")).w(12).h(12))));
}

// The scrolling rows. No pointer capture: a release outside the list never arrives, so leaving it cancels a drag.
function list(view, t, rows) {
  return v_flex().id("bw-list").flex_1().min_h(0).overflow_y_scrollbar()
    .on_hover((hovered, cx) => {
      if (hovered || !view.drag) return;
      view.drag = null;
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => {
      const drag = view.drag;
      if (!drag) return;
      const inPlace = dropsInPlace(view);
      view.drag = null;
      // A drop where the row already is changes nothing, and leaves the current notice be.
      if (inPlace) cx.notify();
      else view.act(cx, () => view.watch.move(drag.symbol, dropBefore(view.watch.preferences.symbols, shownSymbols(view), drag.before)));
    })
    .when(!rows.length, (el) => el.child(div().px(GUTTER).py(8).text_color(t.dim).child(view.tx("list.empty"))))
    .children(rows);
}

// One line: the disclaimer, which opens the settings' disclaimer tab.
function footer(view, t) {
  const short = view.size && view.size.width < SHORT_FOOTER_WIDTH;
  return div().flex_none().px(GUTTER)
    .child(div().id("bw-disclaimer").py(10).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => view.openSettings("disclaimer"))
      .child(view.tx(short ? "footer.short" : "footer.long")));
}

// Below TABLE_MIN_WIDTH: the header, the status line, the add field, two-line rows, the footer.
export function sidebar(view, root, t) {
  const symbols = shownSymbols(view);
  const now = Date.now();
  const header = v_flex().flex_none().px(GUTTER).pt(10).gap(2)
    .child(h_flex().h(28).items_center().gap(8)
      .child(brand(view, t))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(countText(view)))
      .child(headerIcons(view, t)))
    .child(div().truncate().text_size(11).text_color(t.dim).child(statusText(view)))
    .children(problemLines(view, t));
  const field = v_flex().flex_none().px(GUTTER).pt(12).gap(6)
    .when(!view.settings.languagePromptDismissed, (el) => el.child(languagePrompt(view, t)))
    .child(addField(view, t))
    .children(messages(view, t));
  const rows = symbols.map((symbol, index) => sidebarRow(view, t, symbol, index, symbols, now));
  return root.child(header).child(field).children(filterBar(view, t)).child(list(view, t, rows).pt(8)).child(footer(view, t));
}

// Symbol, then its name on a line of its own, then freshness on the left; the line, then the price
// over the change, at a fixed width on the right, so a wider pane gives its room to the left lines.
// A row without a name of its own (a pair, a name that repeats the ticker) keeps two lines.
function sidebarRow(view, t, symbol, index, symbols, now) {
  const row = rowData(view, t, symbol, now);
  const shown = row.quote ? rowName(symbol, row.label, row.name) : { label: "", name: "" };
  const meta = [shown.label, row.date].filter(Boolean).join(" · ");
  const body = v_flex().py(8).gap(2)
    .child(h_flex().gap(12).items_center()
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_semibold().truncate().child(symbol))
        .when(Boolean(shown.name), (el) => el.child(div().text_size(11).text_color(t.muted).truncate().child(shown.name)))
        .when(Boolean(meta), (el) => el.child(h_flex().gap(6).items_center()
          .when(Boolean(row.dot), (line) => line.child(row.dot))
          .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(meta)))))
      .child(row.quote ? chart(row.quote, row.color, t, SPARK) : div().flex_none().w(SPARK.width).h(SPARK.height))
      .child(priceStack(view, t, row)))
    .children(rowNotes(view, t, row));
  return rowFrame(view, t, symbol, index, symbols, body, Boolean(row.quote));
}

// A table cell at its column's width.
function tableCell(id, nameW) {
  return div().flex_none().w(id === "name" ? nameW : columnWidth(id));
}

// From TABLE_MIN_WIDTH: one header line, column labels that stay while the rows scroll, 36 px rows. At most
// TABLE_MAX_WIDTH wide, centered; columns drop by DROP_ORDER when the width cannot hold them.
export function table(view, root, t) {
  const symbols = shownSymbols(view);
  const now = Date.now();
  const width = Math.min(view.size.width, TABLE_MAX_WIDTH);
  const columns = tableColumns(width);
  const nameW = nameWidth(width, columns);
  const notes = [
    ...(view.settings.languagePromptDismissed ? [] : [languagePrompt(view, t)]),
    ...messages(view, t),
    ...problemLines(view, t),
  ];
  const header = h_flex().flex_none().px(GUTTER).pt(10).gap(12).items_center()
    .child(brand(view, t))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${countText(view)} · ${statusText(view)}`))
    .child(div().flex_none().w(320).child(addField(view, t)))
    .child(headerIcons(view, t));
  const rows = symbols.map((symbol, index) => tableRow(view, t, symbol, index, symbols, columns, nameW, now));
  const frame = v_flex().w(width).flex_1().min_h(0)
    .child(header)
    .when(notes.length > 0, (el) => el.child(v_flex().flex_none().px(GUTTER).pt(8).gap(4).children(notes)))
    .children(filterBar(view, t))
    .child(tableHead(view, t, columns, nameW))
    .child(list(view, t, rows))
    .child(footer(view, t));
  return root.items_center().child(frame);
}

function tableHead(view, t, columns, nameW) {
  const labels = {
    symbol: "table.symbol", name: "table.name", state: "table.state", line: "table.line", price: "table.price",
    change: "table.change", changePct: "table.changePct", high: "detail.high", low: "detail.low", prevClose: "detail.prevClose",
  };
  return div().flex_none().px(GUTTER).pt(12)
    .child(h_flex().h(28).items_center().gap(COLUMN_GAP).border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .children(columns.map((id) => {
        const right = TABLE_COLUMNS.find((column) => column.id === id).align === "right";
        // Over the number, not the currency slot; over the state's text, past its dot.
        return tableCell(id, nameW).truncate().when(right, (el) => el.text_right())
          .when(id === "price", (el) => el.pr(CODE_W)).when(id === "state", (el) => el.pl(12))
          .child(view.tx(labels[id]));
      })));
}

function tableRow(view, t, symbol, index, symbols, columns, nameW, now) {
  const row = rowData(view, t, symbol, now);
  const { quote, color } = row;
  // As the sidebar's line: a name that begins with the label (a pair's "Binance Spot") replaces it.
  const shown = rowName(symbol, row.label, row.name);
  const state = [shown.label, row.date].filter(Boolean).join(" · ");
  const cell = (id) => tableCell(id, nameW);
  const figure = (id, value) => cell(id).text_right().whitespace_nowrap().text_color(t.muted).child(quote ? number(quote, value) : "");
  const cells = {
    symbol: () => cell("symbol").font_semibold().truncate().child(symbol),
    name: () => cell("name").text_color(t.muted).truncate().child(shown.name),
    state: () => h_flex().flex_none().w(columnWidth("state")).gap(6).items_center()
      .child(div().flex_none().w(6).h(6).when(Boolean(row.dot), (el) => el.child(row.dot)))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(state)),
    line: () => (quote ? chart(quote, color, t, TABLE_SPARK) : cell("line")),
    price: () => (quote
      ? h_flex().flex_none().w(columnWidth("price")).items_baseline()
        .child(div().flex_1().min_w(0).text_right().whitespace_nowrap().text_color(row.failed ? t.dim : t.foreground).child(number(quote)))
        .child(div().flex_none().w(CODE_W).pl(4).text_size(11).text_color(t.dim).child(quote.currency ?? ""))
      : cell("price").pr(CODE_W).text_right().text_size(11).text_color(t.dim).child(waiting(view, row))),
    change: () => cell("change").text_right().whitespace_nowrap().text_color(color).child(quote ? signed(quote) : ""),
    changePct: () => cell("changePct").text_right().whitespace_nowrap().text_color(color).child(quote ? formatChange(quote.changePercent) : ""),
    high: () => figure("high", quote?.high),
    low: () => figure("low", quote?.low),
    // A pair's reference is the price 24 hours back, not a close: left out here, as in the detail.
    prevClose: () => figure("prevClose", quote && !isCryptoPair(symbol) ? quote.previousClose : null),
  };
  const notes = rowNotes(view, t, row);
  const body = v_flex()
    .child(h_flex().h(36).items_center().gap(COLUMN_GAP).children(columns.map((id) => cells[id]())))
    .when(notes.length > 0, (el) => el.child(v_flex().pb(8).gap(2).children(notes)));
  return rowFrame(view, t, symbol, index, symbols, body, Boolean(quote));
}

// The rows a copy draws: the chosen market's, or all of them.
function shownSymbols(view) {
  const { symbols } = view.watch.preferences;
  return visibleSymbols(symbols, chosenFilter(symbols, view.filter));
}

// One row of market filters above the list (a list of one element, as `messages`), or none while the list is short or of one market. The chosen
// one sits on a pill that slides to a new choice: an absolute div whose `left` is the widths of the labels
// before it plus the gaps, and whose `width` is the chosen label's, both measured from the labels
// themselves (on_size_change), so the pill follows any language or count. The scrolling area holds the
// labels in a content box of their own, so the pill scrolls with them; it scrolls sideways, by wheel too,
// when the labels do not fit. Until every label it needs has been measured there is no pill.
function filterBar(view, t) {
  const filters = marketFilters(view.watch.preferences.symbols);
  if (!filters.length) return [];
  const chosen = chosenFilter(view.watch.preferences.symbols, view.filter);
  const index = filters.findIndex(({ id }) => id === chosen);
  const widths = view.filterWidths;
  const measured = filters.slice(0, index + 1).every(({ id }) => widths[id] > 0);
  const left = filters.slice(0, index).reduce((sum, { id }) => sum + (widths[id] ?? 0) + FILTER_GAP, 0);
  const label = ({ id, count }) => h_flex().id(`bw-filter-${id}`).flex_none().h(FILTER_H).px(10).gap(5).items_center()
    .whitespace_nowrap().text_size(11).cursor_pointer()
    .on_size_change((size, cx) => {
      if (widths[id] === size.width) return;
      widths[id] = size.width;
      cx.notify();
    })
    .on_click((_e, cx) => { view.setFilter(id); cx.notify(); })
    .child(div().text_color(id === chosen ? t.foreground : t.muted).child(view.tx(id === "all" ? "filter.all" : `market.${id}`)))
    .child(div().text_color(t.dim).child(String(count)));
  return [div().flex_none().px(GUTTER).pt(10)
    .child(h_flex().id("bw-filters").w_full().min_w(0).h(FILTER_H).overflow_x_scrollbar()
      .child(div().relative().flex().flex_none().gap(FILTER_GAP)
        .when(measured, (el) => el.child(div().id("bw-filter-pill").absolute().top(0).left(left).w(widths[chosen]).h(FILTER_H)
          .rounded(FILTER_H / 2).bg(t.selected)
          .transition("left", FILTER_SLIDE).transition("width", FILTER_SLIDE)))
        .children(filters.map(label))))];
}

// The drag would put the row where it already is: in front of itself or of the row after it, among the rows shown.
function dropsInPlace(view) {
  const symbols = shownSymbols(view);
  const { symbol, before } = view.drag;
  return before === symbol || before === (symbols[symbols.indexOf(symbol) + 1] ?? null);
}

function dropBar(t) {
  return div().absolute().left(GUTTER).right(GUTTER).h(2).bg(t.accent);
}
