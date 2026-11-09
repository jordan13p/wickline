// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, TAIWAN_YAHOO_DELAY_S, detailSource, freshness, sessionOf, shownLimit,
} from "../mods/wickline/freshness.js";
import { formatTime } from "../mods/wickline/format.js";
import { t } from "../mods/wickline/i18n.js";

const now = 1_000_000;
const quote = (fields) => ({ symbol: "AAPL", source: "yahoo", timestamp: now - 5_000, delaySeconds: null, periods: null, ...fields });

test("freshness constants", () => {
  assert.equal(LIVE_MAX_AGE_MS, 120_000);
  assert.equal(TAIWAN_YAHOO_DELAY_S, 1200);
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
    [quote({ symbol: "2330.TW", delaySeconds: 0 }), "open", { state: "delayed", delayMinutes: 20, stoppedAt: null }],
    [quote({ delaySeconds: 0 }), "open", { state: "delayed", delayMinutes: null, stoppedAt: null }],
    [quote({ symbol: "0700.HK", delaySeconds: 900 }), "open", { state: "delayed", delayMinutes: 15, stoppedAt: null }],
    // A delayed quote whose session is unknown is still delayed, never live.
    [quote({ delaySeconds: 0 }), "unknown", { state: "delayed", delayMinutes: null, stoppedAt: null }],
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
  const say = (lang) => (key, params) => t(lang, key, params);
  const own = { symbol: "2330.TW", source: "yahootw", timestamp: NOW - 10_000, chartSource: "yahootw", chartDelaySeconds: 0 };
  assert.deepEqual(detailSource(own, "open", NOW, say("zh-TW")), ["價格：即時 · Yahoo 奇摩股市", "走勢：即時 · Yahoo 奇摩股市"]);
  assert.deepEqual(detailSource(own, "open", NOW, say("en")), ["Price: Live · Yahoo TW Stock", "Line: Live · Yahoo TW Stock"]);
  // A stalled price makes its own line read stalled too, with the time it stopped.
  const old = { ...own, timestamp: NOW - 180_000 };
  const stalled = t("zh-TW", "freshness.stalled", { time: formatTime(old.timestamp) });
  assert.deepEqual(detailSource(old, "open", NOW, say("zh-TW")), [`價格：${stalled} · Yahoo 奇摩股市`, `走勢：${stalled} · Yahoo 奇摩股市`]);
  // A line from another source keeps its own delay.
  const mis = { symbol: "2330.TW", source: "mis", timestamp: NOW - 10_000, chartSource: "yahoo", chartDelaySeconds: null };
  assert.deepEqual(detailSource(mis, "open", NOW, say("zh-TW")), ["價格：即時 · 證交所 MIS", "走勢：延遲 20 分鐘 · Yahoo Finance"]);
  assert.deepEqual(detailSource({ ...mis, symbol: "AAPL", source: "finnhub", chartDelaySeconds: 900 }, "open", NOW, say("en")),
    ["Price: Live · Finnhub", "Line: delayed 15 min · Yahoo Finance"]);
  // Not trading: the session, not "Live"; a session not known yet reads unknown.
  assert.deepEqual(detailSource(own, "closed", NOW, say("en")), ["Price: Market closed · Yahoo TW Stock", "Line: Market closed · Yahoo TW Stock"]);
  assert.deepEqual(detailSource({ ...mis, chartSource: null }, "unknown", NOW, say("en")), ["Price: Session unknown · TWSE MIS"]);
  // Base only: unchanged.
  const base = { symbol: "2330.TW", source: "yahoo", timestamp: NOW, delaySeconds: null };
  assert.deepEqual(detailSource(base, "open", NOW, say("en")), ["Yahoo Finance · regular session", "delayed 20 min"]);
});

// A light says the stock is at its limit now (or closed there), so it follows the price's own freshness.
test("a price at its limit is lit only while that is still true", () => {
  const at = (fields) => quote({ symbol: "2330.TW", source: "mis", price: 2485, limitUp: 2485, limitDown: 2035, ...fields });
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

