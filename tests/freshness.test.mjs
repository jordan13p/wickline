// node --test tests/  (freshness.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MAX_AGE_MS, REALTIME_SOURCES, TAIWAN_YAHOO_DELAY_S, freshness, sessionOf,
} from "../mods/bellwether/freshness.js";

const now = 1_000_000;
const quote = (fields) => ({ symbol: "AAPL", source: "yahoo", timestamp: now - 5_000, delaySeconds: null, periods: null, ...fields });

test("freshness constants", () => {
  assert.equal(LIVE_MAX_AGE_MS, 120_000);
  assert.equal(TAIWAN_YAHOO_DELAY_S, 1200);
  assert.deepEqual([...REALTIME_SOURCES].sort(), ["binance", "finnhub", "mis"]);
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
