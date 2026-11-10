// node --test tests/  (watchlist.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_SYMBOLS, USER_AGENT } from "../mods/wickline/quotes.js";
import { yahoo, yahooUrl } from "../mods/wickline/providers/yahoo.js";
import { finnhub } from "../mods/wickline/providers/finnhub.js";
import { SECRET_KEY_FINNHUB } from "../mods/wickline/settings.js";
import { binanceKlinesUrl, binanceUrl } from "../mods/wickline/providers/binance.js";
import { Watchlist, WATCHLIST_KEY, mergeOverlay, pickOverlay, readPreferences } from "../mods/wickline/watchlist.js";
import { t } from "../mods/wickline/i18n.js";
import { LIVE_MAX_AGE_MS, freshness, sessionName, sessionOf } from "../mods/wickline/freshness.js";
import { collapsedRow, formatStaleDate, formatTime, freshnessLabel } from "../mods/wickline/format.js";
import {
  CLOSE_0509, EARLIER_ROWS, EARLIER_TICK, FUTURES_ROWS, FUTURES_TICK, FUT_NOW, NIGHT, SEGMENTS, advance, at, chart, chartSymbol, day,
  fakeHost, isLine, jsonFixture, lineSymbol, ok, start, stop, yq,
} from "./helpers.mjs";
import { MIS_CONSENT_VERSION, MIS_URL, mis } from "../mods/wickline/providers/mis.js";
import { YAHOOTW_BASE, YAHOOTW_CONSENT_VERSION, taipeiDay, yahootw } from "../mods/wickline/providers/yahootw.js";

const BASE = "https://data-api.binance.vision";

const AAPL = { symbol: "AAPL", regularMarketPrice: 230.1, regularMarketTime: 1_760_000_000, previousClose: 225, currency: "USD", longName: "Apple Inc." };

test("reads saved preferences defensively", () => {
  assert.deepEqual(readPreferences(undefined), { version: 1, symbols: STARTER_SYMBOLS, paused: false });
  assert.deepEqual(readPreferences({ version: 1, symbols: [], paused: false }), { version: 1, symbols: [], paused: false });
  assert.deepEqual(readPreferences({ version: 1, symbols: ["aapl", "AAPL", 5, "bad url"], paused: true }),
    { version: 1, symbols: ["AAPL"], paused: true });
});

test("refreshes stocks spaced apart and crypto in one batch", async () => {
  const host = fakeHost((url) => url.includes("binance")
    ? ok([{ symbol: "BTCUSDT", lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 }])
    : chart({ ...AAPL, symbol: chartSymbol(url) }));
  const w = new Watchlist(host);
  w.add("BTC/USDT"); w.add("MSFT"); w.add("AAPL");
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
    : chart({ ...AAPL, symbol: chartSymbol(url) }));
  const sent = [];
  const fetch = host.fetch;
  host.fetch = (url, headers) => { sent.push({ url, at: host.clock, headers }); return fetch(url, headers); };
  const w = new Watchlist(host);
  w.add("BTC/USDT"); w.add("MSFT"); w.add("AAPL");
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
  w.add("BAD/USDT"); w.add("ETH/USDT"); w.add("BTC/USDT");
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
  w.add("MSFT"); w.add("AAPL");
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
  const host = fakeHost((url) => chart({ ...AAPL, symbol: chartSymbol(url) }));
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 0);
  assert.ok(w.quotes.AAPL);
  const removed = w.remove("AAPL");
  assert.deepEqual(removed, { code: "notice.removed", params: { symbol: "AAPL" }, undo: { symbol: "AAPL", index: 0 } });
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

test("refreshing means a round the person asked for, not an automatic one", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: chartSymbol(url) }));
  const w = new Watchlist(host);
  w.add("AAPL");
  // What the view would draw on each redraw: [loading, refreshing].
  const seen = [];
  host.changed = () => seen.push([Object.values(w.sources).some((state) => state.loading), w.refreshing]);
  const runs = start(w, host);
  await advance(host, 1_000);
  assert.ok(seen.some(([loading]) => loading), "an automatic round ran");
  assert.ok(seen.every(([, refreshing]) => !refreshing), "an automatic round is not refreshing");
  seen.length = 0;
  w.refreshNow();
  await advance(host, 2_000);
  assert.ok(seen.some(([loading, refreshing]) => loading && refreshing), "the asked-for round is refreshing");
  assert.equal(w.refreshing, false);
  seen.length = 0;
  await advance(host, 200_000);
  assert.ok(seen.some(([loading]) => loading));
  assert.ok(seen.every(([, refreshing]) => !refreshing), "the next automatic round is not");
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

test("a new symbol goes to the top; a duplicate stays where it is", () => {
  const host = fakeHost(() => ok({}));
  host.store = { version: 1, symbols: ["AAPL", "2330.TW"], paused: false };
  const w = new Watchlist(host);
  w.add("nvda");
  assert.deepEqual(host.store.symbols, ["NVDA", "AAPL", "2330.TW"]);
  assert.equal(w.add("AAPL").code, "notice.duplicate");
  assert.deepEqual(host.store.symbols, ["NVDA", "AAPL", "2330.TW"]);
  w.add("BTC/USDT");
  assert.deepEqual(host.store.symbols, ["BTC/USDT", "NVDA", "AAPL", "2330.TW"]);
});

test("a Yahoo cooldown holds stocks, also for Refresh", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: chartSymbol(url) }));
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
  const host = fakeHost((url) => chart({ ...AAPL, symbol: chartSymbol(url) }));
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

test("remove carries what Undo needs", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const removed = new Watchlist(host).remove("NVDA");
  assert.equal(removed.code, "notice.removed");
  assert.deepEqual(removed.undo, { symbol: "NVDA", index: 1 });
});

test("restore puts a symbol back where it was", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW"]);
  const w = new Watchlist(host);
  const { undo } = w.remove("NVDA");
  const restored = w.restore(undo.symbol, undo.index);
  assert.deepEqual(restored, { code: "notice.restored", params: { symbol: "NVDA" } });
  assert.equal(t("en", restored.code, restored.params), "Restored NVDA.");
  assert.deepEqual(host.store.symbols, ["AAPL", "NVDA", "2330.TW"]);
  assert.deepEqual(w.preferences.symbols, ["AAPL", "NVDA", "2330.TW"]);
});

test("restore clamps to the end", () => {
  const host = listed(["AAPL"]);
  new Watchlist(host).restore("2330.TW", 5);
  assert.deepEqual(host.store.symbols, ["AAPL", "2330.TW"]);
});

test("restore of a listed symbol saves nothing", () => {
  const host = listed(["AAPL", "NVDA"]);
  const w = new Watchlist(host);
  const saved = JSON.stringify(host.store);
  assert.equal(w.restore("NVDA", 0), null);
  assert.equal(JSON.stringify(host.store), saved);
});

test("removing an unlisted symbol offers no Undo", () => {
  const removed = new Watchlist(listed(["AAPL"])).remove("MSFT");
  assert.equal(removed.code, "notice.notListed");
  assert.equal("undo" in removed, false);
});

// Quiet loops: nothing marked for a new round, so a restart shows as `dirty` and a new revision.
function settle(w) {
  for (const state of Object.values(w.sources)) state.dirty = false;
  return w.revision;
}
const restarted = (w) => Object.values(w.sources).some((state) => state.dirty);

test("a reorder leaves the rounds alone, here and in other copies", () => {
  const host = listed(["AAPL", "NVDA", "2330.TW", "BTC/USDT"]);
  const a = new Watchlist(host);
  const b = new Watchlist(host);
  const revisionA = settle(a);
  const revisionB = settle(b);
  assert.equal(a.move("BTC/USDT", "AAPL").code, "notice.moved");
  assert.equal(a.revision, revisionA);
  assert.equal(restarted(a), false);
  assert.equal(b.sync(), true);
  assert.deepEqual(b.preferences.symbols, ["BTC/USDT", "AAPL", "NVDA", "2330.TW"]);
  assert.equal(b.revision, revisionB);
  assert.equal(restarted(b), false);
  // Adding, removing and pausing still start new rounds.
  a.add("MSFT");
  assert.equal(restarted(a), true);
  settle(a);
  a.pause(true);
  assert.equal(restarted(a), true);
});

test("a reorder that changes Finnhub's slice restarts", () => {
  const host = listed(["AAPL", "MSFT", "NVDA", "2330.TW"]);
  // Budget 8: the first two US symbols use Finnhub.
  host.prefs = { version: 1, keyRev: 0, sources: { us: { provider: "finnhub", budgetPerMinute: 8 } } };
  const w = new Watchlist(host);
  w.finnhubKey = "test-key";
  assert.deepEqual(w.finnhubSymbols(), ["AAPL", "MSFT"]);
  const revision = settle(w);
  // Inside the slice and outside it: the same symbols, so no new round.
  w.move("MSFT", "AAPL");
  w.move("2330.TW", "AAPL");
  assert.equal(restarted(w), false);
  assert.equal(w.revision, revision);
  // NVDA enters the slice.
  w.move("NVDA", "MSFT");
  assert.deepEqual(w.finnhubSymbols(), ["NVDA", "MSFT"]);
  assert.equal(restarted(w), true);
  assert.ok(w.revision > revision);
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

test("pickOverlay: first live in order, else newest, ties keep order, none → null", () => {
  const NOW = 1_000_000;
  const order = ["yahootw", "mis"];
  const pick = (yahootw, mis) => pickOverlay({ yahootw: { timestamp: yahootw }, mis: { timestamp: mis } }, order, NOW)?.id;
  assert.equal(pick(NOW - 10_000, NOW - 5_000), "yahootw");
  assert.equal(pick(NOW - 180_000, NOW - 5_000), "mis");
  // Live up to LIVE_MAX_AGE_MS old, inclusive.
  assert.equal(pick(NOW - 120_000, NOW - 5_000), "yahootw");
  assert.equal(pick(NOW - 120_001, NOW - 5_000), "mis");
  assert.equal(pick(NOW - 180_000, NOW - 300_000), "yahootw");
  assert.equal(pick(NOW - 180_000, NOW - 180_000), "yahootw");
  assert.equal(pickOverlay({}, order, NOW), null);
});

test("pickOverlay: with none live, a real-time base no older than the newest overlay shows instead", () => {
  const NOW = 1_000_000;
  const stale = { finnhub: { timestamp: NOW - 180_000 } };
  const pick = (base, byProvider = stale) => pickOverlay(byProvider, ["finnhub"], NOW, base)?.id ?? null;
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 10_000), fetchedAt: NOW }), null);
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 180_000), fetchedAt: NOW }), null); // a tie keeps the base
  // An older base, a delayed one or a live overlay: the overlay still shows.
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 180_001), fetchedAt: NOW }), "finnhub");
  assert.equal(pick({ ...yq("2330.TW", "TAI", NOW - 10_000), fetchedAt: NOW }), "finnhub");
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 1_000), fetchedAt: NOW }, { finnhub: { timestamp: NOW - 60_000 } }), "finnhub");
  assert.equal(pick(undefined), "finnhub");
});

test("mergeOverlay: a quote over itself keeps its own name, currency and periods, and no line but its own", () => {
  const own = { symbol: "^TWOII", source: "yahootw", name: "櫃檯指數", currency: "TWD", price: 321.97, previousClose: 304.02,
    timestamp: 1, fetchedAt: 2, day: 5 };
  const periods = { pre: null, regular: [0, 1], post: null };
  const row = mergeOverlay({ ...own, periods }, own, null);
  assert.deepEqual([row.name, row.localName, row.currency, row.periods], ["櫃檯指數", "櫃檯指數", "TWD", periods]);
  assert.deepEqual([row.series, row.chartSource, row.chartTimestamp, row.chartFetchedAt], [[], null, null, null]);
  const line = { day: 5, series: [320, 321], lastAt: 0 };
  assert.deepEqual(mergeOverlay({ ...own, periods }, own, line).series, [320, 321, 321.97]);
  assert.equal(mergeOverlay({ ...own, periods }, own, line).chartSource, "yahootw");
});

// Taiwan's two real-time sources over Yahoo Finance, on a clock set to a trading morning in Taipei.
const TW_NOW = 1794188480000;
const TW_ROWS = jsonFixture("yahootw-stocklist");
const MIS_ROW = jsonFixture("mis-open").msgArray[0];
const BOTH = { version: 1, sources: { tw: {
  yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION }, mis: true, misAck: { version: MIS_CONSENT_VERSION },
} } };
const ONLY_YAHOOTW = { version: 1, sources: { tw: { yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION } } } };
// Yahoo 奇摩股市 on with a consent to an older text: awaiting re-confirmation.
const STALE_YAHOOTW = { version: 1, sources: { tw: { yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION - 1 } } } };
// The recorded Yahoo 奇摩股市 rows (`rows`, the stock ones by default), each one that has a trade traded at `time`, with
// some rows' fields replaced.
const stockList = (time, bySymbol = {}, rows = TW_ROWS) => ok(rows.map((row) => ({
  ...row, ...(row.regularMarketTime && row.regularMarketTime !== "-" && { regularMarketTime: new Date(time).toISOString() }),
  ...bySymbol[row.symbol],
})));
// The recorded MIS row for 2330, traded at `time`.
const misAt = (time) => ok({ msgArray: [{ ...MIS_ROW, z: "2250.0000", tlong: String(time) }] });
const offline = () => { throw new Error("offline"); };
const isYahootw = (url) => url.startsWith(YAHOOTW_BASE);

// A Yahoo 奇摩股市 line answer for `symbol`: one close a minute, the last at `time` (ms), and `periods` (if any) as
// its meta's currentTradingPeriod.
const tickAt = (symbol, time, closes, periods) => ok([{ symbol, chart: {
  meta: { symbol, ...(periods && { currentTradingPeriod: periods }) },
  timestamp: closes.map((_, i) => Math.floor(time / 1000) - (closes.length - 1 - i) * 60),
  indicators: { quote: [{ close: closes }] },
} }]);
// Yahoo Finance's line under every Taiwan row.
const BASE_SERIES = [2190, 2195];
// Yahoo Finance's answer for a Taiwan row today, with `fields` added to its meta.
const twYahoo = (symbol, fields = {}) => ok({ chart: { result: [{ meta: { symbol, regularMarketPrice: 2200,
  regularMarketTime: 1_794_187_000, previousClose: 2135, currency: "TWD", ...fields }, indicators: { quote: [{ close: BASE_SERIES }] } }], error: null } });

// `yahoo` answers Yahoo Finance per symbol.
function taiwanHost(prefs, {
  yahootw = () => stockList(TW_NOW - 5_000), mis = () => misAt(TW_NOW - 5_000),
  line = (symbol) => tickAt(symbol, TW_NOW - 60_000, [2200, 2205]), yahoo = (symbol) => twYahoo(symbol),
} = {}) {
  const host = fakeHost((url) => isLine(url) ? host.line(lineSymbol(url)) : isYahootw(url) ? host.yahootw(url)
    : url.startsWith(MIS_URL) ? host.mis(url)
    : host.yahoo(chartSymbol(url)));
  Object.assign(host, { clock: TW_NOW, prefs, yahootw, mis, line, yahoo });
  host.store = { version: 1, symbols: ["2330.TW"], paused: false };
  return host;
}

// One round of every source, then `check(w, host)`.
async function firstRound(host, check) {
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, TW_NOW + 1);
  await check(w, host);
  await stop(w, host, runs);
}

test("both live: Yahoo 奇摩股市 is shown", async () => {
  await firstRound(taiwanHost(BOTH), (w) => {
    const quote = w.shown("2330.TW", TW_NOW);
    assert.deepEqual([quote.source, quote.price, quote.localName], ["yahootw", 2240, "台積電"]);
    assert.equal(w.overlayError("2330.TW"), null);
  });
});

test("Yahoo stale, MIS live: MIS is shown with the Yahoo Finance line", async () => {
  await firstRound(taiwanHost(BOTH, { yahootw: () => stockList(TW_NOW - 180_000) }), (w) => {
    const quote = w.shown("2330.TW");
    assert.deepEqual([quote.source, quote.chartSource], ["mis", "yahoo"]);
    // The stale Yahoo 奇摩股市 price is still held; MIS wins on liveness, not by being alone.
    assert.ok(w.overlays["2330.TW"].yahootw);
  });
});

test("both stale: the newer is shown, ties keep Yahoo 奇摩股市", async () => {
  for (const [yahootwAge, misAge, expected] of [[180_000, 300_000, "yahootw"], [300_000, 180_000, "mis"], [180_000, 180_000, "yahootw"]]) {
    const host = taiwanHost(BOTH, { yahootw: () => stockList(TW_NOW - yahootwAge), mis: () => misAt(TW_NOW - misAge) });
    await firstRound(host, (w) => assert.equal(w.shown("2330.TW").source, expected, `${yahootwAge} ${misAge}`));
  }
});

test("no overlay: the base, with the reason", async () => {
  await firstRound(taiwanHost(ONLY_YAHOOTW, { yahootw: offline }), (w) => {
    assert.equal(w.shown("2330.TW").source, "yahoo");
    assert.equal(w.overlayError("2330.TW").code, "yahootw.unreachable");
    assert.deepEqual(w.problems(), [{ provider: "yahootw", code: "yahootw.unreachable", params: {} }]);
  });
});

test("MIS live after a Yahoo 奇摩股市 failure shows no fallback note", async () => {
  await firstRound(taiwanHost(BOTH, { yahootw: offline }), (w) => {
    assert.equal(w.shown("2330.TW").source, "mis");
    // The failure is kept, only not shown while MIS covers the row.
    assert.equal(w.overlayErrors["2330.TW"].yahootw.code, "yahootw.unreachable");
    assert.equal(w.overlayError("2330.TW"), null);
  });
});

test("a stale MIS price still shows why Yahoo 奇摩股市 has none", async () => {
  // 2330 is priced above its limit-up, and MIS has not traded for 3 minutes.
  const host = taiwanHost(BOTH, {
    yahootw: () => stockList(TW_NOW - 5_000, { "2330.TW": { price: { raw: "9999" } } }), mis: () => misAt(TW_NOW - 180_000),
  });
  await firstRound(host, (w) => {
    assert.equal(w.shown("2330.TW").source, "mis");
    assert.equal(w.overlayError("2330.TW").code, "yahootw.outOfLimits");
  });
});

test("turning Yahoo 奇摩股市 off drops its overlay and error at once", async () => {
  // 0050 is priced above its limit-up, so it holds an error instead of an overlay.
  const host = taiwanHost(BOTH, { yahootw: () => stockList(TW_NOW - 5_000, { "0050.TW": { price: { raw: "11" } } }) });
  host.store.symbols = ["2330.TW", "0050.TW"];
  await firstRound(host, async (w) => {
    assert.ok(w.overlays["2330.TW"].yahootw);
    assert.equal(w.overlayErrors["0050.TW"].yahootw.code, "yahootw.outOfLimits");
    host.prefs = { version: 1, sources: { tw: { ...BOTH.sources.tw, yahootw: false } } };
    assert.equal(w.sync(), true);
    assert.equal(w.overlays["2330.TW"].yahootw, undefined);
    assert.equal(w.overlayErrors["0050.TW"]?.yahootw, undefined);
    assert.equal(w.shown("2330.TW").source, "mis");
    const sent = host.requests.filter(isYahootw).length;
    await advance(host, TW_NOW + 61_000);
    assert.equal(host.requests.filter(isYahootw).length, sent);
  });
});

test("a fresh install never asks tw.stock.yahoo.com", async () => {
  const host = taiwanHost(undefined);
  host.store.symbols = ["2330.TW", "6488.TWO", "0050.TW"];
  await firstRound(host, async (w) => {
    await advance(host, TW_NOW + 61_000);
    assert.ok(host.requests.length > 0);
    assert.ok(host.requests.every((url) => !url.includes("tw.stock.yahoo.com")), host.requests.join());
    assert.deepEqual(w.problems(), []);
  });
});

test("only MIS consented: only MIS and Yahoo Finance are asked for Taiwan", async () => {
  // Switched on, but its box never ticked.
  const prefs = { version: 1, sources: { tw: { ...BOTH.sources.tw, yahootwAck: null } } };
  await firstRound(taiwanHost(prefs), async (w, host) => {
    await advance(host, TW_NOW + 61_000);
    assert.ok(host.requests.some((url) => url.startsWith(MIS_URL)));
    assert.ok(host.requests.every((url) => url.startsWith(MIS_URL) || url.startsWith(yahooUrl("2330.TW"))), host.requests.join());
    assert.equal(w.shown("2330.TW").source, "mis");
    assert.deepEqual(w.problems(), [{ provider: "yahootw", code: "yahootw.reconfirm", params: {}, stopped: true }]);
  });
});

test("a 403 hands Taiwan rows to MIS and pauses Yahoo 奇摩股市", async () => {
  await firstRound(taiwanHost(BOTH, { yahootw: () => ({ status: 403, ok: false, text: "" }) }), async (w, host) => {
    assert.equal(w.shown("2330.TW").source, "mis");
    assert.deepEqual(w.problems(), [{ provider: "yahootw", code: "yahootw.refused", params: {} }]);
    const sent = host.requests.filter(isYahootw).length;
    await advance(host, TW_NOW + 59_000);
    assert.equal(host.requests.filter(isYahootw).length, sent);
    assert.equal(w.shown("2330.TW").source, "mis");
  });
});

test("a Yahoo 奇摩股市 name reaches the row", async () => {
  await firstRound(taiwanHost(ONLY_YAHOOTW), (w) => assert.equal(w.shown("2330.TW").localName, "台積電"));
});

// The recorded rows with 2330 priced at 2210.
const at2210 = (time = TW_NOW - 5_000) => stockList(time, { "2330.TW": { price: { raw: "2210" } } });

test("the Yahoo 奇摩股市 line ends at the shown price, and is used only while its price is shown", async () => {
  await firstRound(taiwanHost(BOTH, { yahootw: () => at2210() }), (w) => {
    const quote = w.shown("2330.TW");
    assert.deepEqual(quote.series, [2200, 2205, 2210]);
    assert.deepEqual([quote.source, quote.chartSource], ["yahootw", "yahootw"]);
  });
  // A stale Yahoo 奇摩股市 price yields to a live MIS one, and its line goes with it.
  await firstRound(taiwanHost(BOTH, { yahootw: () => at2210(TW_NOW - 180_000) }), (w) => {
    assert.ok(w.lines.yahootw["2330.TW"]);
    const quote = w.shown("2330.TW");
    assert.deepEqual([quote.source, quote.chartSource, quote.series], ["mis", "yahoo", BASE_SERIES]);
  });
});

test("a frozen line is not drawn as live; a quiet stock's line is", async () => {
  // 2330 traded at 09:41:15 but its line stops at 09:10; 0050 last traded at 09:17:12 and its line
  // stops at 09:18, its last trade's minute.
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(TW_NOW - 5_000, { "0050.TW": { regularMarketTime: "2026-11-09T01:17:12Z" } }),
    line: (symbol) => symbol === "0050.TW" ? ok(jsonFixture("yahootw-tick-quiet")) : tickAt(symbol, Date.parse("2026-11-09T01:10:00Z"), [2200, 2205]),
  });
  host.store.symbols = ["2330.TW", "0050.TW"];
  await firstRound(host, (w) => {
    assert.equal(w.lines.yahootw?.["2330.TW"], undefined);
    const frozen = w.shown("2330.TW");
    assert.deepEqual([frozen.source, frozen.chartSource, frozen.series], ["yahootw", "yahoo", BASE_SERIES]);
    const quiet = w.shown("0050.TW");
    assert.deepEqual([quiet.chartSource, quiet.series], ["yahootw", [10.05, 10.05]]);
  });
});

test("the base line is never overwritten", async () => {
  await firstRound(taiwanHost(ONLY_YAHOOTW), (w) => {
    assert.deepEqual(w.shown("2330.TW").series, [2200, 2205, 2240]);
    assert.deepEqual(w.quotes["2330.TW"].series, BASE_SERIES);
  });
});

test("removing a symbol, or turning its source off, drops its Yahoo 奇摩股市 line", async () => {
  const host = taiwanHost(BOTH);
  host.store.symbols = ["2330.TW", "0050.TW"];
  await firstRound(host, (w) => {
    assert.deepEqual(Object.keys(w.lines.yahootw).sort(), ["0050.TW", "2330.TW"]);
    w.remove("0050.TW");
    assert.deepEqual(Object.keys(w.lines.yahootw), ["2330.TW"]);
    host.prefs = { version: 1, sources: { tw: { ...BOTH.sources.tw, yahootw: false } } };
    w.sync();
    assert.equal(w.lines.yahootw?.["2330.TW"], undefined);
  });
});

test("an answer without today's points removes the old line", async () => {
  const host = taiwanHost(ONLY_YAHOOTW);
  await firstRound(host, async (w) => {
    assert.ok(w.lines.yahootw["2330.TW"]);
    host.line = (symbol) => tickAt(symbol, TW_NOW - 86_400_000, [2200, 2205]);
    await advance(host, TW_NOW + 120_000);
    assert.equal(w.lines.yahootw["2330.TW"], undefined);
    assert.deepEqual(w.shown("2330.TW").series, BASE_SERIES);
    assert.deepEqual(w.problems(), []);
  });
});

test("a line never outlives its price", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(host.clock - 5_000) });
  await firstRound(host, async (w) => {
    assert.ok(w.lines.yahootw["2330.TW"]);
    // The next price answer has no row for 2330: its price and line go together.
    host.yahootw = () => ok(TW_ROWS.filter((row) => row.symbol !== "2330.TW"));
    await advance(host, TW_NOW + 10_000);
    assert.equal(w.overlays["2330.TW"], undefined);
    assert.equal(w.lines.yahootw["2330.TW"], undefined);
    // A new price shows the base line until a new line arrives.
    host.yahootw = () => stockList(host.clock - 5_000);
    await advance(host, TW_NOW + 20_000);
    assert.equal(w.shown("2330.TW").source, "yahootw");
    assert.deepEqual(w.shown("2330.TW").series, BASE_SERIES);
  });
});

test("a hung line keeps the price, drops the line and shows the problem until a line comes in", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(host.clock - 5_000) });
  await firstRound(host, async (w) => {
    assert.ok(w.lines.yahootw["2330.TW"]);
    host.line = () => new Promise(() => {});
    // The line is due again at 120 s; it times out at 130 s.
    await advance(host, TW_NOW + 130_000);
    assert.equal(w.lines.yahootw["2330.TW"], undefined);
    assert.equal(w.shown("2330.TW").source, "yahootw");
    assert.deepEqual(w.shown("2330.TW").series, BASE_SERIES);
    assert.deepEqual(w.problems(), [{ provider: "yahootw", code: "request.timeout", params: { source: "yahootw", seconds: 10 } }]);
    // The rounds that send no line (not due) keep it; the next line clears it.
    host.line = (symbol) => tickAt(symbol, host.clock - 60_000, [2200, 2205]);
    await advance(host, TW_NOW + 141_000);
    assert.equal(w.problems()[0]?.code, "request.timeout");
    await advance(host, TW_NOW + 241_000);
    assert.ok(w.lines.yahootw["2330.TW"]);
    assert.deepEqual(w.problems(), []);
  });
});

test("identity", () => {
  assert.equal(WATCHLIST_KEY, "wickline.watchlist.v1");
});

// Yahoo Finance names ^TWII's exchange (TAI): from then on it is a Taiwan index, priced live by Yahoo 奇摩股市.
const atTai = (symbol) => twYahoo(symbol, { exchangeName: "TAI" });
const stockLists = (host) => host.requests.filter((url) => isYahootw(url) && url.includes("StockServices"));
const chartCount = (host) => host.requests.filter((url) => url.includes("/chart/")).length;

test("a Taiwan index reaches Yahoo 奇摩股市 as soon as Yahoo Finance names its exchange", async () => {
  const host = taiwanHost(BOTH, { yahoo: atTai });
  host.store = { version: 1, symbols: ["^TWII"], paused: false };
  const w = new Watchlist(host);
  const runs = start(w, host);
  // Well inside the 120 s an idle Yahoo 奇摩股市 loop would otherwise sleep.
  await advance(host, TW_NOW + 5_000);
  assert.ok(stockLists(host).some((url) => url.includes("%5ETWII")), stockLists(host).join(" "));
  // MIS prices stocks only.
  assert.equal(host.requests.filter((url) => url.startsWith(MIS_URL)).length, 0);
  // Yahoo Finance's round was not restarted: one request for the one symbol.
  assert.equal(chartCount(host), 1);
  assert.equal(w.shown("^TWII").source, "yahootw");
  await stop(w, host, runs);
});

test("a wake during an overlay round adds a round, it aborts none", async () => {
  const host = taiwanHost(BOTH, { yahoo: atTai });
  host.store = { version: 1, symbols: ["2330.TW", "^TWII"], paused: false };
  // Yahoo 奇摩股市's first answer waits until released; any later one never comes, so only the first can price
  // 2330.TW.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let answers = 0;
  host.yahootw = () => (answers++ ? new Promise(() => {}) : held.then(() => stockList(TW_NOW - 5_000)));
  const w = new Watchlist(host);
  const runs = start(w, host);
  // Yahoo Finance answers ^TWII a second after 2330.TW (its spacing), with the first stockList still out.
  await advance(host, TW_NOW + 1_000);
  assert.equal(w.exchangeOf("^TWII"), "TAI");
  assert.equal(stockLists(host).length, 1);
  release();
  await advance(host, TW_NOW + 2_000);
  assert.equal(w.shown("2330.TW").source, "yahootw");
  assert.equal(stockLists(host).length, 2);
  assert.ok(stockLists(host)[1].includes("%5ETWII"), stockLists(host)[1]);
  assert.deepEqual(host.requests.filter((url) => url.includes("/chart/")).map(chartSymbol),
    ["2330.TW", "^TWII"]);
  await stop(w, host, runs);
});

// A ^TW… index Yahoo Finance does not know (404) is priced by Yahoo 奇摩股市 alone, while it is on: TW-only.
const NOT_FOUND = { status: 404, ok: false, text: "" };
test("after the statement changes, a consent to the old one leaves Taiwan on its fallback, and indices and futures say why", async () => {
  const host = twOnlyHost(["2330.TW", "^TWOII", "WTX&"]);
  host.prefs = STALE_YAHOOTW;
  await soleRun(host, (w) => {
    assert.deepEqual(host.requests.filter(isYahootw), []);
    assert.equal(w.errors["WTX&"].code, "yahootw.reconfirm");
    assert.equal(w.errors["^TWOII"].code, "yahootw.reconfirm");
    assert.equal(w.shown("2330.TW").source, "yahoo");
    assert.equal(charts(host, "WTX&"), 0);
    assert.deepEqual(w.problems().map(({ provider, code, stopped }) => [provider, code, stopped]), [["yahootw", "yahootw.reconfirm", true]]);
    // Confirming again clears the reason at once.
    host.prefs = ONLY_YAHOOTW;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["^TWOII"], undefined);
    assert.equal(w.errors["WTX&"], undefined);
  });
});

test("turning Yahoo 奇摩股市 off while its consent awaits re-confirmation, with the list paused, leaves no re-confirm reason", async () => {
  const host = twOnlyHost(["^TWOII", "WTX&"]);
  host.prefs = STALE_YAHOOTW;
  await soleRun(host, (w) => {
    assert.equal(w.errors["^TWOII"].code, "yahootw.reconfirm");
    host.store = { ...host.store, paused: true };
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
    assert.equal(w.errors["WTX&"].code, "yahootw.futuresNeedSource");
  });
});

// ^TWOII's line on the trading morning, with a regular session around the clock.
const OPEN_NOW = { regular: { start: TW_NOW / 1000 - 3600, end: TW_NOW / 1000 + 3600 } };
const charts = (host, symbol) => host.requests.filter((url) => url.includes(`/chart/${encodeURIComponent(symbol)}?`)).length;

function twOnlyHost(symbols = ["^TWOII"], options = {}) {
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahoo: (symbol) => (symbol.startsWith("^TW") || symbol === "APPL" ? NOT_FOUND : twYahoo(symbol)),
    line: (symbol) => tickAt(symbol, host.clock - 60_000, [321.5, 321.97], OPEN_NOW),
    ...options,
  });
  host.store = { version: 1, symbols, paused: false };
  return host;
}

// Every source from `from`, then `check(w, host)` once the clock is at `from + 5 s`. Each redraw renders, and a
// render calls sync(), as in main.js.
async function soleRun(host, check, from = TW_NOW) {
  host.clock = from;
  const w = new Watchlist(host);
  host.changed = () => w.sync();
  const runs = start(w, host);
  await advance(host, from + 5_000);
  await check(w, host);
  await stop(w, host, runs);
}

// The recorded futures rows, as stockList gives them.
const futuresAt = (time, bySymbol = {}) => stockList(time, bySymbol, FUTURES_ROWS);
// Yahoo 奇摩股市 on and consented, the futures rows as recorded, no line unless given; run with soleRun(host, check, FUT_NOW).
function futuresHost(symbols = ["WTX&"], options = {}) {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => ok(FUTURES_ROWS), line: offline, ...options });
  host.store = { version: 1, symbols, paused: false };
  return host;
}

// An index holds the chosen market on a remove only while it waits for its first quote (filterAfterRemove).
test("an index is pending until its first quote, overlay or error", async () => {
  const host = taiwanHost(BOTH, { yahoo: atTai });
  host.store = { version: 1, symbols: ["^TWII", "AAPL"], paused: false };
  const before = new Watchlist(host);
  assert.equal(before.pendingIndex("^TWII"), true);
  // Only an index waits: a stock's market is known from its symbol.
  assert.equal(before.pendingIndex("AAPL"), false);
  await firstRound(host, (w) => assert.equal(w.pendingIndex("^TWII"), false));
  // Priced without an exchange: never Taiwan's, so it holds nothing.
  const bare = taiwanHost(BOTH);
  bare.store = { version: 1, symbols: ["^TWII", "AAPL"], paused: false };
  await firstRound(bare, (w) => {
    assert.ok(w.quotes["^TWII"]);
    assert.equal(w.exchangeOf("^TWII"), null);
    assert.equal(w.pendingIndex("^TWII"), false);
  });
  // Priced by Yahoo 奇摩股市 alone: its market is known from that source.
  await soleRun(twOnlyHost(["^TWOII"]), (w) => {
    assert.ok(w.shown("^TWOII", TW_NOW + 5_000));
    assert.equal(w.pendingIndex("^TWOII"), false);
  });
  // Not found by either source.
  await soleRun(twOnlyHost(["^TWXYZ"]), (w) => {
    assert.equal(w.errors["^TWXYZ"].code, "yahoo.notFound");
    assert.equal(w.pendingIndex("^TWXYZ"), false);
  });
});

test("^TWOII, unknown to Yahoo Finance, is priced by Yahoo 奇摩股市 alone", async () => {
  await soleRun(twOnlyHost(), (w, host) => {
    const now = TW_NOW + 5_000;
    const quote = w.shown("^TWOII", now);
    assert.equal(quote.source, "yahootw");
    assert.deepEqual([quote.price, quote.name, quote.currency], [321.97, "櫃檯指數", "TWD"]);
    assert.equal(w.errors["^TWOII"], undefined);
    assert.equal(w.marketFor("^TWOII"), "tw");
    assert.equal(sessionOf(quote, now), "open");
    // Asked once: its 404 moved it, and Yahoo Finance's round was not restarted.
    assert.equal(chartCount(host), 1);
  });
});

test("overnight, a TW-only symbol shows its last close and polls gently", async () => {
  const tx = (key, params) => t("en", key, params);
  // The recorded line (the day before's periods and minutes), and one with no point from today and no periods.
  for (const line of [() => ok(EARLIER_TICK), (symbol) => tickAt(symbol, CLOSE_0509, [321.97])]) {
    const host = twOnlyHost(["^TWOII"], { yahootw: () => ok(EARLIER_ROWS), line });
    await soleRun(host, async (w) => {
      const now = NIGHT + 5_000;
      const quote = w.shown("^TWOII", now);
      assert.deepEqual([quote.source, quote.price, quote.timestamp], ["yahootw", 321.97, CLOSE_0509]);
      const fresh = freshness(quote, sessionOf(quote, now), now);
      assert.equal(fresh.state, "closed");
      // Its own trade's date and time (the date shows where the local day has turned).
      assert.equal(freshnessLabel(quote, fresh, now, "en", tx),
        `${tx("session.closed")} · ${[formatStaleDate(CLOSE_0509, now, "en"), formatTime(CLOSE_0509)].filter(Boolean).join(" ")}`);
      assert.equal(w.problems().length, 0);
      // The closed cadence: no round 10 s on, the next at 60 s.
      assert.equal(stockLists(host).length, 1);
      await advance(host, NIGHT + 15_000);
      assert.equal(stockLists(host).length, 1);
      await advance(host, NIGHT + 61_000);
      assert.equal(stockLists(host).length, 2);
    }, NIGHT);
  }
});

test("a ^TW symbol neither source knows says not found", async () => {
  await soleRun(twOnlyHost(["^TWZZ"]), async (w, host) => {
    assert.equal(w.errors["^TWZZ"].code, "yahoo.notFound");
    assert.equal(stockLists(host).length, 1);
    assert.ok(stockLists(host)[0].includes("%5ETWZZ"), stockLists(host)[0]);
    await advance(host, TW_NOW + 15_000);
    assert.equal(stockLists(host).length, 1);
    await advance(host, TW_NOW + 61_000);
    assert.equal(stockLists(host).length, 2);
    assert.equal(w.errors["^TWZZ"].code, "yahoo.notFound");
  });
});

test("a rate limit shows on a TW-only row", async () => {
  const limited = { status: 429, ok: false, text: "" };
  await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => limited }), (w) => {
    assert.equal(w.errors["^TWOII"].code, "yahootw.rateLimited");
  });
  // A rate-limited line keeps the price it was asked beside, drawn as cached: the row says why.
  await soleRun(twOnlyHost(["^TWOII"], { line: () => limited }), (w) => {
    const quote = w.shown("^TWOII");
    assert.deepEqual([quote.source, quote.price, quote.cached], ["yahootw", 321.97, true]);
    assert.equal(w.errors["^TWOII"].code, "request.deferred");
  });
});

test("a failed round keeps a TW-only index's last price, cached with the reason, until the next answer", async () => {
  let hang = false;
  const host = twOnlyHost(["^TWOII"], { yahootw: () => (hang ? new Promise(() => {}) : stockList(host.clock - 5_000)) });
  await soleRun(host, async (w) => {
    const priced = w.shown("^TWOII");
    assert.equal(priced.cached, undefined);
    hang = true;
    // The next round (10 s on: the line's periods say open) hangs and times out 10 s later.
    await advance(host, TW_NOW + 30_000);
    const kept = w.shown("^TWOII");
    assert.deepEqual([kept.source, kept.price, kept.timestamp, kept.cached], ["yahootw", priced.price, priced.timestamp, true]);
    assert.equal(w.errors["^TWOII"].code, "request.timeout");
    assert.equal(w.overlayError("^TWOII"), null);
    hang = false;
    await advance(host, TW_NOW + 60_000);
    assert.equal(w.shown("^TWOII").cached, undefined);
    assert.equal(w.errors["^TWOII"], undefined);
  });
});

test("after a price, a name-only answer keeps a TW-only index's last price and line, not cached", async () => {
  let placeholder = false;
  const host = twOnlyHost(["^TWOII"], {
    yahootw: () => stockList(host.clock - 5_000, placeholder ? { "^TWOII": { price: { raw: "-" }, regularMarketTime: "-" } } : {}),
  });
  await soleRun(host, async (w) => {
    const priced = w.shown("^TWOII");
    placeholder = true;
    await advance(host, TW_NOW + 25_000);
    const kept = w.shown("^TWOII");
    assert.deepEqual([kept.price, kept.timestamp, kept.cached], [priced.price, priced.timestamp, undefined]);
    assert.deepEqual(kept.series, priced.series);
    assert.equal(w.errors["^TWOII"], undefined);
  });
});

test("after a price, an answer without its row keeps a TW-only index's last price, cached as not found", async () => {
  let absent = false;
  const host = twOnlyHost(["^TWOII"], {
    yahootw: () => (absent ? ok(TW_ROWS.filter((row) => row.symbol !== "^TWOII")) : stockList(host.clock - 5_000)),
  });
  await soleRun(host, async (w) => {
    const priced = w.shown("^TWOII");
    absent = true;
    await advance(host, TW_NOW + 25_000);
    const kept = w.shown("^TWOII");
    assert.deepEqual([kept.price, kept.cached], [priced.price, true]);
    assert.deepEqual(kept.series, priced.series);
    assert.equal(w.errors["^TWOII"].code, "yahootw.notFound");
  });
});

test("after a price, an answer that rejects its row keeps a TW-only index's last price and line, cached with that reason", async () => {
  let rejected = false;
  // Limits the recorded price (321.97) is above: the decoder discards it with a reason.
  const limits = { "^TWOII": { limitUpPrice: { raw: "320.00" }, limitDownPrice: { raw: "290.00" } } };
  const host = twOnlyHost(["^TWOII"], { yahootw: () => stockList(host.clock - 5_000, rejected ? limits : {}) });
  await soleRun(host, async (w) => {
    const priced = w.shown("^TWOII");
    assert.ok(priced.series.length);
    rejected = true;
    await advance(host, TW_NOW + 25_000);
    const kept = w.shown("^TWOII");
    assert.deepEqual([kept.price, kept.timestamp, kept.cached], [priced.price, priced.timestamp, true]);
    assert.deepEqual(kept.series, priced.series);
    assert.equal(w.errors["^TWOII"].code, "yahootw.outOfLimits");
  });
});

// Yahoo Finance priced ^TWII, then no longer knows it: TW-only from then on, with nothing kept of Yahoo's quote.
test("a symbol turned TW-only keeps no Yahoo Finance quote", async () => {
  let known = true;
  const host = twOnlyHost(["^TWII"], { yahoo: (symbol) => (known ? atTai(symbol) : NOT_FOUND), line: offline });
  await soleRun(host, async (w) => {
    assert.equal(w.quotes["^TWII"].source, "yahoo");
    known = false;
    const asked = charts(host, "^TWII");
    await advance(host, TW_NOW + 70_000);
    assert.equal(charts(host, "^TWII"), asked + 1);
    assert.equal(w.quotes["^TWII"], undefined);
    // Yahoo 奇摩股市 prices it again: nothing of Yahoo Finance's quote shows beside that price.
    await advance(host, TW_NOW + 85_000);
    const quote = w.shown("^TWII");
    assert.equal(quote.source, "yahootw");
    assert.notEqual(quote.chartSource, "yahoo");
    assert.notDeepEqual(quote.series, BASE_SERIES);
    assert.equal(w.errors["^TWII"], undefined);
  });
});

// A TW-only row has no base to fall back to: its own error says why, and no fallback note repeats it.
test("a TW-only row's failure is its error alone, not also an overlay error", async () => {
  await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => new Promise(() => {}) }), async (w, host) => {
    await advance(host, TW_NOW + 20_000);
    assert.equal(w.errors["^TWOII"].code, "request.timeout");
    assert.equal(w.overlayError("^TWOII"), null);
  });
});

// During the session, a TW-only row still from the day before is no real-time price.
test("a lone earlier-day row does not hide that nothing is real time", async () => {
  const yesterday = { "^TWOII": { regularMarketTime: "2026-11-08T05:31:00Z" } };
  await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => stockList(TW_NOW - 5_000, yesterday) }), (w) => {
    assert.equal(w.shown("^TWOII").timestamp, Date.parse("2026-11-08T05:31:00Z"));
    assert.deepEqual(w.problems().map(({ provider, code }) => [provider, code]), [["yahootw", "yahootw.noLiveRows"]]);
  });
});

test("the move to TW-only does not restart Yahoo's round", async () => {
  await soleRun(twOnlyHost(["2330.TW", "^TWOII"]), (w, host) => {
    assert.equal(w.shown("^TWOII").source, "yahootw");
    // The renders' sync() found nothing changed: the TW-only set is not part of config().
    assert.equal(w.sync(), false);
    assert.equal(charts(host, "2330.TW"), 1);
    assert.equal(charts(host, "^TWOII"), 1);
  });
});

test("a mistyped symbol never reaches the Taiwan host", async () => {
  await soleRun(twOnlyHost(["APPL"]), (w, host) => {
    assert.equal(w.errors.APPL.code, "yahoo.notFound");
    assert.deepEqual(host.requests.filter((url) => isYahootw(url) && url.includes("APPL")), []);
  });
});

test("with Yahoo 奇摩股市 off, ^TWOII is not found", async () => {
  const host = twOnlyHost();
  host.prefs = undefined;
  await soleRun(host, (w) => {
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
    assert.equal(w.marketFor("^TWOII"), "other");
    assert.deepEqual(host.requests.filter(isYahootw), []);
  });
});

test("turning Yahoo 奇摩股市 off, then on, starts over", async () => {
  await soleRun(twOnlyHost(), async (w, host) => {
    assert.equal(w.shown("^TWOII").source, "yahootw");
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.equal(w.shown("^TWOII"), undefined);
    const before = chartCount(host);
    await advance(host, TW_NOW + 61_000);
    assert.ok(chartCount(host) > before);
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
    host.prefs = ONLY_YAHOOTW;
    assert.equal(w.sync(), true);
    const asked = charts(host, "^TWOII");
    await advance(host, TW_NOW + 66_000);
    // Asked of Yahoo Finance again: nothing was kept from before.
    assert.equal(charts(host, "^TWOII"), asked + 1);
    assert.equal(w.shown("^TWOII").source, "yahootw");
    assert.equal(w.errors["^TWOII"], undefined);
  });
});

// At the open the line still carries the day before's periods (recorded at 08:14): they are not today's row's.
test("after the open, a TW-only row is not read closed by the day before's periods", async () => {
  const open = Date.parse("2026-11-10T01:00:00Z");
  const host = twOnlyHost(["^TWOII"], {
    yahootw: () => (host.clock >= open ? stockList(host.clock - 5_000) : ok(EARLIER_ROWS)),
    line: () => ok(EARLIER_TICK),
  });
  const lines = () => host.requests.filter(isLine).length;
  // 08:57:30: the day before's close, and its line's periods, are known before the open.
  await soleRun(host, async (w) => {
    assert.equal(sessionOf(w.shown("^TWOII", host.clock), host.clock), "closed");
    assert.equal(lines(), 1);
    // The round at 09:00:30 prices today's first row and asks the line again at once.
    await advance(host, open + 31_000);
    const now = open + 31_000;
    const quote = w.shown("^TWOII", now);
    assert.equal(quote.day, taipeiDay(now));
    assert.notEqual(sessionOf(quote, now), "closed");
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "unconfirmed");
    assert.equal(lines(), 2);
    // At 09:05 it still is not closed, and it polls every 10 s.
    const asked = stockLists(host).length;
    await advance(host, open + 300_000);
    assert.notEqual(sessionOf(w.shown("^TWOII", open + 300_000), open + 300_000), "closed");
    assert.ok(stockLists(host).length - asked >= 25, String(stockLists(host).length - asked));
  }, open - 150_000);
});

// A feed that stalls during the session: today's price ages with no periods from its own day (the line still
// gives the day before's, or fails). That reads unconfirmed, never closed: only an earlier day's price does.
test("a stalled TW-only price from today is not read closed", async () => {
  const DAY_S = 86_400;
  const dayBefore = { regular: { start: OPEN_NOW.regular.start - DAY_S, end: OPEN_NOW.regular.end - DAY_S } };
  for (const line of [(symbol) => tickAt(symbol, TW_NOW - 60_000, [321.97], dayBefore), offline]) {
    await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => stockList(TW_NOW - 5_000), line }), async (w, host) => {
      const now = TW_NOW + 300_000;
      await advance(host, now);
      const quote = w.shown("^TWOII", now);
      assert.equal(quote.day, taipeiDay(now));
      assert.equal(quote.periods, null);
      assert.notEqual(sessionOf(quote, now), "closed");
      assert.notEqual(freshness(quote, sessionOf(quote, now), now).state, "closed");
    });
  }
  // An earlier day's price still reads closed.
  await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => ok(EARLIER_ROWS), line: offline }), (w) => {
    const quote = w.shown("^TWOII", NIGHT + 5_000);
    assert.equal(sessionOf(quote, NIGHT + 5_000), "closed");
  }, NIGHT);
});

test("turning Yahoo 奇摩股市 off while paused says not found at once", async () => {
  await soleRun(twOnlyHost(), (w, host) => {
    assert.equal(w.errors["^TWOII"], undefined);
    w.pause(true);
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
  });
});

test("a future goes to Yahoo 奇摩股市 alone, never with the Finnhub key", async () => {
  // Every answer is unreadable: only what is asked, and with which headers, matters here.
  const host = fakeHost(() => ok({}));
  host.prefs = { version: 1, sources: { us: { provider: "finnhub" }, tw: BOTH.sources.tw } };
  host.secrets = { [SECRET_KEY_FINNHUB]: "k".repeat(20) };
  host.store = { version: 1, symbols: ["WTX&", "AAPL", "2330.TW"], paused: false };
  await soleRun(host, (w) => {
    const config = w.config();
    for (const provider of [yahoo, finnhub, mis]) assert.equal(w.serves(provider, "WTX&", config), false, provider.id);
    assert.equal(w.serves(yahootw, "WTX&", config), true);
    assert.equal(w.marketFor("WTX&"), "tw");
    assert.deepEqual(w.finnhubSymbols(), ["AAPL"]);
    assert.deepEqual(host.requests.filter((url) => !isYahootw(url) && url.includes("WTX")), []);
    assert.ok(host.requests.some((url) => isYahootw(url) && url.includes("WTX%26")));
    assert.ok(host.headers.some((headers) => headers["X-Finnhub-Token"]), "Finnhub was asked");
    host.headers.forEach((headers, i) => {
      if (headers["X-Finnhub-Token"]) assert.doesNotMatch(host.requests[i], /WTX/);
    });
  }, FUT_NOW);
});

test("without Yahoo 奇摩股市 a future stays listed as one unavailable line, and turning it on prices it", async () => {
  const host = futuresHost();
  host.prefs = undefined;
  await soleRun(host, async (w) => {
    assert.equal(w.errors["WTX&"].code, "yahootw.futuresNeedSource");
    assert.equal(w.shown("WTX&"), undefined);
    assert.equal(collapsedRow({ quote: w.shown("WTX&"), failed: w.errors["WTX&"] }), true);
    assert.deepEqual(host.requests.filter((url) => url.includes("WTX")), []);
    assert.equal(w.marketFor("WTX&"), "tw");
    host.prefs = ONLY_YAHOOTW;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["WTX&"], undefined);
    await advance(host, FUT_NOW + 10_000);
    const quote = w.shown("WTX&");
    assert.deepEqual([quote.source, quote.price], ["yahootw", 42604]);
    assert.deepEqual(w.preferences.symbols, ["WTX&"]);
  }, FUT_NOW);
});

test("a future awaiting Yahoo 奇摩股市's re-confirmation gives that reason, and the futures reason once it is off", async () => {
  const host = futuresHost();
  // Switched on, with a consent to an older statement.
  host.prefs = STALE_YAHOOTW;
  await soleRun(host, (w) => {
    assert.equal(w.errors["WTX&"].code, "yahootw.reconfirm");
    assert.deepEqual(host.requests.filter(isYahootw), []);
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["WTX&"].code, "yahootw.futuresNeedSource");
  }, FUT_NOW);
});

// A failed round keeps the last price, as for a TW-only index, now for a future.
test("a failed round keeps a future's last price, cached with the reason", async () => {
  let hang = false;
  const host = futuresHost(["WTX&"], { yahootw: () => (hang ? new Promise(() => {}) : futuresAt(host.clock - 5_000)) });
  await soleRun(host, async (w) => {
    assert.equal(w.shown("WTX&").price, 42604);
    hang = true;
    // Whatever the cadence (10 s or 60 s), a hung round has timed out by then.
    await advance(host, FUT_NOW + 75_000);
    const kept = w.shown("WTX&");
    assert.deepEqual([kept.source, kept.price, kept.cached], ["yahootw", 42604, true]);
    assert.equal(w.errors["WTX&"].code, "request.timeout");
  }, FUT_NOW);
});

// A name-only answer keeps the last price, and so does a failed round (a missing row), for a future.
test("after a price, a name-only answer keeps a future's price unmarked, and a missing row keeps it cached as not found", async () => {
  let answer = "priced";
  const host = futuresHost(["WTX&"], {
    yahootw: () => (answer === "priced" ? futuresAt(host.clock - 5_000)
      : answer === "name" ? futuresAt(host.clock - 5_000, { "WTX&": { price: { raw: "-" }, regularMarketTime: "-" } })
      : ok(FUTURES_ROWS.filter((row) => row.symbol !== "WTX&"))),
  });
  await soleRun(host, async (w) => {
    answer = "name";
    await advance(host, FUT_NOW + 75_000);
    let kept = w.shown("WTX&");
    assert.deepEqual([kept.price, kept.cached], [42604, undefined]);
    assert.equal(w.errors["WTX&"], undefined);
    answer = "absent";
    await advance(host, FUT_NOW + 150_000);
    kept = w.shown("WTX&");
    assert.deepEqual([kept.price, kept.cached], [42604, true]);
    assert.equal(w.errors["WTX&"].code, "yahootw.notFound");
  }, FUT_NOW);
});

// A row with a price that is refused (delayed, or timed too far ahead) is not a name-only answer: the kept price reads
// cached, with why. Only a placeholder (`-`) leaves it unmarked.
test("after a price, a delayed or far-ahead row keeps a future's price cached as not real time; a placeholder leaves it unmarked", async () => {
  let answer = "priced";
  const host = futuresHost(["WTX&"], {
    yahootw: () => (answer === "priced" ? futuresAt(host.clock - 5_000)
      : answer === "delayed" ? futuresAt(host.clock - 5_000, { "WTX&": { exchangeDataDelayedBy: 15 } })
      : answer === "ahead" ? futuresAt(host.clock + 3_600_000)
      : futuresAt(host.clock - 5_000, { "WTX&": { price: { raw: "-" } } })),
  });
  await soleRun(host, async (w) => {
    for (const [step, until] of [["delayed", 75_000], ["ahead", 150_000]]) {
      answer = "priced";
      await advance(host, FUT_NOW + until - 30_000);
      assert.equal(w.shown("WTX&").cached, undefined, step);
      answer = step;
      await advance(host, FUT_NOW + until);
      const kept = w.shown("WTX&");
      assert.deepEqual([kept.price, kept.cached], [42604, true], step);
      assert.equal(w.errors["WTX&"].code, "yahootw.noLiveRows", step);
    }
    answer = "placeholder";
    await advance(host, FUT_NOW + 225_000);
    assert.equal(w.shown("WTX&").cached, undefined);
    assert.equal(w.errors["WTX&"], undefined);
  }, FUT_NOW);
});

test("a futures code Yahoo 奇摩股市 does not answer reads not found on Yahoo 奇摩股市", async () => {
  await soleRun(futuresHost(["WTXP&"]), (w, host) => {
    assert.equal(w.errors["WTXP&"].code, "yahootw.notFound");
    assert.ok(stockLists(host)[0].includes("WTXP%26"), stockLists(host)[0]);
    assert.equal(charts(host, "WTXP&"), 0);
    assert.equal(w.shown("WTXP&"), undefined);
  }, FUT_NOW);
});

test("WTX& is priced by Yahoo 奇摩股市 alone: name, price, change, line and limits", async () => {
  await soleRun(futuresHost(["WTX&"], { line: () => ok(FUTURES_TICK) }), (w, host) => {
    const now = FUT_NOW + 5_000;
    const quote = w.shown("WTX&", now);
    assert.deepEqual([quote.source, quote.name, quote.localName, quote.price, quote.currency], ["yahootw", "台指期近一", "台指期近一", 42604, "TWD"]);
    assert.ok(Math.abs(quote.changePercent - 1126 / 41478 * 100) < 1e-9);
    assert.deepEqual([quote.limitUp, quote.limitDown], [45625, 37331]);
    assert.deepEqual([quote.series.length, quote.series[0], quote.series.at(-1), quote.chartSource], [1133, 41235, 42604, "yahootw"]);
    assert.equal(w.marketFor("WTX&"), "tw");
    assert.equal(w.errors["WTX&"], undefined);
    assert.equal(host.requests.filter(isLine).length, 1);
  }, FUT_NOW);
});

test("a future answered from another exchange reads not found", async () => {
  await soleRun(futuresHost(["WTX&"], { yahootw: () => futuresAt(FUT_NOW - 5_000, { "WTX&": { exchange: "NMS" } }) }), (w) => {
    assert.equal(w.errors["WTX&"].code, "yahootw.notFound");
    assert.equal(w.shown("WTX&"), undefined);
  }, FUT_NOW);
});

test("at 20:00 a stock beside a trading future still reads closed at 13:30", async () => {
  const now = at("2026-11-10T12:00:05Z");
  const close = at("2026-11-10T05:30:00Z");
  const open = { regular: { start: at("2026-11-10T01:00:00Z") / 1000, end: close / 1000 } };
  const host = futuresHost(["2330.TW", "WTX&"], {
    yahootw: () => ok([{ ...TW_ROWS[0], exchange: "TAI", regularMarketTime: new Date(close).toISOString() },
      { ...FUTURES_ROWS[0], regularMarketTime: "2026-11-10T12:00:00Z" }]),
    yahoo: (symbol) => twYahoo(symbol, { exchangeName: "TAI", currentTradingPeriod: open }),
  });
  const tx = (key, params) => t("zh-TW", key, params);
  await soleRun(host, (w) => {
    const later = now + 5_000;
    const quote = w.shown("2330.TW", later);
    assert.equal(quote.timestamp, close);
    const fresh = freshness(quote, sessionOf(quote, later), later);
    assert.equal(fresh.state, "closed");
    assert.equal(freshnessLabel(quote, fresh, later, "zh-TW", tx),
      `${tx("session.closed")} · ${[formatStaleDate(close, later, "zh-TW"), formatTime(close)].filter(Boolean).join(" ")}`);
  }, now);
});

test("the add field takes a futures code; WTX alone stays a US ticker", () => {
  const host = fakeHost(() => ok({}));
  const w = new Watchlist(host);
  assert.deepEqual(w.add("wtx&"), { code: "notice.added", params: { symbol: "WTX&" } });
  assert.deepEqual(host.store.symbols, ["WTX&"]);
  w.add("WTX");
  assert.deepEqual(host.store.symbols, ["WTX", "WTX&"]);
  assert.equal(w.marketFor("WTX"), "us");
  assert.equal(w.marketFor("WTX&"), "tw");
  assert.throws(() => w.add("TXF1&"), (e) => e.code === "symbol.invalid");
  assert.deepEqual(host.store.symbols, ["WTX", "WTX&"]);
  assert.deepEqual(readPreferences({ version: 1, symbols: ["wtx&", "WTX@", "WTX&"] }).symbols, ["WTX&", "WTX@"]);
});

test("the idle wake waits for each quote's own stale moment", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const T = at("2026-11-10T02:00:00Z");
  const periods = day("2026-11-10T01:30:00Z", "2026-11-10T08:00:00Z");
  // A Yahoo quote's age is taken at its fetch, so what turns it is 5 minutes without one.
  const fetchedAt = { "0700.HK": T + 100_000, "ES=F": T, AAPL: T };
  for (const [symbol, exchange] of [["0700.HK", "HKG"], ["ES=F", "CME"], ["AAPL", "NMS"]]) {
    w.quotes[symbol] = { ...yq(symbol, exchange, T, periods), fetchedAt: fetchedAt[symbol] };
  }
  assert.equal(w.staleInMs(["0700.HK"], T + 100_000), 120_000);
  assert.equal(w.staleInMs(["0700.HK"], T + 300_000), 100_001);
  assert.equal(w.staleInMs(["ES=F"], T + 250_000), 120_000);
  assert.equal(w.staleInMs(["AAPL"], T + 250_000), 50_001);
  assert.equal(w.staleInMs(["AAPL", "0700.HK"], T + 250_000), 50_001);
  // One stale already is skipped: AAPL past its guard, the wake is 0700.HK's.
  assert.equal(w.staleInMs(["AAPL", "0700.HK"], T + 300_001), 100_000);
});

test("the idle wake skips a delayed quote whose session is not known yet", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const T = at("2026-11-10T02:00:00Z");
  // No trading hours yet: it reads delayed, never stalled, so no stale moment is due. Real time still wakes,
  // since a stale overlay hands its row to another source.
  for (const [symbol, exchange] of [["0700.HK", "HKG"], ["AAPL", "NMS"]]) w.quotes[symbol] = { ...yq(symbol, exchange, T), fetchedAt: T };
  assert.equal(w.staleInMs(["0700.HK"], T + 1_100_000), 120_000);
  assert.equal(w.staleInMs(["AAPL"], T + 240_000), 60_001);
});

test("after the Taiwan close the idle wake still lands when the shown overlay hands over", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const tw = day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"); // 09:00–13:30 in Taipei
  w.quotes["2330.TW"] = { ...yq("2330.TW", "TAI", at("2026-11-10T05:10:00Z"), tw), fetchedAt: at("2026-11-10T05:31:00Z") };
  // Yahoo 奇摩股市 timed 13:31:00 comes first while live; MIS, 30 s newer, takes over once it is not.
  const overlay = (source, iso) => ({ symbol: "2330.TW", source, price: 2200, timestamp: at(iso), fetchedAt: at(iso) });
  w.overlays["2330.TW"] = { yahootw: overlay("yahootw", "2026-11-10T05:31:00Z"), mis: overlay("mis", "2026-11-10T05:31:30Z") };
  const now = at("2026-11-10T05:32:00Z"); // 13:32, the market closed
  assert.equal(sessionOf(w.shown("2330.TW", now), now), "closed");
  assert.equal(w.shown("2330.TW", now).source, "yahootw");
  assert.equal(w.staleInMs(["2330.TW"], now), 60_001);
  assert.equal(w.shown("2330.TW", now + 60_001).source, "mis");
});

test("a cached Yahoo quote never reads live: after a failed fetch its age runs to now", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const success = at("2026-11-10T15:00:00Z"); // the last good fetch, 10:00 in New York
  w.quotes.AAPL = { ...yq("AAPL", "NMS", success - 10_000, day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z")), fetchedAt: success };
  const state = (now) => { const q = w.shown("AAPL", now); return freshness(q, sessionOf(q, now), now).state; };
  // No error: the fetch-based rule, live until the 5-minute guard.
  assert.equal(state(success + 121_000), "live");
  w.errors.AAPL = { code: "yahoo.unreachable", params: {} };
  assert.equal(state(success + 110_000), "live");
  assert.equal(state(success + 110_001), "stalled");
  assert.equal(state(at("2026-11-10T15:02:01Z")), "stalled");
  assert.equal(w.staleInMs(["AAPL"], success + 60_000), 50_001);
  delete w.errors.AAPL;
  assert.equal(state(at("2026-11-10T15:02:01Z")), "live");
});

test("the busiest session ranks lunch below open and unknown", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  const noon = at("2026-11-10T02:45:00Z"); // 11:45 JST
  const quote = (symbol, exchange, open, close) => yq(symbol, exchange, noon - 600_000, day(open, close));
  w.quotes["7203.T"] = quote("7203.T", "JPX", "2026-11-10T00:00:00Z", "2026-11-10T06:30:00Z");
  w.quotes["2330.TW"] = quote("2330.TW", "TAI", "2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z");
  w.quotes.AAPL = quote("AAPL", "NMS", "2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z");
  assert.equal(w.sessionFor(["7203.T"], noon), "lunch");
  assert.equal(w.sessionFor(["7203.T", "AAPL"], noon), "lunch");
  assert.equal(w.sessionFor(["7203.T", "2330.TW"], noon), "open");
  assert.equal(w.sessionFor(["7203.T", "MSFT"], noon), "unknown");
  // A JPX quote from 11:30 JST fetched at 11:59: nothing turns stale over lunch; once open again, its fetch guard.
  w.quotes["7203.T"] = { ...w.quotes["7203.T"], timestamp: at("2026-11-10T02:30:00Z"), fetchedAt: at("2026-11-10T02:59:00Z") };
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T03:00:00Z")), 120_000); // 12:00 JST: the cap
  w.quotes["7203.T"].fetchedAt = at("2026-11-10T03:45:00Z"); // 12:45 JST: 15 min traded
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T03:49:00Z")), 60_001);
  // A quote from 11:10 JST at 11:45: its frozen age (20 min) would leave 1 ms, and the wake would spin all lunch.
  w.quotes["7203.T"] = { ...w.quotes["7203.T"], timestamp: at("2026-11-10T02:10:00Z") };
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T02:45:00Z")), 120_000);
});

test("a half day's close inside lunch does not spin the idle wake", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  // HKEX half day: 09:30–12:00 HKT, so at 12:10 the market is closed though the clock is inside 12:00–13:00.
  w.quotes["0700.HK"] = yq("0700.HK", "HKG", at("2026-11-10T03:40:00Z"), day("2026-11-10T01:30:00Z", "2026-11-10T04:00:00Z"));
  for (const hms of ["04:10:00", "04:30:00", "04:59:00"]) assert.equal(w.staleInMs(["0700.HK"], at(`2026-11-10T${hms}Z`)), 120_000, hms);
});

test("a JPX quote from before lunch wakes the loop at most at the cap, and its stop moment falls into lunch", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  // Timed 11:10 JST, last fetched 11:25.
  w.quotes["7203.T"] = { ...yq("7203.T", "JPX", at("2026-11-10T02:10:00Z"), day("2026-11-10T00:00:00Z", "2026-11-10T06:30:00Z")), fetchedAt: at("2026-11-10T02:25:00Z") };
  // 11:26: 240 001 ms to the fetch guard, held to the cap.
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T02:26:00Z")), 120_000);
  // 11:29: 60 001 ms left, a wake at 11:30:00.001, inside lunch, where the quote is skipped.
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T02:29:00Z")), 60_001);
  assert.equal(w.staleInMs(["7203.T"], at("2026-11-10T02:30:00Z") + 1), 120_000);
});

// A futures line answer: one close a minute over each of `spans` ([[from, to]] in ms, both ends included), 42 000 rising
// by one a point, with `segments` as its sourceTradingPeriods and their span as its currentTradingPeriod.
const futuresLineOf = (symbol, spans, segments) => {
  const timestamp = spans.flatMap(([from, to]) =>
    Array.from({ length: Math.round((to - from) / 60_000) + 1 }, (_, i) => from / 1000 + i * 60));
  return ok([{ symbol, chart: {
    meta: { symbol, currentTradingPeriod: { regular: { start: segments[0][0] / 1000, end: segments.at(-1)[1] / 1000 } },
      sourceTradingPeriods: [segments.map(([start, end]) => ({ start: start / 1000, end: end / 1000 }))] },
    timestamp,
    indicators: { quote: [{ close: timestamp.map((_, i) => 42000 + i) }] },
  } }]);
};
const futuresLine = (symbol, from, to, segments) => futuresLineOf(symbol, [[from, to]], segments);
const NEXT_SEGMENTS = [[at("2026-11-10T07:00:00Z"), at("2026-11-10T21:00:00Z")],
  [at("2026-11-11T00:45:00Z"), at("2026-11-11T05:45:00Z")]];                                    // Wed's
const MON_1500 = at("2026-11-09T07:00:00Z");
// Monday 2026-11-16's trading day, as its line would give it: Friday 15:00 → Saturday 05:00, Monday 08:45 → 13:45.
const FRI_1500 = at("2026-11-13T07:00:00Z");
const FRI_SEGMENTS = [[FRI_1500, at("2026-11-13T21:00:00Z")], [at("2026-11-16T00:45:00Z"), at("2026-11-16T05:45:00Z")]];

test("22:00 in the night session: Live, and the detail names the night session", async () => {
  const from = at("2026-11-10T14:00:00Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 20_000),
    line: (symbol) => futuresLine(symbol, NEXT_SEGMENTS[0][0], from - 60_000, NEXT_SEGMENTS),
  });
  await soleRun(host, async (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    const session = sessionOf(quote, now);
    assert.equal(freshness(quote, session, now).state, "live");
    assert.equal(t("zh-TW", `session.${sessionName(quote, session, now)}`), "夜盤交易中");
    const asked = stockLists(host).length;
    await advance(host, from + 35_000);
    assert.ok(stockLists(host).length - asked >= 3, String(stockLists(host).length - asked));
  }, from);
});

test("06:30 in the morning break: closed at 05:00, polled gently", async () => {
  const from = at("2026-11-09T22:30:00Z");
  const last = at("2026-11-09T21:00:00Z");
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(last), line: (symbol) => futuresLine(symbol, MON_1500, last, SEGMENTS) });
  await soleRun(host, async (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "closed");
    assert.equal(quote.timestamp, last);
    assert.deepEqual(w.problems(), []);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 15_000);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 61_000);
    assert.equal(stockLists(host).length, 2);
  }, from);
});

// The last trade at 04:59:50, 10 s before the break and 40 s before the test starts at 05:00:30: in session it would turn
// stale 75 s after the first check; in the break it never does. The staleInMs assertion is the guard; the redraw bound is a
// backstop (it passes before the change too, since a real-time age always grows).
test("a break never spins the idle wake", async () => {
  const from = at("2026-11-09T21:00:30Z"); // 05:00:30
  const last = at("2026-11-09T20:59:50Z"); // 04:59:50
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(last), line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-09T20:59:00Z"), SEGMENTS),
  });
  host.clock = from;
  const w = new Watchlist(host);
  let redraws = 0;
  const runs = w.providerIds().map((id) => w.runProvider(id, { sleep: host.sleep, changed: () => { redraws++; } }));
  await advance(host, from + 5_000);
  for (const now of [from + 5_000, from + 30_000]) assert.equal(w.staleInMs(["WTX&"], now), LIVE_MAX_AGE_MS, String(now));
  await advance(host, from + 600_000);
  assert.ok(redraws < 100, String(redraws));
  await stop(w, host, runs);
});

test("01:00 in the night session: Live, with the line from 15:00", async () => {
  const from = at("2026-11-09T17:00:00Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 20_000),
    line: (symbol) => futuresLine(symbol, MON_1500, from - 60_000, SEGMENTS),
  });
  await soleRun(host, (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
    assert.equal(sessionName(quote, "open", now), "night");
    assert.deepEqual([quote.series.length, quote.series[0]], [601, 42000]);
  }, from);
});

test("09:00 after a night: Live, read by the line's own sessions", async () => {
  const from = at("2026-11-10T01:00:00Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 10_000),
    line: (symbol) => futuresLine(symbol, MON_1500, from - 60_000, SEGMENTS),
  });
  await soleRun(host, (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.deepEqual(quote.periods.segments, SEGMENTS);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
    assert.equal(sessionName(quote, "open", now), "day");
  }, from);
});

// Friday's night session belongs to Monday's trading day, so its line is still drawn on Monday morning.
test("Monday 09:00 after Friday night: Live in the day session, with Friday night's line", async () => {
  const from = at("2026-11-16T01:00:00Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 10_000),
    // Friday night's 840 minutes, then Monday's first 15.
    line: (symbol) => futuresLineOf(symbol, [[FRI_1500, at("2026-11-13T20:59:00Z")], [FRI_SEGMENTS[1][0], from - 60_000]], FRI_SEGMENTS),
  });
  await soleRun(host, (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.deepEqual(quote.periods.segments, FRI_SEGMENTS);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
    assert.equal(t("zh-TW", `session.${sessionName(quote, "open", now)}`), "日盤交易中");
    assert.deepEqual([quote.series.length, quote.series[0]], [856, 42000]);
  }, from);
});

// Saturday 04:59:59 belongs to Monday's trading day, so on Sunday it is not an earlier day: no noLive. The round's
// `asked.anyDay` lists futures as well, so it would be accepted as an earlier day's row anyway.
test("on Sunday, Friday night's last price reads closed with its date, polled gently", async () => {
  const from = at("2026-11-15T14:00:00Z"); // Sun 22:00
  const last = at("2026-11-13T20:59:59Z"); // Sat 04:59:59
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(last),
    line: (symbol) => futuresLine(symbol, FRI_1500, at("2026-11-13T20:59:00Z"), FRI_SEGMENTS),
  });
  const tx = (key, params) => t("zh-TW", key, params);
  await soleRun(host, async (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    const fresh = freshness(quote, sessionOf(quote, now), now);
    assert.equal(fresh.state, "closed");
    const date = formatStaleDate(last, now, "zh-TW");
    assert.ok(date, "the date shows");
    assert.equal(freshnessLabel(quote, fresh, now, "zh-TW", tx), `${tx("session.closed")} · ${date} ${formatTime(last)}`);
    assert.deepEqual(w.problems(), []);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 15_000);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 61_000);
    assert.equal(stockLists(host).length, 2);
  }, from);
});

test("13:50 after the day session: closed, polled gently", async () => {
  const from = at("2026-11-10T05:50:00Z");
  const last = at("2026-11-10T05:44:59Z");
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(last), line: (symbol) => futuresLine(symbol, MON_1500, last, SEGMENTS) });
  await soleRun(host, async (w) => {
    const now = host.clock;
    assert.equal(sessionOf(w.shown("WTX&", now), now), "closed");
    await advance(host, from + 15_000);
    assert.equal(stockLists(host).length, 1);
  }, from);
});

test("the night opens with its first trade, before the line brings the new trading day's sessions", async () => {
  const from = at("2026-11-10T06:59:50Z");          // 14:59:50
  const first = at("2026-11-10T07:00:02Z"); // 15:00:02
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock < first ? at("2026-11-10T05:44:59Z") : first),
    line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-10T05:44:00Z"), SEGMENTS),
  });
  await soleRun(host, async (w) => {
    assert.equal(sessionOf(w.shown("WTX&", host.clock), host.clock), "closed");
    await advance(host, from + 75_000);
    const now = from + 75_000;
    const quote = w.shown("WTX&", now);
    assert.equal(quote.timestamp, first);
    assert.equal(sessionOf(quote, now), "open");
    assert.equal(freshness(quote, "open", now).state, "live");
  }, from);
});

// The first round hangs and times out at 10 s; the row says so, and the next ask comes at the session's cadence: 10 s at
// night (the TAIFEX hours, since the row has no quote), 60 s in a break.
test("a failed round says why, and retries at the session's cadence", async () => {
  for (const [from, at22s, at72s] of [[at("2026-11-10T14:00:00Z"), 2, null], [at("2026-11-09T22:30:00Z"), 1, 2]]) {
    const label = new Date(from).toISOString();
    const host = futuresHost(["WTX&"], {
      yahootw: () => (host.clock < from + 10_000 ? new Promise(() => {}) : futuresAt(host.clock - 5_000)),
    });
    await soleRun(host, async (w) => {
      await advance(host, from + 11_000);
      assert.equal(w.errors["WTX&"].code, "request.timeout", label);
      assert.equal(stockLists(host).length, 1, label);
      await advance(host, from + 22_000);
      assert.equal(stockLists(host).length, at22s, label);
      if (at72s !== null) {
        await advance(host, from + 72_000);
        assert.equal(stockLists(host).length, at72s, label);
      }
    }, from);
  }
});

// Between segments a future reads closed, so its line, already held for the trading day, is not asked again every
// 120 s, and its prices come at the break's 60 s cadence, not every 10 s.
test("a break and a weekend ask a future's line no more", async () => {
  for (const [from, last, line] of [
    [at("2026-11-09T22:30:00Z"), at("2026-11-09T21:00:00Z"),
      (symbol) => futuresLine(symbol, MON_1500, at("2026-11-09T21:00:00Z"), SEGMENTS)],                        // 06:30
    [at("2026-11-15T14:00:00Z"), at("2026-11-13T20:59:59Z"),
      (symbol) => futuresLine(symbol, FRI_1500, at("2026-11-13T20:59:00Z"), FRI_SEGMENTS)],                    // Sun 22:00
  ]) {
    const label = new Date(from).toISOString();
    const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(last), line });
    await soleRun(host, async () => {
      assert.equal(host.requests.filter(isLine).length, 1, label);
      await advance(host, from + 600_000);
      assert.equal(host.requests.filter(isLine).length, 1, label);
      assert.ok(stockLists(host).length <= 11, `${label} ${stockLists(host).length}`);
    }, from);
  }
});

// A future still without a price in a break is asked again as its session opens, not up to the break's 60 s later.
test("a future without a price yet is asked as its session opens", async () => {
  for (const open of [at("2026-11-10T00:45:00Z"), at("2026-11-10T07:00:00Z")]) { // 08:45, 15:00
    const label = new Date(open).toISOString();
    const host = futuresHost(["WTX&"], {
      yahootw: () => futuresAt(host.clock, host.clock < open ? { "WTX&": { price: { raw: "-" } } } : {}),
    });
    await soleRun(host, async (w) => {
      assert.ok(!w.shown("WTX&", host.clock), label);
      await advance(host, open + 1_000);
      const now = open + 1_000;
      const quote = w.shown("WTX&", now);
      assert.equal(quote?.timestamp, open, label);
      assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live", label);
    }, open - 30_000);
  }
});

// At 15:00 the wake usually comes before the night's first trade; the day's segments no longer hold on the new trading
// day, so the row reads the night session and the next ask does not wait the break's 60 s.
test("at 15:00 a priced future is asked every 10 s until the night's first trade", async () => {
  const from = at("2026-11-10T06:59:50Z");          // 14:59:50
  const first = at("2026-11-10T07:00:05Z"); // 15:00:05
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock < first ? at("2026-11-10T05:44:59Z") : first),
    line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-10T05:44:00Z"), SEGMENTS),
  });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-10T07:00:20Z"));
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.equal(quote.timestamp, first);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
  }, from);
});

// With no night trade (a holiday, or a feed that stopped at the day close), the day close is not the night's: from 15:00
// the row reads stalled, never closed, and is asked every 10 s as in any open session.
test("without a night trade, the day close reads stalled from 15:00 and is asked every 10 s", async () => {
  const from = at("2026-11-10T06:59:50Z");          // 14:59:50
  const last = at("2026-11-10T05:44:59Z");          // 13:44:59
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(last), line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-10T05:44:00Z"), SEGMENTS),
  });
  await soleRun(host, async (w) => {
    const ten = at("2026-11-10T07:10:00Z");         // 15:10
    await advance(host, ten);
    const asked = stockLists(host).length;
    await advance(host, ten + 60_000);
    assert.ok(stockLists(host).length - asked >= 5, String(stockLists(host).length - asked));
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.equal(sessionOf(quote, now), "open");
    const fresh = freshness(quote, "open", now);
    assert.deepEqual([fresh.state, fresh.stoppedAt], ["stalled", last]);
  }, from);
});

test("at 08:45 a priced future from the night is asked again and reads Live", async () => {
  const from = at("2026-11-10T00:44:30Z"); // 08:44:30
  const open = at("2026-11-10T00:45:00Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock < open ? at("2026-11-09T20:59:59Z") : host.clock),
    line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-09T20:59:00Z"), SEGMENTS),
  });
  await soleRun(host, async (w) => {
    assert.equal(sessionOf(w.shown("WTX&", host.clock), host.clock), "closed");
    await advance(host, open + 1_000);
    const now = open + 1_000;
    const quote = w.shown("WTX&", now);
    assert.equal(stockLists(host).length, 2);
    assert.equal(quote.timestamp, open);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
  }, from);
});
