// The chart: its line and price in the box (chartGeometry, laid out by chartLayout from how far the trading day has
// run), and the crosshair's point and card. No Herdr imports, so tests run it under Node.
import { futuresDay, taipeiAt } from "./calendar.js";
import { formatChange, formatDate, number, stamp } from "./format.js";
import { hoursWindow, lunchWithin } from "./freshness.js";
import { DAY_SESSION, NIGHT_SESSION, TAIFEX_HOURS, kindOf } from "./markets.js";
import { changePercent, positive } from "./quotes.js";
import { tradesOn } from "./time.js";

/**
 * The line through `series`, scaled into its box as [x%, y%] points spread over `extent` of its width (null: all of
 * it; chartLayout), where the reference price (the previous close) falls whenever it is positive, and
 * `dot` ({ x, price }: x a share of the width) as [x%, y%], or null. The y range holds all three. null when nothing
 * would be drawn: no reference, no dot and fewer than two points (a line needs two).
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
  return {
    points: points.map((value, index) => [last ? pct((index / last) * width) : 0, y(value)]),
    reference: rule === null ? null : y(rule),
    dot: dot ? [pct(dot.x), y(dot.price)] : null,
  };
}

// The crosshair card's size, estimated: its time at 11 px (6.5 px a character) over its price and change at 12 px
// semibold (7.5 px a character, 6 px between them), 6 px padding each side and 4 px above and below; exactly 40 px
// tall: a 14 px and a 16 px line (ui/parts.js sets both line heights) and the 2 px between them. Only to pick its side
// and height and to catch a card too wide for both sides: a card on the line's left is placed by its right edge and
// one at the bottom by its bottom edge, so the gaps never depend on the font.
const CROSSHAIR_TIME_CHAR_PX = 6.5;
const CROSSHAIR_VALUE_CHAR_PX = 7.5;
const CROSSHAIR_VALUE_GAP_PX = 6;
const CROSSHAIR_PAD_PX = 12;
export const CROSSHAIR_CARD_PX = 40;
// Between the vertical line and the card.
const CROSSHAIR_GAP_PX = 6;

/**
 * The drawn line point (chartGeometry) nearest `xShare` of the box's width, clamped to 0…1, the later one on a tie:
 * `{ index, x, y }` (x and y in % of the box), so past a line that ends early it holds on the last point. null when
 * there is no line, `times` is not one time per point, or `xShare` is not a finite number.
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
 * What the crosshair's card says of point `index` of `quote`'s line: `time`, its local date and time, always dated
 * (a US line crosses midnight, so a bare time would read ambiguously): "11/20 10:32", "Nov 19 23:00"; `price`
 * ("2,175.00"); `change`, its change against the previous close ("+0.23%"), and `percent`, that change as a number,
 * both null without a positive previous close.
 */
export function crosshairLabel(quote, index, lang) {
  const time = quote.times[index];
  const value = quote.series[index];
  const percent = changePercent(value, quote.previousClose);
  const change = percent === null ? null : formatChange(percent);
  return { time: stamp(formatDate(time, lang), time), price: number(quote, value), change, percent };
}

/**
 * Where the crosshair's card (crosshairLabel) sits across a box `widthPx` wide for a line at `x`% of it: `{ left }`
 * 6 px right of the line when it fits there, else `{ right }` (its right edge 6 px left of the line) when it fits
 * there, else `{ left: 0 }`, held at the box's left edge. Its width is its wider line's.
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

/**
 * Where the crosshair's card sits down a box `heightPx` tall for a point `y`% down it: its middle at the point,
 * `{ top }` in px, held at the top (`{ top: 0 }`) and at the bottom by its own bottom edge (`{ bottom: 0 }`).
 */
export function crosshairLevel(y, heightPx) {
  const top = (y * heightPx) / 100 - CROSSHAIR_CARD_PX / 2;
  if (top <= 0 || heightPx <= CROSSHAIR_CARD_PX) return { top: 0 };
  return top + CROSSHAIR_CARD_PX >= heightPx ? { bottom: 0 } : { top };
}

// A future's trading day `day` (futuresDay) as its two sessions from TAIFEX_HOURS: the night from 15:00 on the trading
// weekday before it (Friday's for a Monday), then the day session.
function taifexDay(day) {
  let night = day - 1;
  while (!tradesOn(TAIFEX_HOURS, night)) night--;
  return [
    [taipeiAt(night, NIGHT_SESSION.from), taipeiAt(night, NIGHT_SESSION.to)],
    [taipeiAt(day, DAY_SESSION.from), taipeiAt(day, DAY_SESSION.to)],
  ];
}

// A regular period ([start, end] in ms) as its spans of trading time: split around the exchange's lunch
// (exchangeRule(...).lunch, via localWindow taken at its start, so a Saturday detail with Friday's periods still splits)
// when it falls inside, else whole.
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

// The spans of trading time in the trading day that `t` belongs to, as [start, end] in ms, or null when unknown. A future:
// the segments its periods list for `t`'s trading day, else TAIFEX's. Any other: its regular period, else its exchange's
// hours (hoursWindow), split around the exchange's lunch (regularSpans).
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
 * The share of `quote`'s trading day elapsed at `t`, in [0, 1], counting trading time only (a lunch break and the gap
 * between a future's sessions take none); null for a pair, FX or a Yahoo future (`=F`), or with neither periods nor
 * exchange hours. An earlier, finished day gives 1: a time before its period, any time while the quote's own time is
 * before its period's start (yesterday's bars under today's periods), and a period of zero length.
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
 * Where `quote`'s line and price fall in its box (chartGeometry draws them): `extent`, the share of the box the
 * line reaches, sessionProgress at its last point (`chartTimestamp`, else the quote's time); and `dot`, the price at
 * sessionProgress of its own time, when its trading day is known and no line is drawn or the line ends more than
 * DOT_AFTER_MS before it. null extent: the whole box.
 */
export function chartLayout(quote) {
  const lineEnd = quote.chartTimestamp ?? quote.timestamp;
  const extent = sessionProgress(quote, lineEnd);
  const behind = !quote.series?.length || quote.timestamp - lineEnd > DOT_AFTER_MS;
  if (!behind) return { extent, dot: null };
  const at = lineEnd === quote.timestamp ? extent : sessionProgress(quote, quote.timestamp);
  return { extent, dot: at === null ? null : { x: at, price: quote.price } };
}
