// Stateless drawing helpers shared by the panel and the dialogs: each takes the theme and what it
// draws, and returns an element, except failureText, which returns the failure note's words. No Herdr calls, no state.
import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Checkbox, Switch } from "gpui-base";
import { chartGeometry, failureNote } from "../format.js";
import { chartLayout } from "../freshness.js";
import { SPIN_MS } from "../motion.js";

// The soft fill under a line chart.
const AREA_OPACITY = 0.16;

// Freshness states drawn with a hollow dot: the price may not be current.
const HOLLOW = ["unconfirmed", "stalled", "delayed"];
export const icon = (name) => `mods/wickline/icons/${name}.svg`;

// What `quote`'s chart draws (format.js chartGeometry, laid out by chartLayout), or null when its box holds nothing.
export const chartShape = (quote) => chartGeometry(quote.series, quote.previousClose, chartLayout(quote));

// The day's line, scaled to its box and reaching only as far as its trading day has run (chartLayout); the previous
// close is a dashed rule, drawn with any number of points; a price past its line is a filled dot in `color`, `dot` px
// (4 in rows and the table, 6 in the detail), never joined to the line and no state dot. `stroke` defaults to 2 px with
// the area and 1.25 px without. `crosshair` (only the detail passes it) follows the pointer: the box takes its `id`,
// hands `move` the pointer's x as a share of its width (0…1) with that width, and calls `leave` when the pointer goes;
// its `mark`, when set, draws a 1 px `dim` vertical line and a 6 px dot at a line point and a label on a `background`
// plate at the top, placed by `spot` ({ left } or { right }, px).
export function chart(quote, color, t, { width, height, fill, stroke = fill ? 2 : 1.25, dot = 4, crosshair }) {
  const box = div().relative().flex_none().h(height);
  const sized = width === "full" ? box.w_full() : box.w(width);
  const g = chartShape(quote);
  if (!g) return sized;
  const layer = (path, paint) => window.paint_path(path, paint).absolute().top(0).left(0).size_full();
  const lined = g.points.length > 1;
  let line = PathBuilder.stroke(stroke);
  g.points.forEach(([x, y], i) => { line = i ? line.line_to(`${x}%`, `${y}%`) : line.move_to(`${x}%`, `${y}%`); });
  const end = lined ? g.points[g.points.length - 1][0] : 0;
  const half = dot / 2;
  const mark = crosshair?.mark ?? null;
  return sized
    .when(Boolean(crosshair), (el) => el.id(crosshair.id)
      .on_mouse_move((event, cx) => {
        if (!event.bounds || event.bounds.width <= 0) return;
        crosshair.move(Math.min(1, Math.max(0, event.local_position.x / event.bounds.width)), event.bounds.width, cx);
      })
      .on_hover((hovered, cx) => { if (!hovered) crosshair.leave(cx); }))
    .when(g.reference !== null, (el) => el.child(layer(
      PathBuilder.stroke(1).dash_array([3, 3]).move_to("0%", `${g.reference}%`).line_to("100%", `${g.reference}%`).build(),
      t.border)))
    .when(lined && Boolean(fill), (el) => {
      let area = PathBuilder.fill().move_to("0%", "100%");
      for (const [x, y] of g.points) area = area.line_to(`${x}%`, `${y}%`);
      return el.child(layer(area.line_to(`${end}%`, "100%").close().build(),
        Background.solid(color).opacity(AREA_OPACITY)));
    })
    .when(lined, (el) => el.child(layer(line.build(), color)))
    // Inset by half the dot across, so a dot at either end stays whole inside the box.
    .when(g.dot !== null, (el) => el.child(div().absolute().top(0).bottom(0).left(half).right(half)
      .child(div().absolute().left(`${g.dot[0]}%`).top(`${g.dot[1]}%`).ml(-half).mt(-half).w(dot).h(dot).rounded_full()
        .bg(color))))
    .when(Boolean(mark), (el) => el.children(crosshairLayers(t, mark)));
}

// The crosshair's three layers over the full box (positioned, so none takes room): the vertical line and the dot
// centred on the point (never the price dot's inset layer; at either end half the dot falls outside); the label at the top.
function crosshairLayers(t, mark) {
  const label = h_flex().absolute().top(0).px(4).rounded(3).bg(t.background).text_size(11).whitespace_nowrap()
    .opacity(mark.opacity).text_color(t.foreground).child(div().child(mark.head))
    .when(Boolean(mark.change), (el) => el.child(div().child(" · "))
      .child(div().text_color(mark.changeColor).child(mark.change)));
  return [
    div().absolute().top(0).bottom(0).left(`${mark.x}%`).ml(-0.5).w(1).bg(t.dim),
    div().absolute().left(`${mark.x}%`).top(`${mark.y}%`).ml(-3).mt(-3).w(6).h(6).rounded_full().bg(mark.dotColor),
    "left" in mark.spot ? label.left(mark.spot.left) : label.right(mark.spot.right),
  ];
}

// One place of the detail's second row of price levels: the stat look (a 10.5 px `dim` label over a semibold value) with
// the unit 3 px after the value in 10.5 px `dim`; a place without a cell stays empty and keeps its column.
export function statCell(t, cell) {
  if (!cell) return div().flex_1();
  return v_flex().flex_1().gap(2)
    .child(div().text_size(10.5).text_color(t.dim).child(cell.label))
    .child(h_flex().items_end().child(div().font_semibold().child(cell.value))
      .when(Boolean(cell.unit), (el) => el.child(div().ml(3).text_size(10.5).text_color(t.dim).child(cell.unit))));
}

// Cells (statCell) two to a row, as the detail's activity grid; an odd last cell keeps its column.
export function statGrid(t, cells) {
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(h_flex().gap(12).child(statCell(t, cells[i])).child(statCell(t, cells[i + 1] ?? null)));
  return v_flex().gap(10).children(rows);
}

// The inner/outer line (format.js innerOuter) over a 4 px bar of two parts 2 px apart, sized by their shares: inner in
// `innerColor`, outer in `outerColor`. A side with no share draws no part.
export function innerOuterBar(flow, innerColor, outerColor) {
  return v_flex().gap(6)
    .child(h_flex().justify_between().gap(8).text_size(11)
      .child(div().whitespace_nowrap().child(flow.left)).child(div().whitespace_nowrap().child(flow.right)))
    .child(h_flex().h(4).gap(2)
      .when(flow.innerShare > 0, (el) => el.child(div().flex_none().h_full().rounded(2).bg(innerColor)
        .w(`${Math.round(flow.innerShare * 1000) / 10}%`)))
      .when(flow.outerShare > 0, (el) => el.child(div().flex_1().h_full().rounded(2).bg(outerColor))));
}

// 6px: filled for a live quote, a 1px ring when the price may not be current, none for a session.
export function dot(t, state) {
  const dot = div().flex_none().w(6).h(6).rounded_full();
  if (state === "live") return dot.bg(t.foreground);
  return HOLLOW.includes(state) ? dot.border_1().border_color(t.dim) : null;
}

// `a · b · c` that wraps only between parts: each part stays whole, the `·` ends the line it is on.
export function segments(t, parts) {
  const shown = parts.filter(Boolean);
  return h_flex().flex_wrap().gap_x(4).text_size(11).text_color(t.dim)
    .children(shown.map((part, i) => div().whitespace_nowrap().child(i < shown.length - 1 ? `${part} ·` : part)));
}

export function button(t, id, label, onClick) {
  return h_flex().id(id).flex_none().h(22).px(8).items_center().rounded(5).border_1().border_color(t.border)
    .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx)).child(label);
}

/** A price's ink when it is not lit: `dim` while cached (kept through a failed refresh), else `foreground`. */
export const priceInk = (t, quote) => (quote.cached ? t.dim : t.foreground);

// The failure note under a price (failureNote) for `quote` after `error`, or null: the reason alone, or inside the
// words for what is cached. `say` words a reason, `tx` translates.
export function failureText(quote, error, say, tx) {
  const key = failureNote(quote, error);
  if (key === null) return null;
  return key === "reason" ? say(error) : tx(key, { reason: say(error) });
}

/**
 * A price in a content-sized box whose padding and negative margin cancel, so its digits stay put, lit or not.
 * `mark` (a price at its limit, from the view's limitMark) lights it as Taiwan's quote boards do: a solid
 * block in the limit's color, the text in `mark.ink`, the limit in words on hover.
 */
export function priceBox(id, text, color, mark, { pad = 4 } = {}) {
  return div().id(id).flex_none().whitespace_nowrap().px(pad).mx(-pad).rounded(3).text_color(mark ? mark.ink : color)
    .when(Boolean(mark), (el) => el.bg(mark.color).tooltip(mark.tip)).child(text);
}

// A text link: `muted`, `foreground` under the pointer.
export function link(t, id, label, onClick) {
  return div().id(id).flex_none().cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx)).child(label);
}

// A header action: a 16 px single-color icon in a 28 × 28 target, named by its tooltip.
export function iconButton(t, id, name, label, onClick, spinning = false) {
  return h_flex().id(id).flex_none().w(28).h(28).items_center().justify_center().rounded(6)
    .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(label).on_click((_e, cx) => onClick(cx))
    .child(svg(icon(name)).w(16).h(16).when(spinning, (el) => el.spin(SPIN_MS)));
}

// One group of choices: the chosen one filled, the rest muted.
export function segmented(t, id, choices, current, onPick) {
  return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
    .children(choices.map(([value, label]) => h_flex().id(`${id}-${value}`).h(28).px(12).items_center().cursor_pointer()
      .text_color(value === current ? t.foreground : t.muted).when(value === current, (el) => el.bg(t.hover).font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { onPick(value); cx.notify(); }).child(label)));
}

// A box drawn in the theme (accent-filled while ticked) and its label; a click on either toggles it.
export function checkbox(t, id, checked, label, onChange) {
  return Checkbox.new(id).w_full().min_w(0).checked(checked).cursor_pointer()
    .on_change((value, cx) => { onChange(value); cx.notify(); })
    .child(h_flex().w_full().min_w(0).gap(8).items_start()
      .child(div().flex_none().mt(2).w(14).h(14).rounded(3).border_1().border_color(checked ? t.accent : t.border)
        .flex().items_center().justify_center().text_size(10).text_color(t.background)
        .when(checked, (el) => el.bg(t.accent).child("✓")))
      .child(div().flex_1().min_w(0).font_semibold().child(label)));
}

// A switch drawn in the theme: a 28 × 16 track, `accent` with the knob at the right while on, `border` with
// it at the left while off. It draws no label of its own, so `label` is what a screen reader announces.
export function toggle(t, id, on, label, onChange) {
  return Switch.new(id).flex_none().checked(on).accessibility_label(label).cursor_pointer()
    .on_change((value, cx) => { onChange(value); cx.notify(); })
    .child(h_flex().w(28).h(16).p(2).rounded_full().bg(on ? t.accent : t.border).when(on, (el) => el.justify_end())
      .child(div().flex_none().w(12).h(12).rounded_full().bg(t.background)));
}

export function note(t, text) {
  // Its full width, and no wider, so a long note wraps at its column's edge.
  return div().w_full().min_w(0).text_size(11.5).text_color(t.dim).child(text);
}
