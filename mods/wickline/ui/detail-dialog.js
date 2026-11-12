// The detail dialog: a copy whose props carry `detail` draws only this;
// it fetches nothing and redraws at its quote's own moments (freshness.js followDetail).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { hasLimits, isCryptoPair } from "../quotes.js";
import { displayName, detailTimes, failureNote, formatChange, number, sessionTimesParts } from "../format.js";
import { detailSource, sessionName, sessionOf, sessionTimes } from "../freshness.js";
import { heldMarks } from "../calendar.js";
import { chart, priceBox, priceInk, segments } from "./parts.js";

// The dialog a row opens: the day's chart, its range and the session.
export function detailView(view, t) {
  const now = Date.now();
  // Never refetched: its mark holds only until that mark's end.
  const q = heldMarks(view.detail, now);
  const color = view.changeColor(t, q.changePercent);
  const mark = view.limitMark(t, q, now);
  const note = failureNote(q, q.error);
  const session = sessionOf(q, now);
  const tx = (key, params) => view.tx(key, params);
  const source = detailSource(q, session, now, tx);
  const times = detailTimes(q, now, view.lang, tx);
  const hours = sessionTimesParts(sessionTimes(q, now), view.lang, tx);
  const stat = (label, price) => v_flex().flex_1().gap(2)
    .child(div().text_size(10.5).text_color(t.dim).child(view.tx(label)))
    .child(div().font_semibold().child(number(q, price)));

  return v_flex().id("bw-detail").w_full().p(18).gap(14).text_color(t.foreground).text_size(12.5)
    .child(h_flex().items_center().gap(10)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(16).font_semibold().truncate().child(q.symbol))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(displayName(q, view.lang) ?? "")))
      // The session as plain text: a filled dot means a live quote, everywhere. No word while it is not known.
      .when(sessionName(q, session, now) !== "unknown", (el) => el
        .child(div().flex_none().text_size(11).text_color(t.muted).child(view.tx(`session.${sessionName(q, session, now)}`))))
      .child(div().id("bw-detail-close").flex_none().w(18).text_right().text_size(14).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click(() => view.closeDialog()).child("×")))
    .child(h_flex().gap(10).items_end()
      .child(priceBox("bw-detail-price", number(q), priceInk(t, q), mark, { pad: 6 }).text_size(26).font_semibold())
      // Outside the price, as in the rows: a lit price's 6px block keeps 4px clear of it.
      .when(Boolean(q.currency), (el) => el.child(div().pb(4).text_size(13).text_color(t.dim).child(q.currency)))
      .child(div().pb(4).text_size(13).font_semibold().text_color(color).child(formatChange(q.changePercent)))
      .when(Boolean(mark), (el) => el.child(div().pb(4).text_size(13).font_semibold().text_color(mark.color)
        .child(view.tx(mark.limit === "up" ? "detail.limitUp" : "detail.limitDown")))))
    .child(q.series?.length > 1
      ? chart(q, color, t, { width: "full", height: 140, fill: true })
      : div().h(60).flex().items_center().justify_center().text_color(t.dim).child(view.tx("detail.noLine")))
    .child(isCryptoPair(q.symbol)
      ? h_flex().gap(12).child(stat("detail.open24h", q.open)).child(stat("detail.high24h", q.high))
        .child(stat("detail.low24h", q.low))
      : h_flex().gap(12).child(stat("detail.open", q.open)).child(stat("detail.high", q.high)).child(stat("detail.low", q.low))
        .child(stat("detail.prevClose", q.previousClose)))
    // The day's limits on the same four-column grid, whenever the source sent both, at a limit or not.
    .when(hasLimits(q.limitUp, q.limitDown), (el) => el.child(h_flex().gap(12)
      .child(stat("detail.limitUpPrice", q.limitUp)).child(stat("detail.limitDownPrice", q.limitDown))
      .child(div().flex_1()).child(div().flex_1())))
    .child(v_flex().gap(2).children([...source, ...(hours.length ? [hours] : []), times].map((parts) => segments(t, parts))))
    .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.blocked).child(view.tx(note, { reason: view.say(q.error) }))))
    .when(Boolean(q.fallback), (el) => el.child(div().text_size(11).text_color(t.blocked).child(view.fallbackText(q, q.fallback))));
}
