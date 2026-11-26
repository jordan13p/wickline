// The chart: where its line and price fall in the box, by how far the trading day has run, and the crosshair's point
// and card.
import { futuresDay, taipeiAt } from "./calendar.js";
import { formatChange, formatDate, number, stamp } from "./format.js";
import { hoursWindow, lunchWithin } from "./freshness.js";
import { DAY_SESSION, NIGHT_SESSION, TAIFEX_HOURS, kindOf } from "./markets.js";
import { changePercent, positive } from "./quotes.js";
import { tradesOn } from "./time.js";

/**
 * The chart in its box, in % of the box, as `{ points, reference, dot }`; null when nothing would be drawn.
 * - `points`: the line through `series` as [x, y], spread over `extent` of the width (null for all of it).
 * - `reference`: the y of the previous close, when it is positive.
 * - `runs`: the line cut at that rule into `{ side, points }` (see runs); none without a rule.
 * - `dot`: `{ x, price }` (x a share of the width) as [x, y], or null.
 * The y range holds all three. A line needs two points.
 */
export function chartGeometry(series, reference, { extent, dot } = {}) {
  const points = Array.isArray(series) ? series : [];
  const rule = positive(reference) ? reference : null;
  if (points.length < 2 && rule === null && !dot) return null;
  let min = Infinity;
  let max = -Infinity;
  const widen = (value) => {
    min = Math.min(min, value);
    max = Math.max(max, value);
  };
  for (const value of points) widen(value);
  if (rule !== null) widen(rule);
  if (dot) widen(dot.price);
  if (max - min < max * 1e-9) {
    min -= 1;
    max += 1;
  }
  // 8% headroom keeps the stroke inside the box.
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const pct = (share) => Math.round(share * 10000) / 100;
  const y = (value) => pct(1 - (value - min) / (max - min));
  const width = extent ?? 1;
  const last = points.length - 1;
  const x = (index) => (last ? (index / last) * width : 0);
  const drawn = points.map((value, index) => [pct(x(index)), y(value)]);
  return {
    points: drawn,
    reference: rule === null ? null : y(rule),
    runs: rule === null ? [] : runs(points, rule, drawn, (from, share) => [pct(x(from + share)), y(rule)]),
    dot: dot ? [pct(dot.x), y(dot.price)] : null,
  };
}

/**
 * The line cut where it crosses `rule`, as `[{ side, points }]`: `gain` above the rule, `loss` below, `flat` for a
 * line wholly on it. Sides come from the prices, so rounding never moves a point across the rule. A point on the rule
 * stays with the side it came from (the side it goes to, at the start); a crossing between two points is placed on
 * the rule by `crossing(index, share)`, `share` of the way from point `index` to the next.
 */
function runs(values, rule, drawn, crossing) {
  const sideOf = (value) => Math.sign(value - rule);
  let side = sideOf(values.find((value) => sideOf(value) !== 0) ?? rule);
  const cut = [];
  let run = [drawn[0]];
  for (let i = 1; i < values.length; i++) {
    const next = sideOf(values[i]);
    if (next !== 0 && next !== side) {
      const from = values[i - 1];
      const edge = sideOf(from) === 0 ? drawn[i - 1] : crossing(i - 1, (rule - from) / (values[i] - from));
      if (edge !== drawn[i - 1]) run.push(edge);
      cut.push({ side, points: run });
      run = [edge];
      side = next;
    }
    run.push(drawn[i]);
  }
  cut.push({ side, points: run });
  const name = { 1: "gain", "-1": "loss", 0: "flat" };
  return cut.filter((part) => part.points.length > 1).map((part) => ({ side: name[part.side], points: part.points }));
}

// The crosshair card's size. The width is estimated from 6.5 px a character for the 11 px time, and 7.5 px for the
// 12 px semibold price and change, which sit 6 px apart; 6 px padding each side. The height is exact: a 14 px and a
// 16 px line (ui/parts.js sets both), plus 2 px between and 4 px above and below.
// The estimate only picks the card's side and catches a card too wide for both. A card on the line's left is placed
// by its right edge, and one at the bottom by its bottom edge, so the gaps never depend on the font.
const CROSSHAIR_TIME_CHAR_PX = 6.5;
const CROSSHAIR_VALUE_CHAR_PX = 7.5;
const CROSSHAIR_VALUE_GAP_PX = 6;
const CROSSHAIR_PAD_PX = 12;
export const CROSSHAIR_CARD_PX = 40;
// Between the vertical line and the card.
const CROSSHAIR_GAP_PX = 6;

/**
 * The drawn line point nearest `xShare` of the box's width (clamped to 0…1), the later one on a tie, as
 * `{ index, x, y }` in % of the box. Past a line that ends early it holds on the last point. null when there is no
 * line, `times` is not one time per point, or `xShare` is not a finite number.
 */
export function crosshairAt(geometry, times, xShare) {
  const points = geometry?.points ?? [];
  if (points.length < 2 || !Array.isArray(times) || times.length !== points.length || !Number.isFinite(xShare))
    return null;
  const target = Math.min(1, Math.max(0, xShare)) * 100;
  let index = 0;
  // x never decreases along the line, so `<=` keeps the later point on a tie.
  const distance = (i) => Math.abs(points[i][0] - target);
  for (let i = 1; i < points.length; i++) if (distance(i) <= distance(index)) index = i;
  return { index, x: points[index][0], y: points[index][1] };
}

/**
 * What the crosshair's card says of point `index` of `quote`'s line:
 * - `time`: its local date and time ("Nov 19 23:00"), always dated, as a US line crosses midnight;
 * - `price`: "2,175.00";
 * - `change` ("+0.23%") and `percent` (the same as a number), against the previous close; null without one.
 */
export function crosshairLabel(quote, index, lang) {
  const time = quote.times[index];
  const value = quote.series[index];
  const percent = changePercent(value, quote.previousClose);
  const change = percent === null ? null : formatChange(percent);
  return { time: stamp(formatDate(time, lang), time), price: number(quote, value), change, percent };
}

/**
 * Where the crosshair's card sits across a box `widthPx` wide, for a line at `x`% of it. It goes right of the line
 * when it fits, else left of it, else at the box's left edge.
 */
export function crosshairSpot(x, label, widthPx) {
  const time = label.time.length * CROSSHAIR_TIME_CHAR_PX;
  const value =
    (label.price.length + (label.change?.length ?? 0)) * CROSSHAIR_VALUE_CHAR_PX +
    (label.change ? CROSSHAIR_VALUE_GAP_PX : 0);
  const w = Math.max(time, value) + CROSSHAIR_PAD_PX;
  const px = (x / 100) * widthPx;
  if (px + CROSSHAIR_GAP_PX + w <= widthPx) return { left: px + CROSSHAIR_GAP_PX };
  if (px - CROSSHAIR_GAP_PX - w >= 0) return { right: widthPx - px + CROSSHAIR_GAP_PX };
  return { left: 0 };
}

/** Where the crosshair's card sits down a box `heightPx` tall: its middle at the point `y`% down, kept inside. */
export function crosshairLevel(y, heightPx) {
  const top = (y * heightPx) / 100 - CROSSHAIR_CARD_PX / 2;
  if (top <= 0 || heightPx <= CROSSHAIR_CARD_PX) return { top: 0 };
  return top + CROSSHAIR_CARD_PX >= heightPx ? { bottom: 0 } : { top };
}

// A future's trading day `day` as its two sessions: the night from 15:00 on the weekday before (Friday's for a
// Monday), then the day session.
function taifexDay(day) {
  let night = day - 1;
  while (!tradesOn(TAIFEX_HOURS, night)) night--;
  return [
    [taipeiAt(night, NIGHT_SESSION.from), taipeiAt(night, NIGHT_SESSION.to)],
    [taipeiAt(day, DAY_SESSION.from), taipeiAt(day, DAY_SESSION.to)],
  ];
}

/**
 * A regular period ([start, end] in ms) as its spans of trading time: split around the exchange's lunch when it falls
 * inside, else whole. The lunch is taken on the period's own day, so a Saturday detail with Friday's periods still
 * splits.
 */
export function regularSpans(quote, regular) {
  const [start, end] = regular;
  const lunch = lunchWithin(quote, regular, start);
  return lunch
    ? [
        [start, lunch[0]],
        [lunch[1], end],
      ]
    : [[start, end]];
}

// The spans of trading time in the trading day of `t`, as [start, end] in ms, or null when unknown.
function tradingSpans(quote, t) {
  if (kindOf(quote.symbol) === "future") {
    const day = futuresDay(t);
    const own = (quote.periods?.segments ?? []).filter(([start]) => futuresDay(start) === day);
    return own.length ? own : taifexDay(day);
  }
  const regular = quote.periods?.regular ?? hoursWindow(quote, t)?.regular;
  return regular ? regularSpans(quote, regular) : null;
}

/**
 * The share of `quote`'s trading day elapsed at `t`, in [0, 1], counting trading time only: a lunch break and the gap
 * between a future's sessions take none. null for a pair, FX or a Yahoo future (`=F`), or without periods or hours.
 * A finished earlier day gives 1. So does a quote timed before its period's start (yesterday's bars under today's
 * periods), and a trading day with no trading time (also a regular period that ends at or before its start).
 */
export function sessionProgress(quote, t) {
  const kind = kindOf(quote.symbol);
  if (kind === "pair" || kind === "other") return null;
  const regular = quote.periods?.regular;
  if (regular && (quote.timestamp < regular[0] || regular[1] <= regular[0])) return 1;
  const spans = tradingSpans(quote, t);
  if (!spans) return null;
  const total = spans.reduce((sum, [start, end]) => sum + end - start, 0);
  if (total <= 0 || t < spans[0][0]) return 1;
  const elapsed = spans.reduce((sum, [start, end]) => sum + Math.min(Math.max(t, start), end) - start, 0);
  return elapsed / total;
}

// A drawn line that ends more than this before the shown price's time leaves the price a dot of its own.
const DOT_AFTER_MS = 300_000;

/**
 * Where `quote`'s line and price fall in its box, as `{ extent, dot }`, for chartGeometry.
 * - `extent`: the share of the box the line reaches, the session's progress at its last point; null for the whole box.
 * - `dot`: the price at its own time's progress, when the trading day is known and no line is drawn or the line ends
 *   more than DOT_AFTER_MS before the price.
 */
export function chartLayout(quote) {
  const lineEnd = quote.chartTimestamp ?? quote.timestamp;
  const extent = sessionProgress(quote, lineEnd);
  const behind = !quote.series?.length || quote.timestamp - lineEnd > DOT_AFTER_MS;
  if (!behind) return { extent, dot: null };
  const at = lineEnd === quote.timestamp ? extent : sessionProgress(quote, quote.timestamp);
  return { extent, dot: at === null ? null : { x: at, price: quote.price } };
}
