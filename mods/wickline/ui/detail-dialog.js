// The detail dialog: a copy whose props carry `detail` draws only this; it fetches nothing, its row hands it newer
// quotes (main.js adoptDetail), and it redraws at its quote's own moments (freshness.js followDetail).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { isCryptoPair } from "../quotes.js";
import {
  activityCells, bookTotals, changeTone, crosshairAt, crosshairLabel, crosshairLevel, crosshairSpot, detailBook,
  displayName, detailTimes, formatChange, formatCount, formatSignedCount, innerOuter, ladder, lineDate, number,
  secondRow, sessionTimesParts, signed,
} from "../format.js";
import { detailDimmed, detailSource, sessionName, sessionOf, sessionTimes } from "../freshness.js";
import { heldMarks } from "../calendar.js";
import { chart, chartShape, failureText, innerOuterBar, priceBox, segments, statCell, statGrid } from "./parts.js";

// How far a stopped price dims, with the activity and book beside it.
const DIM_OPACITY = 0.5;
// The detail's chart's height, px.
const CHART_H = 140;
// The ladder's bid sizes sit in a fixed column, so each bid price starts at the same place.
const SIZE_W = 44;

// One side of a ladder row (format.js ladder): a 24 px band, the bid's size in its fixed column then its price toward the
// center, the ask's price then its size. A price at the previous close (or without one) is plain `foreground`; others
// take the change color; a market order reads detail.marketOrder in plain ink. `rung` null: empty.
function ladderSide(view, t, q, rung, bid) {
  const side = h_flex().flex_1().h(24).px(6).items_center().justify_between();
  if (!rung) return side;
  const plain = ["flat", "none"].includes(changeTone(rung.change));
  const price = div().font_medium().text_color(plain ? t.foreground : view.changeColor(t, rung.change))
    .child(rung.market ? view.tx("detail.marketOrder") : number(q, rung.price));
  const size = div().child(formatCount(rung.size));
  return bid ? side.child(size.w(SIZE_W).text_right()).child(price) : side.child(price).child(size);
}

// The right column's book: the ladder with its totals and their difference and ratio (detailBook shown), or its title
// over one line saying why there is none.
function bookBlock(view, t, q, shown, tx) {
  const title = div().text_size(11).text_color(t.dim).child(tx(shown.title));
  if (!shown.book) {
    const line = shown.line === "reason" ? view.say(q.fallback ?? q.error) : tx(shown.line);
    return v_flex().gap(6).child(title).child(div().text_size(11).text_color(t.dim).child(line));
  }
  const half = (left, right) => h_flex().flex_1().px(6).justify_between().child(left).child(right);
  const header = h_flex().gap(8).pb(4).border_b_1().border_color(t.border).text_size(10.5).text_color(t.dim)
    .child(half(div().w(SIZE_W).text_right().child(tx("detail.bidSize")), div().child(tx("detail.bidPrice"))))
    .child(half(div().child(tx("detail.askPrice")), div().child(tx("detail.askSize"))));
  const rows = ladder(shown.book, q.previousClose).map((row) => h_flex().gap(8)
    .child(ladderSide(view, t, q, row.bid, true)).child(ladderSide(view, t, q, row.ask, false)));
  const totals = bookTotals(shown.book);
  const total = (key, n) => h_flex().gap(4).child(div().child(tx(key)))
    .child(div().font_semibold().text_color(t.foreground).child(formatCount(n)));
  const balance = [`${tx("detail.bookDiff")} ${formatSignedCount(totals.diff)}`,
    ...(totals.ratio === null ? [] : [`${tx("detail.bookRatio")} ${totals.ratio.toFixed(2)}`])].join(" · ");
  return v_flex().gap(6).child(title)
    .child(v_flex().child(header).children(rows)
      .child(h_flex().gap(8).pt(6).border_t_1().border_color(t.border).text_size(11).text_color(t.dim)
        .child(half(total("detail.bidTotal", totals.bids), div())).child(half(div(), total("detail.askTotal", totals.asks)))))
    .child(div().w_full().text_center().text_size(11).text_color(t.dim).child(balance));
}

// The chart's crosshair (parts.js chart): the line point nearest the pointer (view.chartPointer) of `shape`, its card
// as of `now` (the detail's clock) and its place, the card's text at the detail's dim opacity when `dimmed`. A move
// redraws only when the nearest point or the box's width changes; a leave clears the pointer.
function crosshairOption(view, t, q, shape, now, dimmed) {
  const pointer = view.chartPointer;
  const at = pointer && crosshairAt(shape, q.times, pointer.share);
  let mark = null;
  if (at) {
    const label = crosshairLabel(q, at.index, now, view.lang);
    const changeColor = view.changeColor(t, label.percent);
    mark = {
      x: at.x, y: at.y, dotColor: changeColor, time: label.time, price: label.price, change: label.change, changeColor,
      spot: crosshairSpot(at.x, label, pointer.width), level: crosshairLevel(at.y, CHART_H),
      opacity: dimmed ? DIM_OPACITY : 1,
    };
  }
  return {
    id: "bw-detail-chart",
    move: (share, width, cx) => {
      view.chartPointer = { share, width };
      if (crosshairAt(shape, q.times, share)?.index !== at?.index || width !== pointer?.width) cx.notify();
    },
    leave: (cx) => {
      if (!view.chartPointer) return;
      view.chartPointer = null;
      cx.notify();
    },
    mark,
  };
}

// The dialog a row opens: the day's chart, its range and the session. A quote that can carry a book (main.js
// openDetail) opens wide, in two columns: the price, chart, levels and source lines on the left, its activity and book
// on the right. The right column always holds the book or the line saying why there is none, so its width never moves.
export function detailView(view, t) {
  const now = Date.now();
  // Never refetched: its row hands it newer quotes; a mark holds until its end or the next hand-over.
  const q = heldMarks(view.detail, now);
  const color = view.changeColor(t, q.changePercent);
  const mark = view.limitMark(t, q, now);
  const session = sessionOf(q, now);
  const tx = (key, params) => view.tx(key, params);
  const note = failureText(q, q.error, (reason) => view.say(reason), tx);
  const source = detailSource(q, session, now, tx);
  const times = detailTimes(q, now, view.lang, tx);
  const hours = sessionTimesParts(sessionTimes(q, now), view.lang, tx);
  const second = secondRow(q, view.wide, view.lang, tx);
  const amount = signed(q);
  // A stalled or cached price dims with its activity, so nothing beside it looks current; its ink stays foreground.
  const dimmed = detailDimmed(q, session, now);
  const dim = (el) => (dimmed ? el.opacity(DIM_OPACITY) : el);
  const shape = chartShape(q);
  // A crosshair needs a line with one time per point (crosshairAt places one at any share then). A pointer kept while
  // there is none would bring it back at its old place when one returns.
  const traced = crosshairAt(shape, q.times, 0) !== null;
  if (!traced) view.chartPointer = null;
  const stat = (label, price) => v_flex().flex_1().gap(2)
    .child(div().text_size(10.5).text_color(t.dim).child(view.tx(label)))
    .child(div().font_semibold().child(number(q, price)));

  const header = h_flex().items_center().gap(10)
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(16).font_semibold().truncate().child(q.symbol))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(displayName(q, view.lang) ?? "")))
    // The session as plain text: a filled dot means a live quote, everywhere. No word while it is not known.
    .when(sessionName(q, session, now) !== "unknown", (el) => el
      .child(div().flex_none().text_size(11).text_color(t.muted).child(view.tx(`session.${sessionName(q, session, now)}`))))
    .child(div().id("bw-detail-close").flex_none().w(18).text_right().text_size(14).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click(() => view.closeDialog()).child("×"));
  const left = [
    dim(h_flex().gap(10).items_end()
      .child(priceBox("bw-detail-price", number(q), t.foreground, mark, { pad: 6 }).text_size(26).font_semibold())
      // Outside the price, as in the rows: a lit price's 6px block keeps 4px clear of it.
      .when(Boolean(q.currency), (el) => el.child(div().pb(4).text_size(13).text_color(t.dim).child(q.currency)))
      .when(amount !== "—", (el) => el.child(div().pb(4).text_size(13).font_semibold().text_color(color).child(amount)))
      .child(div().pb(4).text_size(13).font_semibold().text_color(color).child(formatChange(q.changePercent)))
      .when(Boolean(mark), (el) => el.child(div().pb(4).text_size(13).font_semibold().text_color(mark.color)
        .child(view.tx(mark.limit === "up" ? "detail.limitUp" : "detail.limitDown"))))),
    // The box only when its chart draws something (chartShape: a rule, a line or the price's dot), else nothing. The
    // crosshair's card text dims with the detail, and over a cached line, which is not current.
    shape !== null && chart(q, color, t, {
      width: "full", height: CHART_H, fill: true, dot: 6, date: lineDate(q, now, view.lang),
      crosshair: traced ? crosshairOption(view, t, q, shape, now, dimmed || Boolean(q.chartCached)) : null,
    }),
    isCryptoPair(q.symbol)
      ? h_flex().gap(12).child(stat("detail.open24h", q.open)).child(stat("detail.high24h", q.high))
        .child(stat("detail.low24h", q.low))
      : h_flex().gap(12).child(stat("detail.open", q.open)).child(stat("detail.high", q.high)).child(stat("detail.low", q.low))
        .child(stat("detail.prevClose", q.previousClose)),
    // The second row on the same grid: the limits under high and low (at a limit or not); under open, one column's
    // volume (its activity, dimmed with the price) or two columns' average price; two columns draw every place.
    second !== null && h_flex().gap(12).children(second.map((cell, i) =>
      (i === 0 && !view.wide ? dim(statCell(t, cell)) : statCell(t, cell)))),
    v_flex().gap(2).children([...source, ...(hours.length ? [hours] : []), times].map((parts) => segments(t, parts))),
    Boolean(note) && div().text_size(11).text_color(t.blocked).child(note),
    Boolean(q.fallback) && div().text_size(11).text_color(t.blocked).child(view.fallbackText(q, q.fallback)),
  ].filter(Boolean);

  const root = v_flex().id("bw-detail").w_full().p(18).gap(14).text_color(t.foreground).text_size(12.5).child(header);
  if (!view.wide) return root.children(left);
  const cells = activityCells(q, view.lang, tx);
  const flow = innerOuter(q, tx);
  const shown = detailBook(q, sessionName(q, session, now) === "auction");
  const book = bookBlock(view, t, q, shown, tx);
  const right = [
    dim(statGrid(t, cells)),
    flow !== null && dim(innerOuterBar(flow, view.changeColor(t, -1), view.changeColor(t, 1))),
    shown.book ? dim(book) : book,
  ].filter(Boolean);
  return root.child(h_flex().items_start().gap(28)
    .child(v_flex().flex_1().min_w(0).gap(14).children(left))
    .child(v_flex().flex_none().w(268).gap(14).children(right)));
}
