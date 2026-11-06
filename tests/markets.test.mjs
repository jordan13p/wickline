// node --test tests/  (markets.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { FILTER_MIN_MARKETS, FILTER_MIN_SYMBOLS, chosenFilter, marketFilters, marketOf, visibleSymbols } from "../mods/wickline/markets.js";

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

// 5 Taiwan, 4 US and 3 crypto symbols, Taiwan first.
const TWELVE = [
  "2330.TW", "0050.TW", "AAPL", "00632R.TW", "NVDA", "BTC/USDT", "2317.TW", "MSFT", "ETH/USDT", "2454.TW", "AMZN", "SOL/USDT",
];

test("no filters below 8 symbols or 2 markets", () => {
  assert.deepEqual(marketFilters(["AAPL", "2330.TW", "BTC/USDT", "NVDA"]), []);
  assert.deepEqual(marketFilters(["AAPL", "NVDA", "MSFT", "AMZN", "GOOG", "META", "TSLA", "NFLX"]), []);
  assert.equal(FILTER_MIN_SYMBOLS, 8);
  assert.equal(FILTER_MIN_MARKETS, 2);
});

test("filters list All, then the markets in first-appearance order, and the counts add up", () => {
  const filters = marketFilters(TWELVE);
  assert.deepEqual(filters, [{ id: "all", count: 12 }, { id: "tw", count: 5 }, { id: "us", count: 4 }, { id: "crypto", count: 3 }]);
  assert.equal(filters.slice(1).reduce((sum, { count }) => sum + count, 0), filters[0].count);
});

test("a market shows its own symbols in list order", () => {
  assert.deepEqual(visibleSymbols(TWELVE, "tw"), ["2330.TW", "0050.TW", "00632R.TW", "2317.TW", "2454.TW"]);
  assert.deepEqual(visibleSymbols(TWELVE, "crypto"), ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
});

test("All, an unknown filter and an absent market show everything", () => {
  for (const filter of ["all", "kr", "nonsense"]) assert.deepEqual(visibleSymbols(TWELVE, filter), TWELVE, filter);
});

test("the chosen filter is the stored one only while it is offered", () => {
  assert.equal(chosenFilter(TWELVE, "tw"), "tw");
  assert.equal(chosenFilter(TWELVE, "kr"), "all");
  assert.equal(chosenFilter(TWELVE, "all"), "all");
  // Below the thresholds there is no filter row, so a stored choice must not hide rows.
  assert.equal(chosenFilter(["2330.TW", "AAPL"], "tw"), "all");
});
