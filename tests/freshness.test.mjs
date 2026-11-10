// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, detailSource, freshness, isRealtime, quoteAgeMs, sessionOf, shownLimit, staleAfterMs,
} from "../mods/wickline/freshness.js";
import { formatTime, freshnessLabel } from "../mods/wickline/format.js";
import { t } from "../mods/wickline/i18n.js";

const now = 1_000_000;
const quote = (fields) => ({ symbol: "AAPL", source: "yahoo", timestamp: now - 5_000, periods: null, ...fields });
const say = (lang) => (key, params) => t(lang, key, params);

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
  assert.deepEqual(detailSource({ ...mis, symbol: "AAPL", source: "finnhub", exchange: "NMS" }, "open", NOW, say("en")),
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
const at = (iso) => Date.parse(iso);
const day = (open, close) => ({ pre: null, regular: [at(open), at(close)], post: null });
const yq = (symbol, exchange, timestamp, periods = null) => ({ symbol, source: "yahoo", exchange, timestamp, periods });
const HK_DAY = day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z");

test("a Yahoo quote from a real-time exchange is live, and stalls after 120 s", () => {
  for (const exchange of ["NMS", "NYQ", "PCX", "SNP", "DJI", "NIM", "CCY"]) {
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
  const minutes = [["2330.TW", "TAI", 20], ["^TWII", "TAI", 20], ["005930.KS", "KSC", 20], ["7203.T", "JPX", 15], ["^N225", "OSA", 15],
    ["600519.SS", "SHH", 15], ["000858.SZ", "SHZ", 15], ["^VIX", "CXI", 15], ["ES=F", "CME", 10]];
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

test("staleAfterMs: 120 s for real time, the delay plus 5 min, else never", () => {
  assert.equal(staleAfterMs(yq("AAPL", "NMS", 0)), 120_000);
  assert.equal(staleAfterMs({ symbol: "2330.TW", source: "mis", exchange: "TAI", timestamp: 0 }), 120_000);
  assert.equal(staleAfterMs({ symbol: "BTC/USDT", source: "binance", timestamp: 0 }), 120_000);
  assert.equal(staleAfterMs(yq("0700.HK", "HKG", 0)), 1_200_000);
  assert.equal(staleAfterMs(yq("2330.TW", "TAI", 0)), 1_500_000);
  for (const [symbol, exchange] of [["ES=F", "CME"], ["AAPL", "XYZ"], ["AAPL", null]]) assert.equal(staleAfterMs(yq(symbol, exchange, 0)), null, symbol);
});

test("a delayed market's first minutes read delayed, not stopped at yesterday's close", () => {
  const open = at("2026-11-10T01:00:00Z"); // 09:00 in Taipei
  const tw = yq("2330.TW", "TAI", at("2026-11-09T05:30:00Z"), day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"));
  assert.equal(quoteAgeMs(tw, open + 60_000), 60_000);
  assert.deepEqual(freshness(tw, "open", open + 60_000), { state: "delayed", delayMinutes: 20, stoppedAt: null });
  assert.equal(freshness(tw, "open", open + 1_500_000).state, "delayed");
  assert.deepEqual(freshness(tw, "open", open + 1_500_001), { state: "stalled", delayMinutes: null, stoppedAt: tw.timestamp });
  // Real time is never anchored: yesterday's price at the open reads stopped, never live.
  const usOpen = at("2026-11-10T14:30:30Z");
  const us = yq("AAPL", "NMS", at("2026-11-09T21:00:00Z"), day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z"));
  assert.equal(quoteAgeMs(us, usOpen), usOpen - us.timestamp);
  assert.equal(freshness(us, "open", usOpen).state, "stalled");
});

test("the detail names Yahoo's state and keeps a delay while closed", () => {
  const NOW = 1794188480000;
  assert.deepEqual(detailSource(yq("AAPL", "NMS", NOW - 40_000), "open", NOW, say("en")), [["Price: Live · Yahoo Finance"]]);
  assert.deepEqual(detailSource(yq("0700.HK", "HKG", NOW - 40_000), "closed", NOW, say("en")), [["Yahoo Finance · regular session", "delayed 15 min"]]);
});

test("the line under a real-time price never reads stalled", () => {
  const NOW = 1794188480000;
  const finnhub = { symbol: "AAPL", source: "finnhub", exchange: "NMS", timestamp: NOW - 600_000, chartSource: "yahoo" };
  const stalled = t("en", "freshness.stalled", { time: formatTime(NOW - 600_000) });
  assert.deepEqual(detailSource(finnhub, "open", NOW, say("en")), [[`Price: ${stalled} · Finnhub`], ["Line: Live · Yahoo Finance"]]);
  assert.deepEqual(detailSource(finnhub, "closed", NOW, say("en")), [["Price: Market closed · Finnhub"], ["Line: Market closed · Yahoo Finance"]]);
  const mis = { symbol: "2330.TW", source: "mis", exchange: "TAI", timestamp: NOW - 10_000, chartSource: "yahoo" };
  assert.deepEqual(detailSource(mis, "closed", NOW, say("en")), [["Price: Market closed · TWSE MIS"], ["Line: delayed 20 min · Yahoo Finance"]]);
});
