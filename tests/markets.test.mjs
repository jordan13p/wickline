// node --test tests/  (markets.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { marketOf } from "../mods/bellwether/markets.js";

test("routes symbols to markets", () => {
  const table = [
    ["2330.TW", "tw"], ["6488.TWO", "tw"], ["AAPL", "us"], ["BRK-B", "us"], ["^GSPC", "other"], ["EURUSD=X", "other"],
    ["0700.HK", "hk"], ["600519.SS", "cn"], ["000001.SZ", "cn"], ["7203.T", "jp"], ["005930.KS", "kr"],
    ["035720.KQ", "kr"], ["BTC/USDT", "crypto"], ["VOD.L", "other"],
    // Only a leading ^ marks an index.
    ["A^B", "us"],
  ];
  for (const [symbol, market] of table) assert.equal(marketOf(symbol), market, symbol);
});
