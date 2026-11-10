// node --test tests/  (quotes.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, normalizeSymbol, priceLimit } from "../mods/wickline/quotes.js";

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
  for (const bad of ["TXF1&", "WTX&&", "&", "ABCDEFG&", "WTX &", "^WTX&"]) assert.throws(() => normalizeSymbol(bad), (e) => e.code === "symbol.invalid", bad);
});

test("identity", () => {
  assert.equal(USER_AGENT, "Wickline-Herdr/0.4.0");
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
