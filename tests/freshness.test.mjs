// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, detailSource, freshness, isRealtime, msUntilStale, sessionOf, shownLimit,
} from "../mods/wickline/freshness.js";
import { formatTime, freshnessLabel } from "../mods/wickline/format.js";
import { t } from "../mods/wickline/i18n.js";
import { at, day, yq } from "./helpers.mjs";

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
  assert.equal(sessionOf({ symbol: "AAPL", periods: null }, 1), "unknown");
  assert.equal(sessionOf({ symbol: "AAPL", periods: { pre: null, regular: null, post: null } }, 1), "unknown");
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
  // Not trading: the session, not "Live"; a session not known yet reads unknown.
  assert.deepEqual(detailSource(own, "closed", NOW, say("en")), [["Price: Market closed · Yahoo TW Stock"], ["Line: Market closed · Yahoo TW Stock"]]);
  assert.deepEqual(detailSource({ ...mis, chartSource: null }, "unknown", NOW, say("en")), [["Price: Session unknown · TWSE MIS"]]);
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

test("a lunch break counts only where it overlaps the quote's trading time", () => {
  // Timed 11:35 JST, inside lunch: only the minutes since the 12:30 reopening count, so it stops after 12:50.
  const inLunch = yq("7203.T", "JPX", at("2026-11-10T02:35:00Z"), TOKYO_DAY);
  assert.equal(freshness(fetched(inLunch, at("2026-11-10T03:50:00Z")), "open", at("2026-11-10T03:50:00Z")).state, "delayed");
  assert.equal(msUntilStale(fetched(inLunch, at("2026-11-10T03:50:00Z") + 1), "open", at("2026-11-10T03:50:00Z") + 1), 0);
  // Timed 11:00 JST, fetched 11:20: lunch has not begun, nothing is taken off: exactly its 20 min, not stale.
  const early = yq("7203.T", "JPX", at("2026-11-10T02:00:00Z"), TOKYO_DAY);
  assert.equal(msUntilStale(fetched(early, at("2026-11-10T02:20:00Z")), "open", at("2026-11-10T02:20:00Z")), left(300_000, 0));
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

test("Yahoo at the US open: yesterday's close fetched a minute before the open does not read stopped", () => {
  const now = at("2026-11-10T14:30:20Z"); // 09:30:20 in New York
  const aapl = fetched(yq("AAPL", "NMS", at("2026-11-09T21:00:00Z"), US_DAY), at("2026-11-10T14:29:00Z"));
  assert.notEqual(freshness(aapl, "open", now).state, "stalled");
  // Its age counts from the open: the same close fetched 120 s after it is live, 121 s after it stopped.
  assert.equal(freshness(fetched(aapl, at("2026-11-10T14:32:00Z")), "open", at("2026-11-10T14:32:00Z")).state, "live");
  assert.equal(freshness(fetched(aapl, at("2026-11-10T14:32:01Z")), "open", at("2026-11-10T14:32:01Z")).state, "stalled");
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

test("a Yahoo quote without a fetch time counts as fetched now", () => {
  const T = at("2026-11-10T15:00:00Z");
  const aapl = yq("AAPL", "NMS", T - 10_000, US_DAY);
  for (const now of [T, T + 110_000, T + 110_001]) assert.deepEqual(freshness(aapl, "open", now), freshness(fetched(aapl, now), "open", now), `${now}`);
  assert.equal(freshness(aapl, "open", T + 110_001).state, "stalled");
});
