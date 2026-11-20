// node --test tests/  (format.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  changeTone,
  chartGeometry,
  collapsedRow,
  dayFor,
  detailTimes,
  bandCurrency,
  failureNote,
  formatChange,
  formatPrice,
  formatStaleDate,
  formatTime,
  freshnessLabel,
  isFlat,
  number,
  rowName,
  signed,
} from "../mods/wickline/format.js";
import { compact, formatAmount, formatCount, formatSize, secondRow } from "../mods/wickline/format.js";
import { activityCells, amplitude, formatShare, innerOuter } from "../mods/wickline/format.js";
import { bookTotals, detailBook, formatSignedCount, ladder } from "../mods/wickline/format.js";
import { decodeStockList } from "../mods/wickline/providers/yahootw.js";
import { formatDate, nextDayTurn, sessionTimesParts, stateText } from "../mods/wickline/format.js";
import { crosshairAt, crosshairLabel, crosshairLevel, crosshairSpot, lineDate } from "../mods/wickline/format.js";
import { decodeKlines } from "../mods/wickline/providers/binance.js";
import { detailSource, freshness, sessionName, sessionOf, sessionTimes } from "../mods/wickline/freshness.js";
import { CLOSE_1224, at, day, jsonFixture, ok, say, taipei, withTZ } from "./helpers.mjs";
import { t } from "../mods/wickline/i18n.js";

test("formats without Intl", () => {
  assert.equal(formatPrice({ price: 1234567.891, currency: "USD" }), "1,234,567.89 USD");
  assert.equal(formatPrice({ price: 0.00000441, currency: null }), "0.00000441");
  assert.equal(formatPrice({ price: 0.5, currency: null }), "0.50");
  assert.equal(formatPrice({ price: 0.123456, currency: null }), "0.1235");
  // The band draws its currency apart, so a lit price's block holds the digits only.
  assert.equal(bandCurrency({ symbol: "2330.TW", currency: "TWD" }), "TWD");
  assert.equal(bandCurrency({ symbol: "AAPL", currency: "USD" }), null);
  assert.equal(bandCurrency({ symbol: "BTC/USDT", currency: "USDT" }), null);
  assert.equal(formatChange(1.234), "+1.23%");
  assert.equal(formatChange(-0.5), "-0.50%");
  assert.equal(formatChange(null), "—");
  const now = new Date(2026, 10, 2, 12).getTime();
  assert.equal(formatStaleDate({ symbol: "AAPL", timestamp: new Date(2026, 10, 2, 9).getTime() }, now), "");
  assert.equal(formatStaleDate({ symbol: "AAPL", timestamp: new Date(2026, 9, 31, 16).getTime() }, now), "Oct 31");
});

test("signed: the day's change in the price's units", () => {
  assert.equal(signed({ price: 2260, previousClose: 2135, currency: "TWD" }), "+125.00");
  assert.equal(signed({ price: 98.2, previousClose: 92.5 }), "+5.70");
  // Below 1 the change keeps the price's significant digits.
  assert.equal(signed({ price: 0.00000441, previousClose: 0.00000429 }), "+0.00000012");
  assert.equal(signed({ price: 2135, previousClose: 2260 }), "-125.00");
  assert.equal(signed({ price: 2260 }), "—");
  // From 1 up the change keeps the price's 2 decimals: a price with float noise is flat, not +0.000004272.
  assert.equal(signed({ price: 227.52000427246094, previousClose: 227.52 }), "0.00");
  assert.equal(signed({ price: 100.004, previousClose: 100 }), "0.00");
  assert.equal(signed({ price: 1.15, previousClose: 1.1 }), "+0.05");
  assert.equal(signed({ price: 91234.56, previousClose: 90000 }), "+1,234.56");
  assert.equal(number({ price: 2260, currency: "TWD" }), "2,260.00");
});

test("a flat day has no sign", () => {
  assert.equal(signed({ price: 100, previousClose: 100 }), "0.00");
  assert.equal(formatChange(-0.001), "0.00%");
  assert.equal(formatChange(0), "0.00%");
});

test("a flat change is neither up nor down", () => {
  for (const flat of [-0.001, 0, 0.004]) assert.equal(isFlat(flat), true, String(flat));
  for (const moved of [0.005, -1.2, null]) assert.equal(isFlat(moved), false, String(moved));
});

test("the change's tone", () => {
  assert.equal(changeTone(null), "none");
  assert.equal(changeTone(undefined), "none");
  assert.equal(changeTone(-0.001), "flat");
  assert.equal(changeTone(0), "flat");
  assert.equal(changeTone(0.01), "up");
  assert.equal(changeTone(-0.01), "down");
});

test("change and percent agree for one quote", () => {
  const quote = { price: 2260, previousClose: 2135 };
  assert.equal(signed(quote), "+125.00");
  assert.equal(formatChange(((quote.price - quote.previousClose) / quote.previousClose) * 100), "+5.85%");
});

test("dates by language, times in 24 hours", () => {
  const now = new Date(2026, 10, 2, 12).getTime();
  const oct31 = { symbol: "AAPL", timestamp: new Date(2026, 9, 31, 16).getTime() };
  assert.equal(formatStaleDate(oct31, now, "en"), "Oct 31");
  for (const lang of ["zh-TW", "zh-CN", "ja", "ko"]) assert.equal(formatStaleDate(oct31, now, lang), "10/31", lang);
  assert.equal(formatStaleDate({ symbol: "AAPL", timestamp: new Date(2026, 10, 2, 9).getTime() }, now, "zh-TW"), "");
  assert.equal(formatTime(new Date(2026, 10, 2, 21, 5, 7).getTime()), "21:05");
  assert.equal(formatTime(new Date(2026, 10, 2, 9, 5, 7).getTime(), true), "09:05:07");
});

// A line needs two points: a lone one with no rule and no dot draws nothing, so the detail shows no empty box.
test("a lone point is drawn only with a rule or a dot", () => {
  assert.equal(chartGeometry([2200], null), null);
  assert.equal(chartGeometry([2200], 0, { extent: 0.5 }), null);
  const ruled = chartGeometry([2200], 2190);
  assert.ok(ruled.reference !== null && ruled.reference > 0 && ruled.reference < 100);
  const dotted = chartGeometry([2200], null, { extent: 0.2, dot: { x: 0.5, price: 2210 } });
  assert.deepEqual([dotted.reference, dotted.dot[0]], [null, 50]);
});

test("scales a line into its box", () => {
  // One point: the rule and the point at the left edge.
  const one = chartGeometry([1], 1);
  assert.deepEqual(
    one.points.map((p) => p[0]),
    [0],
  );
  assert.notEqual(one.reference, null);
  assert.equal(one.dot, null);
  const g = chartGeometry([10, 20], 15);
  assert.deepEqual(
    g.points.map((p) => p[0]),
    [0, 100],
  );
  assert.equal(g.dot, null);
  // Points spread over the extent only; a null extent is the whole box, 0 keeps them at the left edge.
  assert.deepEqual(
    chartGeometry([10, 20, 15], 15, { extent: 0.25 }).points.map((p) => p[0]),
    [0, 12.5, 25],
  );
  assert.deepEqual(
    chartGeometry([10, 20], 15, { extent: null }).points.map((p) => p[0]),
    [0, 100],
  );
  assert.deepEqual(
    chartGeometry([10, 20], 15, { extent: 0 }).points.map((p) => p[0]),
    [0, 0],
  );
  // The dot's price is inside the y range: above every point here, still inside the box.
  const dotted = chartGeometry([10, 20], 15, { extent: 0.25, dot: { x: 0.5, price: 30 } });
  assert.equal(dotted.dot[0], 50);
  assert.ok(dotted.dot[1] > 0 && dotted.dot[1] < 100);
  assert.ok(dotted.points.every(([, y]) => y > dotted.dot[1]));
  // No points: the rule alone, the dot alone, or nothing.
  assert.deepEqual(chartGeometry([], 15).points, []);
  assert.notEqual(chartGeometry([], 15).reference, null);
  assert.deepEqual(chartGeometry([], null, { dot: { x: 0, price: 15 } }).dot, [0, 50]);
  assert.equal(chartGeometry([], null), null);
  assert.equal(chartGeometry(undefined, 0), null);
  assert.ok(g.points[0][1] > g.points[1][1]);
  assert.ok(g.reference > g.points[1][1] && g.reference < g.points[0][1]);
  assert.ok(g.points.every(([, y]) => y > 0 && y < 100));
  const flat = chartGeometry([5, 5, 5], null);
  assert.equal(flat.reference, null);
  assert.equal(flat.points[0][1], 50);
  assert.match(formatTime(new Date(2026, 10, 2, 9, 5).getTime()), /^09:05$/);
});

test("a name that begins with the live label keeps both", () => {
  const live = t("en", "freshness.live");
  assert.deepEqual(rowName("LYV", live, "Live Nation Entertainment"), {
    label: "Live",
    name: "Live Nation Entertainment",
  });
});

test("a pair has no instrument name: its venue never becomes a name line", () => {
  assert.deepEqual(rowName("BTC/USDT", "Live", "Binance Spot"), { label: "Live", name: "" });
  assert.deepEqual(rowName("BTC/USDT", "quote stopped at 13:05", "Binance Spot"), {
    label: "quote stopped at 13:05",
    name: "",
  });
});

test("a stock's name gets its own line", () => {
  assert.deepEqual(rowName("2330.TW", "已收盤 · 11/5 13:30", "台積電"), {
    label: "已收盤 · 11/5 13:30",
    name: "台積電",
  });
  // Finnhub keeps the Yahoo name, so a US row reads the same with either source.
  assert.deepEqual(rowName("AAPL", "Finnhub", "Apple Inc."), { label: "Finnhub", name: "Apple Inc." });
  assert.deepEqual(rowName("AAPL", "Yahoo · delayed", "Apple Inc."), { label: "Yahoo · delayed", name: "Apple Inc." });
});

test("a row's name that only repeats the ticker, or is missing, is left out", () => {
  assert.deepEqual(rowName("^GSPC", "delayed 15 min", "^GSPC"), { label: "delayed 15 min", name: "" });
  assert.deepEqual(rowName("AAPL", "Yahoo", null), { label: "Yahoo", name: "" });
});

test("the live label names the state, not the source", () => {
  const now = new Date(2026, 10, 9, 9, 41, 20).getTime();
  const at = (source, symbol) => ({ symbol, source, timestamp: now - 10_000 });
  for (const lang of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
    const tx = (key, params) => t(lang, key, params);
    const label = (quote, session) => freshnessLabel(quote, freshness(quote, session, now), now, lang, tx);
    for (const [source, symbol, session] of [
      ["mis", "2330.TW", "open"],
      ["yahootw", "2330.TW", "open"],
      ["finnhub", "AAPL", "open"],
      ["binance", "BTC/USDT", "24h"],
    ]) {
      assert.equal(label(at(source, symbol), session), t(lang, "freshness.live"), `${lang} ${source}`);
    }
    // A session not known yet keeps the source name: nothing says it is live.
    assert.equal(label(at("mis", "2330.TW"), "unknown"), t(lang, "src.mis"), lang);
    assert.equal(
      label({ ...at("yahootw", "2330.TW"), timestamp: now - 180_000 }, "open"),
      t(lang, "freshness.stalled", { time: formatTime(now - 180_000) }),
      lang,
    );
  }
});

test("the detail times: quoted, the last trade when it differs, fetched", () => {
  const tx = (key, params) => t("en", key, params);
  const at = (h, m, s) => new Date(2026, 10, 9, h, m, s).getTime();
  const now = at(9, 41, 20);
  // 0050.TW from Yahoo 奇摩股市: quoted at the feed's time, its own last trade earlier.
  const quiet = { symbol: "AAPL", timestamp: at(9, 41, 13), tradeTime: at(9, 17, 12), fetchedAt: at(9, 41, 19) };
  assert.deepEqual(detailTimes(quiet, now, "en", tx), ["Quote at 09:41:13", "last trade 09:17:12", "Fetched 09:41:19"]);
  assert.deepEqual(detailTimes({ ...quiet, tradeTime: quiet.timestamp }, now, "en", tx), [
    "Quote at 09:41:13",
    "Fetched 09:41:19",
  ]);
  const { tradeTime, ...plain } = quiet;
  assert.deepEqual(detailTimes(plain, now, "en", tx), ["Quote at 09:41:13", "Fetched 09:41:19"]);
  // An earlier day puts its date before the quote time.
  assert.deepEqual(
    detailTimes({ ...plain, timestamp: at(9, 41, 13) - 86_400_000 }, now, "en", tx)[0],
    "Quote at Nov 8 09:41:13",
  );
});

test("a row collapses only when it has no price and its fetch failed", () => {
  const notFound = { code: "yahoo.notFound", params: {} };
  assert.equal(collapsedRow({ quote: null, failed: notFound }), true);
  assert.equal(collapsedRow({ quote: undefined, failed: { code: "request.timeout", params: {} } }), true);
  // Waiting for its first quote: keeps the grid, so a price arriving moves nothing.
  assert.equal(collapsedRow({ quote: null, failed: undefined }), false);
  // Only the real-time source failed: still waiting for the base.
  assert.equal(
    collapsedRow({ quote: null, failed: undefined, fallback: { code: "request.timeout", params: {} } }),
    false,
  );
  // Cached: a price from an earlier round with an error keeps the grid and its cached note.
  assert.equal(collapsedRow({ quote: { symbol: "2330.TW", price: 1000 }, failed: notFound }), false);
});

// A Taiwan quote's day is Taipei's (dayFor), not the local date: on a London clock, 23:30 on 11/1 is the same Taipei day
// as 12:00 on 11/2, and 10:00 on 11/2 an earlier Taipei day than 18:00 (11/3 02:00 in Taipei).
test("formatStaleDate and detailTimes compare by the quote's own day", () => {
  const tx = (key, params) => t("en", key, params);
  withTZ("Europe/London", () => {
    const now = at("2026-11-02T12:00:00Z");
    const earlier = at("2026-11-01T23:30:00Z");
    assert.equal(formatStaleDate({ symbol: "2330.TW", timestamp: earlier }, now, "en"), "");
    assert.equal(
      formatStaleDate({ symbol: "2330.TW", timestamp: at("2026-11-02T10:00:00Z") }, at("2026-11-02T18:00:00Z"), "en"),
      "Nov 2",
    );
    assert.deepEqual(
      detailTimes({ symbol: "2330.TW", timestamp: earlier, fetchedAt: now }, now, "en", tx)[0],
      `Quote at ${formatTime(earlier, true)}`,
    );
  });
  const earlier = new Date(2026, 9, 31, 16).getTime();
  assert.deepEqual([formatDate(earlier, "en"), formatDate(earlier, "zh-TW")], ["Oct 31", "10/31"]);
});

test("an unconfirmed state has no word of its own", () => {
  assert.equal(
    stateText({ state: "unconfirmed" }, (key) => key),
    null,
  );
  assert.equal(
    stateText({ state: "closed" }, (key) => key),
    "session.closed",
  );
});

test("the session times line, per market kind, in local time", () => {
  const zh = (key, params) => t("zh-TW", key, params);
  const en = (key, params) => t("en", key, params);
  const line = (quote, now, tx = zh) => sessionTimesParts(sessionTimes(quote, now), tx === en ? "en" : "zh-TW", tx);
  const nov = at("2026-11-10T02:00:00Z");
  const tw = { symbol: "2330.TW", exchange: "TAI", periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z") };
  const wtx = { symbol: "WTX&", periods: null };
  const hk = { symbol: "0700.HK", exchange: "HKG", periods: day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z") };
  const aapl = { symbol: "AAPL", exchange: "NMS", periods: day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z") };
  withTZ("Asia/Taipei", () => {
    assert.deepEqual(line(tw, nov), ["交易時段：09:00–13:30"]);
    assert.deepEqual(line(wtx, nov), ["交易時段：日盤 08:45–13:45", "夜盤 15:00–05:00"]);
    assert.deepEqual(line(hk, nov), ["交易時段：09:30–12:00", "13:00–16:00"]);
    assert.deepEqual(line(aapl, nov), ["交易時段：22:30–05:00"]);
    // Before its Yahoo quote: the US hours.
    assert.deepEqual(line({ symbol: "AAPL", source: "finnhub", periods: null }, at("2026-11-10T15:00:00Z")), [
      "交易時段：22:30–05:00",
    ]);
    assert.deepEqual(line({ symbol: "AAPL", source: "finnhub", periods: null }, at("2026-07-15T15:00:00Z")), [
      "交易時段：21:30–04:00",
    ]);
    assert.deepEqual(
      line({ ...aapl, periods: day("2026-07-15T13:30:00Z", "2026-07-15T20:00:00Z") }, at("2026-07-15T15:00:00Z")),
      ["交易時段：21:30–04:00"],
    );
    assert.deepEqual(line({ symbol: "BTC/USDT", periods: null }, nov), ["交易時段：24 小時"]);
    assert.deepEqual(
      line({ symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z") }, nov),
      ["交易時段：24 小時"],
    );
    assert.deepEqual(
      line({ symbol: "ES=F", exchange: "CME", periods: day("2026-11-09T23:00:00Z", "2026-11-10T22:00:00Z") }, nov),
      ["交易時段：07:00–06:00"],
    );
    assert.deepEqual(line({ symbol: "^N225", exchange: "OSA", periods: null }, nov), []);
    // Taiwan reads TWSE's hours whatever its periods say (a TW-only index from Friday's close, on Saturday).
    const friday = at("2026-11-13T05:30:00Z");
    const saturday = at("2026-11-14T02:00:00Z");
    assert.deepEqual(
      line(
        { symbol: "^TWOII", exchange: "TWO", periods: { pre: null, regular: [friday, friday], post: null } },
        saturday,
      ),
      ["交易時段：09:00–13:30"],
    );
    // A lunch split on the session's own day: a Saturday detail with Friday's periods.
    assert.deepEqual(line({ ...hk, periods: day("2026-11-13T01:30:00Z", "2026-11-13T08:00:00Z") }, saturday), [
      "交易時段：09:30–12:00",
      "13:00–16:00",
    ]);
    assert.deepEqual(line(wtx, nov, en), ["Trading hours: Day 08:45–13:45", "Night 15:00–05:00"]);
    assert.deepEqual(line({ symbol: "BTC/USDT", periods: null }, nov, en), ["Trading hours: 24 hours"]);
  });
  withTZ("Europe/London", () => {
    assert.deepEqual(line(tw, nov), ["交易時段：01:00–05:30"]);
    assert.deepEqual(line(wtx, nov), ["交易時段：日盤 00:45–05:45", "夜盤 07:00–21:00"]);
  });
});

test('a Taiwan row\'s "today" is the Taipei date, printed in local time', () => {
  const zh = (key, params) => t("zh-TW", key, params);
  const closed = { state: "closed", delayMinutes: null, stoppedAt: null };
  const friday = at("2026-11-13T05:30:00Z"); // 13:30 Taipei Friday
  const tw = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: friday, fetchedAt: friday };
  const us = { ...tw, symbol: "AAPL", exchange: "NMS" };
  withTZ("Europe/London", () => {
    const now = at("2026-11-13T23:00:00Z"); // 23:00 London Friday, 07:00 Taipei Saturday
    assert.equal(freshnessLabel(tw, closed, now, "zh-TW", zh), "已收盤 · 11/13 05:30");
    assert.equal(freshnessLabel(us, closed, now, "zh-TW", zh), "已收盤 · 05:30");
  });
  withTZ("America/New_York", () => {
    const now = at("2026-11-14T02:00:00Z"); // 21:00 New York Friday, 10:00 Taipei Saturday
    assert.equal(formatStaleDate(tw, now, "zh-TW"), "11/13");
    assert.equal(detailTimes(tw, now, "zh-TW", zh)[0], "報價 11/13 00:30:00");
    assert.equal(formatStaleDate(us, now, "zh-TW"), "");
    assert.equal(dayFor({ symbol: "WTX&" })(friday), dayFor(tw)(friday));
  });
});

test("the 休市 label and the closed day's session times", () => {
  withTZ("Asia/Taipei", () => {
    const zh = (key, params) => t("zh-TW", key, params);
    const en = (key, params) => t("en", key, params);
    const holiday = { state: "holiday", delayMinutes: null, stoppedAt: null };
    const q = {
      symbol: "2330.TW",
      source: "yahoo",
      exchange: "TAI",
      timestamp: CLOSE_1224,
      closure: { kind: "listed", reason: "行憲紀念日" },
    };
    const now = at("2026-12-25T02:00:00Z");
    assert.equal(freshnessLabel(q, holiday, now, "zh-TW", zh), "休市 · 12/24 13:30");
    assert.equal(freshnessLabel(q, holiday, now, "en", en), "No trading · Dec 24 13:30");
    assert.equal(
      freshnessLabel({ ...q, timestamp: at("2026-12-24T20:59:00Z") }, holiday, now, "zh-TW", zh),
      "休市 · 04:59",
    );
    assert.deepEqual(sessionTimesParts(sessionTimes(q, now), "zh-TW", zh), ["交易時段：今日休市", "行憲紀念日"]);
    assert.deepEqual(sessionTimesParts(sessionTimes(q, now), "en", en), ["Trading hours: Closed today"]);
    assert.deepEqual(
      sessionTimesParts(
        sessionTimes({ symbol: "WTX&", periods: null, closure: { kind: "nightRemoved" } }, at("2026-12-25T18:00:00Z")),
        "zh-TW",
        zh,
      ),
      ["交易時段：日盤 08:45–13:45", "夜盤休市"],
    );
  });
});

test("the 今日無成交 label, header and session times", () => {
  withTZ("Asia/Taipei", () => {
    const zh = (key, params) => t("zh-TW", key, params);
    const en = (key, params) => t("en", key, params);
    const now = at("2026-11-11T01:00:00Z"); // 09:00 on a normal Wednesday
    const wtx = {
      symbol: "WTX&",
      source: "yahootw",
      price: 42604,
      timestamp: at("2026-11-10T20:59:00Z"),
      periods: null,
      chartSource: "yahootw",
      closure: { kind: "noTrades", source: "yahootw" },
    }; // stuck at 04:59, the same Taipei day
    assert.equal(sessionOf(wtx, now), "noTrades");
    const fresh = freshness(wtx, "noTrades", now);
    assert.deepEqual(fresh, { state: "noTrades", delayMinutes: null, stoppedAt: null });
    assert.equal(freshnessLabel(wtx, fresh, now, "zh-TW", zh), "今日無成交 · 11/11 04:59"); // the date, though it is today
    assert.equal(freshnessLabel(wtx, fresh, now, "en", en), "No trades today · Nov 11 04:59");
    assert.equal(t("zh-TW", `session.${sessionName(wtx, "noTrades", now)}`), "今日無成交");
    assert.deepEqual(detailSource(wtx, "noTrades", now, zh), [
      ["價格：今日無成交 · Yahoo 奇摩股市"],
      ["走勢：今日無成交 · Yahoo 奇摩股市"],
    ]);
    // Yahoo Finance alone, a delayed source on a closed day: the header 今日無成交, never 休市, and
    // the delayed line keeps its text.
    const base = {
      symbol: "2330.TW",
      source: "yahoo",
      exchange: "TAI",
      timestamp: at("2026-11-10T05:30:00Z"),
      closure: { kind: "noTrades", source: "yahoo" },
    };
    assert.equal(t("zh-TW", `session.${sessionName(base, "noTrades", now)}`), "今日無成交");
    assert.deepEqual(detailSource(base, "noTrades", now, zh), [["Yahoo Finance · 一般交易時段", "延遲 20 分鐘"]]);
    assert.deepEqual(sessionTimesParts(sessionTimes(wtx, now), "zh-TW", zh), ["交易時段：今日尚無成交，可能休市"]);
    assert.deepEqual(sessionTimesParts(sessionTimes(wtx, now), "en", en), [
      "Trading hours: No trades yet today; the market may be closed",
    ]);
    const night = {
      ...wtx,
      timestamp: at("2026-11-11T05:45:00Z"),
      closure: { kind: "nightNoTrades", source: "yahootw" },
    };
    const later = at("2026-11-11T07:10:00Z"); // 15:10
    assert.equal(sessionOf(night, later), "closed");
    assert.equal(freshnessLabel(night, freshness(night, "closed", later), later, "zh-TW", zh), "已收盤 · 13:45");
    assert.deepEqual(sessionTimesParts(sessionTimes(night, later), "zh-TW", zh), [
      "交易時段：日盤 08:45–13:45",
      "夜盤尚無成交",
    ]);
  });
});

test("the failure note names what is cached: the price first, else the line; none on the price's own line or without an error", () => {
  const error = { code: "request.timeout", params: {} };
  assert.equal(failureNote({ cached: true, chartCached: true }, error), "quote.cached");
  assert.equal(failureNote({ chartCached: true }, error), "quote.chartCached");
  assert.equal(failureNote({ source: "yahootw", chartSource: "yahootw" }, error), null);
  assert.equal(failureNote({ cached: true, chartCached: true }, null), null);
});

test("the failure note keeps the reason alone on a row whose line is not its price's and holds nothing cached", () => {
  const error = { code: "request.timeout", params: {} };
  // A MIS price with no Yahoo Finance quote under it: no line at all.
  assert.equal(failureNote({ source: "mis", chartSource: null }, error), "reason");
  assert.equal(failureNote({ source: "finnhub" }, error), "reason");
  assert.equal(failureNote({ source: "mis", chartSource: null }, null), null);
});

test("nextDayTurn: Taipei midnight for a Taiwan row, the local one for others, over DST", () => {
  const aapl = { symbol: "AAPL", exchange: "NMS" };
  withTZ("America/New_York", () => {
    assert.equal(nextDayTurn(aapl, at("2026-03-08T16:00:00Z")), at("2026-03-09T04:00:00Z")); // a 23 h day
    assert.equal(nextDayTurn(aapl, at("2026-11-01T17:00:00Z")), at("2026-11-02T05:00:00Z")); // a 25 h day
    assert.equal(nextDayTurn({ symbol: "2330.TW" }, at("2026-11-10T20:00:00Z")), at("2026-11-11T16:00:00Z"));
  });
  withTZ("America/Santiago", () => {
    // 2026-09-06 has no 00:00: the day turns at 01:00 (04:00Z).
    assert.equal(nextDayTurn(aapl, at("2026-09-06T02:30:00Z")), at("2026-09-06T04:00:00Z"));
    // 2026-04-04 runs 23:00-24:00 twice: the turn is the second 24:00 (04:00Z), never the first 23:00.
    assert.equal(nextDayTurn(aapl, at("2026-04-05T02:30:00Z")), at("2026-04-05T04:00:00Z"));
  });
  // A London clock turns AAPL at London midnight and 2330.TW at Taipei midnight.
  withTZ("Europe/London", () => {
    const time = at("2026-11-10T12:00:00Z");
    assert.equal(nextDayTurn(aapl, time), at("2026-11-11T00:00:00Z"));
    assert.equal(nextDayTurn({ symbol: "2330.TW" }, time), at("2026-11-10T16:00:00Z"));
  });
});

const AAPL_Q = {
  symbol: "AAPL",
  price: 230,
  previousClose: 225,
  currency: "USD",
  volume: 48_213_500,
  sizeUnit: "share",
};
const BTC_Q = {
  symbol: "BTC/USDT",
  price: 65_000,
  previousClose: 64_000,
  currency: "USDT",
  volume: 1234.5,
  sizeUnit: "BTC",
};
const text = (cell) => [cell.label, cell.value, cell.unit].filter(Boolean).join(" ");

test("counts and amounts are grouped by hand", () => {
  assert.equal(formatCount(42269), "42,269");
  assert.equal(formatCount(41999.6), "42,000");
  assert.equal(formatCount(0), "0");
  assert.equal(formatAmount(1234.5), "1,234.5");
  assert.equal(formatAmount(1234), "1,234");
  assert.equal(formatAmount(0.125), "0.13");
  assert.equal(formatAmount(1234.004), "1,234");
});

test("Another market", () => {
  assert.equal(text(secondRow(AAPL_Q, false, "en", say("en"))[0]), "Volume 48.2M");
  assert.deepEqual(
    secondRow(BTC_Q, false, "en", say("en")).map((c) => c && text(c)),
    ["24h volume 1,234.5 BTC", null, null],
  );
  assert.deepEqual(
    secondRow(AAPL_Q, false, "en", say("en")).map((c) => c && text(c)),
    ["Volume 48.2M", null, null, null],
  );
});

test("Detail at limit-up", () => {
  const q = { symbol: "6488.TWO", price: 563, previousClose: 512, limitUp: 563, limitDown: 461 };
  assert.deepEqual(
    secondRow(q, false, "zh-TW", say("zh-TW")).map((c) => c && text(c)),
    [null, "漲停價 563.00", "跌停價 461.00", null],
  );
});

test("Limits without the limit", () => {
  const q = { symbol: "2330.TW", price: 2240, previousClose: 2170, limitUp: 2345, limitDown: 1925 };
  const row = secondRow(q, false, "zh-TW", say("zh-TW"));
  assert.equal(text(row[1]), "漲停價 2,345.00");
  assert.equal(text(row[2]), "跌停價 1,925.00");
  // A stock without daily limits (MIS's 9999.95) has none to show.
  assert.equal(secondRow({ ...q, limitUp: 9999.95, limitDown: null }, false, "zh-TW", say("zh-TW")), null);
});

test("Layout unchanged", () => {
  assert.equal(secondRow({ symbol: "^GSPC", price: 6000, previousClose: 5990 }, false, "en", say("en")), null);
});

test("The change amount beside the change", () => {
  const q = { price: 2175, previousClose: 2170 };
  assert.equal(signed(q), "+5.00");
  assert.equal(formatChange((5 / 2170) * 100), "+0.23%");
  assert.equal(changeTone((5 / 2170) * 100), "up");
});

test("compact promotes at a unit's edge", () => {
  assert.deepEqual(compact(999_950, "en"), { value: "1.0M", unit: "" });
  assert.deepEqual(compact(99_999_999, "zh-TW", 2), { value: "1.00", unit: "億" });
  assert.deepEqual(compact(48_213_500, "zh-TW"), { value: "4,821.35", unit: "萬" });
  assert.deepEqual(compact(9_999, "zh-TW"), { value: "9,999", unit: "" });
});

test("compact by language", () => {
  assert.deepEqual(compact(48_213_500, "en"), { value: "48.2M", unit: "" });
  assert.deepEqual(compact(1_500, "en"), { value: "1.5K", unit: "" });
  assert.deepEqual(compact(999, "en"), { value: "999", unit: "" });
  assert.deepEqual(compact(2_345_000_000, "en"), { value: "2.3B", unit: "" });
  assert.deepEqual(compact(1_500_000_000_000, "en"), { value: "1,500.0B", unit: "" });
  assert.deepEqual(compact(48_213_500, "zh-CN"), { value: "4,821.35", unit: "万" });
  assert.deepEqual(compact(48_213_500, "ja"), { value: "4,821.35", unit: "万" });
  assert.deepEqual(compact(48_213_500, "ko"), { value: "4,821.35", unit: "만" });
  assert.deepEqual(compact(1_234_567_890, "zh-TW"), { value: "12.35", unit: "億" });
  assert.deepEqual(compact(1_234_567_890, "ja"), { value: "12.35", unit: "億" });
  assert.deepEqual(compact(1_234_567_890, "ko"), { value: "12.35", unit: "억" });
  assert.deepEqual(compact(1_234_567_890, "zh-CN"), { value: "12.35", unit: "亿" });
});

test("sizes by unit and language", () => {
  assert.deepEqual(formatSize(42269, "lot", "zh-TW", say("zh-TW")), { value: "42,269", unit: "張" });
  assert.deepEqual(formatSize(42269, "lot", "en", say("en")), { value: "42,269", unit: "lots" });
  assert.equal(formatSize(1, "lot", "en", say("en")).unit, "lot");
  assert.deepEqual(formatSize(82587, "contract", "zh-TW", say("zh-TW")), { value: "82,587", unit: "口" });
  assert.equal(formatSize(1, "contract", "en", say("en")).unit, "contract");
  assert.deepEqual(formatSize(1234.5, "BTC", "en", say("en")), { value: "1,234.5", unit: "BTC" });
  assert.deepEqual(formatSize(48_213_500, "share", "en", say("en")), { value: "48.2M", unit: "" });
});

test("a pair's large volume is compact, with its base asset", () => {
  assert.deepEqual(formatSize(1_012_345_678.9, "DOGE", "en", say("en")), { value: "1.0B", unit: "DOGE" });
  assert.deepEqual(formatSize(1_012_345_678.9, "DOGE", "zh-TW", say("zh-TW")), { value: "10.12", unit: "億 DOGE" });
  assert.deepEqual(formatSize(48_213_500, "DOGE", "ja", say("ja")), { value: "4,821.35", unit: "万 DOGE" });
  // Below a million it stays in full, decimals and all.
  assert.deepEqual(formatSize(999_999.5, "DOGE", "zh-TW", say("zh-TW")), { value: "999,999.5", unit: "DOGE" });
});

// The recorded 2026-11-18 rows (2330.TW after the close, WTX& in the day session) as Yahoo 奇摩股市's decoder gives them.
const DETAIL_NOW = at("2026-11-18T06:05:00Z");
const ytw = (name, symbol) => decodeStockList([symbol], ok(jsonFixture(name)), DETAIL_NOW).quotes[symbol];
const YTW_2330 = ytw("ytw-detail-close", "2330.TW");
const YTW_WTX = ytw("ytw-detail-mixed", "WTX&");
const texts = (cells) => cells.map((cell) => cell && text(cell));

test("Yahoo 奇摩股市's activity", () => {
  assert.deepEqual(texts(activityCells(YTW_2330, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "昨日成交量 54,723 張",
    "成交值 920.47 億",
    "最後一筆 4,869 張",
  ]);
  // Below 1 億, 萬.
  assert.equal(
    text(activityCells({ ...YTW_2330, turnover: 48_213_500 }, "zh-TW", say("zh-TW"))[2]),
    "成交值 4,821.35 萬",
  );
});

test("Other languages", () => {
  const en = activityCells(YTW_2330, "en", say("en"));
  assert.equal(text(en[0]), "Volume 42,269 lots");
  assert.equal(text(en[2]), "Turnover 92.05B");
  const cn = activityCells(YTW_2330, "zh-CN", say("zh-CN"));
  assert.equal(text(cn[0]), "成交量 42,269 张");
  assert.equal(text(cn[2]), "成交额 920.47 亿");
});

test("MIS alone", () => {
  const mis = {
    symbol: "2330.TW",
    source: "mis",
    price: 2175,
    previousClose: 2170,
    volume: 42_269,
    lastSize: 4_869,
    sizeUnit: "lot",
  };
  assert.deepEqual(texts(activityCells(mis, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "昨日成交量 —",
    "成交值 —",
    "最後一筆 4,869 張",
  ]);
});

test("Before the open", () => {
  // Yahoo Finance's earlier-day quote, its activity stripped under MIS: every label stays, each value `—`.
  const bare = { symbol: "2330.TW", source: "yahoo", price: 2215, previousClose: 2200, high: 2220, low: 2190 };
  assert.deepEqual(texts(activityCells(bare, "zh-TW", say("zh-TW"))), [
    "成交量 —",
    "昨日成交量 —",
    "成交值 —",
    "最後一筆 —",
  ]);
  assert.deepEqual(texts(secondRow({ ...bare, high: null, low: null }, true, "zh-TW", say("zh-TW"))), [
    "均價 —",
    "漲停價 —",
    "跌停價 —",
    "振幅 —",
  ]);
  assert.deepEqual(texts(activityCells(bare, "en", say("en"))), [
    "Volume —",
    "Prev volume —",
    "Turnover —",
    "Last size —",
  ]);
  // One column is unchanged: nothing to show, no row.
  assert.equal(secondRow({ ...bare, high: null, low: null }, false, "zh-TW", say("zh-TW")), null);
});

test("A future", () => {
  assert.deepEqual(texts(activityCells(YTW_WTX, "zh-TW", say("zh-TW"))), [
    "成交量 82,587 口",
    "昨日成交量 170,139 口",
    "成交值 —",
    "最後一筆 3 口",
  ]);
  const row = secondRow(YTW_WTX, true, "zh-TW", say("zh-TW"));
  assert.equal(text(row[0]), "均價 —");
  assert.equal(row.length, 4);
});

test("The bar", () => {
  const tw = innerOuter(YTW_2330, say("zh-TW"));
  assert.equal(tw.left, "內盤 39.1% 15,147");
  assert.equal(tw.right, "外盤 60.9% 23,585");
  assert.ok(Math.abs(tw.innerShare - 0.391) < 0.0005);
  assert.ok(Math.abs(tw.outerShare - 0.609) < 0.0005);
  const cn = innerOuter(YTW_2330, say("zh-CN"));
  assert.deepEqual([cn.left, cn.right], ["内盘 39.1% 15,147", "外盘 60.9% 23,585"]);
  const en = innerOuter(YTW_2330, say("en"));
  assert.deepEqual([en.left, en.right], ["At bid 39.1% 15,147", "At ask 60.9% 23,585"]);
});

test("an inner volume of 0 reads 0.0%", () => {
  const io = innerOuter({ ...YTW_2330, inner: 0, outer: 38_732 }, say("zh-TW"));
  assert.deepEqual([io.left, io.right, io.innerShare, io.outerShare], ["內盤 0.0% 0", "外盤 100.0% 38,732", 0, 1]);
});

test("no inner/outer line without both, or with both at 0", () => {
  const { inner, outer, ...rest } = YTW_2330;
  assert.equal(innerOuter(rest, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, inner }, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, outer }, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, inner: 0, outer: 0 }, say("zh-TW")), null);
});

test("The second row's places", () => {
  const q = {
    symbol: "2330.TW",
    price: 2175,
    high: 2210,
    low: 2150,
    previousClose: 2170,
    avgPrice: 2177,
    limitUp: 2385,
    limitDown: 1955,
    volume: 42_269,
    sizeUnit: "lot",
  };
  assert.deepEqual(texts(secondRow(q, true, "zh-TW", say("zh-TW"))), [
    "均價 2,177.00",
    "漲停價 2,385.00",
    "跌停價 1,955.00",
    "振幅 2.76%",
  ]);
  // One column keeps its volume under open, and no amplitude.
  assert.deepEqual(texts(secondRow(q, false, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "漲停價 2,385.00",
    "跌停價 1,955.00",
    null,
  ]);
  assert.equal(text(secondRow(YTW_2330, true, "zh-TW", say("zh-TW"))[0]), "均價 2,177.00");
});

test("amplitude and shares", () => {
  assert.ok(Math.abs(amplitude({ high: 2210, low: 2150, previousClose: 2170 }) - 2.7649) < 0.0001);
  assert.equal(amplitude({ high: 2210, low: 2150, previousClose: null }), null);
  assert.equal(amplitude({ high: 2210, previousClose: 2170 }), null);
  assert.equal(formatShare(39.107), "39.1%");
  assert.equal(formatShare(2.76498, 2), "2.76%");
  assert.equal(formatShare(0), "0.0%");
});

// 2330.TW's best five levels at the close of 11/18, against a previous close of 2,170.
const levels = (pairs) => pairs.map(([price, size]) => ({ price, size }));
const SCENARIO_BOOK = {
  bids: levels([
    [2170, 2280],
    [2165, 208],
    [2160, 394],
    [2155, 467],
    [2150, 1280],
  ]),
  asks: levels([
    [2175, 503],
    [2180, 1248],
    [2185, 571],
    [2190, 362],
    [2195, 361],
  ]),
};
const AUCTION_BOOK = { bids: levels([[2185, 1]]), asks: levels([[2200, 73]]), auction: true };

test("The ladder", () => {
  const rows = ladder(SCENARIO_BOOK, 2170);
  assert.equal(rows.length, 5);
  // A rung is its price, size and change: the ladder draws no depth bars.
  assert.deepEqual(rows[0].bid, { price: 2170, size: 2280, change: 0 });
  assert.deepEqual([rows[0].ask.price, rows[0].ask.size], [2175, 503]);
  assert.deepEqual(
    [changeTone(rows[0].bid.change), changeTone(rows[1].bid.change), changeTone(rows[0].ask.change)],
    ["flat", "down", "up"],
  );
  const totals = bookTotals(SCENARIO_BOOK);
  assert.deepEqual([totals.bids, totals.asks, totals.diff], [4_629, 3_045, 1_584]);
  assert.equal(totals.ratio.toFixed(2), "1.52");
  assert.deepEqual([formatSignedCount(1_584), formatSignedCount(-12), formatSignedCount(0)], ["+1,584", "-12", "0"]);
  // Without a previous close, no change to color by.
  assert.equal(ladder(SCENARIO_BOOK, null)[0].bid.change, null);
});

test("A market order", () => {
  const book = {
    bids: [],
    asks: levels([
      [null, 171],
      [490, 244],
      [490.5, 1],
      [491, 2],
      [491.5, 2],
    ]),
  };
  const rows = ladder(book, 520);
  // No price, so no change to color by: plain ink, and marked as a market order.
  assert.deepEqual(rows[0].ask, { price: null, size: 171, change: null, market: true });
  assert.equal(changeTone(rows[0].ask.change), "none");
  assert.equal("market" in rows[1].ask, false);
  assert.equal(bookTotals(book).asks, 420);
  const texts = ["zh-TW", "en", "zh-CN", "ja", "ko"].map((lang) => say(lang)("detail.marketOrder"));
  assert.deepEqual(texts, ["市價", "Market", "市价", "成行", "시장가"]);
});

test("In a call auction", () => {
  const q = { symbol: "2330.TW", book: AUCTION_BOOK };
  assert.deepEqual(detailBook(q, true), { title: "detail.auctionBook", book: AUCTION_BOOK, line: null });
  assert.equal(detailBook(q, false).book, null);
});

test("Before any order", () => {
  // MIS answered at 08:20 with the stock's name and no level: not an auction.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: { bids: [], asks: [] } }, false), {
    title: "detail.book",
    book: null,
    line: "detail.bookEmpty",
  });
});

test("The auction ends in a paused detail", () => {
  // At 09:01:57 the flag is 2 minutes old: the auction book no longer shows.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: AUCTION_BOOK }, false), {
    title: "detail.book",
    book: null,
    line: "detail.bookNone",
  });
});

test("Yahoo 奇摩股市 alone before the open", () => {
  assert.equal(detailBook({ symbol: "2330.TW" }, true).line, "detail.bookNone");
  // A book from before the auction never shows in it.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: SCENARIO_BOOK }, true), {
    title: "detail.book",
    book: null,
    line: "detail.bookNone",
  });
});

test("A failure without a book", () => {
  const fallback = { code: "mis.timeout", params: {} };
  assert.equal(detailBook({ symbol: "2330.TW", fallback, error: null }, false).line, "reason");
  // A cached price's own failure says why too; an error under a current price does not.
  assert.equal(detailBook({ symbol: "2330.TW", cached: true, error: fallback, fallback: null }, false).line, "reason");
  assert.equal(detailBook({ symbol: "2330.TW", error: fallback, fallback: null }, false).line, "detail.bookNone");
  // A book to show wins over the reason.
  assert.equal(detailBook({ symbol: "2330.TW", fallback, book: SCENARIO_BOOK }, false).book, SCENARIO_BOOK);
});

test("a one-sided book", () => {
  const book = { bids: SCENARIO_BOOK.bids, asks: [] };
  const rows = ladder(book, 2170);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.ask === null && row.bid !== null));
  assert.deepEqual([rows[4].bid.price, rows[4].bid.size], [2150, 1280]);
  const totals = bookTotals(book);
  assert.deepEqual(totals, { bids: 4_629, asks: 0, diff: 4_629, ratio: null });
  const text = JSON.stringify(rows) + formatSignedCount(totals.diff);
  assert.ok(!/NaN|Infinity/.test(text), text);
  assert.deepEqual(ladder({ bids: [], asks: [] }, 2170), []);
  assert.deepEqual(bookTotals({ bids: [], asks: [] }), { bids: 0, asks: 0, diff: 0, ratio: null });
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
test("A pair's and a night future's points carry their dates", () =>
  withTZ("Asia/Taipei", () => {
    const line = decodeKlines(ok(jsonFixture("binance-btc-15m")));
    const q = { symbol: "BTC/USDT", price: 63_719.01, previousClose: 63_500, timestamp: 1795076099999, ...line };
    assert.deepEqual(crosshairLabel(q, 24, "en"), {
      time: "Nov 18 22:15",
      price: "64,000.01",
      change: "+0.79%",
      percent: ((64_000.01 - 63_500) / 63_500) * 100,
    });
    const wtx = {
      symbol: "WTX&",
      exchange: "TFE",
      price: 40_000,
      previousClose: 40_000,
      timestamp: taipei("10:00:00", "2026-11-11"),
      series: [40_000, 40_000],
      times: [taipei("22:00:00", "2026-11-10"), taipei("02:00:00", "2026-11-11")],
    };
    assert.equal(crosshairLabel(wtx, 0, "zh-TW").time, "11/10 22:00");
    assert.equal(crosshairLabel(wtx, 1, "zh-TW").time, "11/11 02:00");
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
test("A timed line carries its first point's date on the detail's chart", () =>
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
    assert.equal(lineDate(q, "zh-TW"), "11/19"); // the morning call auction: yesterday's line
    assert.equal(lineDate(q, "en"), "Nov 19");
    // Today's line is dated too, from its first point.
    const today = {
      symbol: "2330.TW",
      exchange: "TAI",
      price: 2180,
      previousClose: 2170,
      timestamp: taipei("10:00:00", "2026-11-20"),
      series: [2170, 2180],
      times: [taipei("09:00:00", "2026-11-20"), taipei("10:00:00", "2026-11-20")],
    };
    assert.equal(lineDate(today, "zh-TW"), "11/20");
    // A pair's 24-hour line, like a Yahoo Finance cryptocurrency's: the date of its first point.
    const pair = {
      symbol: "BTC/USDT",
      price: 91_000,
      previousClose: 90_000,
      timestamp: taipei("10:00:00", "2026-11-20"),
      series: [90_500, 91_000],
      times: [taipei("10:00:00", "2026-11-19"), taipei("23:45:00", "2026-11-19")],
    };
    assert.equal(lineDate(pair, "zh-TW"), "11/19");
    assert.equal(lineDate({ ...pair, symbol: "BTC-USD", exchange: "CCC" }, "en"), "Nov 19");
    // A line across midnight is dated by its first point.
    assert.equal(
      lineDate({ ...pair, times: [taipei("23:00:00", "2026-11-19"), taipei("03:00:00", "2026-11-20")] }, "en"),
      "Nov 19",
    );
    // FX: a weekend's line from Friday.
    const friday = taipei("05:55:00", "2026-11-14");
    const fx = {
      symbol: "TWD=X",
      exchange: "CCY",
      price: 32,
      previousClose: 32.1,
      timestamp: friday,
      series: [32.1, 32],
      times: [taipei("08:00:00", "2026-11-13"), friday],
    };
    assert.equal(lineDate(fx, "en"), "Nov 13");
    // No times, a different number of times than points, or fewer than two points: no date.
    const { times: _times, ...untimed } = q;
    assert.equal(lineDate(untimed, "zh-TW"), "");
    assert.equal(lineDate({ ...q, times: [taipei("11:55:00", "2026-11-19")] }, "zh-TW"), "");
    assert.equal(lineDate({ ...q, times: [...q.times, taipei("13:35:00", "2026-11-19")] }, "zh-TW"), "");
    assert.equal(lineDate({ ...q, series: [], times: [] }, "zh-TW"), "");
    assert.equal(lineDate({ ...q, series: [60], times: [taipei("13:30:00", "2026-11-19")] }, "zh-TW"), "");
  }));
