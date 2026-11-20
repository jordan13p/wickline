// node --test tests/  (markets.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  TYPICAL_EXCHANGE,
  exchangeMarket,
  exchangeRule,
  isTaiwanForm,
  kindOf,
  marketOf,
  resolvedMarket,
} from "../mods/wickline/markets.js";
import { filterAfterAdd, filterAfterRemove, marketFilters, readFilter } from "../mods/wickline/filter.js";
import { TWELVE } from "./helpers.mjs";

test("routes symbols to markets", () => {
  const table = [
    ["2330.TW", "tw"],
    ["6488.TWO", "tw"],
    ["AAPL", "us"],
    ["BRK-B", "us"],
    ["^GSPC", "other"],
    ["EURUSD=X", "other"],
    ["0700.HK", "hk"],
    ["600519.SS", "cn"],
    ["000001.SZ", "cn"],
    ["7203.T", "jp"],
    ["005930.KS", "kr"],
    ["035720.KQ", "kr"],
    ["BTC/USDT", "crypto"],
    ["VOD.L", "other"],
    // Only a leading ^ marks an index.
    ["A^B", "us"],
  ];
  for (const [symbol, market] of table) assert.equal(marketOf(symbol), market, symbol);
});

const live = { realtime: true, delayS: null, lunch: null, futures: false, fx: false };
const late = (delayS, lunch = null, futures = false) => ({ realtime: false, delayS, lunch, futures, fx: false });
const TOKYO = { offsetMin: 540, from: 690, to: 750 };
const HONG_KONG = { offsetMin: 480, from: 720, to: 780 };
const CHINA = { offsetMin: 480, from: 690, to: 780 };

test("exchangeRule: the closed table", () => {
  for (const code of ["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS", "SNP", "DJI", "NIM"])
    assert.deepEqual(exchangeRule(code, "AAPL"), live, code);
  assert.deepEqual(exchangeRule("CCY", "EURUSD=X"), { ...live, fx: true });
  for (const code of ["TAI", "TWO", "KSC", "KOE", "CXI"])
    assert.deepEqual(exchangeRule(code, "2330.TW"), late(1200), code);
  for (const code of ["JPX", "OSA"]) assert.deepEqual(exchangeRule(code, "7203.T"), late(900, TOKYO), code);
  assert.deepEqual(exchangeRule("HKG", "0700.HK"), late(900, HONG_KONG));
  for (const code of ["SHH", "SHZ"]) assert.deepEqual(exchangeRule(code, "600519.SS"), late(900, CHINA), code);
  for (const code of ["PNK", "NYS", "WCB"]) assert.deepEqual(exchangeRule(code, "^VIX"), late(900), code);
  for (const code of ["CME", "NYM", "CMX", "CBT"])
    assert.deepEqual(exchangeRule(code, "ES=F"), late(600, null, true), code);
  assert.deepEqual(exchangeRule("XYZ", "AAPL"), late(null));
});

test("exchangeRule: a Taiwan suffix keeps TAI's 20 min when its exchange is missing or not in the table", () => {
  for (const [exchange, symbol] of [
    [null, "2330.TW"],
    [undefined, "6488.TWO"],
    ["", "2330.TW"],
    ["XYZ", "6488.TWO"],
  ]) {
    assert.deepEqual(exchangeRule(exchange, symbol), late(1200), `${exchange} ${symbol}`);
  }
  assert.deepEqual(exchangeRule("TWO", "6488.TWO"), late(1200));
  // Only the suffix counts: an index of Taiwan form or a name merely containing TW does not.
  for (const symbol of ["^TWII", "TWLO", "2330.TWX"]) assert.deepEqual(exchangeRule(null, symbol), late(null), symbol);
});

test("exchangeRule: without an exchange, the suffix decides", () => {
  assert.deepEqual(exchangeRule(null, "ES=F"), late(null, null, true));
  assert.deepEqual(exchangeRule(undefined, "EURUSD=X"), { ...live, fx: true });
  assert.deepEqual(exchangeRule("", "AAPL"), late(null));
  assert.deepEqual(exchangeRule("XYZ", "ES=F"), late(null)); // a reported exchange wins
  assert.deepEqual(TYPICAL_EXCHANGE, { us: "NMS", tw: "TAI" });
  assert.equal(exchangeRule(TYPICAL_EXCHANGE.tw, "").delayS, 1200);
  assert.equal(exchangeRule(TYPICAL_EXCHANGE.us, "").realtime, true);
});

// filterAfterRemove's `pending`: no index waits for its first quote, or every index does.
const none = () => false;
const waiting = (symbol) => symbol.startsWith("^");

test("a remove returns the filter to All only when its market has no symbol left", () => {
  assert.equal(filterAfterRemove(TWELVE, "tw", marketOf, none), "tw");
  assert.equal(
    filterAfterRemove(
      TWELVE.filter((s) => !s.endsWith("/USDT")),
      "crypto",
      marketOf,
      none,
    ),
    "all",
  );
  assert.equal(filterAfterRemove(TWELVE, "all", marketOf, none), "all");
  // A list that fell under the thresholds keeps the choice: readFilter already reads it as All.
  assert.equal(filterAfterRemove(["2330.TW", "AAPL"], "tw", marketOf, none), "tw");
  assert.equal(filterAfterRemove(["^TWII", "AAPL"], "tw", marketOf, waiting), "tw");
  assert.equal(filterAfterRemove(["^TWII", "AAPL"], "tw", marketOf, none), "all");
  assert.equal(filterAfterRemove(["^TWII", "AAPL"], "all", marketOf, waiting), "all");
  // Kept while pending: All for now, the choice again once the index reports its exchange.
  const list = ["^TWII", ...TWELVE.filter((s) => !s.endsWith(".TW"))];
  assert.equal(readFilter(list, "tw", marketOf).chosen, "all");
  const twii = (symbol) => (symbol === "^TWII" ? resolvedMarket(symbol, "TAI") : marketOf(symbol));
  assert.equal(readFilter(list, "tw", twii).chosen, "tw");
});

// An index has no market in its form; the exchange its source reports gives one (Yahoo's exchangeName,
// measured 2026-11-09). A currency or a future stays other, whatever exchange it trades on.
test("an index takes its market from the exchange its source reports", () => {
  const table = [
    ["^GSPC", "SNP", "us"],
    ["^DJI", "DJI", "us"],
    ["^IXIC", "NIM", "us"],
    ["^SOX", "NIM", "us"],
    ["^RUT", "WCB", "us"],
    ["^VIX", "CXI", "us"],
    ["^NYA", "NYS", "us"],
    ["^TWII", "TAI", "tw"],
    ["^TWOII", "TWO", "tw"],
    ["^N225", "OSA", "jp"],
    ["^HSI", "HKG", "hk"],
    ["^KS11", "KSC", "kr"],
    ["^KQ11", "KOE", "kr"],
    ["000001.SS", "SHH", "cn"],
    ["^STOXX50E", "ZRH", "other"],
    ["^FTSE", "FGI", "other"],
    ["^GSPC", null, "other"],
    ["^GSPC", undefined, "other"],
    ["TWD=X", "CCY", "other"],
    ["ES=F", "CME", "other"],
    ["EURUSD=X", "NYQ", "other"],
    // A symbol whose form names its market keeps it, whatever is reported.
    ["2330.TW", "NMS", "tw"],
    ["AAPL", "TAI", "us"],
    ["BTC/USDT", "TAI", "crypto"],
  ];
  for (const [symbol, exchange, market] of table)
    assert.equal(resolvedMarket(symbol, exchange), market, `${symbol} ${exchange}`);
  assert.equal(exchangeMarket("TFE"), "tw");
  assert.equal(exchangeMarket("XYZ"), null);
});

test("a symbol's kind comes from its form", () => {
  const table = [
    ["AAPL", "stock"],
    ["2330.TW", "stock"],
    ["A^B", "stock"],
    ["^TWII", "index"],
    ["TWD=X", "other"],
    ["ES=F", "other"],
    ["BTC/USDT", "pair"],
  ];
  for (const [symbol, kind] of table) assert.equal(kindOf(symbol), kind, symbol);
});

test("a future is letters then & or @, and trades in Taiwan", () => {
  for (const symbol of ["WTX&", "WTX@", "WMT&", "WTF&", "WTE&"]) {
    assert.equal(kindOf(symbol), "future", symbol);
    assert.equal(marketOf(symbol), "tw", symbol);
    assert.equal(resolvedMarket(symbol, null), "tw", symbol);
  }
  assert.equal(kindOf("WTX"), "stock");
  assert.equal(marketOf("WTX"), "us");
  for (const symbol of ["TXF1&", "^WTX&", "WTX&&", "ABCDEFG&", "ES=F"])
    assert.notEqual(kindOf(symbol), "future", symbol);
});

// An index of Taiwan form may be known to Yahoo 奇摩股市 when Yahoo Finance does not know it.
test("a Taiwan form is an index starting ^TW", () => {
  for (const symbol of ["^TWOII", "^TWII"]) assert.equal(isTaiwanForm(symbol), true, symbol);
  for (const symbol of ["^GSPC", "APPL", "2330.TW"]) assert.equal(isTaiwanForm(symbol), false, symbol);
});

test("the filter counts an index under its resolved market", () => {
  const exchanges = { "^DJI": "DJI", "^IXIC": "NIM", "^SOX": "NIM", "^TWII": "TAI" };
  const marketFor = (symbol) => resolvedMarket(symbol, exchanges[symbol]);
  const symbols = ["^DJI", "^IXIC", "^SOX", "^TWII", "2330.TW", "0050.TW", "AAPL", "NVDA", "BTC/USDT", "ETH/USDT"];
  assert.deepEqual(marketFilters(symbols, marketFor, "en"), [
    { id: "all", count: 10 },
    { id: "us", count: 5 },
    { id: "tw", count: 3 },
    { id: "crypto", count: 2 },
  ]);
  assert.deepEqual(readFilter(symbols, "us", marketFor, "en").shown, ["^DJI", "^IXIC", "^SOX", "AAPL", "NVDA"]);
  // Before the first quotes the indices are other.
  assert.deepEqual(
    marketFilters(symbols, marketOf, "en").find(({ id }) => id === "other"),
    { id: "other", count: 4 },
  );
  // The filter moves with the resolved market: adding a US index keeps the US filter once it is known.
  assert.equal(filterAfterAdd(symbols, "us", "^SOX", marketFor), "us");
  assert.equal(filterAfterRemove(["^DJI", "2330.TW"], "us", marketFor, none), "us");
});
