// node --test tests/  (quotes.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, normalizeSymbol } from "../mods/wickline/quotes.js";

test("normalizes symbols", () => {
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  assert.equal(normalizeSymbol("700.hk"), "0700.HK");
  assert.equal(normalizeSymbol("00700.HK"), "0700.HK");
  assert.equal(normalizeSymbol("600519.SH"), "600519.SS");
  assert.equal(normalizeSymbol("btc/usdt"), "BTC/USDT");
  assert.throws(() => normalizeSymbol("https://example.com"));
  assert.throws(() => normalizeSymbol("Apple Inc"));
});

test("identity", () => {
  assert.equal(USER_AGENT, "Wickline-Herdr/0.4.0");
});
