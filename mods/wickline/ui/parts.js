// Stateless drawing helpers shared by the panel and the dialogs: each takes the theme and what it
// draws, and returns an element. No Herdr calls, no state.
import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { chartGeometry } from "../format.js";
import { SPIN_MS } from "../layout.js";

// Freshness states drawn with a hollow dot: the price may not be current.
const HOLLOW = ["unconfirmed", "stalled", "delayed"];
export const icon = (name) => `mods/wickline/icons/${name}.svg`;

// The day's line, scaled to its box; the previous close is a dashed rule.
export function chart(quote, color, t, { width, height, fill }) {
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

// A source's card: its name and kind, then whatever it lets the person set.
export function card(t, title, source, ...children) {
  return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).font_semibold().child(title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(source)))
    .children(children.filter(Boolean));
}

export function note(t, text) {
  return div().text_size(11.5).text_color(t.dim).child(text);
}
