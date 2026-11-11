// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, detailSource, freshness, futuresSegment, isRealtime, msUntilStale, sessionName, sessionOf,
  shownLimit,
} from "../mods/wickline/freshness.js";
import { hoursWindow, nextEdge } from "../mods/wickline/freshness.js";
import { MINUTE_MS, kindOf, resolvedMarket, usOffsetMin } from "../mods/wickline/markets.js";
import { closureOf, parseHolidays } from "../mods/wickline/calendar.js";
import { mergeOverlay } from "../mods/wickline/watchlist.js";
import { dayFor, formatStaleDate, formatTime, freshnessLabel } from "../mods/wickline/format.js";
import { t } from "../mods/wickline/i18n.js";
import { ownPeriods } from "../mods/wickline/providers/yahootw.js";
import { CLOSE_1224, HOLIDAYS_2026, LINE_PERIODS, SEGMENTS, at, day, yq } from "./helpers.mjs";

const now = 1_000_000;
const quote = (fields) => ({ symbol: "AAPL", source: "yahoo", timestamp: now - 5_000, periods: null, ...fields });
const say = (lang) => (key, params) => t(lang, key, params);
// A Yahoo Finance quote as fetched at `fetchedAt`. Without one it counts as fetched at the instant drawn
// (pinned below), which is what the tests that pass only a quote time mean.
const fetched = (q, fetchedAt) => ({ ...q, fetchedAt });

test("freshness constants", () => {
  assert.equal(LIVE_MAX_AGE_MS, 120_000);
  assert.deepEqual([...REALTIME_SOURCES].sort(), ["binance", "finnhub", "mis", "yahootw"]);
});

test("Yahoo 奇摩股市 is a real-time source", () => {
  const NOW = 1794188480000;
  const at = (timestamp) => freshness({ source: "yahootw", timestamp, symbol: "2330.TW" }, "open", NOW).state;
  assert.equal(at(NOW - 10_000), "live");
  assert.equal(at(NOW - 121_000), "stalled");
});

test("freshness states", () => {
  const cases = [
    [quote({ symbol: "BTC/USDT", source: "binance", timestamp: now - 30_000 }), "24h", { state: "live", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "2330.TW", source: "mis", timestamp: now - 120_000 }), "open", { state: "live", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "2330.TW", source: "mis", timestamp: now - 121_000 }), "open", { state: "stalled", delayMinutes: null, stoppedAt: now - 121_000 }],
    [quote({ source: "finnhub" }), "unknown", { state: "unconfirmed", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "2330.TW", exchange: "TAI" }), "open", { state: "delayed", delayMinutes: 20, stoppedAt: null }],
    [quote({}), "open", { state: "delayed", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "0700.HK", exchange: "HKG" }), "open", { state: "delayed", delayMinutes: 15, stoppedAt: null }],
    // A delayed quote whose session is unknown is still delayed, never live.
    [quote({}), "unknown", { state: "delayed", delayMinutes: null, stoppedAt: null }],
    [quote({}), "closed", { state: "closed", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "2330.TW", source: "mis" }), "closed", { state: "closed", delayMinutes: null, stoppedAt: null }],
    [quote({}), "pre", { state: "pre", delayMinutes: null, stoppedAt: null }],
    [quote({}), "post", { state: "post", delayMinutes: null, stoppedAt: null }],
    // A clock running a little behind the source must not make a fresh quote look stuck.
    [quote({ symbol: "2330.TW", source: "mis", timestamp: now + 5_000 }), "open", { state: "live", delayMinutes: null, stoppedAt: null }],
  ];
  for (const [q, session, expected] of cases) assert.deepEqual(freshness(q, session, now), expected, `${q.source} ${q.symbol} ${session}`);
});

test("the session of a quote", () => {
  const day = { pre: [100, 200], regular: [200, 300], post: [300, 400] };
  assert.equal(sessionOf({ symbol: "BTC/USDT", periods: null }, 1), "24h");
  assert.equal(sessionOf({ symbol: "AAPL", periods: null }, 1), "closed");
  assert.equal(sessionOf({ symbol: "AAPL", periods: { pre: null, regular: null, post: null } }, 1), "closed");
  assert.equal(sessionOf({ symbol: "0700.HK", exchange: "HKG", periods: null }, 1), "unknown");
  assert.equal(sessionOf({ symbol: "AAPL", periods: day }, 150), "pre");
  assert.equal(sessionOf({ symbol: "AAPL", periods: day }, 250), "open");
  assert.equal(sessionOf({ symbol: "AAPL", periods: day }, 350), "post");
  assert.equal(sessionOf({ symbol: "AAPL", periods: day }, 500), "closed");
});

// The detail dialog names the state first, then the source, for the price and for the line.
test("the detail source line reads state · source", () => {
  const NOW = 1794188480000;
  const own = { symbol: "2330.TW", source: "yahootw", timestamp: NOW - 10_000, chartSource: "yahootw" };
  assert.deepEqual(detailSource(own, "open", NOW, say("zh-TW")), [["價格：即時 · Yahoo 奇摩股市"], ["走勢：即時 · Yahoo 奇摩股市"]]);
  assert.deepEqual(detailSource(own, "open", NOW, say("en")), [["Price: Live · Yahoo TW Stock"], ["Line: Live · Yahoo TW Stock"]]);
  // A stalled price makes its own line read stalled too, with the time it stopped.
  const old = { ...own, timestamp: NOW - 180_000 };
  const stalled = t("zh-TW", "freshness.stalled", { time: formatTime(old.timestamp) });
  assert.deepEqual(detailSource(old, "open", NOW, say("zh-TW")), [[`價格：${stalled} · Yahoo 奇摩股市`], [`走勢：${stalled} · Yahoo 奇摩股市`]]);
  // A line from another source keeps its own delay.
  const mis = { symbol: "2330.TW", source: "mis", exchange: "TAI", timestamp: NOW - 10_000, chartSource: "yahoo" };
  assert.deepEqual(detailSource(mis, "open", NOW, say("zh-TW")), [["價格：即時 · 證交所 MIS"], ["走勢：延遲 20 分鐘 · Yahoo Finance"]]);
  assert.deepEqual(detailSource({ ...mis, symbol: "AAPL", source: "finnhub", exchange: "NMS", chartTimestamp: NOW - 40_000, chartFetchedAt: NOW - 30_000 }, "open", NOW, say("en")),
    [["Price: Live · Finnhub"], ["Line: Live · Yahoo Finance"]]);
  // Not trading: the session, not "Live"; a session not known yet names the source alone.
  assert.deepEqual(detailSource(own, "closed", NOW, say("en")), [["Price: Market closed · Yahoo TW Stock"], ["Line: Market closed · Yahoo TW Stock"]]);
  assert.deepEqual(detailSource({ ...mis, chartSource: null }, "unknown", NOW, say("en")), [["Price: TWSE MIS"]]);
  // Base only: unchanged.
  const base = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: NOW };
  assert.deepEqual(detailSource(base, "open", NOW, say("en")), [["Yahoo Finance · regular session", "delayed 20 min"]]);
});

// Yahoo reports ^TWII on TAI: a Taiwan quote, 20 minutes late like Taiwan stocks.
test("a Taiwan index on Yahoo reads 20 minutes", () => {
  const index = quote({ symbol: "^TWII", exchange: "TAI" });
  assert.equal(freshness(index, "open", now).delayMinutes, 20);
  assert.equal(freshness(quote({ symbol: "^GSPC", exchange: "SNP" }), "open", now).delayMinutes, null);
  assert.equal(freshness(quote({ symbol: "^GSPC", exchange: "SNP" }), "open", now).state, "live");
});

// A light says the stock is at its limit now (or closed there), so it follows the price's own freshness.
test("a price at its limit is lit only while that is still true", () => {
  const at = (fields) => quote({ symbol: "2330.TW", source: "mis", price: 2485, limitUp: 2485, limitDown: 2035,
    periods: { pre: null, regular: [now - 3_600_000, now + 3_600_000], post: null }, ...fields });
  assert.equal(shownLimit(at({}), "open", now), "up");
  assert.equal(shownLimit(at({ price: 2035 }), "open", now), "down");
  // Closed at the limit, and the after-hours session at the close: still the day's limit.
  assert.equal(shownLimit(at({}), "closed", now), "up");
  assert.equal(shownLimit(at({}), "post", now), "up");
  // Stalled: the lock may have opened since.
  assert.equal(shownLimit(at({ timestamp: now - LIVE_MAX_AGE_MS - 1 }), "open", now), null);
  // Before the open MIS shows a trial match, not a stock locked at its limit.
  assert.equal(shownLimit(at({}), "pre", now), null);
  assert.equal(shownLimit(at({}), "unknown", now), null);
  assert.equal(shownLimit(at({ price: 2400 }), "open", now), null);
});

// Yahoo gives Taiwan no pre-market period (its pre and post are zero-length), so 08:45 reads "closed", the
// same as after 13:30: only a price from today's regular session is lit once the market is not open.
test("MIS's trial match before the open is not lit, a close at the limit is", () => {
  const open = Date.parse("2026-11-09T01:00:00Z");
  const close = Date.parse("2026-11-09T05:30:00Z");
  const tw = (timestamp) => ({ symbol: "2330.TW", source: "mis", price: 2485, limitUp: 2485, limitDown: 2035, timestamp,
    periods: { pre: null, regular: [open, close], post: null } });
  const before = Date.parse("2026-11-09T00:45:00Z");
  assert.equal(sessionOf(tw(before), before), "closed");
  assert.equal(shownLimit(tw(before), sessionOf(tw(before), before), before), null);
  const later = Date.parse("2026-11-09T07:00:00Z");
  assert.equal(shownLimit(tw(close), sessionOf(tw(close), later), later), "up");
  // After hours: TWSE's fixed-price trades end 14:30, an hour past the close.
  const fixed = Date.parse("2026-11-09T06:30:00Z");
  assert.equal(shownLimit(tw(fixed), sessionOf(tw(fixed), later), later), "up");
  // A copy that slept overnight still holds yesterday's periods when today's trial match arrives at 08:45.
  const nextMorning = Date.parse("2026-11-10T00:45:00Z");
  assert.equal(shownLimit(tw(nextMorning), sessionOf(tw(nextMorning), nextMorning), nextMorning), null);
  // Yesterday's close under today's periods is not today's limit.
  const today = { pre: null, regular: [open + 86_400_000, close + 86_400_000], post: null };
  assert.equal(shownLimit({ ...tw(close), periods: today }, "closed", nextMorning), null);
});

// Fixed clocks in UTC; Tuesday 2026-11-10.
const HK_DAY = day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z");

test("a Yahoo quote from a real-time exchange is live, and stalls after 120 s", () => {
  // One stock and one FX exchange; markets.test.mjs pins which exchanges are real time.
  for (const exchange of ["NMS", "CCY"]) {
    assert.deepEqual(freshness(yq("AAPL", exchange, now - 40_000), "open", now), { state: "live", delayMinutes: null, stoppedAt: null }, exchange);
    assert.equal(freshness(yq("AAPL", exchange, now - 120_000), "open", now).state, "live", exchange);
    assert.deepEqual(freshness(yq("AAPL", exchange, now - 121_000), "open", now), { state: "stalled", delayMinutes: null, stoppedAt: now - 121_000 }, exchange);
  }
  assert.equal(freshness(yq("AAPL", "NMS", now), "unknown", now).state, "unconfirmed");
  assert.deepEqual([isRealtime(yq("AAPL", "NMS", now)), isRealtime(yq("2330.TW", "TAI", now))], [true, false]);
});

test("a delayed Yahoo quote shows its exchange's minutes and stalls at its delay plus 5 min", () => {
  const T = at("2026-11-10T02:12:00Z"); // 10:12 in Hong Kong
  const hk = yq("0700.HK", "HKG", T, HK_DAY);
  assert.deepEqual(freshness(hk, "open", T + 19 * 60_000), { state: "delayed", delayMinutes: 15, stoppedAt: null }); // 10:31
  assert.equal(freshness(hk, "open", T + 1_200_000).state, "delayed");
  assert.deepEqual(freshness(hk, "open", T + 1_200_001), { state: "stalled", delayMinutes: null, stoppedAt: T });
  assert.equal(freshness(hk, "open", T + 21 * 60_000).state, "stalled"); // 10:33
  assert.equal(freshness(hk, "closed", T + 3_600_000).state, "closed");
  // Two examples; markets.test.mjs pins every exchange's delay.
  const minutes = [["2330.TW", "TAI", 20], ["7203.T", "JPX", 15]];
  for (const [symbol, exchange, m] of minutes) assert.equal(freshness(yq(symbol, exchange, T, HK_DAY), "open", T + 60_000).delayMinutes, m, symbol);
  const cn = yq("600519.SS", "SHH", T, HK_DAY);
  assert.equal(freshnessLabel(cn, freshness(cn, "open", T + 60_000), T + 60_000, "en", say("en")), "delayed 15 min");
});

test("futures, unknown exchanges and a quote with no exchange never stall", () => {
  const T = at("2026-11-10T02:12:00Z");
  const delayed = (delayMinutes) => ({ state: "delayed", delayMinutes, stoppedAt: null });
  assert.deepEqual(freshness(yq("ES=F", "CME", T, HK_DAY), "open", T + 3_600_000), delayed(10));
  assert.deepEqual(freshness(yq("ES=F", null, T, HK_DAY), "open", T + 3_600_000), delayed(null));
  assert.deepEqual(freshness(yq("AAPL", "XYZ", T, HK_DAY), "open", T + 3_600_000), delayed(null));
  assert.deepEqual(detailSource(yq("AAPL", "XYZ", T, HK_DAY), "open", T + 60_000, say("en")), [["Yahoo Finance · regular session", "delay not provided"]]);
  const bare = yq("AAPL", null, now - 5_000); // no exchange yet: never live
  assert.deepEqual(freshness(bare, "open", now), delayed(null));
  assert.equal(freshnessLabel(bare, freshness(bare, "open", now), now, "en", say("en")), "Yahoo · delayed");
  assert.deepEqual(detailSource(bare, "open", now, say("en")), [["Yahoo Finance · regular session", "delay not provided"]]);
});

// What msUntilStale leaves a quote of `ageMs` that may get `limitMs` old: it stalls 1 ms past the limit.
const left = (limitMs, ageMs) => limitMs - ageMs + 1;

test("a quote may get 120 s old for real time, its delay plus 5 min, else it never stalls", () => {
  assert.equal(msUntilStale({ symbol: "2330.TW", source: "mis", exchange: "TAI", timestamp: 0 }, "open", 0), left(120_000, 0));
  assert.equal(msUntilStale({ symbol: "BTC/USDT", source: "binance", timestamp: 0 }, "24h", 0), left(120_000, 0));
  // Yahoo Finance, by its age at the fetch: at the limit it waits only for the fetch guard, 1 ms past it is stale.
  for (const [symbol, exchange, limit] of [["AAPL", "NMS", 120_000], ["0700.HK", "HKG", 1_200_000], ["2330.TW", "TAI", 1_500_000]]) {
    assert.equal(msUntilStale(fetched(yq(symbol, exchange, 0), limit), "open", limit), left(300_000, 0), symbol);
    assert.equal(msUntilStale(fetched(yq(symbol, exchange, 0), limit + 1), "open", limit + 1), left(limit, limit + 1), symbol);
  }
  for (const [symbol, exchange] of [["ES=F", "CME"], ["AAPL", "XYZ"], ["AAPL", null]]) assert.equal(msUntilStale(yq(symbol, exchange, 0), "open", 0), null, symbol);
});

test("msUntilStale: the ms left before freshness reads stalled; real time counts in every session, delayed only while open", () => {
  const T = at("2026-11-10T02:12:00Z"); // 10:12 in Hong Kong
  const hk = fetched(yq("0700.HK", "HKG", T, HK_DAY), T + 60_000);
  assert.equal(msUntilStale(hk, "open", T + 300_000), 60_001);
  assert.equal(msUntilStale(hk, "open", T + 360_001), 0);
  const us = fetched(yq("AAPL", "NMS", T), T);
  assert.equal(msUntilStale(us, "open", T + 60_000), 240_001);
  const finnhub = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: T };
  assert.equal(msUntilStale(finnhub, "open", T + 60_000), 60_001);
  assert.equal(msUntilStale(finnhub, "open", T + 120_001), 0);
  for (const session of ["closed", "pre", "post", "lunch"]) {
    assert.equal(msUntilStale(hk, session, T), null, session);
    // A real-time quote's moment is when its row may go to another source (pickOverlay), whatever the session.
    assert.equal(msUntilStale(finnhub, session, T + 60_000), 60_001, session);
    assert.equal(freshness(finnhub, session, T + 120_001).state, session);
  }
  // A session not known yet: a delayed quote never stalls; real time still counts, for the overlay pick.
  assert.equal(msUntilStale(hk, "unknown", T + 1_200_001), null);
  assert.equal(msUntilStale(us, "unknown", T + 60_000), 240_001);
  assert.equal(msUntilStale(finnhub, "unknown", T + 60_000), 60_001);
  for (const [symbol, exchange] of [["ES=F", "CME"], ["AAPL", "XYZ"], ["AAPL", null]]) {
    assert.equal(msUntilStale(yq(symbol, exchange, T, HK_DAY), "open", T + 3_600_000), null, symbol);
  }
});

test("a delayed market's first minutes read delayed, not stopped at yesterday's close", () => {
  const open = at("2026-11-10T01:00:00Z"); // 09:00 in Taipei
  const tw = yq("2330.TW", "TAI", at("2026-11-09T05:30:00Z"), day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"));
  assert.equal(msUntilStale(fetched(tw, open + 1_500_001), "open", open + 1_500_001), 0);
  assert.deepEqual(freshness(tw, "open", open + 60_000), { state: "delayed", delayMinutes: 20, stoppedAt: null });
  assert.equal(freshness(tw, "open", open + 1_500_000).state, "delayed");
  assert.deepEqual(freshness(tw, "open", open + 1_500_001), { state: "stalled", delayMinutes: null, stoppedAt: tw.timestamp });
  // An overlay is never anchored: yesterday's MIS price at the open reads stopped, never live.
  const mis = { ...tw, source: "mis" };
  assert.equal(msUntilStale(mis, "open", open + 30_000), left(120_000, open + 30_000 - mis.timestamp));
  assert.equal(freshness(mis, "open", open + 30_000).state, "stalled");
});

test("the detail names Yahoo's state and keeps a delay while closed", () => {
  const NOW = 1794188480000;
  assert.deepEqual(detailSource(yq("AAPL", "NMS", NOW - 40_000), "open", NOW, say("en")), [["Price: Live · Yahoo Finance"]]);
  assert.deepEqual(detailSource(yq("0700.HK", "HKG", NOW - 40_000), "closed", NOW, say("en")), [["Yahoo Finance · regular session", "delayed 15 min"]]);
});

test("the line under a real-time price reads as its own quote, not the price", () => {
  const NOW = 1794188480000;
  const finnhub = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: NOW - 600_000, chartSource: "yahoo",
    chartTimestamp: NOW - 40_000, chartFetchedAt: NOW - 30_000 };
  const stalled = t("en", "freshness.stalled", { time: formatTime(NOW - 600_000) });
  assert.deepEqual(detailSource(finnhub, "open", NOW, say("en")), [[`Price: ${stalled} · Finnhub`], ["Line: Live · Yahoo Finance"]]);
  assert.deepEqual(detailSource(finnhub, "closed", NOW, say("en")), [["Price: Market closed · Finnhub"], ["Line: Market closed · Yahoo Finance"]]);
  const mis = { symbol: "2330.TW", source: "mis", exchange: "TAI", timestamp: NOW - 10_000, chartSource: "yahoo" };
  assert.deepEqual(detailSource(mis, "closed", NOW, say("en")), [["Price: Market closed · TWSE MIS"], ["Line: delayed 20 min · Yahoo Finance"]]);
});

const TOKYO_DAY = day("2026-11-10T00:00:00Z", "2026-11-10T06:30:00Z"); // 09:00–15:30 JST
const CN_DAY = day("2026-11-10T01:30:00Z", "2026-11-10T07:00:00Z");
const sessions = (q, times) => times.map((hms) => sessionOf(q, at(`2026-11-10T${hms}Z`)));

test("Tokyo's lunch break is a session of its own", () => {
  const q = yq("7203.T", "JPX", at("2026-11-10T02:10:00Z"), TOKYO_DAY); // timed 11:10 JST
  assert.deepEqual(sessions(q, ["02:29:59", "02:30:00", "03:29:59", "03:30:00", "03:31:00"]), ["open", "lunch", "lunch", "open", "open"]);
  const noon = at("2026-11-10T02:45:00Z"); // 11:45 JST
  assert.equal(sessionOf(yq("^N225", "OSA", q.timestamp, TOKYO_DAY), noon), "lunch");
  assert.deepEqual(freshness(q, sessionOf(q, noon), noon), { state: "lunch", delayMinutes: null, stoppedAt: null });
  assert.equal(freshnessLabel(q, freshness(q, "lunch", noon), noon, "zh-TW", say("zh-TW")), "午休");
  assert.equal(freshnessLabel(q, freshness(q, "lunch", noon), noon, "en", say("en")), "Lunch");
  assert.deepEqual(detailSource(q, "lunch", noon, say("en")), [["Yahoo Finance · regular session", "delayed 15 min"]]);
  assert.equal(shownLimit(q, "lunch", noon), null);
  // Yesterday's periods (a copy that slept): closed, not lunch.
  assert.equal(sessionOf({ ...q, periods: day("2026-11-09T00:00:00Z", "2026-11-09T06:30:00Z") }, noon), "closed");
});

test("Hong Kong and Shanghai lunch; Taiwan, Korea and the US have none", () => {
  const hk = yq("0700.HK", "HKG", at("2026-11-10T03:00:00Z"), HK_DAY);
  assert.deepEqual(sessions(hk, ["03:59:59", "04:00:00", "04:59:59", "05:00:00"]), ["open", "lunch", "lunch", "open"]);
  const cn = yq("600519.SS", "SHH", at("2026-11-10T03:00:00Z"), CN_DAY);
  assert.deepEqual(sessions(cn, ["03:29:59", "03:30:00", "04:59:59", "05:00:00"]), ["open", "lunch", "lunch", "open"]);
  assert.deepEqual(sessions(yq("000858.SZ", "SHZ", cn.timestamp, CN_DAY), ["04:00:00"]), ["lunch"]);
  const noon = at("2026-11-10T04:00:00Z"); // 12:00 in Taipei
  const tw = yq("2330.TW", "TAI", at("2026-11-10T03:50:00Z"), day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"));
  assert.equal(sessionOf(tw, noon), "open");
  assert.equal(freshness(tw, sessionOf(tw, noon), noon).delayMinutes, 20);
  for (const [symbol, exchange] of [["005930.KS", "KSC"], ["AAPL", "NMS"]]) assert.equal(sessionOf(yq(symbol, exchange, noon, TOKYO_DAY), noon), "open", symbol);
});

test("the minutes of a lunch break do not count toward a stop", () => {
  const tokyo = yq("7203.T", "JPX", at("2026-11-10T02:30:00Z"), TOKYO_DAY); // the morning's last trade, 11:30 JST
  // Fetched at 12:31 JST, 1 min traded: nothing but the fetch guard can turn it.
  assert.equal(msUntilStale(fetched(tokyo, at("2026-11-10T03:31:00Z")), "open", at("2026-11-10T03:31:00Z")), left(300_000, 0));
  assert.deepEqual(freshness(tokyo, "open", at("2026-11-10T03:31:00Z")), { state: "delayed", delayMinutes: 15, stoppedAt: null });
  assert.deepEqual(freshness(tokyo, "open", at("2026-11-10T03:40:00Z")), { state: "delayed", delayMinutes: 15, stoppedAt: null }); // 12:40 JST: 10 min traded
  assert.equal(freshness(tokyo, "open", at("2026-11-10T03:50:00Z")).state, "delayed"); // 12:50 JST: 20 min of trading
  assert.equal(freshness(tokyo, "open", at("2026-11-10T03:50:00Z") + 1).state, "stalled");
  const cn = yq("600519.SS", "SHH", at("2026-11-10T03:30:00Z"), CN_DAY);
  assert.equal(freshness(cn, "open", at("2026-11-10T05:20:00Z")).state, "delayed"); // 13:20 CST
  assert.equal(freshness(cn, "open", at("2026-11-10T05:20:00Z") + 1).state, "stalled");
});

test("FX reads closed from Friday 22:00 to Sunday 22:00 UTC", () => {
  // Yahoo's period says open at each instant here.
  const fx = (iso, exchange = "CCY") => {
    const time = at(iso);
    return [{ symbol: "EURUSD=X", source: "yahoo", exchange, timestamp: time - 5_000,
      periods: { pre: null, regular: [time - 3_600_000, time + 3_600_000], post: null } }, time];
  };
  const session = (iso, exchange) => sessionOf(...fx(iso, exchange));
  assert.deepEqual(["2026-11-13T21:59:59Z", "2026-11-13T22:00:00Z", "2026-11-14T12:00:00Z", "2026-11-15T21:59:59Z", "2026-11-15T22:00:00Z"].map((iso) => session(iso)),
    ["open", "closed", "closed", "closed", "open"]);
  assert.equal(session("2026-11-14T12:00:00Z", null), "closed"); // =X without an exchange
  const [saturday, s] = fx("2026-11-14T12:00:00Z");
  assert.equal(freshness({ ...saturday, timestamp: at("2026-11-13T21:59:00Z") }, sessionOf(saturday, s), s).state, "closed");
  const [sunday, u] = fx("2026-11-15T22:01:00Z");
  assert.equal(freshness(sunday, sessionOf(sunday, u), u).state, "live");
});

// Yahoo's FX period is the UTC day (00:00–23:59), not a session: neither its last minute nor a day-old period reads closed.
test("FX reads open outside its weekend whatever its period says", () => {
  const eur = { symbol: "EURUSD=X", source: "yahoo", exchange: "CCY", periods: day("2026-11-10T00:00:00Z", "2026-11-10T23:59:00Z") };
  assert.equal(sessionOf(eur, at("2026-11-10T23:59:30Z")), "open");
  assert.equal(sessionOf(eur, at("2026-11-11T12:00:00Z")), "open");
  assert.equal(sessionOf(eur, at("2026-11-13T22:00:00Z")), "closed");
});

test("a lunch break counts only where it overlaps the quote's trading time", () => {
  // Timed 11:35 JST, inside lunch: only the minutes since the 12:30 reopening count, so it stops after 12:50.
  const inLunch = yq("7203.T", "JPX", at("2026-11-10T02:35:00Z"), TOKYO_DAY);
  assert.equal(freshness(fetched(inLunch, at("2026-11-10T03:50:00Z")), "open", at("2026-11-10T03:50:00Z")).state, "delayed");
  assert.equal(msUntilStale(fetched(inLunch, at("2026-11-10T03:50:00Z") + 1), "open", at("2026-11-10T03:50:00Z") + 1), 0);
  // Timed 11:00 JST, fetched 11:20: lunch has not begun, nothing is taken off: exactly its 20 min, not stale.
  const early = yq("7203.T", "JPX", at("2026-11-10T02:00:00Z"), TOKYO_DAY);
  assert.equal(msUntilStale(fetched(early, at("2026-11-10T02:20:00Z")), "open", at("2026-11-10T02:20:00Z")), left(300_000, 0));
  // Fetched 1 ms past its 20 min: stalled, so a lunch subtracted where it does not overlap would show.
  const pastLimit = at("2026-11-10T02:20:00Z") + 1;
  assert.deepEqual(freshness(fetched(early, pastLimit), "open", pastLimit), { state: "stalled", delayMinutes: null, stoppedAt: early.timestamp });
  const morning = yq("7203.T", "JPX", at("2026-11-10T02:10:00Z"), TOKYO_DAY);
  // Its 20 min of trading end at 11:30, so it reads stalled only once the market reopens.
  assert.equal(freshness(morning, sessionOf(morning, at("2026-11-10T03:30:00Z")), at("2026-11-10T03:30:00Z")).state, "delayed");
  assert.equal(freshness(morning, "open", at("2026-11-10T03:30:00Z") + 1).state, "stalled");
});

// ---- A Yahoo Finance quote's age is taken at its fetch ----

const US_DAY = day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z"); // 09:30–16:00 in New York

test("a long list does not flicker: a Yahoo quote stays live until its next fetch", () => {
  // 60 symbols on Yahoo, each fetched about every 2 minutes; AAPL's trade 10 s older than its fetch.
  const fetchAt = at("2026-11-10T15:00:00Z");
  const aapl = fetched(yq("AAPL", "NMS", fetchAt - 10_000, US_DAY), fetchAt);
  for (const since of [100_000, 119_000]) {
    assert.deepEqual(freshness(aapl, "open", fetchAt + since), { state: "live", delayMinutes: null, stoppedAt: null }, `${since}`);
  }
  // Nothing changes until the next fetch or the 5-minute guard.
  assert.equal(msUntilStale(aapl, "open", fetchAt + 100_000), 200_001);
});

test("Yahoo at the US open: yesterday's close reads unconfirmed, never live or stopped, until today's first trade", () => {
  const now = at("2026-11-10T14:30:20Z"); // 09:30:20 in New York
  const close = yq("AAPL", "NMS", at("2026-11-09T21:00:00Z"), US_DAY); // yesterday's 16:00 close
  const unconfirmed = { state: "unconfirmed", delayMinutes: null, stoppedAt: null };
  assert.deepEqual(freshness(fetched(close, at("2026-11-10T14:30:05Z")), "open", now), unconfirmed);
  // Fetched before the open, or long after it with no trade yet: still unconfirmed.
  assert.deepEqual(freshness(fetched(close, at("2026-11-10T14:29:00Z")), "open", now), unconfirmed);
  assert.deepEqual(freshness(fetched(close, at("2026-11-10T14:40:00Z")), "open", at("2026-11-10T14:40:10Z")), unconfirmed);
  // A fetch that brings a 09:30:10 trade: live.
  const traded = fetched(yq("AAPL", "NMS", at("2026-11-10T14:30:10Z"), US_DAY), at("2026-11-10T14:30:15Z"));
  assert.deepEqual(freshness(traded, "open", now), { state: "live", delayMinutes: null, stoppedAt: null });
  // Not fetched for 5 minutes is still a stop, as for any Yahoo quote.
  const lastFetch = fetched(close, at("2026-11-10T14:30:05Z"));
  assert.equal(freshness(lastFetch, "open", lastFetch.fetchedAt + 300_000).state, "unconfirmed");
  assert.equal(freshness(lastFetch, "open", lastFetch.fetchedAt + 300_001).state, "stalled");
  assert.equal(msUntilStale(lastFetch, "open", at("2026-11-10T14:40:00Z")), left(300_000, 595_000));
  assert.equal(msUntilStale(fetched(close, at("2026-11-10T14:40:00Z")), "open", at("2026-11-10T14:41:00Z")), left(300_000, 60_000));
});

test("a Yahoo quote not fetched for 5 minutes reads stopped while its market is open", () => {
  const fetchAt = at("2026-11-10T02:20:00Z"); // 10:20 in Hong Kong
  const hk = fetched(yq("0700.HK", "HKG", fetchAt - 60_000, HK_DAY), fetchAt);
  assert.deepEqual(freshness(hk, "open", fetchAt + 300_000), { state: "delayed", delayMinutes: 15, stoppedAt: null });
  assert.deepEqual(freshness(hk, "open", fetchAt + 300_001), { state: "stalled", delayMinutes: null, stoppedAt: hk.timestamp });
  assert.equal(msUntilStale(hk, "open", fetchAt + 200_000), 100_001);
  assert.equal(freshness(hk, "closed", fetchAt + 3_600_000).state, "closed");
  const us = fetched(yq("AAPL", "NMS", at("2026-11-10T15:00:00Z") - 1_000, US_DAY), at("2026-11-10T15:00:00Z"));
  assert.equal(freshness(us, "open", us.fetchedAt + 300_000).state, "live");
  assert.equal(freshness(us, "open", us.fetchedAt + 300_001).state, "stalled");
});

test("a delayed Yahoo quote's boundary is taken at its fetch", () => {
  const T = at("2026-11-10T02:12:00Z"); // a trade at 10:12 in Hong Kong
  const hk = yq("0700.HK", "HKG", T, HK_DAY);
  // Fetched 20 min after the trade: delayed, however long ago the fetch (inside the guard); 1 ms later: stopped.
  const edge = fetched(hk, T + 1_200_000);
  for (const since of [0, 60_000, 299_000]) assert.equal(freshness(edge, "open", edge.fetchedAt + since).state, "delayed", `${since}`);
  const past = fetched(hk, T + 1_200_001);
  assert.deepEqual(freshness(past, "open", past.fetchedAt), { state: "stalled", delayMinutes: null, stoppedAt: T });
  assert.equal(msUntilStale(past, "open", past.fetchedAt + 60_000), 0);
});

test("an overlay's age still runs from its own time to now, whatever its fetch time", () => {
  const T = at("2026-11-10T02:12:00Z");
  for (const source of ["mis", "yahootw", "finnhub", "binance"]) {
    const overlay = { symbol: "2330.TW", source, timestamp: T, fetchedAt: T - 400_000 };
    assert.equal(freshness(overlay, "open", T + 120_000).state, "live", source);
    assert.equal(freshness(overlay, "open", T + 120_001).state, "stalled", source);
    assert.equal(msUntilStale(overlay, "open", T + 60_000), 60_001, source);
  }
});

test("FX just after 00:00 UTC is live with the last minute's quote: its day starts then, not a session", () => {
  const now = at("2026-11-10T00:00:20Z");
  const eur = fetched({ ...yq("EURUSD=X", "CCY", at("2026-11-09T23:59:45Z"), day("2026-11-10T00:00:00Z", "2026-11-10T23:59:00Z")), symbol: "EURUSD=X" }, now);
  assert.equal(sessionOf(eur, now), "open");
  assert.deepEqual(freshness(eur, "open", now), { state: "live", delayMinutes: null, stoppedAt: null });
  // Its age counts from the quote, not 00:00: 23:58:00 fetched at 00:01:59 is 4 minutes old.
  const later = at("2026-11-10T00:01:59Z");
  const old = fetched({ ...eur, timestamp: at("2026-11-09T23:58:00Z") }, later);
  assert.deepEqual(freshness(old, "open", later), { state: "stalled", delayMinutes: null, stoppedAt: old.timestamp });
});

test("a cached Yahoo quote still at the previous close reads stalled once the open plus 120 s has passed", () => {
  const open = at("2026-11-10T14:30:00Z");
  const close = { ...fetched(yq("AAPL", "NMS", at("2026-11-09T21:00:00Z"), US_DAY), open - 60_000), cached: true };
  assert.equal(freshness(close, "open", open + 120_000).state, "unconfirmed");
  assert.deepEqual(freshness(close, "open", open + 120_001), { state: "stalled", delayMinutes: null, stoppedAt: close.timestamp });
  assert.equal(msUntilStale(close, "open", open + 60_000), 60_001);
});

test("a Yahoo quote without a fetch time counts as fetched now", () => {
  const T = at("2026-11-10T15:00:00Z");
  const aapl = yq("AAPL", "NMS", T - 10_000, US_DAY);
  for (const now of [T, T + 110_000, T + 110_001]) assert.deepEqual(freshness(aapl, "open", now), freshness(fetched(aapl, now), "open", now), `${now}`);
  assert.equal(freshness(aapl, "open", T + 110_001).state, "stalled");
});

const future = (timestamp, periods = LINE_PERIODS) => ({ symbol: "WTX&", source: "yahootw", timestamp, periods });

test("a future's session: inside a segment open, between segments closed, the TAIFEX hours without them", () => {
  const cases = [
    // [UTC time, periods, segment] (Taipei time in the comment)
    ["2026-11-09T07:00:00Z", LINE_PERIODS, "night"], // Mon 15:00
    ["2026-11-09T15:59:59Z", LINE_PERIODS, "night"], // 23:59:59
    ["2026-11-09T16:00:00Z", LINE_PERIODS, "night"], // 00:00
    ["2026-11-09T17:00:00Z", LINE_PERIODS, "night"], // 01:00
    ["2026-11-09T20:59:59Z", LINE_PERIODS, "night"], // 04:59:59
    ["2026-11-09T21:00:00Z", LINE_PERIODS, null],    // 05:00
    ["2026-11-09T22:30:00Z", LINE_PERIODS, null],    // 06:30
    ["2026-11-10T00:44:59Z", LINE_PERIODS, null],    // 08:44:59
    ["2026-11-10T00:45:00Z", LINE_PERIODS, "day"],   // 08:45
    ["2026-11-10T05:44:59Z", LINE_PERIODS, "day"],   // 13:44:59
    ["2026-11-10T05:45:00Z", LINE_PERIODS, null],    // 13:45
    ["2026-11-10T07:00:00Z", LINE_PERIODS, null],    // Tue 15:00: past the line's last segment
    ["2026-11-10T06:59:59Z", null, null],            // TAIFEX hours: 14:59:59
    ["2026-11-10T07:00:00Z", null, "night"],         // 15:00
    ["2026-11-10T14:00:00Z", null, "night"],         // 22:00
    ["2026-11-09T22:30:00Z", null, null],            // 06:30
    ["2026-11-10T01:00:00Z", null, "day"],           // 09:00
    ["2026-11-10T05:45:00Z", null, null],            // 13:45
    ["2026-11-13T07:00:00Z", null, "night"],         // Fri 15:00
    ["2026-11-13T20:59:59Z", null, "night"],         // Sat 04:59:59
    ["2026-11-13T21:00:00Z", null, null],            // Sat 05:00
    ["2026-11-14T02:00:00Z", null, null],            // Sat 10:00
    ["2026-11-14T07:00:00Z", null, null],            // Sat 15:00: no Saturday night
    ["2026-11-15T14:00:00Z", null, null],            // Sun 22:00
    ["2026-11-15T16:30:00Z", null, null],            // Mon 00:30: no Sunday night
    ["2026-11-16T00:44:59Z", null, null],            // Mon 08:44:59
    ["2026-11-16T00:45:00Z", null, "day"],           // Mon 08:45
  ];
  for (const [iso, periods, segment] of cases) {
    const now = at(iso);
    const q = future(now - 10_000, periods);
    assert.equal(futuresSegment(q, now), segment, `${iso} ${periods ? "line" : "table"}`);
    assert.equal(sessionOf(q, now), segment ? "open" : "closed", iso);
  }
  // A periods value without segments (here ownPeriods' closed session): the TAIFEX hours decide.
  const friday = at("2026-11-13T20:59:58Z");
  assert.equal(sessionOf(future(friday, { pre: null, regular: [friday, friday], post: null }), at("2026-11-16T00:45:00Z")), "open");
});

test("a future reads Live in both sessions, closed with its last trade in a break, and never stale there", () => {
  const tx = (key, params) => t("zh-TW", key, params);
  const night = at("2026-11-09T17:00:00Z");                            // 01:00
  assert.equal(freshness(future(night - 20_000), "open", night).state, "live");
  assert.equal(sessionName(future(night - 20_000), "open", night), "night");
  const nine = at("2026-11-10T01:00:00Z");                             // 09:00
  assert.equal(freshness(future(nine - 10_000), "open", nine).state, "live");
  assert.equal(sessionName(future(nine - 10_000), "open", nine), "day");
  assert.equal(freshness(future(nine - 121_000), "open", nine).state, "stalled");
  const last = at("2026-11-09T21:00:00Z");                             // 05:00
  const now = at("2026-11-09T22:30:00Z");                              // 06:30
  const q = future(last);
  const fresh = freshness(q, sessionOf(q, now), now);
  assert.equal(fresh.state, "closed");
  assert.equal(freshnessLabel(q, fresh, now, "zh-TW", tx),
    `${tx("session.closed")} · ${[formatStaleDate(last, now, "zh-TW", dayFor(q)), formatTime(last)].filter(Boolean).join(" ")}`);
  assert.equal(sessionName(q, "closed", now), "closed");
  for (const iso of ["2026-11-09T21:00:00.001Z", "2026-11-09T21:01:00Z", "2026-11-09T22:30:00Z", "2026-11-10T05:45:30Z"]) {
    assert.equal(msUntilStale(future(at(iso) - 30_000), "closed", at(iso)), null, iso);
  }
  assert.equal(msUntilStale(future(nine - 20_000), "open", nine), 100_001);
  // A stock's session name is its session.
  assert.equal(sessionName({ symbol: "2330.TW", periods: null }, "open", nine), "open");
});

test("a future at its reported limit is lit while live and after its session, never while stalled", () => {
  const atLimit = (timestamp) => ({ ...future(timestamp), price: 45625, limitUp: 45625, limitDown: 37331 });
  const nine = at("2026-11-10T01:00:00Z");
  assert.equal(shownLimit(atLimit(nine - 10_000), sessionOf(atLimit(nine - 10_000), nine), nine), "up");
  assert.equal(shownLimit(atLimit(nine - 121_000), "open", nine), null);
  const last = at("2026-11-10T05:44:00Z");                             // 13:44
  const after = at("2026-11-10T06:30:00Z");                            // 14:30
  assert.equal(sessionOf(atLimit(last), after), "closed");
  assert.equal(shownLimit(atLimit(last), "closed", after), "up");
});

// TWSE's fixed-price trades after the close are a stock's: a future's price belongs to its session only up to its end.
test("a future's limit holds after its session only for a trade inside it, with no after-close window", () => {
  const atLimit = (timestamp) => ({ ...future(timestamp), price: 45625, limitUp: 45625, limitDown: 37331 });
  const two = at("2026-11-10T06:00:00Z");                              // 14:00, the break
  assert.equal(shownLimit(atLimit(at("2026-11-10T05:44:00Z")), "closed", two), "up");
  // Timed a minute past the day session's end: not the session's price.
  assert.equal(shownLimit(atLimit(at("2026-11-10T05:46:00Z")), "closed", two), null);
  // 15:05 with no night trade: the night session is open and the day's limit price has stalled.
  const night = at("2026-11-10T07:05:00Z");
  const quote = atLimit(at("2026-11-10T05:44:00Z"));
  const shown = { ...quote, periods: ownPeriods({ ...quote, tradeTime: quote.timestamp }, quote.periods, night) };
  assert.equal(shownLimit(shown, sessionOf(shown, night), night), null);
});

test("nextEdge: a future's next TAIFEX opening on its Taipei day; a stock without periods at its exchange's opening", () => {
  const wtx = { symbol: "WTX&", periods: null };
  assert.equal(nextEdge(wtx, at("2026-11-09T22:30:00Z"), { openings: true }), at("2026-11-10T00:45:00Z")); // 06:30 → 08:45
  assert.equal(nextEdge(wtx, at("2026-11-10T01:00:00Z"), { openings: true }), at("2026-11-10T07:00:00Z")); // 09:00 → 15:00
  assert.equal(nextEdge(wtx, at("2026-11-10T08:00:00Z"), { openings: true }), null);                       // 16:00
  assert.equal(nextEdge(wtx, at("2026-11-14T02:00:00Z"), { openings: true }), null);                       // Saturday
  assert.equal(nextEdge({ symbol: "2330.TW", periods: null }, at("2026-11-09T22:30:00Z"), { openings: true }), at("2026-11-10T01:00:00Z"));
});

test("nextEdge: each market's next edge, and its next opening", () => {
  const hk = { symbol: "0700.HK", exchange: "HKG", periods: day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z") };
  const us = { symbol: "AAPL", exchange: "NMS", periods: { pre: [at("2026-11-10T09:00:00Z"), at("2026-11-10T14:30:00Z")],
    regular: [at("2026-11-10T14:30:00Z"), at("2026-11-10T21:00:00Z")], post: [at("2026-11-10T21:00:00Z"), at("2026-11-11T01:00:00Z")] } };
  const cases = [
    // [quote, UTC now, next edge, next opening]
    [hk, "2026-11-10T03:59:30Z", "2026-11-10T04:00:00Z", "2026-11-10T05:00:00Z"], // 11:59:30 HK: lunch, then its end
    [us, "2026-11-10T14:29:20Z", "2026-11-10T14:30:00Z", "2026-11-10T14:30:00Z"], // 09:29:20 New York
    [{ symbol: "AAPL", periods: null }, "2026-11-10T14:00:00Z", "2026-11-10T14:30:00Z", "2026-11-10T14:30:00Z"],
    [{ symbol: "WTX&", periods: null }, "2026-11-10T05:00:00Z", "2026-11-10T05:45:00Z", "2026-11-10T07:00:00Z"], // 13:00 Taipei
    [{ symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z") },
      "2026-11-13T21:00:00Z", "2026-11-13T22:00:00Z", "2026-11-15T22:00:00Z"],
    [{ symbol: "2330.TW", exchange: "TAI", periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z") },
      "2026-11-10T06:00:00Z", "2026-11-10T16:00:00Z", null],                                      // 14:00: Taipei midnight
    [us, "2026-11-11T01:30:00Z", null, null],                                                   // after post; no Taiwan midnight
    [{ symbol: "BTC/USDT", periods: null }, "2026-11-10T06:00:00Z", null, null],
  ];
  for (const [quote, iso, edge, opening] of cases) {
    assert.equal(nextEdge(quote, at(iso)), edge && at(edge), `${quote.symbol} ${iso}`);
    assert.equal(nextEdge(quote, at(iso), { openings: true }), opening && at(opening), `${quote.symbol} ${iso} opening`);
  }
});

// A wait cut at the next edge is never zero: standing on an edge gives the one after it.
test("nextEdge on an edge gives the next one", () => {
  const hk = { symbol: "0700.HK", exchange: "HKG", periods: day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z") };
  const wtx = { symbol: "WTX&", periods: null };
  const fx = { symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z") };
  assert.equal(nextEdge(hk, at("2026-11-10T04:00:00Z")), at("2026-11-10T05:00:00Z"));  // 12:00 HK → 13:00
  assert.equal(nextEdge(wtx, at("2026-11-10T07:00:00Z")), at("2026-11-10T16:00:00Z")); // 15:00 Taipei → midnight
  assert.equal(nextEdge(fx, at("2026-11-13T22:00:00Z")), at("2026-11-15T22:00:00Z"));  // Friday 22:00 → Sunday's
});

// A future's line holds its trading day's segments (Monday's night, Tuesday's day); Tuesday's 15:00 night opening is
// only in TAIFEX's table. The two lists together give it once, never a past or repeated edge.
test("nextEdge: a future with its line's segments still opens at 15:00, and past 15:00 goes on", () => {
  const wtx = { symbol: "WTX&", periods: LINE_PERIODS };
  const openings = { openings: true };
  assert.equal(nextEdge(wtx, at("2026-11-10T05:00:00Z")), at("2026-11-10T05:45:00Z"));           // 13:00: day close, in both
  assert.equal(nextEdge(wtx, at("2026-11-10T06:59:50Z")), at("2026-11-10T07:00:00Z"));           // 14:59:50
  assert.equal(nextEdge(wtx, at("2026-11-10T06:59:50Z"), openings), at("2026-11-10T07:00:00Z"));
  assert.equal(nextEdge(wtx, at("2026-11-10T07:00:00Z")), at("2026-11-10T16:00:00Z"));           // 15:00 → midnight
  assert.equal(nextEdge(wtx, at("2026-11-10T07:00:00Z"), openings), null);
});

// The edge invariant: what a row reads (its session, and a Taiwan row's day by dayFor) changes only at a moment that
// nextEdge announced a step before, so a wait cut at the next edge never sleeps past a change. sessionEdges follows
// sessionOf's branches by hand; this sweep is what keeps the two in step. A new way of reading a session adds its
// quotes to EDGE_SWEEP_QUOTES.
// A Taiwan quote carries the closure marks of its time (closureOf, as Watchlist#marks gives them; here from the 2026
// schedule with no trade seen), so the sweep reads a listed day as a row does.
const LISTED_2026 = parseHolidays(JSON.stringify(HOLIDAYS_2026));
const marked = (quote, time) => (resolvedMarket(quote.symbol, quote.exchange) !== "tw" ? quote : {
  ...quote, ...closureOf(kindOf(quote.symbol) === "future" ? "future" : "stock", time, (d) => LISTED_2026[d] ?? null, () => undefined),
});
const reading = (quote, time) => {
  const row = marked(quote, time);
  return `${sessionOf(row, time)} ${resolvedMarket(row.symbol, row.exchange) === "tw" ? dayFor(row)(time) : ""}`;
};

// The instants in [from, to), stepped by `step`, where what `quote` reads changes without an edge at or before it.
function unannounced(quote, [from, to], step = MINUTE_MS) {
  const misses = [];
  let before = reading(quote, from);
  for (let time = from + step; time < to; time += step) {
    const after = reading(quote, time);
    const edge = after === before ? null : nextEdge(marked(quote, time - step), time - step);
    if (after !== before && (edge === null || edge > time)) misses.push(new Date(time).toISOString());
    before = after;
  }
  return misses;
}

// The instants in [from, to) where a row reading a closure (closedDay, or a removed night) is told of an opening that
// falls inside a closure too.
function closedOpenings(quote, [from, to], step = MINUTE_MS) {
  const misses = [];
  const closed = (row) => Boolean(row.closedDay || row.nightClosed);
  for (let time = from; time < to; time += step) {
    const row = marked(quote, time);
    const opens = closed(row) ? nextEdge(row, time, { openings: true }) : null;
    if (opens !== null && closed(marked(quote, opens))) misses.push(new Date(time).toISOString());
  }
  return misses;
}

const EDGE_SWEEP_WEEKS = [
  [at("2026-03-05T00:00:00Z"), at("2026-03-12T00:00:00Z")], // New York to daylight time (Sunday 03-08)
  [at("2026-10-29T00:00:00Z"), at("2026-11-05T00:00:00Z")], // and back (Sunday 11-01)
  [at("2026-11-08T00:00:00Z"), at("2026-11-16T00:00:00Z")], // the periods below, and an FX weekend (Friday 11-13)
];
// Weeks with TWSE/TAIFEX closures: Monday 10/26 after a weekend, and Friday 12/25 with the night it removes.
const HOLIDAY_WEEKS = [
  [at("2026-10-22T00:00:00Z"), at("2026-10-29T00:00:00Z")],
  [at("2026-12-21T00:00:00Z"), at("2026-12-29T00:00:00Z")],
];
const EDGE_SWEEP_QUOTES = [
  { symbol: "2330.TW", exchange: "TAI", periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z") },
  { symbol: "2330.TW", periods: null },
  { symbol: "^TWII", exchange: "TAI", periods: null },
  { symbol: "AAPL", exchange: "NMS", periods: { pre: [at("2026-03-09T08:00:00Z"), at("2026-03-09T13:30:00Z")], // EDT
    regular: [at("2026-03-09T13:30:00Z"), at("2026-03-09T20:00:00Z")], post: [at("2026-03-09T20:00:00Z"), at("2026-03-10T00:00:00Z")] } },
  { symbol: "AAPL", exchange: "NMS", periods: { pre: [at("2026-11-10T09:00:00Z"), at("2026-11-10T14:30:00Z")], // EST
    regular: [at("2026-11-10T14:30:00Z"), at("2026-11-10T21:00:00Z")], post: [at("2026-11-10T21:00:00Z"), at("2026-11-11T01:00:00Z")] } },
  { symbol: "AAPL", periods: null },
  { symbol: "0700.HK", exchange: "HKG", periods: day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z") },
  { symbol: "7203.T", exchange: "JPX", periods: day("2026-11-10T00:00:00Z", "2026-11-10T06:30:00Z") },
  { symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-13T00:00:00Z", "2026-11-13T23:59:00Z") },
  { symbol: "WTX&", periods: null },
  { symbol: "WTX&", periods: LINE_PERIODS },
  { symbol: "BTC/USDT", periods: null },
];

test("every change in what a row reads comes at or after an edge announced for it", () => {
  for (const quote of EDGE_SWEEP_QUOTES) {
    for (const week of [...EDGE_SWEEP_WEEKS, ...HOLIDAY_WEEKS]) {
      assert.deepEqual(unannounced(quote, week), [], `${quote.symbol} ${quote.periods ? "with" : "without"} periods`);
    }
  }
});

test("a row reading a closure is told of no opening inside a closure", () => {
  for (const quote of EDGE_SWEEP_QUOTES) {
    for (const week of HOLIDAY_WEEKS) {
      assert.deepEqual(closedOpenings(quote, week), [], `${quote.symbol} ${quote.periods ? "with" : "without"} periods`);
    }
  }
  // The weeks hold both closures, for stocks and futures alike.
  const reads = (quote, iso) => sessionOf(marked(quote, at(iso)), at(iso));
  assert.deepEqual([reads({ symbol: "2330.TW", periods: null }, "2026-12-25T02:00:00Z"), reads({ symbol: "WTX&", periods: null }, "2026-12-25T18:00:00Z")],
    ["holiday", "closed"]);
});

test("a closed day: no dot, never stale, lit as closed, 休市 in the detail", () => {
  const now = at("2026-12-25T02:00:00Z");
  const q = { symbol: "2330.TW", source: "yahootw", price: 2485, limitUp: 2485, limitDown: 2035, timestamp: CLOSE_1224,
    periods: day("2026-12-24T01:00:00Z", "2026-12-24T05:30:00Z"), closedDay: { reason: "行憲紀念日" }, chartSource: "yahootw" };
  assert.equal(sessionOf(q, now), "holiday");
  assert.deepEqual(freshness(q, "holiday", now), { state: "holiday", delayMinutes: null, stoppedAt: null });
  assert.equal(shownLimit(q, "holiday", now), "up");
  assert.deepEqual(detailSource(q, "holiday", now, say("zh-TW")), [["價格：休市 · Yahoo 奇摩股市"], ["走勢：休市 · Yahoo 奇摩股市"]]);
  const base = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: CLOSE_1224, closedDay: { reason: "行憲紀念日" } };
  assert.deepEqual(detailSource(base, "holiday", now, say("zh-TW")), [["Yahoo Finance · 一般交易時段", "延遲 20 分鐘"]]);
  assert.equal(t("zh-TW", `session.${sessionName(q, "holiday", now)}`), "休市");
  const wtx = { symbol: "WTX&", periods: null, closedDay: { reason: "行憲紀念日" } };
  assert.equal(nextEdge(wtx, at("2026-12-24T22:00:00Z"), { openings: true }), null);   // 12/25 06:00: no opening
  // A removed night: no night segment, so closed, not open.
  assert.equal(sessionOf({ symbol: "WTX&", periods: null, nightClosed: true }, at("2026-12-25T18:00:00Z")), "closed");
});

test("a Taiwan or US quote without periods reads its exchange's hours; any other has no session", () => {
  const cases = [
    // [symbol, exchange, UTC, session] (local time in the comment)
    ["AAPL", undefined, "2026-11-10T14:31:00Z", "open"],     // Tue 09:31 New York (EST)
    ["AAPL", undefined, "2026-11-11T01:00:00Z", "closed"],   // 20:00
    ["AAPL", undefined, "2026-11-14T15:00:00Z", "closed"],   // Saturday
    ["AAPL", undefined, "2026-03-06T14:29:59Z", "closed"],   // Fri 09:29:59 EST
    ["AAPL", undefined, "2026-03-06T14:30:00Z", "open"],     // Fri 09:30 EST
    ["AAPL", undefined, "2026-03-09T13:29:59Z", "closed"],   // Mon 09:29:59 EDT
    ["AAPL", undefined, "2026-03-09T13:30:00Z", "open"],     // Mon 09:30 EDT
    ["AAPL", undefined, "2026-10-30T13:30:00Z", "open"],     // Fri 09:30 EDT
    ["AAPL", undefined, "2026-11-02T13:30:00Z", "closed"],   // Mon 08:30 EST
    ["AAPL", undefined, "2026-11-02T14:30:00Z", "open"],     // Mon 09:30 EST
    ["2330.TW", undefined, "2026-11-10T00:59:59Z", "closed"], // 08:59:59 Taipei
    ["2330.TW", undefined, "2026-11-10T01:00:00Z", "open"],   // 09:00
    ["2330.TW", undefined, "2026-11-10T05:29:59Z", "open"],   // 13:29:59
    ["2330.TW", undefined, "2026-11-10T05:30:00Z", "closed"], // 13:30
    ["2330.TW", undefined, "2026-11-14T02:00:00Z", "closed"], // Saturday 10:00
    ["6488.TWO", undefined, "2026-11-10T02:00:00Z", "open"],
    ["^TWOII", "TWO", "2026-11-10T02:00:00Z", "open"],
    ["0700.HK", "HKG", "2026-11-10T02:00:00Z", "unknown"],
    ["^N225", "OSA", "2026-11-10T02:00:00Z", "unknown"],
  ];
  for (const [symbol, exchange, iso, session] of cases) {
    assert.equal(sessionOf({ symbol, exchange, source: "finnhub", periods: null }, at(iso)), session, `${symbol} ${iso}`);
  }
  // The DST edges, on both Sundays.
  assert.deepEqual(["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z"]
    .map((iso) => usOffsetMin(at(iso))), [-300, -240, -240, -300]);
  assert.deepEqual(hoursWindow({ symbol: "AAPL", periods: null }, at("2026-07-15T15:00:00Z")),
    { regular: [at("2026-07-15T13:30:00Z"), at("2026-07-15T20:00:00Z")], weekday: true });
  assert.equal(hoursWindow({ symbol: "0700.HK", exchange: "HKG", periods: null }, at("2026-11-10T02:00:00Z")), null);
});

test("a Finnhub-first AAPL reads Live and 開盤中 at 09:31 New York, closed with its time at 20:00", () => {
  const open = at("2026-11-10T14:31:00Z");
  const live = mergeOverlay(undefined, { symbol: "AAPL", source: "finnhub", price: 230, timestamp: open - 5_000, fetchedAt: open });
  assert.equal(freshness(live, sessionOf(live, open), open).state, "live");
  assert.equal(t("zh-TW", `session.${sessionName(live, sessionOf(live, open), open)}`), "開盤中");
  const last = at("2026-11-10T20:59:55Z");
  const evening = at("2026-11-11T01:00:00Z");
  const closed = { ...live, timestamp: last };
  const fresh = freshness(closed, sessionOf(closed, evening), evening);
  assert.equal(fresh.state, "closed");
  const tx = say("en");
  assert.equal(freshnessLabel(closed, fresh, evening, "en", tx),
    `${tx("session.closed")} · ${[formatStaleDate(last, evening, "en", dayFor(closed)), formatTime(last)].filter(Boolean).join(" ")}`);
});

test("a MIS-first 2330.TW at 10:00 Taipei reads Live and 開盤中", () => {
  const now = at("2026-11-10T02:00:00Z");
  const quote = mergeOverlay(undefined, { symbol: "2330.TW", source: "mis", price: 2250, timestamp: now - 5_000, fetchedAt: now });
  assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
  assert.equal(t("zh-TW", `session.${sessionName(quote, sessionOf(quote, now), now)}`), "開盤中");
});

test("an unconfirmed price or line names its source alone", () => {
  const open = at("2026-11-10T14:30:00Z");
  const now = open + 20_000; // 09:30:20 New York
  const periods = day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z");
  const yesterday = { ...yq("AAPL", "NMS", at("2026-11-09T21:00:00Z"), periods), fetchedAt: now - 5_000 };
  assert.deepEqual(detailSource(yesterday, sessionOf(yesterday, now), now, say("zh-TW")), [["價格：Yahoo Finance"]]);
  assert.deepEqual(detailSource(yesterday, sessionOf(yesterday, now), now, say("en")), [["Price: Yahoo Finance"]]);
  const finnhub = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: now - 10_000, periods,
    chartSource: "yahoo", chartTimestamp: open - 60_000, chartFetchedAt: now - 5_000 };
  assert.deepEqual(detailSource(finnhub, "open", now, say("en")), [["Price: Live · Finnhub"], ["Line: Yahoo Finance"]]);
});
