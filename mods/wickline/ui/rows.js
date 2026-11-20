// The panel's rows, whichever layout draws them: a sidebar row and a table row, the table's column labels, the frame
// that holds a row's drag handle and ×, and a removed row's fading copy. Drawn from the view; every Herdr call goes
// back through it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { isCryptoPair } from "../quotes.js";
import { collapsedRow, displayName, formatChange, freshnessLabel, number, rowName, signed } from "../format.js";
import { freshness, rowDate, sessionOf } from "../freshness.js";
import { nextOf } from "../filter.js";
import { ROW_MOTION_MS, rowsWithGhosts } from "../motion.js";
import { finnhubCap } from "../providers/finnhub.js";
import { CODE_W, COLUMN_GAP, GUTTER, NUMBER_W, REMOVE_W, TABLE_COLUMNS, columnWidth, sparkWidth } from "../layout.js";
import { blockedNote, chart, dot, failureText, icon, inset, priceBox, priceInk } from "./parts.js";

// The day line spans a sidebar row's three lines (16, 14 and 14 px, 2 px apart); see sidebarRow.
const LINES_H = 48;
const TABLE_SPARK = { width: columnWidth("line"), height: 28 };
// A row fading in, fading out and collapsing, or sliding into its dropped place.
const ROW_MOTION = { duration: ROW_MOTION_MS, easing: "ease-out" };

// What a row shows, whichever layout draws it: `name` as rowName leaves it, and `state`, the freshness label, then an
// earlier day's date.
function rowData(view, t, now, symbol, source) {
  const { quote } = source;
  const fresh = quote && freshness(quote, sessionOf(quote, now), now);
  const stale = quote ? rowDate(quote, fresh, now, view.lang) : "";
  const label = quote ? freshnessLabel(quote, fresh, now, view.lang, (key, params) => view.tx(key, params)) : "";
  const shown = rowName(symbol, label, quote ? displayName(quote, view.lang) : null);
  return {
    ...source,
    name: shown.name,
    state: [shown.label, stale ? view.tx("quote.asOf", { date: stale }) : ""].filter(Boolean).join(" · "),
    dot: quote && dot(t, fresh.state),
    color: quote ? view.changeColor(t, quote.changePercent) : t.dim,
    // The price as both layouts draw it: lit at its limit (see limitMark), `dim` when cached.
    price: quote && priceBox(`bw-price-${symbol}`, number(quote), priceInk(t, quote), view.limitMark(t, quote, now)),
  };
}

// A price's currency in its own slot, 8px after the digits: 4px clear of a lit price's block.
const currencySlot = (t, quote) =>
  div()
    .flex_none()
    .w(CODE_W)
    .pl(8)
    .text_size(11)
    .text_color(t.dim)
    .child(quote.currency ?? "");

// Under a row: a failure's reason (with what is cached, if anything), a real-time source's fallback, Finnhub's budget.
function rowNotes(view, t, { quote, failed, fallback, overCap }) {
  const say = (reason) => view.say(reason);
  const note = quote ? failureText(quote, failed, say, (key, params) => view.tx(key, params)) : failed && say(failed);
  return [
    note && blockedNote(t, note),
    fallback && blockedNote(t, quote ? view.fallbackText(quote, fallback) : view.say(fallback)),
    overCap &&
      div()
        .text_size(11)
        .text_color(t.dim)
        .child(view.tx("finnhub.overCap", { cap: finnhubCap(view.settings.sources.us.budgetPerMinute) })),
  ].filter(Boolean);
}

// Before the first quote: why there is none yet.
function waiting(view, row) {
  return view.tx(row.failed ? "row.unavailable" : view.watch.preferences.paused ? "row.notFetched" : "row.waiting");
}

// That text in a box the caller sizes, right-aligned to end where a price's digits end, a currency slot in from the
// edge.
const waitingCell = (view, t, row, box) =>
  box.pr(CODE_W).text_right().text_size(11).text_color(t.dim).child(waiting(view, row));

// One line of the sidebar grid. Its line height is its own height in px (a bare number is a multiplier), so the
// glyphs and their descenders fit, and equal boxes put the left and right lines on one baseline. It is drawn even
// when empty, so a row keeps its three lines.
const lineBox = (height, el = div()) => el.flex_none().h(height).line_height(`${height}px`);

// The price with its currency in its own slot, then the change and the change %, right-aligned on the price's last
// digit. None of them truncates: a long one grows to the left.
function priceStack(view, t, row) {
  const { quote, color } = row;
  const column = v_flex()
    .flex_none()
    .w(NUMBER_W + CODE_W)
    .gap(2);
  if (!quote) {
    return column
      .child(waitingCell(view, t, row, lineBox(16, div().whitespace_nowrap())))
      .child(lineBox(14))
      .child(lineBox(14));
  }
  const figure = (text) =>
    lineBox(14).w(NUMBER_W).text_right().whitespace_nowrap().text_size(11).text_color(color).child(text);
  return column
    .child(
      lineBox(16, h_flex().items_baseline())
        .child(h_flex().flex_none().w(NUMBER_W).justify_end().child(row.price))
        .child(currencySlot(t, quote)),
    )
    .child(figure(signed(quote)))
    .child(figure(formatChange(quote.changePercent)));
}

// A row: the drag handle in the left gutter and × in its column at the right, both only under the pointer, and the
// body between them, which opens the detail. Hairlines between rows span the body only. A row this copy just added
// fades in; a row just dropped starts where it was and slides to its place (see main.js `playRow`).
function rowFrame(view, t, symbol, place, body, clickable) {
  const { next, moving } = place;
  const dragged = view.drag?.symbol === symbol;
  const controls = dragged || (!view.drag && view.hovered === symbol);
  const arrival = view.added.get(symbol);
  const settling = view.settle?.symbol === symbol;
  return (
    h_flex()
      .id(`bw-line-${symbol}`)
      .relative()
      .items_stretch()
      // Measured for a removed row's collapse and a dropped row's slide; no redraw is needed for it.
      .on_size_change((size) => {
        view.rowHeights[symbol] = size.height;
      })
      .when(arrival !== undefined, (el) => el.opacity(arrival === "new" ? 0 : 1).transition("opacity", ROW_MOTION))
      .when(settling, (el) => el.top(view.settle.from).transition("top", ROW_MOTION))
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
      .when(dragged, (el) =>
        el.child(div().absolute().top(0).left(0).right(0).bottom(0).border_1().border_color(t.border)),
      )
      // The handle fills its gutter for the row's whole height, so it is easy to grab; the slot stays when hidden.
      .child(
        div()
          .id(`bw-handle-${symbol}`)
          .flex_none()
          .w(GUTTER)
          .flex()
          .items_center()
          .justify_center()
          .text_color(t.dim)
          .when(controls, (el) =>
            el
              .hover((s) => s.text_color(t.foreground))
              .when(dragged, (h) => h.text_color(t.foreground).cursor_grabbing())
              .when(!dragged, (h) => h.cursor_grab())
              .on_mouse_down("left", (_e, cx) => {
                cx.stop_propagation();
                view.drag = { symbol, before: symbol };
                cx.notify();
              })
              .child(svg(icon("grip")).w(14).h(14)),
          ),
      )
      .child(
        body
          .id(`bw-row-${symbol}`)
          .flex_1()
          .min_w(0)
          .when(next !== null, (el) => el.border_b(1).border_color(t.border))
          .when(clickable, (el) => el.cursor_pointer())
          .on_click(() => view.openDetail(symbol)),
      )
      // × sits beside the body, not inside it.
      .child(
        div()
          .id(`bw-remove-${symbol}`)
          .flex_none()
          .w(REMOVE_W)
          .flex()
          .items_center()
          .justify_center()
          .text_color(t.dim)
          .when(controls && !dragged, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.text_color(t.foreground))
              .tooltip(view.tx("button.remove"))
              .on_click((_e, cx) => view.removeSymbol(cx, symbol))
              .child(svg(icon("close")).w(12).h(12)),
          ),
      )
  );
}

// A removed row while it fades out and collapses: its copy at its last height, then at none. It takes no clicks and
// no drag, and has an id of its own so it shares no state with a row of the same symbol.
function ghostFrame(t, ghost, body) {
  return v_flex()
    .id(`bw-ghost-${ghost.symbol}`)
    .overflow_hidden()
    .h(ghost.gone ? 0 : ghost.height)
    .opacity(ghost.gone ? 0 : 1)
    .transition("height", ROW_MOTION)
    .transition("opacity", ROW_MOTION)
    .child(
      h_flex()
        .flex_none()
        .h(ghost.height)
        .items_stretch()
        .child(div().flex_none().w(GUTTER))
        .child(body.flex_1().min_w(0).border_b(1).border_color(t.border))
        .child(div().flex_none().w(REMOVE_W)),
    );
}

/**
 * The rows to draw, each removed row (a ghost) where it was. A live row is drawn with its `place`,
 * `{ next, moving }`: the row after it among those shown (null for the last), and whether the drag under way would
 * move a row.
 */
export function drawRows(view, filter, draw) {
  const { shown } = filter;
  const moving = Boolean(view.drag) && !dropsInPlace(view.drag, shown);
  let at = 0;
  return rowsWithGhosts(view.watch.preferences.symbols, filter, view.leaving, view.marketFor).map(
    ({ symbol, ghost }) =>
      ghost ? draw(symbol, null, ghost) : draw(symbol, { next: shown[++at] ?? null, moving }, null),
  );
}

/**
 * A sidebar row: a three-line grid, with notes under it.
 * - Left: symbol, name and freshness. A row without a name of its own keeps line 2 empty.
 * - Middle: the day line, spanning all three lines.
 * - Right: the price, the change and the change % at a fixed width, so a wider pane gives its room to the left lines
 *   and then to the day line.
 * A collapsed row (no price, its fetch failed) is one line, the ticker and its state, with the reason under it.
 */
export function sidebarRow(view, t, symbol, place, now, ghost) {
  const row = rowData(view, t, now, symbol, ghost ? ghost.row : view.rowSource(symbol, now));
  const grid = () => {
    const lineW = sparkWidth(view.size?.width);
    return h_flex()
      .gap(COLUMN_GAP)
      .items_start()
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(lineBox(16).child(div().font_semibold().truncate().child(symbol)))
          .child(lineBox(14).child(div().text_size(11).text_color(t.muted).truncate().child(row.name)))
          .child(
            lineBox(14, h_flex().gap(6).items_center())
              .when(Boolean(row.dot), (line) => line.child(row.dot))
              .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(row.state)),
          ),
      )
      .child(
        row.quote
          ? chart(row.quote, row.color, t, { width: lineW, height: LINES_H, fill: true, stroke: 1.5 })
          : div().flex_none().w(lineW).h(LINES_H),
      )
      .child(priceStack(view, t, row));
  };
  const body = v_flex()
    .py(8)
    .gap(2)
    .child(
      collapsedRow(row)
        ? lineBox(16, h_flex().gap(COLUMN_GAP))
            .child(div().flex_1().min_w(0).font_semibold().truncate().child(symbol))
            .child(
              waitingCell(
                view,
                t,
                row,
                div()
                  .flex_none()
                  .w(NUMBER_W + CODE_W)
                  .whitespace_nowrap(),
              ),
            )
        : grid(),
    )
    .children(rowNotes(view, t, row));
  return ghost ? ghostFrame(t, ghost, body) : rowFrame(view, t, symbol, place, body, Boolean(row.quote));
}

// A table cell at its column's width.
function tableCell(id, nameW) {
  return div()
    .flex_none()
    .w(id === "name" ? nameW : columnWidth(id));
}

/** The table's column labels, which stay while the rows scroll. */
export function tableHead(view, t, columns, nameW) {
  const labels = {
    symbol: "table.symbol",
    name: "table.name",
    state: "table.state",
    line: "table.line",
    price: "table.price",
    change: "table.change",
    changePct: "table.changePct",
    high: "detail.high",
    low: "detail.low",
    prevClose: "detail.prevClose",
  };
  return div()
    .flex_none()
    .map(inset)
    .pt(12)
    .child(
      h_flex()
        .h(28)
        .items_center()
        .gap(COLUMN_GAP)
        .border_b(1)
        .border_color(t.border)
        .text_size(11)
        .text_color(t.dim)
        .children(
          columns.map((id) => {
            const right = TABLE_COLUMNS.find((column) => column.id === id).align === "right";
            // Over the number, not the currency slot; over the state's text, past its dot.
            return tableCell(id, nameW)
              .truncate()
              .when(right, (el) => el.text_right())
              .when(id === "price", (el) => el.pr(CODE_W))
              .when(id === "state", (el) => el.pl(12))
              .child(view.tx(labels[id]));
          }),
        ),
    );
}

/** A table row: one cell per column that fits. */
export function tableRow(view, t, symbol, place, columns, nameW, now, ghost) {
  const row = rowData(view, t, now, symbol, ghost ? ghost.row : view.rowSource(symbol, now));
  const { quote, color } = row;
  const cell = (id) => tableCell(id, nameW);
  const figure = (id, value) =>
    cell(id)
      .text_right()
      .whitespace_nowrap()
      .text_color(t.muted)
      .child(quote ? number(quote, value) : "");
  const cells = {
    symbol: () => cell("symbol").font_semibold().truncate().child(symbol),
    name: () => cell("name").text_color(t.muted).truncate().child(row.name),
    state: () =>
      h_flex()
        .flex_none()
        .w(columnWidth("state"))
        .gap(6)
        .items_center()
        .child(
          div()
            .flex_none()
            .w(6)
            .h(6)
            .when(Boolean(row.dot), (el) => el.child(row.dot)),
        )
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(row.state)),
    line: () => (quote ? chart(quote, color, t, { ...TABLE_SPARK, fill: true, stroke: 1.5 }) : cell("line")),
    price: () =>
      quote
        ? h_flex()
            .flex_none()
            .w(columnWidth("price"))
            .items_baseline()
            .child(h_flex().flex_1().min_w(0).justify_end().child(row.price))
            .child(currencySlot(t, quote))
        : waitingCell(view, t, row, cell("price")),
    change: () =>
      cell("change")
        .text_right()
        .whitespace_nowrap()
        .text_color(color)
        .child(quote ? signed(quote) : ""),
    changePct: () =>
      cell("changePct")
        .text_right()
        .whitespace_nowrap()
        .text_color(color)
        .child(quote ? formatChange(quote.changePercent) : ""),
    high: () => figure("high", quote?.high),
    low: () => figure("low", quote?.low),
    // A pair's reference is the price 24 hours back, not a close: left out here, as in the detail.
    prevClose: () => figure("prevClose", quote && !isCryptoPair(symbol) ? quote.previousClose : null),
  };
  const notes = rowNotes(view, t, row);
  const body = v_flex()
    .child(
      h_flex()
        .h(36)
        .items_center()
        .gap(COLUMN_GAP)
        .children(columns.map((id) => cells[id]())),
    )
    .when(notes.length > 0, (el) => el.child(v_flex().pb(8).gap(2).children(notes)));
  return ghost ? ghostFrame(t, ghost, body) : rowFrame(view, t, symbol, place, body, Boolean(quote));
}

/** Whether `drag` would put the row where it already is: in front of itself or of the row after it, among `shown`. */
export function dropsInPlace(drag, shown) {
  const { symbol, before } = drag;
  return before === symbol || before === nextOf(shown, symbol);
}

function dropBar(t) {
  return div().absolute().left(GUTTER).right(REMOVE_W).h(2).bg(t.accent);
}
