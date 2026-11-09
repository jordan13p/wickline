// Stateless drawing helpers shared by the panel and the dialogs: each takes the theme and what it
// draws, and returns an element. No Herdr calls, no state.
import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, Checkbox, Switch } from "gpui-base";
import { chartGeometry, tint } from "../format.js";
import { SPIN_MS } from "../motion.js";

// The soft fill under a line chart and behind a lit price.
const AREA_OPACITY = 0.16;

// Freshness states drawn with a hollow dot: the price may not be current.
const HOLLOW = ["unconfirmed", "stalled", "delayed"];
export const icon = (name) => `mods/wickline/icons/${name}.svg`;

// The day's line, scaled to its box; the previous close is a dashed rule. `stroke` defaults to 2 px with
// the area and 1.25 px without.
export function chart(quote, color, t, { width, height, fill, stroke = fill ? 2 : 1.25 }) {
  const box = div().relative().flex_none().h(height);
  const sized = width === "full" ? box.w_full() : box.w(width);
  const g = chartGeometry(quote.series, quote.previousClose);
  if (!g) return sized;
  const layer = (path, paint) => window.paint_path(path, paint).absolute().top(0).left(0).size_full();
  let line = PathBuilder.stroke(stroke);
  g.points.forEach(([x, y], i) => { line = i ? line.line_to(`${x}%`, `${y}%`) : line.move_to(`${x}%`, `${y}%`); });
  return sized
    .when(g.reference !== null, (el) => el.child(layer(
      PathBuilder.stroke(1).dash_array([3, 3]).move_to("0%", `${g.reference}%`).line_to("100%", `${g.reference}%`).build(),
      t.border)))
    .when(Boolean(fill), (el) => {
      let area = PathBuilder.fill().move_to("0%", "100%");
      for (const [x, y] of g.points) area = area.line_to(`${x}%`, `${y}%`);
      return el.child(layer(area.line_to("100%", "100%").close().build(),
        Background.solid(color).opacity(AREA_OPACITY)));
    })
    .child(layer(line.build(), color));
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

/**
 * A price in a content-sized box whose padding and negative margin cancel, so its digits stay put, lit or not.
 * `mark` (a price at its limit, from the view's limitMark): the text in its color, on that color at
 * AREA_OPACITY, the limit in words on hover.
 */
export function priceBox(id, text, color, mark, pad = 4) {
  const fill = mark && tint(mark.color, AREA_OPACITY);
  return div().id(id).flex_none().whitespace_nowrap().px(pad).mx(-pad).rounded(3).text_color(mark ? mark.color : color)
    .when(Boolean(fill), (el) => el.bg(fill)).when(Boolean(mark), (el) => el.tooltip(mark.tip)).child(text);
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
