// node --test tests/  (format.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { changeTone, chartGeometry, collapsedRow, dayFor, detailTimes, bandCurrency, failureNote, formatChange, formatPrice, formatStaleDate, formatTime, freshnessLabel, isFlat, number, rowName, signed } from "../mods/wickline/format.js";
import { formatDate, sessionTimesParts, stateText } from "../mods/wickline/format.js";
import { detailSource, freshness, sessionName, sessionOf, sessionTimes } from "../mods/wickline/freshness.js";
import { CLOSE_1224, at, day, withTZ } from "./helpers.mjs";
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
  assert.equal(formatChange((quote.price - quote.previousClose) / quote.previousClose * 100), "+5.85%");
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

test("scales a line into its box", () => {
  assert.equal(chartGeometry([1], 1), null);
  const g = chartGeometry([10, 20], 15);
  assert.deepEqual(g.points.map((p) => p[0]), [0, 100]);
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
  assert.deepEqual(rowName("LYV", live, "Live Nation Entertainment"), { label: "Live", name: "Live Nation Entertainment" });
});

test("a pair has no instrument name: its venue never becomes a name line", () => {
  assert.deepEqual(rowName("BTC/USDT", "Live", "Binance Spot"), { label: "Live", name: "" });
  assert.deepEqual(rowName("BTC/USDT", "quote stopped at 13:05", "Binance Spot"), { label: "quote stopped at 13:05", name: "" });
});

test("a stock's name gets its own line", () => {
  assert.deepEqual(rowName("2330.TW", "已收盤 · 11/5 13:30", "台積電"), { label: "已收盤 · 11/5 13:30", name: "台積電" });
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
    for (const [source, symbol, session] of [["mis", "2330.TW", "open"], ["yahootw", "2330.TW", "open"], ["finnhub", "AAPL", "open"], ["binance", "BTC/USDT", "24h"]]) {
      assert.equal(label(at(source, symbol), session), t(lang, "freshness.live"), `${lang} ${source}`);
    }
    // A session not known yet keeps the source name: nothing says it is live.
    assert.equal(label(at("mis", "2330.TW"), "unknown"), t(lang, "src.mis"), lang);
    assert.equal(label({ ...at("yahootw", "2330.TW"), timestamp: now - 180_000 }, "open"),
      t(lang, "freshness.stalled", { time: formatTime(now - 180_000) }), lang);
  }
});

test("the detail times: quoted, the last trade when it differs, fetched", () => {
  const tx = (key, params) => t("en", key, params);
  const at = (h, m, s) => new Date(2026, 10, 9, h, m, s).getTime();
  const now = at(9, 41, 20);
  // 0050.TW from Yahoo 奇摩股市: quoted at the feed's time, its own last trade earlier.
  const quiet = { symbol: "AAPL", timestamp: at(9, 41, 13), tradeTime: at(9, 17, 12), fetchedAt: at(9, 41, 19) };
  assert.deepEqual(detailTimes(quiet, now, "en", tx), ["Quote at 09:41:13", "last trade 09:17:12", "Fetched 09:41:19"]);
  assert.deepEqual(detailTimes({ ...quiet, tradeTime: quiet.timestamp }, now, "en", tx), ["Quote at 09:41:13", "Fetched 09:41:19"]);
  const { tradeTime, ...plain } = quiet;
  assert.deepEqual(detailTimes(plain, now, "en", tx), ["Quote at 09:41:13", "Fetched 09:41:19"]);
  // An earlier day puts its date before the quote time.
  assert.deepEqual(detailTimes({ ...plain, timestamp: at(9, 41, 13) - 86_400_000 }, now, "en", tx)[0], "Quote at Nov 8 09:41:13");
});

test("a row collapses only when it has no price and its fetch failed", () => {
  const notFound = { code: "yahoo.notFound", params: {} };
  assert.equal(collapsedRow({ quote: null, failed: notFound }), true);
  assert.equal(collapsedRow({ quote: undefined, failed: { code: "request.timeout", params: {} } }), true);
  // Waiting for its first quote: keeps the grid, so a price arriving moves nothing.
  assert.equal(collapsedRow({ quote: null, failed: undefined }), false);
  // Only the real-time source failed: still waiting for the base.
  assert.equal(collapsedRow({ quote: null, failed: undefined, fallback: { code: "request.timeout", params: {} } }), false);
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
    assert.equal(formatStaleDate({ symbol: "2330.TW", timestamp: at("2026-11-02T10:00:00Z") }, at("2026-11-02T18:00:00Z"), "en"), "Nov 2");
    assert.deepEqual(detailTimes({ symbol: "2330.TW", timestamp: earlier, fetchedAt: now }, now, "en", tx)[0], `Quote at ${formatTime(earlier, true)}`);
  });
  const earlier = new Date(2026, 9, 31, 16).getTime();
  assert.deepEqual([formatDate(earlier, "en"), formatDate(earlier, "zh-TW")], ["Oct 31", "10/31"]);
});

test("an unconfirmed state has no word of its own", () => {
  assert.equal(stateText({ state: "unconfirmed" }, (key) => key), null);
  assert.equal(stateText({ state: "closed" }, (key) => key), "session.closed");
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
    assert.deepEqual(line({ symbol: "AAPL", source: "finnhub", periods: null }, at("2026-11-10T15:00:00Z")), ["交易時段：22:30–05:00"]);
    assert.deepEqual(line({ symbol: "AAPL", source: "finnhub", periods: null }, at("2026-07-15T15:00:00Z")), ["交易時段：21:30–04:00"]);
    assert.deepEqual(line({ ...aapl, periods: day("2026-07-15T13:30:00Z", "2026-07-15T20:00:00Z") }, at("2026-07-15T15:00:00Z")), ["交易時段：21:30–04:00"]);
    assert.deepEqual(line({ symbol: "BTC/USDT", periods: null }, nov), ["交易時段：24 小時"]);
    assert.deepEqual(line({ symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z") }, nov), ["交易時段：24 小時"]);
    assert.deepEqual(line({ symbol: "ES=F", exchange: "CME", periods: day("2026-11-09T23:00:00Z", "2026-11-10T22:00:00Z") }, nov), ["交易時段：07:00–06:00"]);
    assert.deepEqual(line({ symbol: "^N225", exchange: "OSA", periods: null }, nov), []);
    // Taiwan reads TWSE's hours whatever its periods say (a TW-only index from Friday's close, on Saturday).
    const friday = at("2026-11-13T05:30:00Z");
    const saturday = at("2026-11-14T02:00:00Z");
    assert.deepEqual(line({ symbol: "^TWOII", exchange: "TWO", periods: { pre: null, regular: [friday, friday], post: null } }, saturday), ["交易時段：09:00–13:30"]);
    // A lunch split on the session's own day: a Saturday detail with Friday's periods.
    assert.deepEqual(line({ ...hk, periods: day("2026-11-13T01:30:00Z", "2026-11-13T08:00:00Z") }, saturday), ["交易時段：09:30–12:00", "13:00–16:00"]);
    assert.deepEqual(line(wtx, nov, en), ["Trading hours: Day 08:45–13:45", "Night 15:00–05:00"]);
    assert.deepEqual(line({ symbol: "BTC/USDT", periods: null }, nov, en), ["Trading hours: 24 hours"]);
  });
  withTZ("Europe/London", () => {
    assert.deepEqual(line(tw, nov), ["交易時段：01:00–05:30"]);
    assert.deepEqual(line(wtx, nov), ["交易時段：日盤 00:45–05:45", "夜盤 07:00–21:00"]);
  });
});

test("a Taiwan row's \"today\" is the Taipei date, printed in local time", () => {
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
    const q = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: CLOSE_1224, closure: { kind: "listed", reason: "行憲紀念日" } };
    const now = at("2026-12-25T02:00:00Z");
    assert.equal(freshnessLabel(q, holiday, now, "zh-TW", zh), "休市 · 12/24 13:30");
    assert.equal(freshnessLabel(q, holiday, now, "en", en), "No trading · Dec 24 13:30");
    assert.equal(freshnessLabel({ ...q, timestamp: at("2026-12-24T20:59:00Z") }, holiday, now, "zh-TW", zh), "休市 · 04:59");
    assert.deepEqual(sessionTimesParts(sessionTimes(q, now), "zh-TW", zh), ["交易時段：今日休市", "行憲紀念日"]);
    assert.deepEqual(sessionTimesParts(sessionTimes(q, now), "en", en), ["Trading hours: Closed today"]);
    assert.deepEqual(sessionTimesParts(sessionTimes({ symbol: "WTX&", periods: null, closure: { kind: "nightRemoved" } }, at("2026-12-25T18:00:00Z")), "zh-TW", zh),
      ["交易時段：日盤 08:45–13:45", "夜盤休市"]);
  });
});

test("the 今日無成交 label, header and session times", () => {
  withTZ("Asia/Taipei", () => {
    const zh = (key, params) => t("zh-TW", key, params);
    const en = (key, params) => t("en", key, params);
    const now = at("2026-11-11T01:00:00Z");                          // 09:00 on a normal Wednesday
    const wtx = { symbol: "WTX&", source: "yahootw", price: 42604, timestamp: at("2026-11-10T20:59:00Z"), periods: null,
      chartSource: "yahootw", closure: { kind: "noTrades", source: "yahootw" } }; // stuck at 04:59, the same Taipei day
    assert.equal(sessionOf(wtx, now), "noTrades");
    const fresh = freshness(wtx, "noTrades", now);
    assert.deepEqual(fresh, { state: "noTrades", delayMinutes: null, stoppedAt: null });
    assert.equal(freshnessLabel(wtx, fresh, now, "zh-TW", zh), "今日無成交 · 11/11 04:59");   // the date, though it is today
    assert.equal(freshnessLabel(wtx, fresh, now, "en", en), "No trades today · Nov 11 04:59");
    assert.equal(t("zh-TW", `session.${sessionName(wtx, "noTrades", now)}`), "今日無成交");
    assert.deepEqual(detailSource(wtx, "noTrades", now, zh), [["價格：今日無成交 · Yahoo 奇摩股市"], ["走勢：今日無成交 · Yahoo 奇摩股市"]]);
    // Yahoo Finance alone (spec "Delayed source on a closed day", review 2 I4): the header 今日無成交, never 休市, and
    // the delayed line keeps its text.
    const base = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: at("2026-11-10T05:30:00Z"), closure: { kind: "noTrades", source: "yahoo" } };
    assert.equal(t("zh-TW", `session.${sessionName(base, "noTrades", now)}`), "今日無成交");
    assert.deepEqual(detailSource(base, "noTrades", now, zh), [["Yahoo Finance · 一般交易時段", "延遲 20 分鐘"]]);
    assert.deepEqual(sessionTimesParts(sessionTimes(wtx, now), "zh-TW", zh), ["交易時段：今日尚無成交，可能休市"]);
    assert.deepEqual(sessionTimesParts(sessionTimes(wtx, now), "en", en), ["Trading hours: No trades yet today; the market may be closed"]);
    const night = { ...wtx, timestamp: at("2026-11-11T05:45:00Z"), closure: { kind: "nightNoTrades", source: "yahootw" } };
    const later = at("2026-11-11T07:10:00Z");                        // 15:10
    assert.equal(sessionOf(night, later), "closed");
    assert.equal(freshnessLabel(night, freshness(night, "closed", later), later, "zh-TW", zh), "已收盤 · 13:45");
    assert.deepEqual(sessionTimesParts(sessionTimes(night, later), "zh-TW", zh), ["交易時段：日盤 08:45–13:45", "夜盤尚無成交"]);
  });
});

test("the failure note names what is cached: the price first, else the line, else nothing", () => {
  assert.equal(failureNote({ cached: true, chartCached: true }), "quote.cached");
  assert.equal(failureNote({ chartCached: true }), "quote.chartCached");
  assert.equal(failureNote({ source: "yahootw", chartSource: "yahootw" }), null);
});
