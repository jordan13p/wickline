// The panel: the band (a short docked strip), the sidebar and the table, with the list that scrolls their rows
// and takes a dragged row's drop, the market filters and the footer; the header's pieces are in header.js, the
// rows in rows.js. Everything that talks to Herdr (storage, requests, commands, panes) stays on the view in
// main.js; these functions draw from it and call back into it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { bandCurrency, formatChange, number } from "../format.js";
import { bandState } from "../freshness.js";
import { GUTTER, REMOVE_W, SCROLL_LANE, TABLE_MAX_WIDTH, nameWidth, tableColumns } from "../layout.js";
import { button, dot, inset, priceBox, priceInk } from "./parts.js";
import {
  addField,
  brand,
  countText,
  headerIcons,
  languagePrompt,
  messages,
  problemLines,
  statusText,
} from "./header.js";
import { drawRows, dropsInPlace, sidebarRow, tableHead, tableRow } from "./rows.js";

const ICON = "mods/wickline/icon.svg";
// The filter row: 24 px labels with 2 px between them; the chosen one sits on a pill of the same height.
const FILTER_H = 24;
const FILTER_GAP = 2;
const FILTER_SLIDE = { duration: 180, easing: "ease-out" };
// Below this panel width the footer shows the short disclaimer.
const SHORT_FOOTER_WIDTH = 480;

// One line: Wickline, then as many quotes as fit.
export function band(view, root, t) {
  const w = view.watch;
  const symbols = w.preferences.symbols;
  const now = Date.now();
  return root
    .px(12)
    .gap(14)
    .items_center()
    .overflow_hidden()
    .child(
      h_flex()
        .flex_none()
        .gap(6)
        .items_center()
        .child(svg(ICON).w(14).h(14).text_color(t.foreground))
        .child(div().text_color(t.foreground).font_semibold().child("Wickline")),
    )
    .when(w.preferences.paused, (el) => el.child(div().flex_none().text_color(t.blocked).child(view.tx("band.paused"))))
    .when(!symbols.length, (el) => el.child(div().text_color(t.dim).truncate().child(view.tx("band.empty"))))
    .children(
      symbols.map((symbol) => {
        const quote = w.shown(symbol, now);
        const code = quote && bandCurrency(quote);
        const mark = quote && dot(t, bandState(quote, now));
        return (
          h_flex()
            .flex_none()
            .gap(5)
            .items_center()
            .whitespace_nowrap()
            .child(div().font_semibold().child(symbol))
            .when(Boolean(mark), (el) => el.child(mark))
            .child(
              quote
                ? priceBox(
                    `bw-band-price-${symbol}`,
                    number(quote),
                    priceInk(t, quote),
                    view.limitMark(t, quote, now),
                    { pad: 3 },
                  )
                : div()
                    .text_color(t.dim)
                    .child(w.errors[symbol] ? view.tx("band.unavailable") : "…"),
            )
            // Its own `dim` text, 2px further out than the gap, so a lit price's 3px block keeps 4px clear of it.
            .when(Boolean(code), (el) => el.child(div().ml(2).text_color(t.dim).child(code)))
            .when(Boolean(quote), (el) =>
              el.child(
                div().text_color(view.changeColor(t, quote.changePercent)).child(formatChange(quote.changePercent)),
              ),
            )
            .when(Boolean(quote?.cached), (el) => el.child(div().text_color(t.dim).child(view.tx("band.cached"))))
        );
      }),
    );
}

// A docked block whose own tab is open: one line and the way back, no quotes. The band has one line of
// height, so it gets one row.
export function yieldView(view, root, t, inBand) {
  const notice = div().text_color(t.dim).child(view.tx("dock.openInTab"));
  const back = button(t, "bw-yield-back", view.tx("button.backToPanel"), (cx) => view.backFromYield(cx));
  if (inBand)
    return root.px(12).gap(14).items_center().overflow_hidden().child(notice.flex_1().min_w(0).truncate()).child(back);
  return root.child(
    v_flex()
      .flex_none()
      .map(inset)
      .py(10)
      .gap(10)
      .items_start()
      .child(brand(t))
      .child(notice.text_size(11))
      .child(back),
  );
}

// The scrolling rows, which end at their × column, and the scrollbar in the lane beside it: the lane is padding
// of the list, so no row fill (hover, a dragged row) reaches under the bar. No pointer capture: a release outside
// the list never arrives, so leaving it cancels a drag. A list with a gap above it (the sidebar) keeps the gap and
// a hairline outside the scroll, so a row scrolled up is cut at the hairline instead of touching the region above.
function list(view, t, rows, top = 0) {
  const scrolling = v_flex()
    .id("bw-list")
    .flex_1()
    .min_h(0)
    .pr(SCROLL_LANE)
    .overflow_y_scroll()
    .on_hover((hovered, cx) => {
      if (hovered || !view.drag) return;
      view.drag = null;
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => {
      const drag = view.drag;
      if (!drag) return;
      const inPlace = dropsInPlace(drag, view.filterState().shown);
      view.drag = null;
      // A drop where the row already is changes nothing, and leaves the current notice be.
      if (inPlace) cx.notify();
      else view.dropRow(cx, drag);
    })
    .when(!rows.length, (el) =>
      el.child(div().pl(GUTTER).pr(REMOVE_W).py(8).text_color(t.dim).child(view.tx("list.empty"))),
    )
    .children(rows);
  return v_flex()
    .flex_1()
    .min_h(0)
    .pt(top)
    .when(top > 0, (el) => el.child(div().flex_none().map(inset).child(div().border_t(1).border_color(t.border))))
    .child(
      v_flex()
        .relative()
        .flex_1()
        .min_h(0)
        .child(scrolling)
        .child(Scrollbar.vertical("bw-list").absolute().top(0).bottom(0).right(0).w(SCROLL_LANE)),
    );
}

// One line: the disclaimer, which opens the settings' disclaimer tab.
function footer(view, t) {
  const short = view.size && view.size.width < SHORT_FOOTER_WIDTH;
  return div()
    .flex_none()
    .map(inset)
    .child(
      div()
        .id("bw-disclaimer")
        .py(10)
        .border_t(1)
        .border_color(t.border)
        .text_size(11)
        .text_color(t.dim)
        .truncate()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => view.openSettings("disclaimer"))
        .child(view.tx(short ? "footer.short" : "footer.long")),
    );
}

// Below TABLE_MIN_WIDTH: the header, the status line, the add field, the rows (see rows.js sidebarRow), the footer.
export function sidebar(view, root, t) {
  const filter = view.filterState();
  const now = Date.now();
  const header = v_flex()
    .flex_none()
    .map(inset)
    .pt(10)
    .gap(2)
    .child(
      h_flex()
        .h(28)
        .items_center()
        .gap(8)
        .child(brand(t))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(countText(view)))
        .child(headerIcons(view, t)),
    )
    .child(div().truncate().text_size(11).text_color(t.dim).child(statusText(view, now)))
    .children(problemLines(view, t));
  const field = v_flex()
    .flex_none()
    .map(inset)
    .pt(12)
    .gap(6)
    .when(!view.settings.languagePromptDismissed, (el) => el.child(languagePrompt(view, t)))
    .child(addField(view, t))
    .children(messages(view, t));
  const rows = drawRows(view, filter, (symbol, place, ghost) => sidebarRow(view, t, symbol, place, now, ghost));
  return root
    .child(header)
    .child(field)
    .children(filterBar(view, t, filter))
    .child(list(view, t, rows, 8))
    .child(footer(view, t));
}

// From TABLE_MIN_WIDTH: one header line, column labels that stay while the rows scroll, 36 px rows. At most
// TABLE_MAX_WIDTH wide, centered; columns drop by DROP_ORDER when the width cannot hold them.
export function table(view, root, t) {
  const filter = view.filterState();
  const now = Date.now();
  const width = Math.min(view.size.width, TABLE_MAX_WIDTH);
  const columns = tableColumns(width);
  const nameW = nameWidth(width, columns);
  const notes = [
    ...(view.settings.languagePromptDismissed ? [] : [languagePrompt(view, t)]),
    ...messages(view, t),
    ...problemLines(view, t),
  ];
  const header = h_flex()
    .flex_none()
    .map(inset)
    .pt(10)
    .gap(12)
    .items_center()
    .child(brand(t))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(11)
        .text_color(t.dim)
        .child(`${countText(view)} · ${statusText(view, now)}`),
    )
    .child(div().flex_none().w(320).child(addField(view, t)))
    .child(headerIcons(view, t));
  const rows = drawRows(view, filter, (symbol, place, ghost) =>
    tableRow(view, t, symbol, place, columns, nameW, now, ghost),
  );
  const frame = v_flex()
    .w(width)
    .flex_1()
    .min_h(0)
    .child(header)
    .when(notes.length > 0, (el) => el.child(v_flex().flex_none().map(inset).pt(8).gap(4).children(notes)))
    .children(filterBar(view, t, filter))
    .child(tableHead(view, t, columns, nameW))
    .child(list(view, t, rows))
    .child(footer(view, t));
  return root.items_center().child(frame);
}

// One row of market filters above the list (a list of one element, as header.js `messages`), or none while the list is short or of one market. The chosen
// one sits on a pill that slides to a new choice: an absolute div whose `left` is the widths of the labels
// before it plus the gaps, and whose `width` is the chosen label's, both measured from the labels
// themselves (on_size_change), so the pill follows any language or count. The scrolling area holds the
// labels in a content box of their own, so the pill scrolls with them; it scrolls sideways (natively: a
// horizontal wheel or a trackpad swipe) when the labels do not fit. Until every label it needs has been
// measured there is no pill. `filter`: the view's filterState().
function filterBar(view, t, { filters, chosen }) {
  if (!filters.length) return [];
  const index = filters.findIndex(({ id }) => id === chosen);
  const widths = view.filterWidths;
  const measured = filters.slice(0, index + 1).every(({ id }) => widths[id] > 0);
  const left = filters.slice(0, index).reduce((sum, { id }) => sum + (widths[id] ?? 0) + FILTER_GAP, 0);
  const label = ({ id, count }) =>
    h_flex()
      .id(`bw-filter-${id}`)
      .flex_none()
      .h(FILTER_H)
      .px(10)
      .gap(5)
      .items_center()
      .whitespace_nowrap()
      .text_size(11)
      .cursor_pointer()
      .on_size_change((size, cx) => {
        if (widths[id] === size.width) return;
        widths[id] = size.width;
        cx.notify();
      })
      .on_click((_e, cx) => {
        view.setFilter(id);
        cx.notify();
      })
      .child(
        div()
          .text_color(id === chosen ? t.foreground : t.muted)
          .child(view.tx(id === "all" ? "filter.all" : `market.${id}`)),
      )
      .child(div().text_color(t.dim).child(String(count)));
  return [
    div()
      .flex_none()
      .map(inset)
      .pt(10)
      .child(
        h_flex()
          .id("bw-filters")
          .w_full()
          .min_w(0)
          .h(FILTER_H)
          .overflow_x_scrollbar()
          .child(
            div()
              .relative()
              .flex()
              .flex_none()
              .gap(FILTER_GAP)
              .when(measured, (el) =>
                el.child(
                  div()
                    .id("bw-filter-pill")
                    .absolute()
                    .top(0)
                    .left(left)
                    .w(widths[chosen])
                    .h(FILTER_H)
                    .rounded(FILTER_H / 2)
                    .bg(t.selected)
                    .transition("left", FILTER_SLIDE)
                    .transition("width", FILTER_SLIDE),
                ),
              )
              .children(filters.map(label)),
          ),
      ),
  ];
}
