// node --test tests/  (chart.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  chartGeometry,
  chartLayout,
  crosshairAt,
  crosshairLabel,
  crosshairLevel,
  crosshairSpot,
  sessionProgress,
} from "../mods/wickline/chart.js";
import { LINE_PERIODS, TW_TODAY, at, day, lineQuote, taipei, withTZ, yq } from "./helpers.mjs";

// A line needs two points: a lone one with no rule and no dot draws nothing, so the detail shows no empty box.
test("a lone point is drawn only with a rule or a dot", () => {
  assert.equal(chartGeometry([2200], null), null);
  assert.equal(chartGeometry([2200], 0, { extent: 0.5 }), null);
  const ruled = chartGeometry([2200], 2190);
  assert.ok(ruled.reference !== null && ruled.reference > 0 && ruled.reference < 100);
  const dotted = chartGeometry([2200], null, { extent: 0.2, dot: { x: 0.5, price: 2210 } });
  assert.deepEqual([dotted.reference, dotted.dot[0]], [null, 50]);
});

test("A line without a rule has no runs", () => {
  assert.deepEqual(chartGeometry([10, 20], null).runs, []);
  assert.deepEqual(chartGeometry([10, 20], 0).runs, []);
});

test("A line on one side is one run of that side", () => {
  const above = chartGeometry([20, 25, 22], 15);
  assert.deepEqual(above.runs, [{ side: "gain", points: above.points }]);
  const below = chartGeometry([10, 12], 15);
  assert.deepEqual(below.runs, [{ side: "loss", points: below.points }]);
});

test("A line that crosses its previous close splits where it crosses", () => {
  const g = chartGeometry([10, 20], 15); // x 0, 100; crosses halfway
  const cross = [50, g.reference];
  assert.deepEqual(g.runs, [
    { side: "loss", points: [g.points[0], cross] },
    { side: "gain", points: [cross, g.points[1]] },
  ]);
  // The crossing follows the line's extent: a line over half the width crosses at a quarter.
  assert.equal(chartGeometry([10, 20], 15, { extent: 0.5 }).runs[0].points[1][0], 25);
});

test("A point on the rule joins the side it came from", () => {
  const back = chartGeometry([20, 15, 20], 15);
  assert.deepEqual(back.runs, [{ side: "gain", points: back.points }]);
  const through = chartGeometry([20, 15, 10], 15);
  assert.deepEqual(through.runs, [
    { side: "gain", points: [through.points[0], through.points[1]] },
    { side: "loss", points: [through.points[1], through.points[2]] },
  ]);
  // A line that starts on the rule takes the side it goes to.
  const start = chartGeometry([15, 15, 10], 15);
  assert.deepEqual(start.runs, [{ side: "loss", points: start.points }]);
  // A line wholly on the rule has no side.
  const flat = chartGeometry([15, 15], 15);
  assert.deepEqual(flat.runs, [{ side: "flat", points: flat.points }]);
});

test("Sides come from the prices, not the rounded positions", () => {
  const g = chartGeometry([100.000001, 99.999999], 100);
  assert.deepEqual(
    g.runs.map((run) => run.side),
    ["gain", "loss"],
  );
});

test("crosshairAt picks the nearest drawn point, the later one on a tie", () => {
  const g = chartGeometry([10, 20, 15], 15); // x 0, 50, 100
  const at = (share) => crosshairAt(g, [1, 2, 3], share)?.index;
  assert.deepEqual([at(0.24), at(0.25), at(0.26), at(0.9)], [0, 1, 1, 2]);
  assert.deepEqual(crosshairAt(g, [1, 2, 3], 0.5), { index: 1, x: 50, y: g.points[1][1] });
  assert.deepEqual([at(-0.2), at(1.3)], [0, 2]); // clamped
  assert.equal(crosshairAt(chartGeometry([10, 20], 15, { extent: 0 }), [1, 2], 0.4).index, 1);
});

test("Past a line that ends early: the crosshair holds on its last point", () => {
  const g = chartGeometry(
    Array.from({ length: 14 }, (_, i) => 2170 + i),
    2170,
    { extent: 0.25 },
  ); // 2330.TW 09:00…10:05
  assert.equal(
    crosshairAt(
      g,
      Array.from({ length: 14 }, (_, i) => taipei("09:00:00") + i * 300_000),
      0.6,
    ).index,
    13,
  );
});

test("crosshairAt refuses what it cannot place", () => {
  const g = chartGeometry([10, 20], 15);
  for (const [geometry, times, share] of [
    [null, [1, 2], 0.5],
    [chartGeometry([], 15), [], 0.5],
    [chartGeometry([], null, { dot: { x: 0, price: 15 } }), [], 0.5],
    [g, undefined, 0.5],
    [g, [1], 0.5],
    [g, [1, 2, 3], 0.5],
    [g, [1, 2], NaN],
    [g, [1, 2], Infinity],
  ]) {
    assert.equal(crosshairAt(geometry, times, share), null);
  }
});

test("crosshairAt reads the same share against a new line", () => {
  const long = chartGeometry(
    Array.from({ length: 1_140 }, (_, i) => 40_000 + i),
    null,
  );
  const short = chartGeometry([40_000, 40_010, 40_005], null, { extent: 0.01 });
  assert.equal(crosshairAt(long, Array(1_140).fill(0), 0.7).index, 797);
  assert.equal(crosshairAt(short, [0, 0, 0], 0.7).index, 2);
});

test("Reading a point: date, time, price and change against the previous close", () =>
  withTZ("Asia/Taipei", () => {
    const q = {
      symbol: "2330.TW",
      exchange: "TAI",
      price: 2180,
      previousClose: 2170,
      timestamp: taipei("10:40:00", "2026-11-20"),
      series: [2170, 2175, 2180],
      times: [taipei("10:31:00", "2026-11-20"), taipei("10:32:00", "2026-11-20"), taipei("10:40:00", "2026-11-20")],
    };
    const label = crosshairLabel(q, 1, "zh-TW");
    assert.deepEqual([label.time, label.price, label.change], ["11/20 10:32", "2,175.00", "+0.23%"]);
    assert.ok(Math.abs(label.percent - (5 / 2170) * 100) < 1e-12);
    assert.equal(crosshairLabel(q, 1, "en").time, "Nov 20 10:32");
    assert.deepEqual(crosshairLabel({ ...q, previousClose: null }, 1, "zh-TW"), {
      time: "11/20 10:32",
      price: "2,175.00",
      change: null,
      percent: null,
    });
  }));

test("A line across midnight: each point carries its own date", () =>
  withTZ("Asia/Taipei", () => {
    const sox = {
      symbol: "^SOX",
      price: 5_000,
      previousClose: 4_950,
      timestamp: taipei("05:00:00", "2026-11-20"),
      series: [4_960, 4_980, 5_000],
      times: [taipei("22:30:00", "2026-11-19"), taipei("23:00:00", "2026-11-19"), taipei("03:00:00", "2026-11-20")],
    };
    assert.equal(crosshairLabel(sox, 1, "zh-TW").time, "11/19 23:00");
    assert.equal(crosshairLabel(sox, 2, "zh-TW").time, "11/20 03:00");
    assert.equal(crosshairLabel(sox, 1, "en").time, "Nov 19 23:00");
  }));

test("Yesterday's line before the open: its points carry their date", () =>
  withTZ("Asia/Taipei", () => {
    const q = {
      symbol: "0050.TW",
      exchange: "TAI",
      price: 60,
      previousClose: 59.5,
      timestamp: taipei("13:30:00", "2026-11-19"),
      series: [59.8, 60],
      times: [taipei("11:55:00", "2026-11-19"), taipei("13:30:00", "2026-11-19")],
    };
    assert.equal(crosshairLabel(q, 0, "zh-TW").time, "11/19 11:55");
    assert.equal(crosshairLabel(q, 0, "en").time, "Nov 19 11:55");
    const pair = {
      symbol: "BTC/USDT",
      price: 91_000,
      previousClose: 90_000,
      timestamp: taipei("08:36:00", "2026-11-20"),
      series: [90_500, 91_000],
      times: [taipei("23:00:00", "2026-11-19"), taipei("00:15:00", "2026-11-20")],
    };
    assert.equal(crosshairLabel(pair, 0, "en").time, "Nov 19 23:00");
    assert.equal(crosshairLabel(pair, 1, "en").time, "Nov 20 00:15");
  }));

// A card's width: the wider of its time (6.5 px a character) and its price and change (7.5 px a character, 6 px
// between them), plus 12 px of padding.
test("Near the right edge the card sits on the line's left", () => {
  const card = { time: "10:32", price: "2,175.00", change: "+0.23%" }; // line 2: 14 characters + 6: 111 px; card 123 px
  assert.deepEqual(crosshairSpot(50, card, 400), { left: 206 }); // 6 px right of the line at 200
  assert.deepEqual(crosshairSpot(80, card, 400), { right: 86 }); // its right edge 6 px left of the line at 320, in any font
  const longest = { time: "Nov 18 22:15", price: "91,234.56", change: "+1.23%" }; // line 2: 118.5 px; card 130.5 px
  assert.deepEqual(crosshairSpot(100, longest, 404), { right: 6 }); // the single-column chart's right edge
  assert.deepEqual(crosshairSpot(75, longest, 388), { right: 103 }); // the two-column chart: fits only on the left
});

test("crosshairSpot holds a wide card inside the box, measured by its wider line", () => {
  const wide = { time: "Nov 18 22:15", price: "64,000.01", change: "+0.79%" }; // 130.5 px
  assert.deepEqual(crosshairSpot(50, wide, 250), { left: 0 }); // fits neither side
  assert.deepEqual(crosshairSpot(95, wide, 300), { right: 21 });
  assert.deepEqual(crosshairSpot(0, { time: "10:32", price: "2,175.00", change: null }, 0), { left: 0 });
  const dated = { time: "Nov 18 22:15", price: "1.00", change: null }; // the time is wider: 78 px; card 90 px
  assert.deepEqual(crosshairSpot(50, dated, 200), { left: 106 });
  assert.deepEqual(crosshairSpot(50, dated, 190), { left: 0 });
});

// A card's height: an 11 px and a 12 px line, 2 px apart, 4 px padding above and below: about 40 px.
test("The card's middle follows the point, held inside the box", () => {
  assert.deepEqual(crosshairLevel(50, 140), { top: 50 }); // its middle at the point's 70 px
  assert.deepEqual(crosshairLevel(20, 140), { top: 8 });
  assert.deepEqual(crosshairLevel(5, 140), { top: 0 }); // a peak: held at the top
  assert.deepEqual(crosshairLevel(95, 140), { bottom: 0 }); // a trough: held at the bottom by its own edge, in any font
  assert.deepEqual(crosshairLevel(50, 30), { top: 0 }); // a box shorter than the card
  const g = chartGeometry([10, 20, 15], 15);
  assert.deepEqual(crosshairLevel(crosshairAt(g, [1, 2, 3], 0.5).y, 140), { top: 0 });
});

// A line in its session: how far across its box a line reaches (sessionProgress, chartLayout), drawn by chartGeometry.
const NY_DAY = day("2026-11-17T14:30:00Z", "2026-11-17T21:00:00Z");
const HK_TODAY = day("2026-11-17T01:30:00Z", "2026-11-17T08:00:00Z");
const ny = (time) => at(`2026-11-17T${time}-05:00`);
const lastX = (g) => g.points.at(-1)[0];
const drawn = (q) => {
  const layout = chartLayout(q);
  return { layout, g: chartGeometry(q.series, q.previousClose, layout) };
};

test("sessionProgress: Taiwan mid-morning", () => {
  const q = yq("2330.TW", "TAI", taipei("10:07:30"), TW_TODAY);
  assert.equal(sessionProgress(q, taipei("10:07:30")), 0.25);
});

test("sessionProgress: US", () => {
  assert.equal(sessionProgress(yq("AAPL", "NMS", ny("12:45:00"), NY_DAY), ny("12:45:00")), 0.5);
});

test("sessionProgress: 0700.HK lunch takes no room", () => {
  assert.equal(sessionProgress(yq("0700.HK", "HKG", taipei("14:00:00"), HK_TODAY), taipei("14:00:00")), 210 / 330);
  // Inside the lunch break it stands at the morning's end.
  assert.equal(sessionProgress(yq("0700.HK", "HKG", taipei("12:30:00"), HK_TODAY), taipei("12:30:00")), 150 / 330);
});

test("sessionProgress: WTX& extent counts the night then the day", () => {
  const night = at("2026-11-09T07:02:00Z"); // 15:02 Taipei
  const morning = at("2026-11-10T02:00:00Z"); // 10:00 Taipei the next day
  const future = (timestamp, periods) => ({ symbol: "WTX&", source: "yahootw", timestamp, periods });
  for (const periods of [LINE_PERIODS, null]) {
    assert.equal(sessionProgress(future(morning, periods), night), 2 / 1140, `night ${Boolean(periods)}`);
    assert.equal(sessionProgress(future(morning, periods), morning), 915 / 1140, `day ${Boolean(periods)}`);
    // Between the sessions, the night is whole and the day not begun.
    assert.equal(sessionProgress(future(morning, periods), at("2026-11-10T00:00:00Z")), 840 / 1140);
  }
  // A future priced from periods without their segments takes TAIFEX's.
  const { segments: _segments, ...daily } = LINE_PERIODS;
  assert.equal(sessionProgress(future(morning, daily), morning), 915 / 1140);
});

test("sessionProgress: WTX& over a weekend", () => {
  // Saturday: Friday 23:00's price sits on Monday's trading day, whose night opened Friday 15:00.
  const q = { symbol: "WTX&", source: "yahootw", timestamp: taipei("23:00:00", "2026-11-20"), periods: null };
  assert.equal(sessionProgress(q, q.timestamp), 480 / 1140);
  assert.equal(
    chartLayout({ ...q, price: 27000, series: [26990, 27000], chartTimestamp: q.timestamp }).extent,
    480 / 1140,
  );
});

test("sessionProgress: a time before the period gives 1", () => {
  const q = yq("2330.TW", "TAI", taipei("10:00:00"), TW_TODAY);
  assert.equal(sessionProgress(q, taipei("08:38:00")), 1);
  assert.equal(sessionProgress(q, taipei("13:30:00")), 1);
  assert.equal(sessionProgress(q, taipei("20:00:00")), 1);
});

test("sessionProgress: yesterday's bars under today's periods fill the box", () => {
  const q = yq("2330.TW", "TAI", taipei("13:30:00", "2026-11-16"), TW_TODAY);
  for (const t of [taipei("10:00:00", "2026-11-16"), taipei("10:00:00"), taipei("13:30:00", "2026-11-16")]) {
    assert.equal(sessionProgress(q, t), 1);
  }
});

test("sessionProgress: hours only", () => {
  const q = { symbol: "2330.TW", source: "mis", timestamp: taipei("10:07:30") };
  assert.equal(sessionProgress(q, taipei("10:07:30")), 0.25);
  assert.equal(sessionProgress(q, taipei("08:38:00")), 1);
  assert.equal(sessionProgress(q, taipei("14:00:00")), 1);
  assert.equal(sessionProgress({ symbol: "AAPL", source: "finnhub", timestamp: ny("12:45:00") }, ny("12:45:00")), 0.5);
});

test("sessionProgress: null by kind", () => {
  const t = taipei("10:00:00");
  for (const q of [
    { symbol: "BTC/USDT", source: "binance", timestamp: t },
    yq("EURUSD=X", "CCY", t, day("2026-11-17T00:00:00Z", "2026-11-17T23:59:00Z")),
    yq("GC=F", "CMX", t, day("2026-11-16T23:00:00Z", "2026-11-17T22:00:00Z")),
    yq("KC=F", "NYB", t, day("2026-11-17T09:15:00Z", "2026-11-17T18:30:00Z")),
    yq("KC=F", undefined, t),
    // Neither periods nor exchange hours.
    yq("0700.HK", "HKG", t),
  ])
    assert.equal(sessionProgress(q, t), null, q.symbol);
});

test("sessionProgress: a zero-length period gives 1", () => {
  const traded = taipei("13:30:00", "2026-11-16");
  const q = yq("^TWII", "TAI", traded, { pre: null, regular: [traded, traded], post: null });
  for (const t of [traded, taipei("10:00:00")]) assert.equal(sessionProgress(q, t), 1);
});

test("A line in its session: mid-morning", () => {
  const { layout, g } = drawn(
    lineQuote({ ...yq("2330.TW", "TAI", taipei("10:07:30"), TW_TODAY), series: [2190, 2185, 2180, 2182, 2180] }),
  );
  assert.deepEqual(layout, { extent: 0.25, dot: null });
  assert.equal(lastX(g), 25);
  assert.ok(g.points.every(([x]) => x <= 25));
  assert.notEqual(g.reference, null);
  assert.equal(g.dot, null);
});

test("A line in its session: a future's night opens", () => {
  const time = at("2026-11-09T07:02:00Z");
  const q = lineQuote({
    symbol: "WTX&",
    source: "yahootw",
    timestamp: time,
    chartSource: "yahootw",
    chartTimestamp: time,
    periods: LINE_PERIODS,
  });
  const { layout, g } = drawn(q);
  assert.deepEqual(layout, { extent: 2 / 1140, dot: null });
  assert.equal(lastX(g), 0.18);
  assert.notEqual(g.reference, null);
});

test("A line in its session: a lunch break takes no room", () => {
  const { layout, g } = drawn(lineQuote(yq("0700.HK", "HKG", taipei("14:00:00"), HK_TODAY)));
  assert.equal(layout.extent, 210 / 330);
  assert.equal(lastX(g), 63.64);
});

test("A line in its session: a finished day", () => {
  // After the close, and at 08:38 the next morning, the line quote's time is the close: the box is full.
  const yahoo = lineQuote(yq("2330.TW", "TAI", taipei("13:30:00"), TW_TODAY));
  assert.equal(drawn(yahoo).layout.extent, 1);
  assert.equal(lastX(drawn(yahoo).g), 100);
  const mis = lineQuote({
    ...yahoo,
    source: "mis",
    timestamp: taipei("13:30:00"),
    chartSource: "yahoo",
    chartTimestamp: taipei("13:30:00"),
  });
  assert.deepEqual(drawn(mis).layout, { extent: 1, dot: null });
  // Hours only: yesterday's close read the next morning.
  const hoursOnly = lineQuote({ symbol: "2330.TW", source: "yahootw", timestamp: taipei("13:30:00", "2026-11-16") });
  assert.equal(drawn(hoursOnly).layout.extent, 1);
});

test("A line in its session: one point", () => {
  const { g } = drawn(lineQuote({ ...yq("2330.TW", "TAI", taipei("09:01:00"), TW_TODAY), series: [2190] }));
  assert.equal(g.points.length, 1);
  assert.equal(g.points[0][0], 0);
  assert.notEqual(g.reference, null);
});

test("A line in its session: crypto", () => {
  const q = {
    symbol: "BTC/USDT",
    source: "binance",
    timestamp: taipei("10:00:00"),
    price: 90000,
    previousClose: null,
    series: [89000, 90000],
  };
  const { layout, g } = drawn(q);
  assert.deepEqual(layout, { extent: null, dot: null });
  assert.equal(lastX(g), 100);
});

test("A price after its line: MIS over a late Yahoo Finance line", () => {
  const q = lineQuote({
    ...yq("2330.TW", "TAI", taipei("10:00:05"), TW_TODAY),
    source: "mis",
    price: 2200,
    chartSource: "yahoo",
    chartTimestamp: taipei("09:40:00"),
  });
  const { layout, g } = drawn(q);
  assert.equal(layout.extent, 40 / 270);
  assert.deepEqual(layout.dot, { x: (60 * 60 + 5) / (270 * 60), price: 2200 });
  assert.equal(lastX(g), 14.81);
  assert.equal(g.dot[0], 22.25);
  assert.ok(g.dot[1] > 0 && g.dot[1] < 100);
  // 2200, the highest price, sits above every point of the line.
  assert.ok(g.points.every(([, y]) => y > g.dot[1]));
});

test("A price after its line: before Yahoo Finance's first bar", () => {
  const q = lineQuote({
    ...yq("2330.TW", "TAI", taipei("09:05:00"), TW_TODAY),
    source: "mis",
    series: [],
    chartSource: null,
    chartTimestamp: null,
  });
  const { layout, g } = drawn(q);
  assert.equal(layout.dot.x, 5 / 270);
  assert.deepEqual(g.points, []);
  assert.notEqual(g.reference, null);
  assert.equal(g.dot[0], 1.85);
});

test("A price after its line: a line one bar behind", () => {
  const q = lineQuote({
    ...yq("AAPL", "NMS", ny("10:03:00"), NY_DAY),
    source: "finnhub",
    chartSource: "yahoo",
    chartTimestamp: ny("10:00:00"),
  });
  assert.equal(chartLayout(q).dot, null);
  // Past 5 minutes it is drawn; at exactly 5 it is not.
  assert.equal(chartLayout({ ...q, timestamp: ny("10:05:00") }).dot, null);
  assert.notEqual(chartLayout({ ...q, timestamp: ny("10:05:01") }).dot, null);
});

test("A price after its line: a future without its day's line", () => {
  const time = at("2026-11-09T07:00:40Z"); // 15:00:40 Taipei
  const q = lineQuote({
    symbol: "WTX&",
    source: "yahootw",
    timestamp: time,
    periods: LINE_PERIODS,
    series: [],
    chartSource: null,
    chartTimestamp: null,
  });
  const { layout, g } = drawn(q);
  assert.equal(layout.dot.x, 40 / (1140 * 60));
  assert.equal(g.dot[0], 0.06);
  assert.notEqual(g.reference, null);
});

test("A price after its line: Yahoo 奇摩股市's own line", () => {
  const time = taipei("10:30:00");
  const q = lineQuote({
    ...yq("0050.TW", "TAI", time, TW_TODAY),
    source: "yahootw",
    chartSource: "yahootw",
    chartTimestamp: time,
  });
  assert.equal(chartLayout(q).dot, null);
});

test("A price after its line: none where the trading day is unknown", () => {
  const q = { ...yq("0700.HK", "HKG", taipei("14:00:00")), price: 400, previousClose: 390, series: [] };
  assert.deepEqual(chartLayout(q), { extent: null, dot: null });
  assert.equal(chartGeometry(q.series, q.previousClose, chartLayout(q)).dot, null);
});
