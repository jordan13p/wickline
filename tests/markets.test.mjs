// node --test tests/  (markets.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  FILTER_MIN_MARKETS, FILTER_MIN_SYMBOLS, FILTER_STORAGE_KEY, TYPICAL_EXCHANGE, dropBefore, exchangeMarket, exchangeRule, filterAfterAdd,
  filterAfterRemove, heldFilter, inFilter, isTaiwanForm, kindOf, marketFilters, marketOf, nextOf, openFilter, readFilter, resolvedMarket,
  visibleSymbols,
} from "../mods/wickline/markets.js";

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

const live = { realtime: true, delayS: null, lunch: null, futures: false, fx: false };
const late = (delayS, lunch = null, futures = false) => ({ realtime: false, delayS, lunch, futures, fx: false });
const TOKYO = { offsetMin: 540, from: 690, to: 750 };
const HONG_KONG = { offsetMin: 480, from: 720, to: 780 };
const CHINA = { offsetMin: 480, from: 690, to: 780 };

test("exchangeRule: the closed table", () => {
  for (const code of ["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS", "SNP", "DJI", "NIM"]) assert.deepEqual(exchangeRule(code, "AAPL"), live, code);
  assert.deepEqual(exchangeRule("CCY", "EURUSD=X"), { ...live, fx: true });
  for (const code of ["TAI", "TWO", "KSC", "KOE", "CXI"]) assert.deepEqual(exchangeRule(code, "2330.TW"), late(1200), code);
  for (const code of ["JPX", "OSA"]) assert.deepEqual(exchangeRule(code, "7203.T"), late(900, TOKYO), code);
  assert.deepEqual(exchangeRule("HKG", "0700.HK"), late(900, HONG_KONG));
  for (const code of ["SHH", "SHZ"]) assert.deepEqual(exchangeRule(code, "600519.SS"), late(900, CHINA), code);
  for (const code of ["PNK", "NYS", "WCB"]) assert.deepEqual(exchangeRule(code, "^VIX"), late(900), code);
  for (const code of ["CME", "NYM", "CMX", "CBT"]) assert.deepEqual(exchangeRule(code, "ES=F"), late(600, null, true), code);
  assert.deepEqual(exchangeRule("XYZ", "AAPL"), late(null));
});

test("exchangeRule: a Taiwan suffix keeps TAI's 20 min when its exchange is missing or not in the table", () => {
  for (const [exchange, symbol] of [[null, "2330.TW"], [undefined, "6488.TWO"], ["", "2330.TW"], ["XYZ", "6488.TWO"]]) {
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

// 5 Taiwan, 4 US and 3 crypto symbols, Taiwan first.
const TWELVE = [
  "2330.TW", "0050.TW", "AAPL", "00632R.TW", "NVDA", "BTC/USDT", "2317.TW", "MSFT", "ETH/USDT", "2454.TW", "AMZN", "SOL/USDT",
];
// filterAfterRemove's `pending`: no index waits for its first quote, or every index does.
const none = () => false;
const waiting = (symbol) => symbol.startsWith("^");

test("no filters below 8 symbols or 2 markets", () => {
  assert.deepEqual(marketFilters(["AAPL", "2330.TW", "BTC/USDT", "NVDA"], marketOf), []);
  assert.deepEqual(marketFilters(["AAPL", "NVDA", "MSFT", "AMZN", "GOOG", "META", "TSLA", "NFLX"], marketOf), []);
  assert.equal(FILTER_MIN_SYMBOLS, 8);
  assert.equal(FILTER_MIN_MARKETS, 2);
});

test("filters list All, then the markets in the language's order, and the counts add up", () => {
  const filters = marketFilters(TWELVE, marketOf, "zh-TW");
  assert.deepEqual(filters, [{ id: "all", count: 12 }, { id: "tw", count: 5 }, { id: "us", count: 4 }, { id: "crypto", count: 3 }]);
  assert.equal(filters.slice(1).reduce((sum, { count }) => sum + count, 0), filters[0].count);
});

test("the order is fixed by the interface language, whatever comes first in the list", () => {
  const ids = (symbols, lang) => marketFilters(symbols, marketOf, lang).map(({ id }) => id);
  // A US symbol first: Chinese still leads with Taiwan, English with the US.
  const usFirst = ["AAPL", ...TWELVE.filter((symbol) => symbol !== "AAPL")];
  assert.deepEqual(ids(usFirst, "zh-TW"), ["all", "tw", "us", "crypto"]);
  assert.deepEqual(ids(usFirst, "zh-CN"), ["all", "tw", "us", "crypto"]);
  assert.deepEqual(ids(usFirst, "en"), ["all", "us", "tw", "crypto"]);
  // Japan and Korea lead with their own market.
  const wide = [...TWELVE, "7203.T", "005930.KS", "0700.HK", "600519.SS", "^GSPC"];
  assert.deepEqual(ids(wide, "en"), ["all", "us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "zh-TW"), ["all", "tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "ja"), ["all", "jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "ko"), ["all", "kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"]);
  // Only markets on the list appear.
  assert.deepEqual(ids(TWELVE, "ja"), ["all", "us", "tw", "crypto"]);
  assert.deepEqual(ids(TWELVE, "ko"), ["all", "us", "tw", "crypto"]);
});

test("adding or dragging symbols never reorders the filters", () => {
  const ids = (symbols) => marketFilters(symbols, marketOf, "en").map(({ id }) => id);
  const before = ids(TWELVE);
  assert.deepEqual(ids(["00878.TW", ...TWELVE]), before);
  assert.deepEqual(ids([...TWELVE].reverse()), before);
});

test("a market shows its own symbols in list order", () => {
  assert.deepEqual(visibleSymbols(TWELVE, "tw", marketOf), ["2330.TW", "0050.TW", "00632R.TW", "2317.TW", "2454.TW"]);
  assert.deepEqual(visibleSymbols(TWELVE, "crypto", marketOf), ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
});

test("All, an unknown filter and an absent market show everything", () => {
  for (const filter of ["all", "kr", "nonsense"]) assert.deepEqual(visibleSymbols(TWELVE, filter, marketOf), TWELVE, filter);
});

test("a drop in the visible list maps to a place in the full list", () => {
  const full = ["2330.TW", "AAPL", "0050.TW", "NVDA"];
  const visible = ["2330.TW", "0050.TW"];
  assert.equal(dropBefore(full, visible, "2330.TW"), "2330.TW");
  assert.equal(dropBefore(full, visible, "0050.TW"), "0050.TW");
  // After the last visible row: in front of that row's successor in the full list.
  assert.equal(dropBefore(full, visible, null), "NVDA");
  // The last visible row is also the last overall.
  assert.equal(dropBefore(["AAPL", "2330.TW"], ["2330.TW"], null), null);
  // No filter: the full list is the visible one.
  assert.equal(dropBefore(full, full, null), null);
});

test("the symbol after another in a list, or null", () => {
  assert.equal(nextOf(["A", "B", "C"], "A"), "B");
  assert.equal(nextOf(["A", "B", "C"], "C"), null);
  assert.equal(nextOf([], "A"), null);
});

test("the chosen filter is the stored one only while it is offered", () => {
  const chosen = (symbols, filter) => readFilter(symbols, filter, marketOf).chosen;
  assert.equal(chosen(TWELVE, "tw"), "tw");
  assert.equal(chosen(TWELVE, "kr"), "all");
  assert.equal(chosen(TWELVE, "all"), "all");
  // Below the thresholds there is no filter row, so a stored choice must not hide rows.
  assert.equal(chosen(["2330.TW", "AAPL"], "tw"), "all");
  // Whatever the interface language orders the filters by.
  assert.equal(readFilter(TWELVE, "tw", marketOf, "ja").chosen, "tw");
});

test("one read of the filter gives the row, the choice and the rows it shows", () => {
  assert.deepEqual(readFilter(TWELVE, "tw", marketOf, "zh-TW"),
    { filters: marketFilters(TWELVE, marketOf, "zh-TW"), chosen: "tw", shown: visibleSymbols(TWELVE, "tw", marketOf) });
  assert.deepEqual(readFilter(TWELVE, "kr", marketOf, "en"), { filters: marketFilters(TWELVE, marketOf, "en"), chosen: "all", shown: TWELVE });
  assert.deepEqual(readFilter(["2330.TW", "AAPL"], "tw", marketOf), { filters: [], chosen: "all", shown: ["2330.TW", "AAPL"] });
});

test("a symbol is in its own market's filter and in All", () => {
  assert.equal(inFilter("2330.TW", "tw", marketOf), true);
  assert.equal(inFilter("AAPL", "tw", marketOf), false);
  assert.equal(inFilter("AAPL", "all", marketOf), true);
});

test("an add keeps the filter unless it would hide the symbol", () => {
  // The symbol is already on the list passed in (the list after the add).
  assert.equal(filterAfterAdd(TWELVE, "tw", "2330.TW", marketOf), "tw");
  assert.equal(filterAfterAdd(TWELVE, "tw", "AAPL", marketOf), "all");
  assert.equal(filterAfterAdd(TWELVE, "all", "AAPL", marketOf), "all");
  // A stored choice the row does not offer reads as All, which hides nothing.
  assert.equal(filterAfterAdd(TWELVE, "kr", "AAPL", marketOf), "kr");
  assert.equal(filterAfterAdd(["AAPL", "2330.TW"], "tw", "AAPL", marketOf), "tw");
});

test("a remove returns the filter to All only when its market has no symbol left", () => {
  assert.equal(filterAfterRemove(TWELVE, "tw", marketOf, none), "tw");
  assert.equal(filterAfterRemove(TWELVE.filter((s) => !s.endsWith("/USDT")), "crypto", marketOf, none), "all");
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

test("a choice is held only while a pending index alone keeps it", () => {
  // No Taiwan symbol left, ^GSPC waiting: kept, but only for the index.
  const list = ["^GSPC", ...TWELVE.filter((s) => !s.endsWith(".TW"))];
  assert.equal(heldFilter(list, "tw", marketOf, waiting), true);
  // A Taiwan symbol keeps it on its own.
  assert.equal(heldFilter(["^GSPC", ...TWELVE], "tw", marketOf, waiting), false);
  // All is never held.
  assert.equal(heldFilter(list, "all", marketOf, waiting), false);
  // Nothing pending: the remove returned it to All already.
  assert.equal(heldFilter(list, "tw", marketOf, none), false);
});

// A copy's own storage as localStorage gives it, recording each write; `broken` throws on every use.
function fakeStorage(stored = {}, broken = false) {
  const storage = { items: { ...stored }, writes: [] };
  storage.getItem = (key) => { if (broken) throw new Error("broken"); return storage.items[key] ?? null; };
  storage.setItem = (key, value) => { if (broken) throw new Error("broken"); storage.writes.push([key, value]); storage.items[key] = value; };
  return storage;
}

test("a copy opens on its stored filter, else the one it was opened with, else All", () => {
  assert.equal(FILTER_STORAGE_KEY, "wickline.filter");
  // A stored choice wins over the props Herdr keeps with the tab.
  assert.equal(openFilter(fakeStorage({ "wickline.filter": "us" }), "tw"), "us");
  assert.equal(openFilter(fakeStorage(), "tw"), "tw");
  assert.equal(openFilter(fakeStorage(), undefined), "all");
  assert.equal(openFilter(fakeStorage(), 3), "all");
  // Storage that cannot be read: as nothing stored.
  assert.equal(openFilter(fakeStorage({}, true), "tw"), "tw");
});

test("opening a copy writes nothing: only a choice the person makes there is stored", () => {
  // The props are saved with the tab, so they seed the copy on every start until a choice is stored;
  // writing them would leave a storage file behind for each moved copy.
  for (const [stored, prop] of [[{}, "tw"], [{}, undefined], [{ "wickline.filter": "us" }, "tw"]]) {
    const storage = fakeStorage(stored);
    openFilter(storage, prop);
    assert.deepEqual(storage.writes, [], JSON.stringify([stored, prop]));
  }
});

// An index has no market in its form; the exchange its source reports gives one (Yahoo's exchangeName,
// measured 2026-11-09). A currency or a future stays other, whatever exchange it trades on.
test("an index takes its market from the exchange its source reports", () => {
  const table = [
    ["^GSPC", "SNP", "us"], ["^DJI", "DJI", "us"], ["^IXIC", "NIM", "us"], ["^SOX", "NIM", "us"], ["^RUT", "WCB", "us"],
    ["^VIX", "CXI", "us"], ["^NYA", "NYS", "us"], ["^TWII", "TAI", "tw"], ["^TWOII", "TWO", "tw"], ["^N225", "OSA", "jp"],
    ["^HSI", "HKG", "hk"], ["^KS11", "KSC", "kr"], ["^KQ11", "KOE", "kr"], ["000001.SS", "SHH", "cn"],
    ["^STOXX50E", "ZRH", "other"], ["^FTSE", "FGI", "other"], ["^GSPC", null, "other"], ["^GSPC", undefined, "other"],
    ["TWD=X", "CCY", "other"], ["ES=F", "CME", "other"], ["EURUSD=X", "NYQ", "other"],
    // A symbol whose form names its market keeps it, whatever is reported.
    ["2330.TW", "NMS", "tw"], ["AAPL", "TAI", "us"], ["BTC/USDT", "TAI", "crypto"],
  ];
  for (const [symbol, exchange, market] of table) assert.equal(resolvedMarket(symbol, exchange), market, `${symbol} ${exchange}`);
  assert.equal(exchangeMarket("TFE"), "tw");
  assert.equal(exchangeMarket("XYZ"), null);
});

test("a symbol's kind comes from its form", () => {
  const table = [["AAPL", "stock"], ["2330.TW", "stock"], ["A^B", "stock"], ["^TWII", "index"], ["TWD=X", "other"], ["ES=F", "other"], ["BTC/USDT", "pair"]];
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
  for (const symbol of ["TXF1&", "^WTX&", "WTX&&", "ABCDEFG&", "ES=F"]) assert.notEqual(kindOf(symbol), "future", symbol);
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
    { id: "all", count: 10 }, { id: "us", count: 5 }, { id: "tw", count: 3 }, { id: "crypto", count: 2 },
  ]);
  assert.deepEqual(readFilter(symbols, "us", marketFor, "en").shown, ["^DJI", "^IXIC", "^SOX", "AAPL", "NVDA"]);
  // Before the first quotes the indices are other.
  assert.deepEqual(marketFilters(symbols, marketOf, "en").find(({ id }) => id === "other"), { id: "other", count: 4 });
  // The filter moves with the resolved market: adding a US index keeps the US filter once it is known.
  assert.equal(filterAfterAdd(symbols, "us", "^SOX", marketFor), "us");
  assert.equal(filterAfterRemove(["^DJI", "2330.TW"], "us", marketFor, none), "us");
});
