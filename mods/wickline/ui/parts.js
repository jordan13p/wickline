// Stateless drawing helpers shared by the panel and the dialogs. Most take the theme and what they draw and return
// an element; icon, inset, chartShape, priceInk and failureText return a path, a padded element, a shape, a color
// and words. No Herdr calls, no state.
import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Checkbox, Switch } from "gpui-base";
import { chartGeometry, chartLayout } from "../chart.js";
import { failureNote } from "../format.js";
import { GUTTER, RIGHT_INSET } from "../layout.js";
import { SPIN_MS } from "../motion.js";

// The soft fill under a line chart.
const AREA_OPACITY = 0.16;

// Freshness states drawn with a hollow dot: the price may not be current.
const HOLLOW = ["unconfirmed", "stalled", "delayed"];
/** The path of icon `name` under the mod's icons/. */
export const icon = (name) => `mods/wickline/icons/${name}.svg`;
/**
 * `el` with the left gutter and the right inset (the × column and the scrollbar lane), so every region outside the
 * list's rows ends on one edge.
 */
export const inset = (el) => el.pl(GUTTER).pr(RIGHT_INSET);

/** What `quote`'s chart draws (chartGeometry), or null when its box holds nothing. */
export const chartShape = (quote) => chartGeometry(quote.series, quote.previousClose, chartLayout(quote));

/**
 * The day's line, scaled to its box and reaching only as far as its trading day has run.
 * - The previous close is a dashed rule, drawn with any number of points.
 * - With that rule and `tones` (`{ gain, loss }`), the line is drawn in `tones.gain` above the rule and `tones.loss`
 *   below it, each side's area filled to the rule; one path per side, however often the line crosses. Without a rule
 *   the line and its area (to the box's bottom) take `color`, as does a line wholly on the rule.
 * - A price past its line is a filled dot in `color`, `dot` px wide, never joined to the line.
 * - `stroke` defaults to 2 px with the area and 1.25 px without.
 * - `crosshair` (the detail's) follows the pointer: the box takes its `id`, hands `move` the pointer's x as a share
 *   of its width with that width, and calls `leave` when the pointer goes. Its `mark`, when set, draws a vertical
 *   line and a dot at a line point, and a card beside them placed by `spot` across and `level` down.
 */
export function chart(quote, color, t, { width, height, fill, stroke = fill ? 2 : 1.25, dot = 4, tones, crosshair }) {
  const box = div().relative().flex_none().h(height);
  const sized = width === "full" ? box.w_full() : box.w(width);
  const g = chartShape(quote);
  if (!g) return sized;
  const layer = (path, paint) => window.paint_path(path, paint).absolute().top(0).left(0).size_full();
  const lined = g.points.length > 1;
  let line = PathBuilder.stroke(stroke);
  g.points.forEach(([x, y], i) => {
    line = i ? line.line_to(`${x}%`, `${y}%`) : line.move_to(`${x}%`, `${y}%`);
  });
  const end = lined ? g.points[g.points.length - 1][0] : 0;
  const sides = tones && g.runs.length ? g.runs : null;
  const toneOf = (side) => (side === "gain" ? tones.gain : side === "loss" ? tones.loss : color);
  // Each side as one path of its runs: the line through each run, the area from the rule along it and back.
  const sideLayers = (side) => {
    const parts = sides.filter((run) => run.side === side);
    if (!parts.length) return [];
    const rule = `${g.reference}%`;
    let stroked = PathBuilder.stroke(stroke);
    let filled = PathBuilder.fill();
    for (const run of parts) {
      run.points.forEach(([x, y], i) => {
        stroked = i ? stroked.line_to(`${x}%`, `${y}%`) : stroked.move_to(`${x}%`, `${y}%`);
      });
      filled = filled.move_to(`${run.points[0][0]}%`, rule);
      for (const [x, y] of run.points) filled = filled.line_to(`${x}%`, `${y}%`);
      filled = filled.line_to(`${run.points[run.points.length - 1][0]}%`, rule).close();
    }
    const tone = toneOf(side);
    return [
      ...(fill ? [layer(filled.build(), Background.solid(tone).opacity(AREA_OPACITY))] : []),
      layer(stroked.build(), tone),
    ];
  };
  const half = dot / 2;
  const mark = crosshair?.mark ?? null;
  return (
    sized
      .when(Boolean(crosshair), (el) =>
        el
          .id(crosshair.id)
          .on_mouse_move((event, cx) => {
            if (!event.bounds || event.bounds.width <= 0) return;
            crosshair.move(
              Math.min(1, Math.max(0, event.local_position.x / event.bounds.width)),
              event.bounds.width,
              cx,
            );
          })
          .on_hover((hovered, cx) => {
            if (!hovered) crosshair.leave(cx);
          }),
      )
      .when(g.reference !== null, (el) =>
        el.child(
          layer(
            PathBuilder.stroke(1)
              .dash_array([3, 3])
              .move_to("0%", `${g.reference}%`)
              .line_to("100%", `${g.reference}%`)
              .build(),
            t.border,
          ),
        ),
      )
      .when(Boolean(sides), (el) => el.children([...sideLayers("gain"), ...sideLayers("loss"), ...sideLayers("flat")]))
      .when(lined && !sides && Boolean(fill), (el) => {
        let area = PathBuilder.fill().move_to("0%", "100%");
        for (const [x, y] of g.points) area = area.line_to(`${x}%`, `${y}%`);
        return el.child(
          layer(area.line_to(`${end}%`, "100%").close().build(), Background.solid(color).opacity(AREA_OPACITY)),
        );
      })
      .when(lined && !sides, (el) => el.child(layer(line.build(), color)))
      // Inset by half the dot across, so a dot at either end stays whole inside the box.
      .when(g.dot !== null, (el) =>
        el.child(
          div()
            .absolute()
            .top(0)
            .bottom(0)
            .left(half)
            .right(half)
            .child(
              div()
                .absolute()
                .left(`${g.dot[0]}%`)
                .top(`${g.dot[1]}%`)
                .ml(-half)
                .mt(-half)
                .w(dot)
                .h(dot)
                .rounded_full()
                .bg(color),
            ),
        ),
      )
      .when(Boolean(mark), (el) => el.children(crosshairLayers(t, mark)))
  );
}

// The crosshair's three layers over the full box, positioned so none takes room:
// - the vertical line and the dot, centred on the point (at either end half the dot falls outside);
// - the card beside them: the date and time (11 px on a 14 px line, `dim`) over the price and its change (12 px on a
//   16 px line). The fixed line heights make the card exactly as tall as crosshairLevel assumes. Its plate stays
//   opaque, so the line never shows through; only its text dims.
function crosshairLayers(t, mark) {
  const card = v_flex()
    .absolute()
    .gap(2)
    .px(6)
    .py(4)
    .rounded(3)
    .bg(t.background)
    .whitespace_nowrap()
    .child(div().opacity(mark.opacity).line_height("14px").text_size(11).text_color(t.dim).child(mark.time))
    .child(
      h_flex()
        .opacity(mark.opacity)
        .line_height("16px")
        .gap(6)
        .text_size(12)
        .child(div().font_semibold().text_color(t.foreground).child(mark.price))
        .when(Boolean(mark.change), (el) => el.child(div().text_color(mark.changeColor).child(mark.change))),
    );
  const across = "left" in mark.spot ? card.left(mark.spot.left) : card.right(mark.spot.right);
  return [
    div().absolute().top(0).bottom(0).left(`${mark.x}%`).ml(-0.5).w(1).bg(t.dim),
    div().absolute().left(`${mark.x}%`).top(`${mark.y}%`).ml(-3).mt(-3).w(6).h(6).rounded_full().bg(mark.dotColor),
    "top" in mark.level ? across.top(mark.level.top) : across.bottom(mark.level.bottom),
  ];
}

/**
 * One place of the detail's second row: a 10.5 px `dim` label over a semibold value, the unit 3 px after it in
 * 10.5 px `dim`. A place without a cell stays empty and keeps its column.
 */
export function statCell(t, cell) {
  if (!cell) return div().flex_1();
  return v_flex()
    .flex_1()
    .gap(2)
    .child(div().text_size(10.5).text_color(t.dim).child(cell.label))
    .child(
      h_flex()
        .items_end()
        .child(div().font_semibold().child(cell.value))
        .when(Boolean(cell.unit), (el) => el.child(div().ml(3).text_size(10.5).text_color(t.dim).child(cell.unit))),
    );
}

/** Cells (statCell) two to a row, as the detail's activity grid; an odd last cell keeps its column. */
export function statGrid(t, cells) {
  const rows = [];
  for (let i = 0; i < cells.length; i += 2)
    rows.push(
      h_flex()
        .gap(12)
        .child(statCell(t, cells[i]))
        .child(statCell(t, cells[i + 1] ?? null)),
    );
  return v_flex().gap(10).children(rows);
}

/**
 * The inner/outer line (innerOuter) over a 4 px bar of two parts 2 px apart, sized by their shares: inner in
 * `innerColor`, outer in `outerColor`. A side with no share draws no part.
 */
export function innerOuterBar(flow, innerColor, outerColor) {
  return v_flex()
    .gap(6)
    .child(
      h_flex()
        .justify_between()
        .gap(8)
        .text_size(11)
        .child(div().whitespace_nowrap().child(flow.left))
        .child(div().whitespace_nowrap().child(flow.right)),
    )
    .child(
      h_flex()
        .h(4)
        .gap(2)
        .when(flow.innerShare > 0, (el) =>
          el.child(
            div()
              .flex_none()
              .h_full()
              .rounded(2)
              .bg(innerColor)
              .w(`${Math.round(flow.innerShare * 1000) / 10}%`),
          ),
        )
        .when(flow.outerShare > 0, (el) => el.child(div().flex_1().h_full().rounded(2).bg(outerColor))),
    );
}

/** A 6 px freshness dot: filled for a live quote, a 1 px ring when the price may not be current, none for a session. */
export function dot(t, state) {
  const dot = div().flex_none().w(6).h(6).rounded_full();
  if (state === "live") return dot.bg(t.foreground);
  return HOLLOW.includes(state) ? dot.border_1().border_color(t.dim) : null;
}

/** `a · b · c` that wraps only between parts: each part stays whole, and the `·` ends the line it is on. */
export function segments(t, parts) {
  const shown = parts.filter(Boolean);
  return h_flex()
    .flex_wrap()
    .gap_x(4)
    .text_size(11)
    .text_color(t.dim)
    .children(
      shown.map((part, i) =>
        div()
          .whitespace_nowrap()
          .child(i < shown.length - 1 ? `${part} ·` : part),
      ),
    );
}

/** A small outlined text button. */
export function button(t, id, label, onClick) {
  return h_flex()
    .id(id)
    .flex_none()
    .h(22)
    .px(8)
    .items_center()
    .rounded(5)
    .border_1()
    .border_color(t.border)
    .text_size(11)
    .text_color(t.muted)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(label);
}

/** A price's ink when it is not lit: `dim` while cached (kept through a failed refresh), else `foreground`. */
export const priceInk = (t, quote) => (quote.cached ? t.dim : t.foreground);

/**
 * The failure note's words under a price (failureNote), or null: the reason alone, or inside the words for what is
 * cached. `say` words a reason, `tx` translates.
 */
export function failureText(quote, error, say, tx) {
  const key = failureNote(quote, error);
  if (key === null) return null;
  return key === "reason" ? say(error) : tx(key, { reason: say(error) });
}

/**
 * A price in a content-sized box whose padding and negative margin cancel, so its digits stay put, lit or not.
 * `mark` (a price at its limit) lights it as Taiwan's quote boards do: a solid block in the limit's color, the text
 * in `mark.ink`, and the limit in words on hover.
 */
export function priceBox(id, text, color, mark, { pad = 4 } = {}) {
  return div()
    .id(id)
    .flex_none()
    .whitespace_nowrap()
    .px(pad)
    .mx(-pad)
    .rounded(3)
    .text_color(mark ? mark.ink : color)
    .when(Boolean(mark), (el) => el.bg(mark.color).tooltip(mark.tip))
    .child(text);
}

/** A text link: `muted`, `foreground` under the pointer. */
export function link(t, id, label, onClick) {
  return div()
    .id(id)
    .flex_none()
    .cursor_pointer()
    .text_color(t.muted)
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(label);
}

/** A header action: a 16 px single-color icon in a 28 × 28 target, named by its tooltip. */
export function iconButton(t, id, name, label, onClick, spinning = false) {
  return h_flex()
    .id(id)
    .flex_none()
    .w(28)
    .h(28)
    .items_center()
    .justify_center()
    .rounded(6)
    .text_color(t.muted)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(label)
    .on_click((_e, cx) => onClick(cx))
    .child(
      svg(icon(name))
        .w(16)
        .h(16)
        .when(spinning, (el) => el.spin(SPIN_MS)),
    );
}

/** One group of choices: the chosen one filled, the rest muted. */
export function segmented(t, id, choices, current, onPick) {
  return h_flex()
    .flex_none()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .overflow_hidden()
    .children(
      choices.map(([value, label]) =>
        h_flex()
          .id(`${id}-${value}`)
          .h(28)
          .px(12)
          .items_center()
          .cursor_pointer()
          .text_color(value === current ? t.foreground : t.muted)
          .when(value === current, (el) => el.bg(t.hover).font_semibold())
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            onPick(value);
            cx.notify();
          })
          .child(label),
      ),
    );
}

/** A box drawn in the theme (accent-filled while ticked) and its label; a click on either toggles it. */
export function checkbox(t, id, checked, label, onChange) {
  return Checkbox.new(id)
    .w_full()
    .min_w(0)
    .checked(checked)
    .cursor_pointer()
    .on_change((value, cx) => {
      onChange(value);
      cx.notify();
    })
    .child(
      h_flex()
        .w_full()
        .min_w(0)
        .gap(8)
        .items_start()
        .child(
          div()
            .flex_none()
            .mt(2)
            .w(14)
            .h(14)
            .rounded(3)
            .border_1()
            .border_color(checked ? t.accent : t.border)
            .flex()
            .items_center()
            .justify_center()
            .text_size(10)
            .text_color(t.background)
            .when(checked, (el) => el.bg(t.accent).child("✓")),
        )
        .child(div().flex_1().min_w(0).font_semibold().child(label)),
    );
}

/**
 * A switch drawn in the theme: a 28 × 16 track, `accent` with the knob at the right while on, `border` with it at
 * the left while off. It draws no label of its own, so `label` is what a screen reader announces.
 */
export function toggle(t, id, on, label, onChange) {
  return Switch.new(id)
    .flex_none()
    .checked(on)
    .accessibility_label(label)
    .cursor_pointer()
    .on_change((value, cx) => {
      onChange(value);
      cx.notify();
    })
    .child(
      h_flex()
        .w(28)
        .h(16)
        .p(2)
        .rounded_full()
        .bg(on ? t.accent : t.border)
        .when(on, (el) => el.justify_end())
        .child(div().flex_none().w(12).h(12).rounded_full().bg(t.background)),
    );
}

/** A problem line under a row or in the detail: smaller, in the blocked color. */
export function blockedNote(t, child) {
  return div().text_size(11).text_color(t.blocked).child(child);
}

/** A small `dim` note across its column. */
export function note(t, text) {
  // Its full width, and no wider, so a long note wraps at its column's edge.
  return div().w_full().min_w(0).text_size(11.5).text_color(t.dim).child(text);
}
