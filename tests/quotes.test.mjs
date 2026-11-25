// node --test tests/  (quotes.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, cleanSeries, cleanTimedSeries, normalizeSymbol, priceLimit } from "../mods/wickline/quotes.js";

test("normalizes symbols", () => {
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  assert.equal(normalizeSymbol("700.hk"), "0700.HK");
  assert.equal(normalizeSymbol("00700.HK"), "0700.HK");
  assert.equal(normalizeSymbol("600519.SH"), "600519.SS");
  assert.equal(normalizeSymbol("btc/usdt"), "BTC/USDT");
  assert.throws(() => normalizeSymbol("https://example.com"));
  assert.throws(() => normalizeSymbol("Apple Inc"));
  assert.equal(normalizeSymbol("wtx&"), "WTX&");
  assert.equal(normalizeSymbol(" wtx@ "), "WTX@");
  assert.equal(normalizeSymbol("wtx"), "WTX");
  for (const bad of ["TXF1&", "WTX&&", "&", "ABCDEFG&", "WTX &", "^WTX&"])
    assert.throws(
      () => normalizeSymbol(bad),
      (e) => e.code === "symbol.invalid",
      bad,
    );
});

test("identity", () => {
  assert.equal(USER_AGENT, "Wickline-Herdr/0.9.1");
});

test("a price is at a limit only when it equals its own source's limit", () => {
  assert.equal(priceLimit({ price: 563, limitUp: 563, limitDown: 461 }), "up");
  assert.equal(priceLimit({ price: 461, limitUp: 563, limitDown: 461 }), "down");
  assert.equal(priceLimit({ price: 562, limitUp: 563, limitDown: 461 }), null);
  // No limits, or limits that are not a pair: never at one, whatever the price.
  assert.equal(priceLimit({ price: 563 }), null);
  assert.equal(priceLimit({ price: 563, limitUp: 563, limitDown: null }), null);
  assert.equal(priceLimit({ price: 9999.95, limitUp: 9999.95, limitDown: 70 }), null);
  assert.equal(priceLimit(null), null);
  // Only MIS's own no-limit marker, 9999.95, means none: a real limit-up can pass 9999 (ticks of 5 from 1000).
  assert.equal(priceLimit({ price: 10010, limitUp: 10010, limitDown: 8190 }), "up");
});

test("cleanTimedSeries cleans values exactly as cleanSeries does", () => {
  for (const values of [
    [1, null, 0, -2, 3, NaN, "4", 5],
    [],
    undefined,
    "x",
    Array.from({ length: 450 }, (_, i) => (i % 7 ? i + 1 : null)),
  ]) {
    assert.deepEqual(cleanTimedSeries(values, null).series, cleanSeries(values));
  }
});

test("cleanTimedSeries drops a value's time with it and caps both", () => {
  assert.deepEqual(cleanTimedSeries([10, null, 12], [100, 200, 300]), { series: [10, 12], times: [100, 300] });
  const long = cleanTimedSeries(
    Array.from({ length: 401 }, (_, i) => i + 1),
    Array.from({ length: 401 }, (_, i) => i * 1000),
  );
  assert.deepEqual(
    [long.series.length, long.times.length, long.series[0], long.times[0], long.times.at(-1)],
    [400, 400, 2, 1000, 400_000],
  );
});

test("cleanTimedSeries keeps no times it cannot align", () => {
  for (const times of [
    undefined,
    null,
    "x",
    [100, 200],
    [100, 200, 300, 400],
    [100, NaN, 300],
    [100, "200", 300],
    [100, null, 300],
    [100, 0, 300],
  ]) {
    assert.deepEqual(cleanTimedSeries([10, 11, 12], times), { series: [10, 11, 12], times: null }, String(times));
  }
  // A missing value's bad time goes with it.
  assert.deepEqual(cleanTimedSeries([10, null, 12], [100, NaN, 300]).times, [100, 300]);
});
