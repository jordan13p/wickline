// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, chartQuote, detailSource, freshness, futuresSegment, isRealtime, msUntilStale, sessionName, sessionOf,
  shownLimit,
} from "../mods/wickline/freshness.js";
import {
  DETAIL_WAKE_CAP_MS, bandState, detailWakeAt, followDetail, hoursWindow, nextEdge, rowDate, sessionTimes,
} from "../mods/wickline/freshness.js";
import { MINUTE_MS, NIGHT_SESSION, resolvedMarket, usOffsetMin } from "../mods/wickline/markets.js";
import { closureOf, closureUntil, heldMarks, taipeiDay, taipeiMinute, twMarket, withClosure } from "../mods/wickline/calendar.js";
import { mergeOverlay } from "../mods/wickline/watchlist.js";
import {
  dayFor, detailTimes, failureNote, formatStaleDate, formatTime, freshnessLabel, sessionTimesParts,
} from "../mods/wickline/format.js";
import { t } from "../mods/wickline/i18n.js";
import { ownPeriods } from "../mods/wickline/providers/yahootw.js";
import {
  CLOSE_1224, LINE_PERIODS, SEGMENTS, advance, at, day, fakeHost, listed2026, observation, ok, say, withTZ, yq, zhLabel,
} from "./helpers.mjs";

const now = 1_000_000;
const quote = (fields) => ({ symbol: "AAPL", source: "yahoo", timestamp: now - 5_000, periods: null, ...fields });
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

test("detailSource reads a cached Yahoo line under a Finnhub price as before the split", () => {
  // AAPL's Yahoo Finance quote (line to 10:00 NY) failed at 10:05; Finnhub prices it live at 10:05.
  const now = at("2026-11-10T15:05:00Z");
  const base = { ...yq("AAPL", "NMS", at("2026-11-10T15:00:00Z"), day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z")),
    fetchedAt: at("2026-11-10T15:00:05Z"), series: [1, 2], cached: true };
  const row = mergeOverlay(base, { symbol: "AAPL", source: "finnhub", price: 230, timestamp: now - 10_000 }, null);
  assert.deepEqual(detailSource(row, "open", now, say("en")), [["Price: Live · Finnhub"], ["Line: quote stopped at " + formatTime(base.timestamp) + " · Yahoo Finance"]]);
});

test("chartQuote is the line's quote, with the line's own cached flag", () => {
  const q = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: 9, chartSource: "yahoo", chartTimestamp: 5,
    chartFetchedAt: 7, chartCached: true, cached: undefined };
  assert.deepEqual(
    [chartQuote(q).source, chartQuote(q).timestamp, chartQuote(q).fetchedAt, chartQuote(q).cached, chartQuote(q).exchange],
    ["yahoo", 5, 7, true, "NMS"]);
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
    `${tx("session.closed")} · ${[formatStaleDate(q, now, "zh-TW"), formatTime(last)].filter(Boolean).join(" ")}`);
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
    [us, "2026-11-11T01:30:00Z", "2026-11-11T16:00:00Z", null],                                 // after post: the row's own midnight
    [{ symbol: "BTC/USDT", periods: null }, "2026-11-10T06:00:00Z", "2026-11-10T16:00:00Z", null],
  ];
  withTZ("Asia/Taipei", () => {
    for (const [quote, iso, edge, opening] of cases) {
      assert.equal(nextEdge(quote, at(iso)), edge && at(edge), `${quote.symbol} ${iso}`);
      assert.equal(nextEdge(quote, at(iso), { openings: true }), opening && at(opening), `${quote.symbol} ${iso} opening`);
    }
  });
});

// A wait cut at the next edge is never zero: standing on an edge gives the one after it.
test("nextEdge on an edge gives the next one", () => {
  const hk = { symbol: "0700.HK", exchange: "HKG", periods: day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z") };
  const wtx = { symbol: "WTX&", periods: null };
  const fx = { symbol: "EURUSD=X", exchange: "CCY", periods: day("2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z") };
  withTZ("Asia/Taipei", () => {
    assert.equal(nextEdge(hk, at("2026-11-10T04:00:00Z")), at("2026-11-10T05:00:00Z"));  // 12:00 HK → 13:00
    assert.equal(nextEdge(wtx, at("2026-11-10T07:00:00Z")), at("2026-11-10T16:00:00Z")); // 15:00 Taipei → midnight
    assert.equal(nextEdge(fx, at("2026-11-13T22:00:00Z")), at("2026-11-14T16:00:00Z"));  // Friday 22:00 → Taipei midnight, before Sunday's
  });
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

// The edge invariant: what a row reads (its session, and its day by dayFor) changes only at a moment that
// nextEdge announced a step before, so a wait cut at the next edge never sleeps past a change. sessionEdges follows
// sessionOf's branches by hand; this sweep is what keeps the two in step. A new way of reading a session adds its
// quotes to EDGE_SWEEP_QUOTES.
// A Taiwan quote carries the closure of its time and its next inference deadline, by the composition Watchlist#marked
// uses (closureOf in its twMarket, through withClosure; here from the 2026 schedule, and the answers its `answers`
// gives at that time, else none), so the sweep reads a listed day, and a day or night without trades, as a row does.
const marked = (quote, time) => (resolvedMarket(quote.symbol, quote.exchange) !== "tw" ? quote
  : withClosure(quote, closureOf(twMarket(quote.symbol), time, listed2026, quote.answers?.(time) ?? (() => undefined))));
// What a row reads: its session, its day, and its no-trades reading, which the detail's session times and
// the status line's note read apart from sessionOf.
const INFERRED = ["noTrades", "nightNoTrades"];
const reading = (quote, time) => {
  const row = marked(quote, time);
  const noTrades = INFERRED.includes(row.closure?.kind) ? row.closure : null;
  return `${sessionOf(row, time)} ${dayFor(row)(time)} ${JSON.stringify(noTrades)}`;
};
// Answers that carry no trade, one a minute (the latest at `time`) from every session: Yahoo 奇摩股市's for
// `quietRealtime`, Yahoo Finance's for `quietDelayed`. `quietNight`: only the nights are observed, each answer carrying
// the day's last trade (newest, just before its 15:00 open), so the night reads closed with its note. A trade is never
// observed: one comes with an answer, which redraws the row itself.
const answeredAt = (time, kind, source) => observation({ [kind]: [{ at: time, source }] });
const quietRealtime = (time) => () => answeredAt(time, "realtime", "yahootw");
const quietDelayed = (time) => () => answeredAt(time, "delayed", "yahoo");
const isNightOpen = (open) => taipeiMinute(open) === NIGHT_SESSION.from;
// `quietDay`: only the day sessions (08:45 and 09:00) answer, so a quiet day's 今日無成交 carries past 15:00 with no night
// answer at all and ends at the night's 15:10 cap.
const quietDay = (time) => (market, open) => (isNightOpen(open) ? undefined : answeredAt(time, "realtime", "yahootw"));
const quietNight = (time) => (market, open) => (isNightOpen(open) ? { ...answeredAt(time, "realtime", "yahootw"), newest: open - 1 } : undefined);

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

// The instants in [from, to) where a row reading a closure (a listed day, or a closed night) is told of an opening that
// falls inside a closure too.
function closedOpenings(quote, [from, to], step = MINUTE_MS) {
  const misses = [];
  const closed = (row) => ["listed", "nightRemoved", "nightNoTrades"].includes(row.closure?.kind);
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
  // Inferred closures: a stock or a future without trades, by a real-time or a delayed source, and a night without trades.
  { symbol: "2330.TW", exchange: "TAI", periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"), answers: quietRealtime },
  { symbol: "2330.TW", periods: null, answers: quietDelayed },
  { symbol: "^TWII", exchange: "TAI", periods: null, answers: quietRealtime },
  { symbol: "WTX&", periods: null, answers: quietRealtime },
  { symbol: "WTX&", periods: LINE_PERIODS, answers: quietRealtime },
  { symbol: "WTX&", periods: null, answers: quietNight },
  { symbol: "WTX&", periods: LINE_PERIODS, answers: quietNight },
  { symbol: "WTX&", periods: null, answers: quietDay },
  { symbol: "WTX&", periods: LINE_PERIODS, answers: quietDay },
];
const sweepName = (quote) => `${quote.symbol} ${quote.periods ? "with" : "without"} periods${quote.answers ? `, ${quote.answers.name}` : ""}`;

test("every change in what a row reads comes at or after an edge announced for it", () => {
  for (const quote of EDGE_SWEEP_QUOTES) {
    for (const week of [...EDGE_SWEEP_WEEKS, ...HOLIDAY_WEEKS]) {
      assert.deepEqual(unannounced(quote, week), [], sweepName(quote));
    }
  }
  // The inferred quotes turn at their deadlines (Tue 11/10: 09:10, 09:30, and the night's 15:10).
  const [realtime, delayed, , , , night] = EDGE_SWEEP_QUOTES.filter((quote) => quote.answers);
  const reads = (quote, iso) => reading(quote, at(iso)).replace(/ \d+ /, " ");
  assert.deepEqual([reads(realtime, "2026-11-10T01:09:59Z"), reads(realtime, "2026-11-10T01:10:00Z"), reads(delayed, "2026-11-10T01:29:59Z"),
    reads(delayed, "2026-11-10T01:30:00Z"), reads(night, "2026-11-10T07:09:59Z"), reads(night, "2026-11-10T07:10:00Z")],
  ["open null", 'noTrades {"kind":"noTrades","source":"yahootw"}', "open null", 'noTrades {"kind":"noTrades","source":"yahoo"}', "open null",
    'closed {"kind":"nightNoTrades","source":"yahootw"}']);
});

test("the edge sweep holds on New York and Santiago clocks, each row turning at its own midnight", () => {
  const SANTIAGO_WEEKS = [[at("2026-04-02T00:00:00Z"), at("2026-04-08T00:00:00Z")], [at("2026-09-03T00:00:00Z"), at("2026-09-09T00:00:00Z")]];
  withTZ("America/New_York", () => {
    for (const quote of EDGE_SWEEP_QUOTES) for (const week of EDGE_SWEEP_WEEKS) assert.deepEqual(unannounced(quote, week), [], sweepName(quote));
  });
  withTZ("America/Santiago", () => {
    for (const quote of EDGE_SWEEP_QUOTES) for (const week of SANTIAGO_WEEKS) assert.deepEqual(unannounced(quote, week), [], sweepName(quote));
  });
});

test("a row reading a closure is told of no opening inside a closure", () => {
  for (const quote of EDGE_SWEEP_QUOTES) {
    for (const week of HOLIDAY_WEEKS) {
      assert.deepEqual(closedOpenings(quote, week), [], sweepName(quote));
    }
  }
  // The weeks hold both closures, for stocks and futures alike.
  const reads = (quote, iso) => sessionOf(marked(quote, at(iso)), at(iso));
  assert.deepEqual([reads({ symbol: "2330.TW", periods: null }, "2026-12-25T02:00:00Z"), reads({ symbol: "WTX&", periods: null }, "2026-12-25T18:00:00Z")],
    ["holiday", "closed"]);
});

// The open detail's wake is never now or earlier, and never missing (every real quote has its row's midnight ahead), so
// its loop never sleeps for nothing nor stops early: each sweep quote, given a real-time source and a trade 30 s before
// (so the stale moment is a number, not NaN), marked at its time as a row is and stamped with its mark's end as the
// detail's quote is, over a plain week and the weeks with listed days.
test("every detail wake is strictly later than now", () => {
  const priced = (quote, t) => ({ ...quote, source: quote.symbol === "BTC/USDT" ? "binance" : "yahootw", timestamp: t - 30_000 });
  const detailAt = (quote, t) => {
    const row = marked(priced(quote, t), t);
    const tw = resolvedMarket(quote.symbol, quote.exchange) === "tw";
    return tw ? { ...row, closureUntil: closureUntil(twMarket(quote.symbol), row.closure, t) } : row;
  };
  const misses = [];
  const marks = { listed: 0, inferred: 0, endFirst: 0 };
  for (const quote of EDGE_SWEEP_QUOTES) {
    for (const [from, to] of [[at("2026-11-08T00:00:00Z"), at("2026-11-15T00:00:00Z")], ...HOLIDAY_WEEKS]) {
      for (let t = from; t < to; t += 7 * MINUTE_MS) {
        const q = heldMarks(detailAt(quote, t), t);
        const wake = detailWakeAt(q, t);
        if (!(wake > t)) misses.push(`${sweepName(quote)} ${new Date(t).toISOString()} ${wake}`);
        if (q.closure) marks[q.closure.kind === "listed" ? "listed" : "inferred"]++;
        if (q.closure && wake === q.closureUntil) marks.endFirst++;
      }
    }
  }
  assert.deepEqual(misses, []);
  // The marks' ends are in the sweep: listed days, inferred marks, and samples where the mark's end is the first wake.
  assert.ok(marks.listed > 0 && marks.inferred > 0 && marks.endFirst > 0, JSON.stringify(marks));
});

test("a closed day: no dot, never stale, lit as closed, 休市 in the detail", () => {
  const now = at("2026-12-25T02:00:00Z");
  const q = { symbol: "2330.TW", source: "yahootw", price: 2485, limitUp: 2485, limitDown: 2035, timestamp: CLOSE_1224,
    periods: day("2026-12-24T01:00:00Z", "2026-12-24T05:30:00Z"), closure: { kind: "listed", reason: "行憲紀念日" }, chartSource: "yahootw" };
  assert.equal(sessionOf(q, now), "holiday");
  assert.deepEqual(freshness(q, "holiday", now), { state: "holiday", delayMinutes: null, stoppedAt: null });
  assert.equal(shownLimit(q, "holiday", now), "up");
  assert.deepEqual(detailSource(q, "holiday", now, say("zh-TW")), [["價格：休市 · Yahoo 奇摩股市"], ["走勢：休市 · Yahoo 奇摩股市"]]);
  const base = { symbol: "2330.TW", source: "yahoo", exchange: "TAI", timestamp: CLOSE_1224, closure: { kind: "listed", reason: "行憲紀念日" } };
  assert.deepEqual(detailSource(base, "holiday", now, say("zh-TW")), [["Yahoo Finance · 一般交易時段", "延遲 20 分鐘"]]);
  assert.equal(t("zh-TW", `session.${sessionName(q, "holiday", now)}`), "休市");
  const wtx = { symbol: "WTX&", periods: null, closure: { kind: "listed", reason: "行憲紀念日" } };
  assert.equal(nextEdge(wtx, at("2026-12-24T22:00:00Z"), { openings: true }), null);   // 12/25 06:00: no opening
  // A removed night: no night segment, so closed, not open.
  assert.equal(sessionOf({ symbol: "WTX&", periods: null, closure: { kind: "nightRemoved" } }, at("2026-12-25T18:00:00Z")), "closed");
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
    `${tx("session.closed")} · ${[formatStaleDate(closed, evening, "en"), formatTime(last)].filter(Boolean).join(" ")}`);
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

test("no trades today: lit as closed, never while stalled", () => {
  const now = at("2026-11-11T01:10:00Z");
  const q = { symbol: "2330.TW", source: "mis", price: 2485, limitUp: 2485, limitDown: 2035, timestamp: at("2026-11-10T05:30:00Z"),
    periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z") };
  assert.equal(shownLimit({ ...q, periods: day("2026-11-11T01:00:00Z", "2026-11-11T05:30:00Z") }, "open", now), null);   // stalled
  assert.equal(shownLimit({ ...q, closure: { kind: "noTrades", source: "mis" } }, "noTrades", now), "up");
});

// The band draws a dot and no label: a day without trades by inference (maybe a stuck feed) must not look like a
// closed market there, while a listed day does.
test("the band's dot: hollow for 今日無成交, none for 休市 or closed", () => {
  const now = at("2026-11-11T01:30:00Z");                          // 09:30 on a normal Wednesday
  const close = at("2026-11-10T05:30:00Z");
  const row = (closure) => ({ symbol: "2330.TW", source: "yahoo", exchange: "TAI", price: 1000, timestamp: close, closure });
  assert.equal(bandState(row({ kind: "noTrades", source: "yahoo" }), now), "stalled");
  assert.equal(bandState(row({ kind: "listed", reason: "颱風" }), now), "holiday");
  assert.equal(bandState(row(null), at("2026-11-14T02:00:00Z")), "closed");   // Saturday
});

// A TW-only index priced by Yahoo 奇摩股市 alone, with no line periods yet, reads its session from TWSE's hours: a feed
// that stopped at 11:00 must not read closed at 11:00 once the hours say the market closed.
test("a price read by the hours that stopped well before the close keeps reading stalled after it", () => {
  const eleven = at("2026-11-11T03:00:00Z");                         // 11:00 Taipei, Wednesday
  const quote = (timestamp, now) => {
    const own = { symbol: "^TWOII", source: "yahootw", exchange: "TWO", price: 300, timestamp, tradeTime: timestamp };
    return { ...own, periods: ownPeriods(own, undefined, now) };
  };
  const state = (timestamp, now) => {
    const q = quote(timestamp, now);
    return freshness(q, sessionOf(q, now), now).state;
  };
  assert.equal(state(eleven, at("2026-11-11T05:00:00Z")), "stalled");         // 13:00, open
  assert.equal(state(eleven, at("2026-11-11T05:31:00Z")), "stalled");         // 13:31, closed by the hours
  assert.equal(state(eleven, at("2026-11-11T12:00:00Z")), "stalled");         // 20:00
  assert.equal(freshness(quote(eleven, at("2026-11-11T05:31:00Z")), "closed", at("2026-11-11T05:31:00Z")).stoppedAt, eleven);
  // A price fresh at the close reads closed; on the next Taipei day the price is an earlier day's, closed with its date.
  assert.equal(state(at("2026-11-11T05:29:30Z"), at("2026-11-11T05:31:00Z")), "closed");
  assert.equal(state(eleven, at("2026-11-11T16:01:00Z")), "closed");
});

// The same for a US stock priced by Finnhub alone (no Yahoo Finance quote, so no periods): last traded at 15:50 New
// York, it reads stalled at 20:00, never closed; one last traded at 15:59:40 reads closed.
test("a Finnhub-only US stock that stopped before the close reads stalled all evening", () => {
  const aapl = (timestamp) => ({ symbol: "AAPL", source: "finnhub", price: 230, timestamp, periods: null });
  const state = (timestamp, now) => freshness(aapl(timestamp), sessionOf(aapl(timestamp), now), now).state;
  const evening = at("2026-11-12T01:00:00Z");                        // 20:00 New York on 11/11
  assert.equal(sessionOf(aapl(at("2026-11-11T20:50:00Z")), evening), "closed");
  assert.equal(state(at("2026-11-11T20:50:00Z"), evening), "stalled");         // 15:50
  assert.equal(state(at("2026-11-11T20:59:40Z"), evening), "closed");          // 15:59:40
});

test("a cached price is never live, in any session that would read live; paused and other states keep theirs", () => {
  const stalledAt = (ts) => ({ state: "stalled", delayMinutes: null, stoppedAt: ts });
  const pair = { symbol: "BTC/USDT", source: "binance", timestamp: now - 10_000, periods: null, cached: true };
  assert.deepEqual(freshness(pair, "24h", now), stalledAt(now - 10_000));
  const mis = { symbol: "2330.TW", source: "mis", timestamp: now - 5_000, periods: null, cached: true };
  assert.deepEqual(freshness(mis, "open", now), stalledAt(now - 5_000));
  for (const session of ["closed", "lunch", "holiday", "noTrades", "pre", "post"]) {
    assert.equal(freshness(mis, session, now).state, session);
  }
  // Unconfirmed stays unconfirmed: an unknown session, and a Yahoo price still at the previous close.
  assert.equal(freshness({ ...mis, source: "finnhub" }, "unknown", now).state, "unconfirmed");
  const open = at("2026-11-10T14:30:00Z");                   // 09:30 New York
  const prior = { ...yq("AAPL", "NMS", open - 61_200_000, day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z")),
    fetchedAt: open + 5_000, cached: true };                  // yesterday's 16:00 close, fetched at 09:30:05
  assert.equal(freshness(prior, "open", open + 20_000).state, "unconfirmed");
  assert.equal(freshness(prior, "open", open + 119_000).state, "unconfirmed");
  assert.equal(freshness(prior, "open", open + 121_000).state, "stalled");
  // A delayed cached quote keeps its delay until its age passes delay + 5 min (15 + 5 min for HKG).
  const tenHK = at("2026-11-10T02:00:00Z");                  // 10:00 Hong Kong
  const hk = { ...yq("0700.HK", "HKG", tenHK - 60_000, day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z")), cached: true };
  assert.equal(freshness(hk, "open", tenHK).state, "delayed");
  assert.equal(freshness(hk, "open", tenHK - 60_000 + 20 * 60_000 + 1_000).state, "stalled");
});

test("a recent cached Yahoo Finance line under a live Finnhub price reads stopped by the rule, not by age", () => {
  const time = at("2026-11-10T15:05:00Z");                  // 10:05 New York
  const base = { ...yq("AAPL", "NMS", time - 30_000, day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z")),
    fetchedAt: time - 25_000, series: [1, 2], cached: true };
  const row = mergeOverlay(base, { symbol: "AAPL", source: "finnhub", price: 230, timestamp: time - 10_000 }, null);
  // A cached line used to read Live by its age (30 s); it now reads stopped at its own time.
  assert.deepEqual(detailSource(row, "open", time, say("en")),
    [["Price: Live · Finnhub"], [`Line: quote stopped at ${formatTime(base.timestamp)} · Yahoo Finance`]]);
});

test("a sole-source future rate limited 5 s after its price reads 報價停在 22:00 at once", () => {
  const price = at("2026-11-11T14:00:00Z");           // 22:00 Taipei, night session
  const q = { symbol: "WTX&", source: "yahootw", timestamp: price, periods: { pre: null, regular: null, post: null,
    segments: [[at("2026-11-11T07:00:00Z"), at("2026-11-11T21:00:00Z")]] }, chartSource: "yahootw", cached: true };
  const time = price + 5_000;
  withTZ("Asia/Taipei", () => {
    assert.equal(zhLabel(q, time), "報價停在 22:00");
    assert.deepEqual(detailSource(q, sessionOf(q, time), time, say("zh-TW")),
      [["價格：報價停在 22:00 · Yahoo 奇摩股市"], ["走勢：報價停在 22:00 · Yahoo 奇摩股市"]]);
  });
});

test("the stale wake judges a cached quote by age, as before", () => {
  const q = { symbol: "2330.TW", source: "yahootw", timestamp: now - 5_000, periods: null, cached: true };
  assert.equal(msUntilStale(q, "open", now), 115_001);
});

test("a cached Yahoo Finance base under a live MIS price leaves the MIS price live", () => {
  const time = at("2026-11-10T02:00:00Z");                 // 10:00 Taipei
  const base = { ...yq("2330.TW", "TAI", time - 600_000, day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z")), cached: true };
  const row = mergeOverlay(base, { symbol: "2330.TW", source: "mis", price: 500, timestamp: time - 5_000 }, null);
  assert.equal(freshness(row, sessionOf(row, time), time).state, "live");
});

test("a live MIS price over a failed Yahoo Finance base: live, lit at its limit, the line's note", () => {
  const time = at("2026-11-10T02:00:00Z");                 // 10:00 Taipei
  const base = { ...yq("6488.TWO", "TWO", time - 600_000, day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z")),
    fetchedAt: time - 590_000, series: [1, 2], previousClose: 500, cached: true };
  const mis = { symbol: "6488.TWO", source: "mis", price: 550, limitUp: 550, limitDown: 450, timestamp: time - 5_000 };
  const row = mergeOverlay(base, mis, null);
  assert.equal(freshness(row, "open", time).state, "live");
  assert.equal(shownLimit(row, "open", time), "up");
  assert.equal(failureNote(row), "quote.chartCached");
  assert.equal(bandState(row, time), "live");
  // The overlay itself gone stale reads stalled by age, still with the line's note, still not cached.
  assert.equal(freshness(row, "open", time + 116_000).state, "stalled");
  assert.deepEqual([row.cached, failureNote(row)], [undefined, "quote.chartCached"]);
});

test("2330.TW's detail with MIS live over a failed Yahoo Finance quote names both sources", () => {
  const time = at("2026-11-10T02:00:00Z");                 // 10:00 Taipei
  const base = { ...yq("2330.TW", "TAI", time - 600_000, day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z")),
    fetchedAt: time - 590_000, series: [1, 2], cached: true };
  const row = mergeOverlay(base, { symbol: "2330.TW", source: "mis", price: 500, timestamp: time - 5_000 }, null);
  assert.deepEqual(detailSource(row, "open", time, say("zh-TW")), [["價格：即時 · 證交所 MIS"], ["走勢：延遲 20 分鐘 · Yahoo Finance"]]);
  assert.equal(failureNote(row), "quote.chartCached");
});

test("Yahoo 奇摩股市 with its own line over a failed Yahoo Finance base: no row note", () => {
  const time = at("2026-11-10T02:00:00Z");
  const base = { ...yq("2330.TW", "TAI", time - 600_000, day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z")), cached: true };
  const today = taipeiDay(time);
  const own = { symbol: "2330.TW", source: "yahootw", price: 500, timestamp: time - 5_000, day: today };
  const row = mergeOverlay(base, own, { day: today, series: [499, 500] });
  assert.equal(failureNote(row), null);
});

test("a live row carries no date; a stalled one keeps it; the detail's times keep it", () => {
  withTZ("Asia/Taipei", () => {
    const midnight = at("2026-11-11T16:00:00Z"); // 00:00 on 11/12 local
    const pair = { symbol: "BTC/USDT", source: "binance", timestamp: midnight - 2_000, periods: null };
    const live = freshness(pair, "24h", midnight + 3_000);
    assert.equal(live.state, "live");
    assert.equal(rowDate(pair, live, midnight + 3_000, "zh-TW"), "");
    const old = { ...pair, timestamp: midnight - 120_000 };
    const stalled = freshness(old, "24h", midnight + 60_000);
    assert.equal(rowDate(old, stalled, midnight + 60_000, "zh-TW"), "11/11");
    assert.match(detailTimes(pair, midnight + 3_000, "zh-TW", say("zh-TW"))[0], /11\/11/);
    // WTX& live at 00:00:05 Taipei, traded at 23:59:55 (11/11 is a Wednesday, so the night session runs).
    const wtx = { symbol: "WTX&", source: "yahootw", timestamp: midnight - 5_000, periods: null };
    const time = midnight + 5_000;
    const fresh = freshness(wtx, sessionOf(wtx, time), time);
    assert.equal(fresh.state, "live");
    assert.equal(rowDate(wtx, fresh, time, "zh-TW"), "");
    // Delayed and pre-session quotes from an earlier day keep their date: only a live row drops it.
    const hk = { symbol: "0700.HK", exchange: "HKG", source: "yahoo", timestamp: midnight - 5_000, periods: null };
    const delayed = freshness(hk, "open", midnight + 5_000);
    assert.equal(delayed.state, "delayed");
    assert.equal(rowDate(hk, delayed, midnight + 5_000, "zh-TW"), "11/11");
    const aapl = { symbol: "AAPL", exchange: "NMS", source: "yahoo", timestamp: midnight - 5_000, periods: null };
    const pre = freshness(aapl, "pre", midnight + 5_000);
    assert.equal(pre.state, "pre");
    assert.equal(rowDate(aapl, pre, midnight + 5_000, "zh-TW"), "11/11");
  });
});

// What the open detail shows at `time`: its session, its source lines and the row's label, from its quote as held then.
const shownAt = (detail, time) => {
  const q = heldMarks(detail, time);
  const session = sessionOf(q, time);
  return { session, source: detailSource(q, session, time, say("zh-TW")), label: zhLabel(q, time) };
};
// Runs followDetail on a fake clock from `from` until `until`, returning the redraw times and each sleep asked. A sleep
// that would end past `until` rejects, as cx.sleep does once the dialog closes, which ends the loop.
async function wakes(detail, from, until) {
  const host = fakeHost(() => ok({}));
  host.clock = from;
  const redraws = [];
  const asked = [];
  const sleep = (ms) => { asked.push(ms); return host.clock + ms > until ? Promise.reject(new Error("closed")) : host.sleep(ms); };
  const run = followDetail(detail, { now: host.now, sleep, changed: () => redraws.push(host.clock) }).catch(() => {});
  await advance(host, until);
  await run;
  return { redraws, asked };
}

test("AAPL's open detail turns from Live to stopped about a second after 120 s", async () => {
  const trade = at("2026-11-10T15:00:00Z");                                        // 10:00:00 NY
  const detail = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: trade, price: 230,
    periods: day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z") };
  assert.equal(detailWakeAt(detail, trade + 30_000), trade + 120_001);
  const { redraws } = await wakes(detail, trade + 30_000, trade + 125_000);
  assert.ok(redraws.some((time) => time >= trade + 120_000 && time <= trade + 121_000), redraws.join());
  assert.match(shownAt(detail, trade + 120_000).source[0][0], /即時/);
  assert.match(shownAt(detail, trade + 120_001).source[0][0], /報價停在/);
});

test("a Finnhub price with a live Yahoo Finance line: the line turns stale at its own moment, first", () => {
  const time = at("2026-11-10T15:05:00Z");                                         // 10:05 New York
  // The line's Yahoo quote was 5 s old when fetched 250 s ago: its fetch guard falls at +50 001, before the price's +110 001.
  const q = { symbol: "AAPL", source: "finnhub", exchange: "NMS", price: 230, timestamp: time - 10_000,
    periods: day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z"),
    chartSource: "yahoo", chartTimestamp: time - 255_000, chartFetchedAt: time - 250_000 };
  assert.equal(detailWakeAt(q, time), time + 50_001);
  withTZ("Asia/Taipei", () => {
    const [[price], [line]] = shownAt(q, time + 50_001).source;
    assert.match(price, /即時/);
    assert.match(line, /報價停在/);
  });
});

test("0700.HK's open detail reads 午休 within a second of 12:00", async () => {
  const noon = at("2026-11-10T04:00:00Z");                                         // 12:00 Hong Kong
  // Fetched 30 s after its quote (fetchedAt set, so the fetch guard does not sit at +300 001 for ever).
  const detail = { ...yq("0700.HK", "HKG", noon - 90_000, day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z")), fetchedAt: noon - 60_000 };
  const { redraws } = await wakes(detail, noon - 60_000, noon + 5_000);
  assert.ok(redraws.some((t) => t >= noon && t <= noon + 1_000), redraws.join());
  assert.equal(sessionOf(heldMarks(detail, noon), noon), "lunch");
});

test("a night mark opened at 02:00 ends at 05:00: 已收盤, the night's hours shown again", () => {
  const opened = at("2026-11-11T18:00:00Z");                                       // 02:00 Thursday 11/12
  const end = at("2026-11-11T21:00:00Z");                                          // 05:00
  // The day traded until 13:45 on 11/11; the night (15:00) had no trade; TAIFEX's table (periods null).
  const detail = { symbol: "WTX&", source: "yahootw", price: 23_000, timestamp: at("2026-11-11T05:45:00Z"), periods: null,
    chartSource: "yahootw", closure: { kind: "nightNoTrades", source: "yahootw" }, closureUntil: end };
  assert.equal(detailWakeAt(detail, opened), end);
  withTZ("Asia/Taipei", () => {
    const hours = (time) => sessionTimesParts(sessionTimes(heldMarks(detail, time), time), "zh-TW", say("zh-TW")).join(" · ");
    assert.match(hours(end - 1_000), /夜盤尚無成交/);
    assert.match(hours(end), /日盤 08:45–13:45 · 夜盤 15:00–05:00/);
    assert.equal(sessionOf(heldMarks(detail, end), end), "closed");
  });
});

test("a futures day's 今日無成交 opened at 15:05 ends at 15:10, never Live", () => {
  const end = at("2026-11-11T07:10:00Z");                                          // 15:10
  // Last trade 13:44 on 11/10; TAIFEX's table; the mark as closureOf gave it at 15:05.
  const detail = { symbol: "WTX&", source: "yahootw", price: 23_000, timestamp: at("2026-11-10T05:44:00Z"), periods: null,
    chartSource: "yahootw", closure: { kind: "noTrades", source: "yahootw" }, noTradesDeadline: end, closureUntil: end };
  assert.equal(sessionOf(heldMarks(detail, end - 1_000), end - 1_000), "noTrades");
  const after = heldMarks(detail, end);
  assert.equal(sessionOf(after, end), "open");
  assert.equal(freshness(after, "open", end).state, "stalled");
});

test("WTX&'s detail opened at 23:50 on 12/24 into a listed 12/25: stalled, then 已收盤, never 休市 or Live", async () => {
  const trade = at("2026-12-24T15:49:30Z");                                        // 23:49:30 Thursday 12/24
  const detail = { symbol: "WTX&", source: "yahootw", price: 23_000, timestamp: trade, periods: null, chartSource: "yahootw" };
  const state = (time) => freshness(detail, sessionOf(detail, time), time).state;
  assert.equal(state(trade + 120_000), "live");
  assert.equal(state(trade + 120_001), "stalled");
  const midnight = at("2026-12-24T16:00:00Z");
  const nightEnd = at("2026-12-24T21:00:00Z");                                     // 05:00 on 12/25
  const dayOpen = at("2026-12-25T00:45:00Z");                                      // 08:45 on 12/25
  const { redraws } = await wakes(detail, trade + 30_000, dayOpen + 5_000);
  for (const moment of [midnight, nightEnd, dayOpen]) {
    assert.ok(redraws.some((t) => t >= moment && t <= moment + 1_000), `${new Date(moment).toISOString()}: ${redraws.join()}`);
  }
  assert.equal(sessionOf(detail, nightEnd), "closed");
  assert.equal(state(at("2026-12-25T01:00:00Z")), "stalled");                        // 09:00 on 12/25
  for (let time = trade + 120_001; time < at("2026-12-25T21:00:00Z"); time += MINUTE_MS) {   // to 05:00 on 12/26
    assert.notEqual(state(time), "live", new Date(time).toISOString());
    assert.notEqual(sessionOf(detail, time), "holiday", new Date(time).toISOString());
  }
});

test("2330.TW's detail opened at 22:00 on listed 2/12 reads 已收盤 with the date from 00:00 on 2/13", () => {
  // LISTED_2026 lists Thursday 2/12 and Friday 2/13 (市場無交易，僅辦理結算交割作業). Last trade 2/11 13:30.
  const end = at("2026-02-12T16:00:00Z");                                          // 00:00 on 2/13
  const detail = { symbol: "2330.TW", source: "yahootw", price: 1_000, timestamp: at("2026-02-11T05:30:00Z"),
    periods: day("2026-02-11T01:00:00Z", "2026-02-11T05:30:00Z"), chartSource: "yahootw",
    closure: { kind: "listed", reason: "市場無交易，僅辦理結算交割作業" }, closureUntil: end };
  withTZ("Asia/Taipei", () => {
    assert.equal(sessionOf(heldMarks(detail, end - 1_000), end - 1_000), "holiday");
    assert.equal(zhLabel(heldMarks(detail, end), end), "已收盤 · 2/11 13:30");
    for (let time = end; time < at("2026-02-13T05:30:00Z"); time += MINUTE_MS) {
      const q = heldMarks(detail, time);
      assert.notEqual(freshness(q, sessionOf(q, time), time).state, "live", new Date(time).toISOString());
      assert.equal(zhLabel(q, time), "已收盤 · 2/11 13:30", new Date(time).toISOString());
    }
  });
});

// A closed 2330.TW (Yahoo 奇摩股市, 11/10's periods, 13:30 trade) opened at 21:00 Taipei: its next wake is 00:00, 3 h on.
const CLOSED_2330 = { symbol: "2330.TW", source: "yahootw", price: 1_000, timestamp: at("2026-11-10T05:30:00Z"),
  periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"), chartSource: "yahootw" };
const NINE_PM = at("2026-11-10T13:00:00Z");
const MIDNIGHT_TPE = at("2026-11-10T16:00:00Z");

test("followDetail sleeps in 10-minute steps to a far wake and redraws only when it is reached", async () => {
  const { redraws, asked } = await wakes(CLOSED_2330, NINE_PM, MIDNIGHT_TPE + 1_000);
  assert.equal(asked.length, 19);
  assert.ok(asked.every((ms) => ms > 0 && ms <= DETAIL_WAKE_CAP_MS), asked.join());
  assert.deepEqual(redraws, [MIDNIGHT_TPE]);
});

test("followDetail after a system sleep past its wake redraws once and computes the next wake from the new now", async () => {
  // The machine slept through the 00:00 wake: the first sleep returns with the clock at 01:00, an hour past it.
  let clock = NINE_PM;
  const asked = [];
  const redraws = [];
  const sleep = (ms) => {
    asked.push(ms);
    if (asked.length === 1) { clock = MIDNIGHT_TPE + 3_600_000; return Promise.resolve(); }
    return Promise.reject(new Error("closed"));
  };
  await followDetail(CLOSED_2330, { now: () => clock, sleep, changed: () => redraws.push(clock) }).catch(() => {});
  assert.deepEqual(redraws, [MIDNIGHT_TPE + 3_600_000]);
  assert.equal(asked[1], DETAIL_WAKE_CAP_MS);
});

test("followDetail ends when its sleep rejects, with no later redraw", async () => {
  const redraws = [];
  const done = followDetail(CLOSED_2330, { now: () => NINE_PM, sleep: () => Promise.reject(new Error("closed")),
    changed: () => redraws.push(1) });
  await assert.rejects(done);
  assert.deepEqual(redraws, []);
});

test("a mark's end alone wakes the detail: row 7's 今日無成交 at 15:10", () => {
  // No noTradesDeadline, so nothing but closureUntil falls at 15:10 (nextEdge gives 00:00 here).
  const fifteen = at("2026-11-11T07:00:00Z");
  const end = at("2026-11-11T07:10:00Z");
  const d = { symbol: "WTX&", source: "yahootw", price: 23_000, timestamp: at("2026-11-10T05:44:00Z"), periods: null,
    chartSource: "yahootw", closure: { kind: "noTrades", source: "yahootw" }, closureUntil: end };
  assert.equal(detailWakeAt(heldMarks(d, fifteen), fifteen), end);
});
