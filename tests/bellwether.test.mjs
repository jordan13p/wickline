// node --test tests/  (quotes.js, watchlist.js and providers/ import nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatBandPrice, formatChange, formatPrice, formatStaleDate,
  normalizeSymbol, marketSession, chartGeometry, formatTime, rowMeta, STARTER_SYMBOLS, USER_AGENT,
} from "../mods/bellwether/quotes.js";
import { decodeYahoo, yahooUrl } from "../mods/bellwether/providers/yahoo.js";
import { binanceKlinesUrl, binanceUrl, decodeBinance, decodeKlines } from "../mods/bellwether/providers/binance.js";
import { Watchlist, WATCHLIST_KEY, readPreferences } from "../mods/bellwether/watchlist.js";
import { t } from "../mods/bellwether/i18n.js";
import { advance, chart, fakeHost, ok, start, stop } from "./helpers.mjs";

const BASE = "https://data-api.binance.vision";

const AAPL = { symbol: "AAPL", regularMarketPrice: 230.1, regularMarketTime: 1_760_000_000, previousClose: 225, currency: "USD", longName: "Apple Inc." };

test("normalizes symbols", () => {
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  assert.equal(normalizeSymbol("700.hk"), "0700.HK");
  assert.equal(normalizeSymbol("00700.HK"), "0700.HK");
  assert.equal(normalizeSymbol("600519.SH"), "600519.SS");
  assert.equal(normalizeSymbol("btc/usdt"), "BTC/USDT");
  assert.throws(() => normalizeSymbol("https://example.com"));
  assert.throws(() => normalizeSymbol("Apple Inc"));
});

test("builds the two request URLs", () => {
  assert.equal(yahooUrl("^GSPC"), "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=5m&range=1d&includePrePost=false");
  assert.equal(binanceUrl(BASE, ["BTC/USDT", "ETH/USDT"]), "https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent('["BTCUSDT","ETHUSDT"]'));
});

test("decodes Yahoo quotes and refuses another ticker", () => {
  const q = decodeYahoo("AAPL", chart(AAPL), 1);
  assert.equal(q.name, "Apple Inc.");
  assert.ok(Math.abs(q.changePercent - 2.2667) < 0.001);
  assert.throws(() => decodeYahoo("MSFT", chart(AAPL), 1), /different ticker/);
  assert.throws(() => decodeYahoo("AAPL", { status: 429, ok: false, text: "" }, 1), (e) => e.retryAfterMs === 60_000);
  assert.throws(() => decodeYahoo("AAPL", { status: 200, ok: true, text: "<html>" }, 1), /unreadable/);
});

test("decodes Binance tickers", () => {
  const quotes = decodeBinance(["BTC/USDT", "ETH/USDT"], ok([
    { symbol: "BTCUSDT", lastPrice: "65000.5", prevClosePrice: "64000", closeTime: 1_760_000_000_000 },
  ]), 1);
  assert.equal(quotes["BTC/USDT"].currency, "USDT");
  assert.equal(quotes["ETH/USDT"], undefined);
  assert.throws(() => decodeBinance(["X/Y"], { status: 400, ok: false, text: "" }, 1), (e) => e.invalidSymbol);
});

test("formats without Intl", () => {
  assert.equal(formatPrice({ price: 1234567.891, currency: "USD" }), "1,234,567.89 USD");
  assert.equal(formatPrice({ price: 0.00000441, currency: null }), "0.00000441");
  assert.equal(formatPrice({ price: 0.5, currency: null }), "0.50");
  assert.equal(formatPrice({ price: 0.123456, currency: null }), "0.1235");
  assert.equal(formatBandPrice({ symbol: "AAPL", price: 230.1, currency: "USD" }), "230.10");
  assert.equal(formatBandPrice({ symbol: "BTC/USDT", price: 65000, currency: "USDT" }), "65,000.00");
  assert.equal(formatBandPrice({ symbol: "0700.HK", price: 600, currency: "HKD" }), "600.00 HKD");
  assert.equal(formatChange(1.234), "+1.23%");
  assert.equal(formatChange(-0.5), "-0.50%");
  assert.equal(formatChange(null), "—");
  const now = new Date(2026, 10, 2, 12).getTime();
  assert.equal(formatStaleDate(new Date(2026, 10, 2, 9).getTime(), now), "");
  assert.equal(formatStaleDate(new Date(2026, 9, 31, 16).getTime(), now), "Oct 31");
});

test("dates by language, times in 24 hours", () => {
  const now = new Date(2026, 10, 2, 12).getTime();
  const oct31 = new Date(2026, 9, 31, 16).getTime();
  assert.equal(formatStaleDate(oct31, now, "en"), "Oct 31");
  for (const lang of ["zh-TW", "zh-CN", "ja", "ko"]) assert.equal(formatStaleDate(oct31, now, lang), "10/31", lang);
  assert.equal(formatStaleDate(new Date(2026, 10, 2, 9).getTime(), now, "zh-TW"), "");
  assert.equal(formatTime(new Date(2026, 10, 2, 21, 5, 7).getTime()), "21:05");
  assert.equal(formatTime(new Date(2026, 10, 2, 9, 5, 7).getTime(), true), "09:05:07");
});

test("reads saved preferences defensively", () => {
  assert.deepEqual(readPreferences(undefined), { version: 1, symbols: STARTER_SYMBOLS, paused: false });
  assert.deepEqual(readPreferences({ version: 1, symbols: [], paused: false }), { version: 1, symbols: [], paused: false });
  assert.deepEqual(readPreferences({ version: 1, symbols: ["aapl", "AAPL", 5, "bad url"], paused: true }),
    { version: 1, symbols: ["AAPL"], paused: true });
});

test("refreshes stocks spaced apart and crypto in one batch", async () => {
  const host = fakeHost((url) => url.includes("binance")
    ? ok([{ symbol: "BTCUSDT", lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 }])
    : chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("MSFT"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 1_000);
  assert.equal(host.requests.filter((u) => u.includes("ticker/24hr")).length, 1);
  assert.equal(host.requests.filter((u) => u.includes("yahoo")).length, 2);
  assert.ok(w.quotes.AAPL && w.quotes.MSFT && w.quotes["BTC/USDT"]);
  await stop(w, host, runs);
});

test("each source keeps its request order and spacing", async () => {
  const host = fakeHost((url) => url.includes("ticker/24hr")
    ? ok([{ symbol: "BTCUSDT", lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 }])
    : url.includes("klines") ? ok([[1, "1", "2", "0.5", "1.5"], [2, "1.5", "2", "1", "1.75"]])
    : chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const sent = [];
  const fetch = host.fetch;
  host.fetch = (url, headers) => { sent.push({ url, at: host.clock, headers }); return fetch(url, headers); };
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("MSFT"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 1_000);
  // The sources run side by side; each keeps its own order.
  assert.deepEqual(host.requests.filter((u) => u.includes("binance")), [binanceUrl(BASE, ["BTC/USDT"]), binanceKlinesUrl(BASE, "BTC/USDT")]);
  assert.deepEqual(host.requests.filter((u) => u.includes("yahoo")), [yahooUrl("AAPL"), yahooUrl("MSFT")]);
  const stocks = sent.filter(({ url }) => url.includes("yahoo"));
  assert.equal(stocks[1].at - stocks[0].at, 1000);
  for (const { headers } of sent) assert.equal(headers["User-Agent"], USER_AGENT);
  assert.deepEqual(w.quotes["BTC/USDT"].series, [1.5, 1.75]);
  await stop(w, host, runs);
});

test("an unknown pair fails its batch, then pairs are asked one by one", async () => {
  const host = fakeHost((url) => url.includes("BADUSDT") ? { status: 400, ok: false, text: "" }
    : url.includes("klines") ? ok([[1, "1", "2", "0.5", "1.5"]])
    : ok(JSON.parse(decodeURIComponent(url.split("symbols=")[1])).map((symbol) =>
      ({ symbol, lastPrice: "10", prevClosePrice: "9", closeTime: 5 }))));
  const w = new Watchlist(host);
  w.add("BTC/USDT"); w.add("ETH/USDT"); w.add("BAD/USDT");
  const runs = start(w, host);
  // Pairs are not spaced, so one round runs without the clock moving.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.requests, [
    binanceUrl(BASE, ["BTC/USDT", "ETH/USDT", "BAD/USDT"]),
    binanceUrl(BASE, ["BTC/USDT"]), binanceUrl(BASE, ["ETH/USDT"]), binanceUrl(BASE, ["BAD/USDT"]),
    binanceKlinesUrl(BASE, "BTC/USDT"), binanceKlinesUrl(BASE, "ETH/USDT"),
  ]);
  assert.deepEqual(w.errors["BAD/USDT"], { code: "binance.invalidPair", params: {} });
  assert.equal(t("en", w.errors["BAD/USDT"].code), "Binance has no Spot pair with this name.");
  assert.ok(w.quotes["BTC/USDT"] && w.quotes["ETH/USDT"]);
  await stop(w, host, runs);
});

test("a rate limit defers the rest of the round", async () => {
  const host = fakeHost(() => ({ status: 429, ok: false, text: "" }));
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("MSFT");
  const runs = start(w, host);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.errors.MSFT, { code: "request.deferred", params: { source: "yahoo" } });
  assert.equal(t("en", w.errors.MSFT.code, { source: "Yahoo" }), "Refresh deferred: Yahoo rate limited requests.");
  assert.equal(w.errors.AAPL.code, "yahoo.rateLimited");
  assert.deepEqual(w.problems(), [{ provider: "yahoo", code: "yahoo.rateLimited", params: {} }]);
  assert.equal(host.requests.length, 1);
  assert.ok(w.sources.yahoo.retryAt >= 60_000);
  await stop(w, host, runs);
});

test("removing a ticker drops its quote; pause stops automatic rounds", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 0);
  assert.ok(w.quotes.AAPL);
  const removed = w.remove("AAPL");
  assert.deepEqual(removed, { code: "notice.removed", params: { symbol: "AAPL" } });
  assert.equal(t("en", removed.code, removed.params), "Removed AAPL.");
  assert.equal(w.quotes.AAPL, undefined);
  w.add("MSFT");
  w.pause(true);
  await advance(host, 0);
  const before = host.requests.length;
  await advance(host, 300_000);
  assert.equal(host.requests.length, before);
  assert.equal(host.store.paused, true);
  await stop(w, host, runs);
});

test("edits return notice codes with the old English text", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const say = (n) => t("en", n.code, n.params);
  assert.equal(say(w.add("aapl")), "Added AAPL.");
  assert.equal(say(w.add("AAPL")), "AAPL is already on your watchlist.");
  assert.equal(say(w.remove("MSFT")), "MSFT is not on your watchlist.");
  assert.equal(say(w.pause(true)), "Automatic refresh paused.");
  assert.equal(say(w.pause(false)), "Automatic refresh resumed.");
  assert.deepEqual(w.problems(), []);
});

test("a Yahoo cooldown holds stocks, also for Refresh", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const w = new Watchlist(host);
  w.add("AAPL");
  w.sources.yahoo.retryAt = 30_000;
  const runs = start(w, host);
  await advance(host, 0);
  w.refreshNow();
  await advance(host, 29_999);
  assert.equal(host.requests.length, 0);
  // The next round waits out the cooldown or the interval, whichever is later.
  await advance(host, 60_000);
  assert.deepEqual(host.requests, [yahooUrl("AAPL")]);
  await stop(w, host, runs);
});

test("another copy's edit is picked up at once", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const a = new Watchlist(host);
  const b = new Watchlist(host);
  a.add("AAPL");
  assert.equal(b.sync(), true);
  assert.deepEqual(b.preferences.symbols, ["AAPL"]);
  assert.equal(b.sync(), false);
  a.pause(true);
  b.sync();
  assert.equal(b.preferences.paused, true);
  a.remove("AAPL");
  b.quotes.AAPL = {};
  b.sync();
  assert.equal(b.quotes.AAPL, undefined);
});

function listed(symbols) {
  const host = fakeHost(() => chart(AAPL));
  host.store = { version: 1, symbols, paused: false };
  return host;
}

test("move before another", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const w = new Watchlist(host);
  const moved = w.move("2330.TW", "AAPL");
  assert.deepEqual(moved, { code: "notice.moved", params: { symbol: "2330.TW" } });
  assert.equal(t("en", moved.code, moved.params), "Moved 2330.TW.");
  assert.deepEqual(host.store.symbols, ["2330.TW", "AAPL", "NVDA"]);
  assert.deepEqual(w.preferences.symbols, ["2330.TW", "AAPL", "NVDA"]);
  w.move("2330.TW", null);
  assert.deepEqual(host.store.symbols, ["AAPL", "NVDA", "2330.TW"]);
  w.move("AAPL", null);
  assert.deepEqual(host.store.symbols, ["NVDA", "2330.TW", "AAPL"]);
});

test("move after a concurrent removal", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const a = new Watchlist(host);
  const b = new Watchlist(host);
  b.remove("AAPL");
  const saved = JSON.stringify(host.store);
  // Copy A has not synced: its drop target is gone.
  assert.equal(a.move("NVDA", "AAPL"), null);
  assert.equal(JSON.stringify(host.store), saved);
  // The dragged symbol is gone.
  b.remove("NVDA");
  const savedAgain = JSON.stringify(host.store);
  assert.equal(a.move("NVDA", "2330.TW"), null);
  assert.equal(JSON.stringify(host.store), savedAgain);
});

test("a drop lands next to its symbol, not at a stale index", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const a = new Watchlist(host);
  const b = new Watchlist(host);
  b.remove("AAPL");
  a.move("2330.TW", "NVDA");
  assert.deepEqual(host.store.symbols, ["2330.TW", "NVDA"]);
});

test("no-op move saves nothing", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const w = new Watchlist(host);
  let writes = 0;
  const save = host.save;
  host.save = (value) => { writes++; save(value); };
  assert.equal(w.move("AAPL", "AAPL"), null);
  assert.equal(w.move("AAPL", "NVDA"), null);
  assert.equal(w.move("2330.TW", null), null);
  assert.equal(w.move("MSFT", "AAPL"), null);
  assert.equal(writes, 0);
});

test("crypto requests use the saved Binance URL, also after a change", async () => {
  const MIRROR = "https://mirror.test";
  const host = fakeHost((url) => url.includes("ticker/24hr")
    ? ok([{ symbol: "BTCUSDT", lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 }])
    : ok([[1, "1", "2", "0.5", "1.5"], [2, "1.5", "2", "1", "1.75"]]));
  host.prefs = { version: 1, sources: { crypto: { binanceUrl: MIRROR } } };
  const w = new Watchlist(host);
  w.add("BTC/USDT");
  const runs = start(w, host);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.requests, [binanceUrl(MIRROR, ["BTC/USDT"]), binanceKlinesUrl(MIRROR, "BTC/USDT")]);
  // A saved change starts a new round against the new address at once.
  assert.equal(w.sync(), false);
  host.prefs = { version: 1, sources: { crypto: { binanceUrl: "https://other.test" } } };
  assert.equal(w.sync(), true);
  assert.equal(w.sync(), false);
  host.requests.length = 0;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.requests, [binanceUrl("https://other.test", ["BTC/USDT"]), binanceKlinesUrl("https://other.test", "BTC/USDT")]);
  await stop(w, host, runs);
});

test("reads today's line, the day's range and the session from Yahoo", () => {
  const body = { chart: { result: [{
    meta: { ...AAPL, regularMarketDayHigh: 232, regularMarketDayLow: 224,
      currentTradingPeriod: { pre: { start: 100, end: 200 }, regular: { start: 200, end: 300 }, post: { start: 300, end: 400 } } },
    indicators: { quote: [{ open: [null, 226, 227], close: [226.5, null, 230.1], high: [227, 228, 231], low: [225, 226, 226] }] },
  }], error: null } };
  const q = decodeYahoo("AAPL", ok(body), 1);
  assert.deepEqual(q.series, [226.5, 230.1]);
  assert.equal(q.open, 226);
  assert.equal(q.high, 232);
  assert.equal(q.previousClose, 225);
  assert.equal(marketSession(q, 150_000), "pre");
  assert.equal(marketSession(q, 250_000), "open");
  assert.equal(marketSession(q, 350_000), "post");
  assert.equal(marketSession(q, 500_000), "closed");
  assert.equal(marketSession({ periods: null }, 1), "24h");
});

test("reads Binance's 24-hour line", () => {
  assert.equal(binanceKlinesUrl(BASE, "BTC/USDT"), "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=96");
  assert.deepEqual(decodeKlines(ok([[1, "1", "2", "0.5", "1.5"], [2, "1.5", "2", "1", "1.75"], "junk"])), [1.5, 1.75]);
  assert.throws(() => decodeKlines({ status: 400, ok: false, text: "" }));
});

test("scales a line into its box", () => {
  assert.equal(chartGeometry([1], 1), null);
  const g = chartGeometry([10, 20], 15);
  assert.deepEqual(g.points.map((p) => p[0]), [0, 100]);
  assert.ok(g.points[0][1] > g.points[1][1]);
  assert.ok(g.reference > g.points[1][1] && g.reference < g.points[0][1]);
  assert.ok(g.points.every(([, y]) => y > 0 && y < 100));
  const flat = chartGeometry([5, 5, 5], null);
  assert.equal(flat.reference, null);
  assert.equal(flat.points[0][1], 50);
  assert.match(formatTime(new Date(2026, 10, 2, 9, 5).getTime()), /^09:05$/);
});

test("a row names its source once", () => {
  // The pair's name is the source's own: show it once.
  assert.deepEqual(rowMeta("BTC/USDT", ["Binance", "", "Binance Spot"]), ["Binance Spot"]);
  assert.deepEqual(rowMeta("AAPL", ["Yahoo · delayed", "As of Oct 31", "Apple Inc."]), ["Yahoo · delayed", "As of Oct 31", "Apple Inc."]);
  // A name that only repeats the ticker is left out.
  assert.deepEqual(rowMeta("^GSPC", ["delayed 15 min", "", "^GSPC"]), ["delayed 15 min"]);
});

test("identity", () => {
  assert.equal(USER_AGENT, "Bellwether-Herdr/0.1.0");
  assert.equal(WATCHLIST_KEY, "bellwether.watchlist.v1");
});
