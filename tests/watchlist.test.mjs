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
import { LIVE_MAX_AGE_MS, freshness, sessionName, sessionOf, sessionTimes } from "../mods/wickline/freshness.js";
import { collapsedRow, dayFor, formatStaleDate, formatTime, freshnessLabel, sessionTimesParts } from "../mods/wickline/format.js";
import {
  CLOSE_0509, CLOSE_1224, EARLIER_ROWS, EARLIER_TICK, FUTURES_NIGHT_TICK, FUTURES_ROWS, FUTURES_TICK, FUT_NOW, HOLIDAYS_2026, NIGHT, SEGMENTS, advance, at,
  chart, chartSymbol, day, fakeHost, isHolidays, isLine, jsonFixture, lineSymbol, ok, start, stop, withTZ, yq,
} from "./helpers.mjs";
import { MIS_CONSENT_VERSION, MIS_URL, mis } from "../mods/wickline/providers/mis.js";
import { YAHOOTW_BASE, YAHOOTW_CONSENT_VERSION, yahootw } from "../mods/wickline/providers/yahootw.js";
import { taipeiDay } from "../mods/wickline/calendar.js";

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

// `yahoo` answers Yahoo Finance per symbol; `holidays` TWSE's holiday schedule.
function taiwanHost(prefs, {
  yahootw = () => stockList(TW_NOW - 5_000), mis = () => misAt(TW_NOW - 5_000),
  line = (symbol) => tickAt(symbol, TW_NOW - 60_000, [2200, 2205]), yahoo = (symbol) => twYahoo(symbol),
  holidays = () => ok(HOLIDAYS_2026),
} = {}) {
  const host = fakeHost((url) => isHolidays(url) ? host.holidays() : isLine(url) ? host.line(lineSymbol(url))
    : isYahootw(url) ? host.yahootw(url)
    : url.startsWith(MIS_URL) ? host.mis(url)
    : host.yahoo(chartSymbol(url)));
  Object.assign(host, { clock: TW_NOW, prefs, yahootw, mis, line, yahoo, holidays });
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
    assert.ok(host.requests.every((url) => url.startsWith(MIS_URL) || url.startsWith(yahooUrl("2330.TW")) || isHolidays(url)), host.requests.join());
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
  // 2330 trades 5 s before each round but its line stops at 09:10; 0050 last traded at 09:17:12 and its
  // line stops at 09:18, its last trade's minute. Judged at the third arrival (09:45:20), against the trades the
  // first one saw.
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(host.clock - 5_000, { "0050.TW": { regularMarketTime: "2026-11-09T01:17:12Z" } }),
    line: (symbol) => symbol === "0050.TW" ? ok(jsonFixture("yahootw-tick-quiet")) : tickAt(symbol, Date.parse("2026-11-09T01:10:00Z"), [2200, 2205]),
  });
  host.store.symbols = ["2330.TW", "0050.TW"];
  await firstRound(host, async (w) => {
    await advance(host, TW_NOW + 241_000);
    assert.equal(w.lines.yahootw?.["2330.TW"], undefined);
    const frozen = w.shown("2330.TW");
    assert.deepEqual([frozen.source, frozen.chartSource, frozen.series], ["yahootw", "yahoo", BASE_SERIES]);
    const quiet = w.shown("0050.TW");
    assert.deepEqual([quiet.chartSource, quiet.series], ["yahootw", [10.05, 10.05]]);
  });
});

test("a stock line listing empty minutes up to now, its closes stopped long before its trades, is dropped", async () => {
  // 2330 trades 5 s before each round; its answer lists every minute from 09:01 to now, with closes only to 09:10.
  const first = Date.parse("2026-11-09T01:01:00Z");
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(host.clock - 5_000),
    line: (symbol) => {
      const minute = Math.floor(host.clock / 60_000) * 60_000;
      return tickAt(symbol, minute, Array.from({ length: (minute - first) / 60_000 + 1 }, (_, i) => (i < 10 ? 2200 + i : null)));
    },
  });
  await walk(host, TW_NOW, TW_NOW + 6 * 60_000, (w, now) => {
    const frozen = now > TW_NOW + 240_000;
    assert.equal(w.lines.yahootw?.["2330.TW"] === undefined, frozen, iso(now));
    assert.equal(w.shown("2330.TW", now).chartSource, frozen ? "yahoo" : "yahootw", iso(now));
  });
});

test("a frozen stock line stays off when its price drops and comes back every few minutes", async () => {
  // 2330 trades 5 s before each round, its line stopped at 09:10; every `every` ms one round fails, dropping the price.
  const first = Date.parse("2026-11-09T01:01:00Z");
  for (const every of [180_000, 300_000]) {
    const from = Date.parse("2026-11-09T01:30:00Z");
    const host = taiwanHost(ONLY_YAHOOTW, {
      yahootw: () => {
        if (host.clock > from && (host.clock - from) % every < 10_000) throw new Error("offline");
        return stockList(host.clock - 5_000);
      },
      line: (symbol) => {
        const minute = Math.floor(host.clock / 60_000) * 60_000;
        return tickAt(symbol, minute, Array.from({ length: (minute - first) / 60_000 + 1 }, (_, i) => (i < 10 ? 2200 + i : null)));
      },
    });
    let drawn = 0;
    await walk(host, from, from + 40 * 60_000, (w, now) => {
      if (!w.lines.yahootw?.["2330.TW"]) return;
      drawn += 10_000;
      assert.ok(now <= from + 245_000, `${every}: ${iso(now)}`);
    });
    assert.ok(drawn > 0, String(every));
  }
});

// Yahoo 奇摩股市's 2330 line recorded at 08:53 in Taipei on 2026-11-11, before the open, trimmed to the fields Wickline
// reads: every minute of the day listed in advance (09:00 to 13:28, closes all null), and currentTradingPeriod's
// regular session 09:00 to 13:30.
const STOCK_DAY = jsonFixture("yahootw-tick-2330-0853")[0];
const STOCK_PERIODS = STOCK_DAY.chart.meta.currentTradingPeriod;
const on1111 = (time) => Date.parse(`2026-11-11T${time}Z`);
// That answer later in the day: a close on each listed minute up to `closesTo` (ms); its minutes listed on to
// `listedTo` when given (13:30, the closing match's minute); without its meta's periods when `periods` is false.
function stockDay({ closesTo, listedTo = null, periods = true }) {
  const stamps = STOCK_DAY.chart.timestamp.slice();
  while (listedTo !== null && stamps[stamps.length - 1] * 1000 < listedTo) stamps.push(stamps[stamps.length - 1] + 60);
  return ok([{ ...STOCK_DAY, chart: { meta: { symbol: "2330.TW", ...(periods && { currentTradingPeriod: STOCK_PERIODS }) },
    timestamp: stamps, indicators: { quote: [{ close: stamps.map((seconds) => (seconds * 1000 <= closesTo ? 2200 : null)) }] } } }]);
}
// Yahoo Finance's 2330 that day: its 13:30 close and the same regular session.
const yahoo1111 = (symbol) => twYahoo(symbol, { regularMarketTime: on1111("05:30:00") / 1000, currentTradingPeriod: STOCK_PERIODS });

test("after its 14:30 fixed-price trade, a Taiwan stock's line that ends with the regular session is kept all evening", async () => {
  // Yahoo 奇摩股市 gives 2330's trade time as 14:30:00 after the close; no line minute can hold it.
  for (const listedTo of [null, on1111("05:30:00")]) { // listed to 13:28 as recorded, or on to 13:30
    for (const from of [on1111("06:35:00"), on1111("12:00:00")]) { // first asked at 14:35, or at 20:00
      const host = taiwanHost(ONLY_YAHOOTW, {
        yahootw: () => stockList(on1111("06:30:00")), yahoo: yahoo1111, line: () => stockDay({ closesTo: on1111("05:30:00"), listedTo }),
      });
      await walk(host, from, from + 30 * 60_000, (w, now) => assert.ok(w.lines.yahootw?.["2330.TW"], `${listedTo} ${iso(now)}`));
    }
  }
});

test("without periods in its answer, a stock's line is capped by its Yahoo Finance session", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(on1111("06:30:00")), yahoo: yahoo1111,
    line: () => stockDay({ closesTo: on1111("05:30:00"), listedTo: on1111("05:30:00"), periods: false }),
  });
  const from = on1111("06:40:00"); // 14:40
  await walk(host, from, from + 30 * 60_000, (w, now) => assert.ok(w.lines.yahootw?.["2330.TW"], iso(now)));
});

test("a Taiwan stock's line first asked after the close is kept when it ends at its last trade", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(on1111("05:30:00")), yahoo: yahoo1111,
    line: () => stockDay({ closesTo: on1111("05:30:00"), listedTo: on1111("05:30:00") }),
  });
  const from = on1111("05:40:00"); // 13:40
  await walk(host, from, from + 20 * 60_000, (w, now) => {
    assert.equal(w.sessionFor(["2330.TW"], now), "closed", iso(now));
    assert.ok(w.lines.yahootw?.["2330.TW"], iso(now));
  });
});

test("a Taiwan stock's answer listing the whole day, its closes stopped at 10:00 while it trades on, is dropped", async () => {
  const freeze = on1111("02:00:00");
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => stockList(host.clock - 5_000), yahoo: yahoo1111, line: () => stockDay({ closesTo: Math.min(host.clock, freeze) }),
  });
  const { dropped, back } = await dropAfter(host, on1111("01:50:00"), on1111("03:00:00"), "2330.TW", freeze);
  assert.ok(dropped !== null && dropped <= FROZEN_WITHIN_MS, String(dropped));
  assert.equal(back, false);
});

test("a TW-only index's line without periods is capped by the periods an earlier answer gave", async () => {
  // ^TWOII, priced by Yahoo 奇摩股市 alone, with a trade time after its 13:30 regular end (as a stock's 14:30 one). Its
  // first answer, at 14:40, gives the periods but no point of today; the next, 10 min later, points but no periods.
  const day = (time) => Date.parse(`2026-11-09T${time}Z`);
  const periods = { regular: { start: day("01:00:00") / 1000, end: day("05:30:00") / 1000 } };
  const closes = Array.from({ length: 271 }, (_, i) => 320 + i / 100);
  let asked = 0;
  const host = twOnlyHost(["^TWOII"], {
    yahootw: () => stockList(day("06:30:00")),
    line: (symbol) => (asked++ === 0 ? tickAt(symbol, day("05:30:00") - 86_400_000, [320], periods) : tickAt(symbol, day("05:30:00"), closes)),
  });
  const from = day("06:40:00");
  await walk(host, from, from + 30 * 60_000, (w, now) => {
    if (now > from + 10 * 60_000 + 5_000) assert.ok(w.lines.yahootw?.["^TWOII"], iso(now));
  });
  assert.equal(asked, 2);
});

test("a quiet stock's line is never dropped, at any arrival phase", async () => {
  // 0050 trades at 09:17:12, 09:41:10 and 09:52:03; its answer lists every minute to now, each traded minute's
  // close in it once that minute has ended. 2330 trades on beside it.
  const first = Date.parse("2026-11-09T01:01:00Z");
  const trades = ["01:17:12", "01:41:10", "01:52:03"].map((time) => Date.parse(`2026-11-09T${time}Z`));
  const minuteOf = (time) => Math.ceil(time / 60_000) * 60_000;
  const grid = (symbol, traded, close) => {
    const minute = Math.floor(host.clock / 60_000) * 60_000;
    return tickAt(symbol, minute, Array.from({ length: (minute - first) / 60_000 + 1 }, (_, i) => (traded(first + i * 60_000) ? close : null)));
  };
  let host;
  for (let phase = 0; phase < 120_000; phase += 15_000) {
    host = taiwanHost(ONLY_YAHOOTW, {
      yahootw: () => stockList(host.clock - 5_000, { "0050.TW": {
        regularMarketTime: new Date(Math.max(...trades.filter((time) => time <= host.clock))).toISOString() } }),
      line: (symbol) => symbol === "0050.TW"
        ? grid(symbol, (minute) => minute <= host.clock && trades.some((time) => minuteOf(time) === minute), 10.05)
        : grid(symbol, (minute) => minute <= host.clock, 2200),
    });
    host.store.symbols = ["2330.TW", "0050.TW"];
    const from = Date.parse("2026-11-09T01:30:00Z") + phase;
    await walk(host, from, Date.parse("2026-11-09T02:05:00Z"), (w, now) => assert.ok(w.lines.yahootw?.["0050.TW"], `${phase} ${iso(now)}`));
  }
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
// render calls sync(), as in main.js. With `redraws`, each redraw's clock is pushed to it first.
async function soleRun(host, check, from = TW_NOW, redraws = null) {
  host.clock = from;
  const w = new Watchlist(host);
  host.changed = () => { redraws?.push(host.clock); w.sync(); };
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
        `${tx("session.closed")} · ${[formatStaleDate(CLOSE_0509, now, "en", dayFor(quote)), formatTime(CLOSE_0509)].filter(Boolean).join(" ")}`);
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
  const from = at("2026-11-09T01:05:00Z");
  await soleRun(twOnlyHost(["^TWOII"], { yahootw: () => stockList(from - 5_000, yesterday) }), (w) => {
    assert.equal(w.shown("^TWOII").timestamp, Date.parse("2026-11-08T05:31:00Z"));
    assert.deepEqual(w.problems().map(({ provider, code }) => [provider, code]), [["yahootw", "yahootw.noLiveRows"]]);
  }, from);
});

test("from 09:10 the same answer reads 今日無成交 and only the no-trades note shows", async () => {
  const yesterday = { "^TWOII": { regularMarketTime: "2026-11-08T05:31:00Z" } };
  const from = at("2026-11-09T01:09:55Z");
  const host = twOnlyHost(["^TWOII"], { yahootw: () => stockList(from - 5_000, yesterday) });
  await soleRun(host, async (w) => {
    await advance(host, from + 20_000);
    assert.deepEqual(w.standIn("^TWOII", host.clock).closure, { kind: "noTrades", source: "yahootw" });
    assert.deepEqual(w.problems(), []);
    assert.deepEqual(w.notes(), [{ code: "closure.noTradesToday", params: { source: "yahootw" } }]);
  }, from);
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
    // The TWSE hours read 09:00:30 as open.
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "live");
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

// A row with a price but no trade time is refused too: the kept price reads cached, with why.
test("after a price, a row with a price but no trade time keeps a future's price cached as not real time", async () => {
  let noTime = false;
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 5_000, noTime ? { "WTX&": { regularMarketTime: "-" } } : {}),
  });
  await soleRun(host, async (w) => {
    assert.equal(w.shown("WTX&").cached, undefined);
    noTime = true;
    await advance(host, FUT_NOW + 75_000);
    const kept = w.shown("WTX&");
    assert.deepEqual([kept.price, kept.cached], [42604, true]);
    assert.equal(w.errors["WTX&"].code, "yahootw.noLiveRows");
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

// A code Yahoo 奇摩股市 has said it does not know has no session to keep up with: it must not hold the whole Taiwan batch
// at the 10 s cadence every session. The opening wake still asks it once at each opening.
test("a futures code not found on Yahoo 奇摩股市 leaves the batch at the closed cadence in a session", async () => {
  const from = at("2026-11-10T14:00:00Z"); // 22:00, the night session
  const close = at("2026-11-10T05:30:00Z");
  const open = { regular: { start: at("2026-11-10T01:00:00Z") / 1000, end: close / 1000 } };
  const host = futuresHost(["2330.TW", "WTXP&"], {
    yahootw: () => ok([{ ...TW_ROWS[0], exchange: "TAI", regularMarketTime: new Date(close).toISOString() }]),
    yahoo: (symbol) => twYahoo(symbol, { exchangeName: "TAI", currentTradingPeriod: open }),
  });
  await soleRun(host, async (w) => {
    assert.equal(w.errors["WTXP&"].code, "yahootw.notFound");
    const asked = stockLists(host).length;
    await advance(host, from + 125_000);
    assert.equal(stockLists(host).length - asked, 2);
  }, from);
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

// A line is judged frozen only against a trade seen at an earlier line arrival whose minute has ended and whose lag has
// passed (a minute shows in the line once it ends), so it takes up to the third arrival, two line intervals, to drop one.
const iso = (time) => new Date(time).toISOString();
// Every source from `from`, then `check(w, now)` every 10 s up to `until`. Lines arrive at `from` and every 2 min.
async function walk(host, from, until, check) {
  host.clock = from;
  const w = new Watchlist(host);
  host.changed = () => w.sync();
  const runs = start(w, host);
  for (let now = from + 5_000; now <= until; now += 10_000) {
    await advance(host, now);
    await check(w, now);
  }
  await stop(w, host, runs);
}
const NIGHT_CHART = FUTURES_NIGHT_TICK[0].chart;
// The recorded night line (every minute of the trading day listed), with a close only on the minutes `traded` picks
// (by their time in ms).
const nightLine = (traded) => ok([{ ...FUTURES_NIGHT_TICK[0], chart: { ...NIGHT_CHART, indicators: { quote: [{
  close: NIGHT_CHART.timestamp.map((seconds) => (traded(seconds * 1000) ? 42255 : null)) }] } } }]);

test("a future's night line that stopped while the price trades on is dropped once a settled trade shows it", async () => {
  // Half an hour after the recorded line's last close (22:20), the price traded 10 s before each round.
  const from = at("2026-11-10T14:50:30Z");
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(host.clock - 10_000), line: () => ok(FUTURES_NIGHT_TICK) });
  await walk(host, from, from + 7 * 60_000, (w, now) => {
    // Arrivals at 22:50:30 and 22:52:30 have no settled trade; 22:50:20's settles at 22:53:20, so 22:54:30's drops it.
    const frozen = now > from + 240_000;
    const quote = w.shown("WTX&", now);
    assert.equal(quote.source, "yahootw", iso(now));
    assert.equal(w.lines.yahootw?.["WTX&"] === undefined, frozen, iso(now));
    assert.equal(quote.chartSource === "yahootw", !frozen, iso(now));
  });
});

test("a busy future's line that keeps up is kept at every arrival", async () => {
  const from = at("2026-11-10T14:50:30Z");
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(host.clock - 10_000), line: () => nightLine((time) => time <= host.clock),
  });
  await walk(host, from, from + 9 * 60_000, (w, now) => assert.ok(w.lines.yahootw?.["WTX&"], iso(now)));
});

test("a thin future keeps its line after a fresh trade its line cannot hold yet, and at every later arrival", async () => {
  // Trades at 21:40:20, 21:59:30 and 22:09:09: minutes 21:41, 22:00 and 22:10, each in the line once it has ended. The
  // line arriving at 22:09:15 lacks 22:09:09's minute, and the one before had 21:59:30 as its newest trade.
  const trades = [at("2026-11-10T13:40:20Z"), at("2026-11-10T13:59:30Z"), at("2026-11-10T14:09:09Z")];
  const minuteOf = (time) => Math.ceil(time / 60_000) * 60_000;
  let host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(Math.max(...trades.filter((time) => time <= host.clock))),
    line: () => nightLine((time) => time <= host.clock && trades.some((trade) => minuteOf(trade) === time)),
  });
  const from = at("2026-11-10T14:01:15Z");
  await walk(host, from, from + 16 * 60_000, (w, now) => {
    assert.ok(w.lines.yahootw?.["WTX&"], iso(now));
    assert.equal(w.shown("WTX&", now).chartSource, "yahootw", iso(now));
  });
  // And at other arrival phases, over an hour with more isolated trades.
  trades.push(at("2026-11-10T14:30:40Z"), at("2026-11-10T14:31:20Z"), at("2026-11-10T14:47:55Z"));
  for (let phase = 0; phase < 120_000; phase += 15_000) {
    host = futuresHost(["WTX&"], {
      yahootw: () => futuresAt(Math.max(...trades.filter((time) => time <= host.clock))),
      line: () => nightLine((time) => time <= host.clock && trades.some((trade) => minuteOf(trade) === time)),
    });
    const start = at("2026-11-10T13:58:00Z") + phase;
    await walk(host, start, at("2026-11-10T14:58:00Z"), (w, now) => assert.ok(w.lines.yahootw?.["WTX&"], `${phase} ${iso(now)}`));
  }
});

// The time from `freeze`, when a line stops, to its first arrival judged frozen (null if never), and whether it came
// back after that.
async function dropAfter(host, from, until, symbol, freeze) {
  let dropped = null;
  let back = false;
  await walk(host, from, until, (w, now) => {
    const kept = Boolean(w.lines.yahootw?.[symbol]);
    if (!kept && now > freeze && dropped === null) dropped = now - freeze;
    else if (kept && dropped !== null) back = true;
  });
  return { dropped, back };
}
// The worst time from a line stopping to its drop, over every arrival phase, while open with lines 2 min apart
// (measured 485-595 s).
const FROZEN_WITHIN_MS = 600_000;

test("a busy future's line that stops mid-session is dropped within the bound, and stays dropped", async () => {
  const from = at("2026-11-10T14:00:00Z");
  for (let offset = 0; offset < 240_000; offset += 30_000) {
    const freeze = at("2026-11-10T14:10:00Z") + offset;
    const host = futuresHost(["WTX&"], {
      yahootw: () => futuresAt(host.clock - 10_000),
      line: () => nightLine((time) => time <= host.clock && time <= Math.ceil(freeze / 60_000) * 60_000),
    });
    const { dropped, back } = await dropAfter(host, from, from + 30 * 60_000, "WTX&", freeze);
    assert.ok(dropped !== null && dropped <= FROZEN_WITHIN_MS, `${iso(freeze)}: ${dropped}`);
    assert.equal(back, false, iso(freeze));
  }
});

test("a future first lined while closed is judged at once, and its frozen line stays off", async () => {
  // 05:30 in Taipei, after the night's last trade at 04:59:58; the line's closes stop at 01:00.
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(at("2026-11-10T20:59:58Z")), line: () => nightLine((time) => time <= at("2026-11-10T17:00:00Z")),
  });
  const from = at("2026-11-10T21:30:00Z");
  await walk(host, from, from + 30 * 60_000, (w, now) => {
    assert.equal(w.sessionFor(["WTX&"], now), "closed", iso(now));
    assert.equal(w.lines.yahootw?.["WTX&"], undefined, iso(now));
  });
});

test("a future's line that agrees with a last trade already settled at its first arrival is kept", async () => {
  // The recorded night line (last close 22:20) read half an hour after a 22:20:20 last trade.
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(at("2026-11-10T14:20:20Z")), line: () => ok(FUTURES_NIGHT_TICK) });
  const from = at("2026-11-10T14:50:30Z");
  await walk(host, from, from + 10 * 60_000, (w, now) => assert.ok(w.lines.yahootw?.["WTX&"], iso(now)));
});

test("removed and added again, a future's line is judged only by its new trades", async () => {
  // Priced 10 s before each round, its line stopped at 22:20: dropped. Removed, then added again with a price that
  // last traded at 22:20:20, its line agreeing: kept.
  const from = at("2026-11-10T14:50:30Z");
  let lastTrade = null;
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(lastTrade ?? host.clock - 10_000), line: () => ok(FUTURES_NIGHT_TICK),
  });
  await walk(host, from, from + 12 * 60_000, (w, now) => {
    if (now === from + 6 * 60_000 + 5_000) {
      assert.equal(w.lines.yahootw?.["WTX&"], undefined);
      w.remove("WTX&");
      lastTrade = at("2026-11-10T14:20:20Z");
      w.add("WTX&");
    } else if (now > from + 8 * 60_000) {
      // From its next line, 2 min after the last one asked.
      assert.ok(w.lines.yahootw?.["WTX&"], iso(now));
    }
  });
});

test("a futures day-session answer cached at 11:00, listing minutes only to then, is dropped by its third arrival", async () => {
  // The 13:36 recording lists minutes only to its own time; cut at 11:00, it is an answer cached then. Its regular
  // period still ends at 13:45, so nothing caps the trades it is judged by.
  const chart = FUTURES_TICK[0].chart;
  const cut = chart.timestamp.findIndex((seconds) => seconds * 1000 > at("2026-11-10T03:00:00Z"));
  const cached = ok([{ ...FUTURES_TICK[0], chart: { ...chart, timestamp: chart.timestamp.slice(0, cut),
    indicators: { quote: [{ close: chart.indicators.quote[0].close.slice(0, cut) }] } } }]);
  const from = at("2026-11-10T03:30:00Z"); // 11:30
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(host.clock - 10_000), line: () => cached });
  await walk(host, from, from + 10 * 60_000, (w, now) => {
    assert.equal(w.sessionFor(["WTX&"], now), "open", iso(now));
    assert.equal(w.lines.yahootw?.["WTX&"] === undefined, now > from + 240_000, iso(now));
  });
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
      `${tx("session.closed")} · ${[formatStaleDate(close, later, "zh-TW", dayFor(quote)), formatTime(close)].filter(Boolean).join(" ")}`);
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
    const date = formatStaleDate(last, now, "zh-TW", dayFor(quote));
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

// With no night trade after a traded day (TAIFEX holding no night session, or a feed that stopped at the day close), the
// day close is not the night's: from 15:00 the row reads stalled, asked every 10 s as in any open session, until the
// night's deadline; then closed, with the night's no-trades note.
test("TAIFEX holds no night session: 已收盤 · 13:45 from 15:10, polled every 60 s, 日盤 08:45–13:45 · 夜盤尚無成交, with its note", async () => {
  const from = at("2026-11-10T06:59:50Z");          // 14:59:50
  const last = at("2026-11-10T05:45:00Z");          // 13:45
  const host = futuresHost(["WTX&"], {
    yahootw: () => futuresAt(last), line: (symbol) => futuresLine(symbol, MON_1500, at("2026-11-10T05:44:00Z"), SEGMENTS),
  });
  await soleRun(host, async (w) => {
    const open = at("2026-11-10T07:00:00Z");        // 15:00
    await advance(host, open);
    const asked = stockLists(host).length;
    const before = at("2026-11-10T07:09:59Z");      // 15:09:59
    await advance(host, before);
    assert.ok(stockLists(host).length - asked >= 5, String(stockLists(host).length - asked));
    let quote = w.shown("WTX&", before);
    assert.equal(freshness(quote, sessionOf(quote, before), before).state, "stalled");
    const after = at("2026-11-10T07:10:01Z");       // 15:10:01
    await advance(host, after);
    assert.deepEqual(w.standIn("WTX&", after).closure, { kind: "nightNoTrades", source: "yahootw" });
    quote = w.shown("WTX&", after);
    const session = sessionOf(quote, after);
    assert.equal(freshness(quote, session, after).state, "closed");
    assert.equal(withTZ("Asia/Taipei", () => freshnessLabel(quote, freshness(quote, session, after), after, "zh-TW", (k, p) => t("zh-TW", k, p))),
      "已收盤 · 13:45");
    assert.equal(t("zh-TW", `session.${sessionName(quote, session, after)}`), t("zh-TW", "session.closed"));
    assert.deepEqual(withTZ("Asia/Taipei", () => sessionTimesParts(sessionTimes(quote, after), "zh-TW", (k, p) => t("zh-TW", k, p))),
      ["交易時段：日盤 08:45–13:45", "夜盤尚無成交"]);
    assert.deepEqual(w.notes(), [{ code: "closure.noTradesNight", params: { source: "yahootw" } }]);
    await advance(host, at("2026-11-10T07:10:05Z"));
    const settled = stockLists(host).length;
    await advance(host, at("2026-11-10T07:11:05Z"));
    assert.equal(stockLists(host).length - settled, 1);
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

// Listed Taiwan closures (TWSE's holiday schedule). Closed-day answers stand in for probes still owed: a Yahoo 奇摩股市
// or MIS answer on a closed day is the recorded rows with an earlier day's trade time. Yahoo Finance's periods on a
// listed holiday are not known yet: the tests give it the day before's, which the listed closure overrides either way.
const twDay = (date) => ({ regular: { start: at(`${date}T01:00:00Z`) / 1000, end: at(`${date}T05:30:00Z`) / 1000 } });
// Yahoo Finance's 2330.TW still at `time` (ms) with `date`'s periods.
const twYahooAt = (symbol, time, date) => twYahoo(symbol, { exchangeName: "TAI", regularMarketTime: time / 1000, currentTradingPeriod: twDay(date) });
// 12/24's futures trading day (12/23 15:00 → 12/24 13:45), for a line that answers.
const DEC23_1500 = at("2026-12-23T07:00:00Z");
const DEC24_SEGMENTS = [[DEC23_1500, at("2026-12-23T21:00:00Z")], [at("2026-12-24T00:45:00Z"), at("2026-12-24T05:45:00Z")]];

test("12/25: 2330.TW reads 休市 · 12/24 13:30, polled every 60 s, 休市 in the header and the reason", async () => {
  const from = at("2026-12-25T02:00:00Z"); // 10:00
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1224), yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-24") });
  await soleRun(host, async (w) => {
    const now = host.clock;
    const quote = w.shown("2330.TW", now);
    assert.deepEqual(quote.closure, { kind: "listed", reason: "行憲紀念日" });
    const fresh = freshness(quote, sessionOf(quote, now), now);
    assert.equal(fresh.state, "holiday");
    withTZ("Asia/Taipei", () => assert.equal(freshnessLabel(quote, fresh, now, "zh-TW", (k, p) => t("zh-TW", k, p)), "休市 · 12/24 13:30"));
    assert.equal(t("zh-TW", `session.${sessionName(quote, "holiday", now)}`), "休市");
    assert.deepEqual(w.problems(), []);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 15_000);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 61_000);
    assert.equal(stockLists(host).length, 2);
  }, from);
});

test("the night before a holiday, held: WTX& Live at 01:00, 休市 · 04:59 from 05:00", async () => {
  const from = at("2026-12-24T17:00:00Z");       // 12/25 01:00
  const last = at("2026-12-24T20:59:00Z");       // 04:59
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(Math.min(host.clock - 20_000, last)) });
  await soleRun(host, async (w) => {
    const quote = w.shown("WTX&", host.clock);
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "live");
    assert.equal(t("zh-TW", `session.${sessionName(quote, "open", host.clock)}`), "夜盤交易中");
    for (let step = from; step <= at("2026-12-24T21:00:05Z"); step += 1_800_000) await advance(host, step);
    await advance(host, at("2026-12-24T21:00:05Z"));
    const now = host.clock;
    const closed = w.shown("WTX&", now);
    assert.deepEqual(closed.closure, { kind: "listed", reason: "行憲紀念日" });
    withTZ("Asia/Taipei", () => assert.equal(freshnessLabel(closed, freshness(closed, "holiday", now), now, "zh-TW", (k, p) => t("zh-TW", k, p)), "休市 · 04:59"));
  }, from);
});

test("after a listed Friday, the night it removed reads closed until Saturday 05:00, polled gently", async () => {
  const from = at("2026-12-25T18:00:00Z"); // Saturday 12/26 02:00
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(at("2026-12-24T20:59:00Z")) });
  await soleRun(host, async (w) => {
    const quote = w.shown("WTX&", host.clock);
    assert.deepEqual(quote.closure, { kind: "nightRemoved" });
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "closed");
    await advance(host, from + 15_000);
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 61_000);
    assert.equal(stockLists(host).length, 2);
  }, from);
});

// The line answers, on the quote's own trading day: with futuresHost's default `line: offline`, problems() would hold
// yahootw.unreachable whatever the closure.
test("a future on a holiday after a night with no trade reads 休市 · 12/24 13:45, and its night never opens", async () => {
  for (const from of [at("2026-12-25T01:30:00Z"), at("2026-12-25T07:00:00Z")]) { // 09:30, 15:00
    const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(at("2026-12-24T05:45:00Z")),
      line: (symbol) => futuresLine(symbol, DEC23_1500, at("2026-12-24T05:44:00Z"), DEC24_SEGMENTS) });
    await soleRun(host, async (w) => {
      const now = host.clock;
      const quote = w.shown("WTX&", now);
      assert.equal(sessionOf(quote, now), "holiday");
      assert.deepEqual(w.problems(), []);   // a closed day stays quiet, futures too
      withTZ("Asia/Taipei", () => assert.equal(freshnessLabel(quote, freshness(quote, "holiday", now), now, "zh-TW", (k, p) => t("zh-TW", k, p)), "休市 · 12/24 13:45"));
      await advance(host, from + 15_000);
      assert.equal(stockLists(host).length, 1);
    }, from);
  }
});

test("on 12/25 no futures round starts for 08:45, and WTX& keeps 60 s", async () => {
  const from = at("2026-12-25T00:44:30Z"); // 08:44:30
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(at("2026-12-24T20:59:00Z")) });
  await soleRun(host, async () => {
    await advance(host, at("2026-12-25T00:45:05Z"));
    assert.equal(stockLists(host).length, 1);
    await advance(host, from + 61_000);
    assert.equal(stockLists(host).length, 2);
  }, from);
});

// A future with no price yet (a name-only answer) takes the closure for its cadence too.
test("a quote-less WTX& on 12/25 polls at 60 s", async () => {
  const from = at("2026-12-25T02:00:00Z"); // 10:00
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(host.clock - 5_000, { "WTX&": { price: { raw: "-" }, regularMarketTime: "-" } }) });
  await soleRun(host, async (w) => {
    assert.equal(w.shown("WTX&", host.clock), undefined);
    await advance(host, from + 59_000);
    assert.equal(stockLists(host).length, 1);   // every 10 s without the closure
  }, from);
});

test("a Monday holiday after a Friday night reads 休市 with Saturday's last trade", async () => {
  const from = at("2026-10-26T01:00:00Z"); // Mon 10/26 09:00
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(at("2026-10-23T20:59:00Z")) }); // Sat 04:59
  await soleRun(host, (w) => {
    const now = host.clock;
    const quote = w.shown("WTX&", now);
    assert.equal(freshness(quote, sessionOf(quote, now), now).state, "holiday");
    withTZ("Asia/Taipei", () => assert.equal(freshnessLabel(quote, freshness(quote, "holiday", now), now, "zh-TW", (k, p) => t("zh-TW", k, p)), "休市 · 10/24 04:59"));
  }, from);
});

test("Saturday 11/14 and the listed Saturday 10/10 read 已收盤", async () => {
  for (const [from, last, date] of [[at("2026-11-14T02:00:00Z"), at("2026-11-13T05:30:00Z"), "2026-11-13"],
    [at("2026-10-10T02:00:00Z"), at("2026-10-08T05:30:00Z"), "2026-10-08"]]) {
    const host = taiwanHost(undefined, { yahoo: (s) => twYahooAt(s, last, date) });
    host.store = { version: 1, symbols: ["2330.TW", "WTX&"], paused: false };
    await soleRun(host, (w) => {
      const quote = w.shown("2330.TW", host.clock);
      assert.notEqual(quote.closure?.kind, "listed");
      assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "closed");
      if (date === "2026-11-13") withTZ("Asia/Taipei", () => assert.equal(freshnessLabel(quote, freshness(quote, "closed", host.clock), host.clock, "zh-TW", (k, p) => t("zh-TW", k, p)), "已收盤 · 11/13 13:30"));
      assert.deepEqual(w.standIn("WTX&", host.clock).closure, null);
    }, from);
  }
});

// Yahoo Finance gives 12/25's own hours, as it would on a day that trades: with 12/24's periods the row reads closed
// with or without the override, so the test could not pass.
test("a trade since 09:00 overrides the schedule for every stock row", async () => {
  const from = at("2026-12-25T02:00:00Z");
  const host = taiwanHost(BOTH, { mis: () => misAt(host.clock - 5_000), yahootw: () => stockList(CLOSE_1224),
    yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-25") });
  host.store = { version: 1, symbols: ["2330.TW", "0050.TW"], paused: false };
  await soleRun(host, (w) => {
    const quote = w.shown("2330.TW", host.clock);
    assert.equal(quote.source, "mis");
    assert.notEqual(quote.closure?.kind, "listed");
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "live");
    // MIS prices only 2330 here; 0050.TW follows the same market-wide override.
    assert.notEqual(w.shown("0050.TW", host.clock).closure?.kind, "listed");
  }, from);
});

// Yahoo Finance is given 12/25's own hours, the case where it does not know the holiday (the 12/25 probe is owed).
// With 12/24's periods the row reads closed anyway and the test could not fail.
test("the status line stays quiet on a listed day, also when Yahoo Finance gives that day's hours", async () => {
  const from = at("2026-12-25T02:00:00Z");
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1224), yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-25") });
  await soleRun(host, async (w) => {
    await advance(host, from + 15_000);   // a round after the schedule is in
    assert.equal(sessionOf(w.shown("2330.TW", host.clock), host.clock), "holiday");
    assert.deepEqual(w.problems(), []);
  }, from);
});

test("a trade overrides the removed night: WTX& trading at Saturday 01:00 after a listed Friday reads Live", async () => {
  const from = at("2026-12-25T17:00:00Z"); // Sat 12/26 01:00
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(host.clock - 5_000) });
  await soleRun(host, (w) => {
    const quote = w.shown("WTX&", host.clock);
    assert.equal(quote.closure, null);
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "live");
  }, from);
});

test("on a London clock a listed day begins at Taipei midnight, within a second", async () => {
  await withTZ("Europe/London", async () => {
    const midnight = at("2026-12-24T16:00:00Z"); // 16:00 London, 00:00 Taipei 12/25
    const host = taiwanHost(undefined, { yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-24") });
    const redraws = [];
    await soleRun(host, async (w) => {
      await advance(host, midnight + 5_000);
      assert.ok(redraws.some((time) => time >= midnight && time <= midnight + 1_000), redraws.join());
      const quote = w.shown("2330.TW", midnight + 1);
      assert.deepEqual(quote.closure, { kind: "listed", reason: "行憲紀念日" });
      assert.equal(freshnessLabel(quote, freshness(quote, "holiday", midnight + 1), midnight + 1, "zh-TW", (k, p) => t("zh-TW", k, p)), "休市 · 12/24 05:30");
    }, midnight - 30_000, redraws);
  });
});

const schedules = (host) => host.requests.filter(isHolidays).length;

test("the schedule: never without a Taiwan symbol", async () => {
  const host = fakeHost(() => ok({}));
  host.store = { version: 1, symbols: ["AAPL", "NVDA", "^GSPC", "BTC/USDT"], paused: false };
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 600_000);
  assert.equal(schedules(host), 0);
  await stop(w, host, runs);
});

// Default settings: only Yahoo Finance prices 2330.TW, and the schedule is asked once that Taipei day.
test("the schedule: once per Taipei date on default settings, with nothing sent to MIS or Yahoo 奇摩股市", async () => {
  const from = at("2026-11-11T00:00:00Z"); // 08:00
  const host = taiwanHost(undefined);
  await soleRun(host, async () => {
    assert.equal(schedules(host), 1);
    assert.equal(host.headers[host.requests.findIndex(isHolidays)]["User-Agent"].startsWith("Wickline-Herdr/"), true);
    for (let step = from; step <= at("2026-11-11T15:59:00Z"); step += 3_600_000) await advance(host, step);
    await advance(host, at("2026-11-11T15:59:00Z"));
    assert.equal(schedules(host), 1);
    await advance(host, at("2026-11-11T16:01:00Z"));          // 00:01 the next Taipei day
    assert.equal(schedules(host), 2);
    assert.deepEqual(host.requests.filter((url) => url.startsWith(MIS_URL) || isYahootw(url)), []);
  }, from);
});

test("a hung schedule holds the first Taiwan round by the timeout at most, says nothing, and its retry holds nothing", async () => {
  const from = at("2026-11-11T00:00:00Z");
  const host = taiwanHost(undefined, { holidays: () => new Promise(() => {}) });
  const charts = [];
  const yahoo = host.yahoo;
  host.yahoo = (symbol) => { charts.push(host.clock); return yahoo(symbol); };
  await soleRun(host, async (w) => {
    await advance(host, from + 135_000);
    assert.ok(charts[0] <= from + 10_001, String(charts[0]));
    assert.ok(charts[2] - charts[1] <= 61_000, charts.join());
    assert.deepEqual(w.problems(), []);
    for (let step = from; step <= from + 3_599_000; step += 600_000) await advance(host, step);
    await advance(host, from + 3_599_000);
    assert.equal(schedules(host), 1);
    await advance(host, from + 3_620_000);
    assert.equal(schedules(host), 2);
    // The retry hangs too, but no round waits for it: the 09:00 round that starts it asks at once.
    assert.equal(charts.find((time) => time >= from + 3_600_000), from + 3_600_000, charts.join());
    await advance(host, from + 3_780_000);
    const later = charts.filter((time) => time >= from + 3_540_000);
    assert.ok(later.every((time, i) => i === 0 || time - later[i - 1] <= 61_000), later.join());
    assert.deepEqual(w.problems(), []);
  }, from);
});

test("a hidden copy asks for the schedule only once shown", async () => {
  const from = at("2026-11-10T15:59:00Z"); // 23:59
  let shown = false;
  const host = taiwanHost(undefined);
  host.shown = () => shown;
  await soleRun(host, async (w) => {
    for (let step = from; step <= at("2026-11-11T01:00:00Z"); step += 3_600_000) await advance(host, step);
    await advance(host, at("2026-11-11T01:00:00Z")); // 09:00
    assert.equal(host.requests.length, 0);
    shown = true;
    w.wakeMissed();
    await advance(host, at("2026-11-11T01:00:01Z"));
    assert.equal(schedules(host), 1);
  }, from);
});

// Taiwan days without trades that TWSE does not list (a typhoon): Wednesday 2026-11-11 stands in for one. The answers
// carry 11/10's close (stocks) or the night's 04:59 trade (futures).
const CLOSE_1110 = at("2026-11-10T05:30:00Z");   // 13:30 Taipei
const NIGHT_0459 = at("2026-11-10T20:59:00Z");   // 04:59 on 11/11
const quietLabel = (quote, now) => withTZ("Asia/Taipei", () =>
  freshnessLabel(quote, freshness(quote, sessionOf(quote, now), now), now, "zh-TW", (k, p) => t("zh-TW", k, p)));
const noTradesToday = (source) => [{ code: "closure.noTradesToday", params: { source } }];

test("a typhoon day with Yahoo 奇摩股市: the existing rules at 09:05, 今日無成交 · 11/10 13:30 from 09:10, polled every 60 s, with its note", async () => {
  const from = at("2026-11-11T01:04:30Z");     // 09:04:30
  const deadline = at("2026-11-11T01:10:00Z");
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1110), yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  await soleRun(host, async (w) => {
    assert.equal(freshness(w.shown("2330.TW", host.clock), sessionOf(w.shown("2330.TW", host.clock), host.clock), host.clock).state, "delayed");
    // The first yahootw round ends before Yahoo Finance's base arrives (PROVIDERS order), so noLiveRows shows only after
    // the second round, 09:04:40. The deadline wake is tested where no round lands (Yahoo Finance alone).
    await advance(host, from + 15_000);
    assert.equal(w.problems()[0]?.code, "yahootw.noLiveRows");
    assert.deepEqual(w.notes(), []);
    await advance(host, deadline + 15_000); // the round after 09:10 clears noLive
    const quote = w.shown("2330.TW", host.clock);
    assert.deepEqual(quote.closure, { kind: "noTrades", source: "yahootw" });
    assert.equal(quietLabel(quote, host.clock), "今日無成交 · 11/10 13:30");
    assert.deepEqual(w.problems(), []);
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    const asked = stockLists(host).length;
    await advance(host, deadline + 75_000);
    assert.equal(stockLists(host).length - asked, 1);
  }, from);
});

// The MIS half of the typhoon scenario: MIS is shown, stalled, at 09:04:30.
test("a typhoon day with MIS: stopped at 09:05, 今日無成交 from 09:10", async () => {
  const host = taiwanHost(BOTH, { mis: () => misAt(CLOSE_1110), yahootw: () => stockList(CLOSE_1110), yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  await soleRun(host, async (w) => {
    const quote = w.shown("2330.TW", host.clock);
    assert.equal(quote.source, "mis");
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "stalled");
    await advance(host, at("2026-11-11T01:10:05Z"));
    assert.equal(sessionOf(w.shown("2330.TW", host.clock), host.clock), "noTrades");
    // MIS is shown, but the fixed order names Yahoo 奇摩股市, round after round.
    for (const step of [at("2026-11-11T01:10:05Z"), at("2026-11-11T01:11:10Z"), at("2026-11-11T01:12:15Z")]) {
      await advance(host, step);
      assert.deepEqual(w.notes(), noTradesToday("yahootw"), String(step));
    }
  }, at("2026-11-11T01:04:30Z"));
});

// An inference deadline wakes the rows: Yahoo Finance's rounds land at hh:mm:30, so only the deadline wake can redraw
// in [09:30:00, 09:30:01].
test("a typhoon day with Yahoo Finance alone: delayed until 09:25, stopped from 09:25, 今日無成交 from 09:30", async () => {
  const from = at("2026-11-11T01:24:30Z");
  const deadline = at("2026-11-11T01:30:00Z");
  const host = taiwanHost(undefined, { yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  const redraws = [];
  await soleRun(host, async (w) => {
    const state = (now) => freshness(w.shown("2330.TW", now), sessionOf(w.shown("2330.TW", now), now), now).state;
    assert.equal(state(host.clock), "delayed");
    await advance(host, at("2026-11-11T01:25:31Z"));   // the first fetch after 09:25
    assert.equal(state(host.clock), "stalled");
    await advance(host, deadline + 1_000);
    assert.ok(redraws.some((time) => time >= deadline && time <= deadline + 1_000), redraws.join());
    assert.equal(state(host.clock), "noTrades");
    assert.deepEqual(w.notes(), noTradesToday("yahoo"));
  }, from, redraws);
});

// Night trades do not count for the day session. The line answers, on the quote's own trading day (11/10 15:00 →
// 11/11 13:45), so no line problem shows.
test("a stuck futures feed on a normal day reads stopped, then 今日無成交 · 11/11 04:59 with a note, never 休市", async () => {
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(NIGHT_0459),   // every answer: the night's 04:59 trade
    line: (symbol) => futuresLine(symbol, NEXT_SEGMENTS[0][0], NIGHT_0459, NEXT_SEGMENTS) });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T00:50:00Z"));                            // 08:50
    let quote = w.shown("WTX&", host.clock);
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "stalled");
    await advance(host, at("2026-11-11T00:55:01Z"));
    quote = w.shown("WTX&", host.clock);
    assert.deepEqual(quote.closure, { kind: "noTrades", source: "yahootw" });
    assert.equal(sessionOf(quote, host.clock), "noTrades");
    assert.equal(quietLabel(quote, host.clock), "今日無成交 · 11/11 04:59");
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    assert.deepEqual(w.problems(), []);
  }, at("2026-11-11T00:44:30Z"));
});

test("a normal open at 09:00:01 never reads 今日無成交", async () => {
  const first = at("2026-11-11T01:00:01Z");
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(host.clock < first ? CLOSE_1110 : Math.max(first, host.clock - 5_000)),
    yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  await soleRun(host, async (w) => {
    for (let step = at("2026-11-11T01:00:05Z"); step <= at("2026-11-11T01:15:00Z"); step += 10_000) {
      await advance(host, step);
      assert.deepEqual(w.standIn("2330.TW", step).closure, null, String(step));
    }
    const quote = w.shown("2330.TW", host.clock);
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "live");
  }, at("2026-11-11T00:59:30Z"));
});

test("a thin WTF&-only list reads 今日無成交 from 08:55, and Live from the answer carrying its 09:02 trade, the note gone", async () => {
  const trade = at("2026-11-11T01:02:00Z");
  const host = futuresHost(["WTF&"], { yahootw: () => futuresAt(host.clock >= trade ? trade : NIGHT_0459) });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T00:54:59Z"));
    assert.deepEqual(w.standIn("WTF&", host.clock).closure, null);
    await advance(host, at("2026-11-11T00:55:01Z"));
    assert.deepEqual(w.standIn("WTF&", host.clock).closure, { kind: "noTrades", source: "yahootw" });
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    const asked = stockLists(host).length;
    await advance(host, at("2026-11-11T00:56:05Z"));
    assert.equal(stockLists(host).length - asked, 1);                // 60 s
    await advance(host, at("2026-11-11T01:03:30Z"));
    const quote = w.shown("WTF&", host.clock);
    assert.equal(freshness(quote, sessionOf(quote, host.clock), host.clock).state, "live");
    assert.equal(t("zh-TW", `session.${sessionName(quote, "open", host.clock)}`), "日盤交易中");
    assert.deepEqual(w.notes(), []);
    const live = stockLists(host).length;
    await advance(host, host.clock + 21_000);
    assert.ok(stockLists(host).length - live >= 2);                  // 10 s again
  }, at("2026-11-11T00:44:30Z"));
});

// Never since the open, or once at the 08:45 opening and then down.
test("a source that times out from before the open, or after one answer at 08:45, never reads 今日無成交", async () => {
  for (const hang of [at("2026-11-11T00:40:05Z"), at("2026-11-11T00:45:05Z")]) {
    const host = futuresHost(["WTX&"], { yahootw: () => (host.clock < hang ? futuresAt(NIGHT_0459) : new Promise(() => {})) });
    await soleRun(host, async (w) => {
      for (let step = hang; step <= at("2026-11-11T01:30:00Z"); step += 600_000) await advance(host, step);
      assert.equal(w.errors["WTX&"].code, "request.timeout");
      assert.deepEqual(w.standIn("WTX&", host.clock).closure, null);
      assert.deepEqual(w.notes(), []);
      assert.equal(freshness(w.shown("WTX&", host.clock), "open", host.clock).state, "stalled");
    }, at("2026-11-11T00:40:00Z"));
  }
});

test("Saturdays are never inferred", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(at("2026-11-13T05:30:00Z")), yahoo: (s) => twYahooAt(s, at("2026-11-13T05:30:00Z"), "2026-11-13") });
  await soleRun(host, (w) => assert.deepEqual(w.standIn("2330.TW", host.clock).closure, null), at("2026-11-14T01:30:00Z"));
});

test("a copy shown after its deadline infers on its first answer", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1110), yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  await soleRun(host, (w) => assert.deepEqual(w.standIn("2330.TW", host.clock).closure, { kind: "noTrades", source: "yahootw" }), at("2026-11-11T02:30:00Z"));
});

test("the whole day without a session keeps 今日無成交 from 15:00 to 05:00, and from 15:10 for a copy shown at 15:05", async () => {
  const quiet = { kind: "noTrades", source: "yahootw" };
  const host = futuresHost(["WTX&"], { yahootw: () => futuresAt(NIGHT_0459) });   // nothing since 04:59
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T00:55:01Z"));
    assert.deepEqual(w.standIn("WTX&", host.clock).closure, quiet);
    for (let step = host.clock; step <= at("2026-11-11T07:00:30Z"); step += 1_800_000) await advance(host, step);
    await advance(host, at("2026-11-11T07:00:30Z"));
    assert.deepEqual(w.standIn("WTX&", host.clock).closure, quiet);        // carried from the day session (row 8b)
    await advance(host, at("2026-11-11T07:10:01Z"));
    assert.deepEqual(w.standIn("WTX&", host.clock).closure, quiet);        // the night's own answers (row 8)
    for (let step = host.clock; step <= at("2026-11-11T18:00:00Z"); step += 1_800_000) await advance(host, step);
    await advance(host, at("2026-11-11T18:00:00Z"));                       // Thu 11/12 02:00
    assert.deepEqual(w.standIn("WTX&", host.clock).closure, quiet);        // kept past midnight (row 4)
    assert.equal(quietLabel(w.shown("WTX&", host.clock), host.clock), "今日無成交 · 11/11 04:59");
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    await advance(host, at("2026-11-11T21:00:30Z"));                       // 05:00:30
    assert.deepEqual([w.standIn("WTX&", host.clock).closure, sessionOf(w.shown("WTX&", host.clock), host.clock), w.notes()], [null, "closed", []]);
  }, at("2026-11-11T00:44:30Z"));
  // No day observation: the answers' newest trade (04:59) says the day never traded.
  const late = futuresHost(["WTX&"], { yahootw: () => futuresAt(NIGHT_0459) });
  await soleRun(late, async (w) => {
    await advance(late, at("2026-11-11T07:10:01Z"));
    assert.deepEqual(w.standIn("WTX&", late.clock).closure, quiet);
  }, at("2026-11-11T07:05:00Z"));
});

// The real-time source answers once at 09:00, then times out.
test("with Yahoo 奇摩股市 down after one answer at 09:00, Yahoo Finance's answers wait until 09:30, and a normal morning never reads 今日無成交", async () => {
  const opened = at("2026-11-11T01:00:30Z");
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => (host.clock < at("2026-11-11T01:00:05Z") ? stockList(CLOSE_1110) : new Promise(() => {})),
    yahoo: (s) => twYahooAt(s, host.clock < at("2026-11-11T01:20:30Z") ? CLOSE_1110 : opened, "2026-11-11") }); // 20 min late
  await soleRun(host, async (w) => {
    for (const step of [at("2026-11-11T01:10:05Z"), at("2026-11-11T01:12:00Z"), at("2026-11-11T01:29:59Z"), at("2026-11-11T01:31:00Z")]) {
      await advance(host, step);
      assert.deepEqual(w.standIn("2330.TW", step).closure, null, String(step));
    }
  }, at("2026-11-11T01:00:00Z"));
});

test("delayed Yahoo 奇摩股市 rows are no answer for a closure", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1110, { "2330.TW": { exchangeDataDelayedBy: 1200 } }),
    yahoo: (s) => twYahooAt(s, host.clock < at("2026-11-11T01:20:30Z") ? CLOSE_1110 : at("2026-11-11T01:00:30Z"), "2026-11-11") });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T01:10:05Z"));
    assert.deepEqual(w.standIn("2330.TW", host.clock).closure, null);
  }, at("2026-11-11T01:00:00Z"));
});

// The veto: stock rows stuck at yesterday; WTX& trading since 08:45.
test("futures trades since 08:45 veto a stock inference", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => ok([...JSON.parse(stockList(CLOSE_1110).text), ...JSON.parse(futuresAt(host.clock - 5_000).text)]),
    yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  host.store = { version: 1, symbols: ["2330.TW", "WTX&"], paused: false };
  await soleRun(host, async (w) => {
    for (const step of [at("2026-11-11T01:10:05Z"), at("2026-11-11T01:31:00Z")]) {
      await advance(host, step);
      assert.deepEqual(w.standIn("2330.TW", step).closure, null, String(step));
    }
    assert.deepEqual(w.notes(), []);
  }, at("2026-11-11T01:04:30Z"));
});

// The schedule fails on a day that is in fact listed.
test("with the schedule unreachable on a listed day, the rows read 今日無成交 by inference, never 休市", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { holidays: () => new Promise(() => {}), yahootw: () => stockList(CLOSE_1224),
    yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-25") });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-12-25T01:10:15Z"));
    const quote = w.shown("2330.TW", host.clock);
    assert.deepEqual(quote.closure, { kind: "noTrades", source: "yahootw" });
    assert.deepEqual(w.problems(), []);
  }, at("2026-12-25T01:04:30Z"));
});

test("the no-trades note is one line per source and stays out of the settings' health; a listed day has none", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, {
    yahootw: () => ok([...JSON.parse(stockList(CLOSE_1110).text), ...JSON.parse(futuresAt(NIGHT_0459).text)]),
    yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  host.store = { version: 1, symbols: ["2330.TW", "WTX&"], paused: false };
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T01:10:15Z"));
    assert.deepEqual([w.standIn("2330.TW", host.clock).closure, w.standIn("WTX&", host.clock).closure], [{ kind: "noTrades", source: "yahootw" }, { kind: "noTrades", source: "yahootw" }]);
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    assert.deepEqual(w.problems(), []);
  }, at("2026-11-11T01:04:30Z"));
  const listed = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1224), yahoo: (s) => twYahooAt(s, CLOSE_1224, "2026-12-25") });
  await soleRun(listed, (w) => assert.deepEqual(w.notes(), []), at("2026-12-25T02:00:00Z"));
});

// An answer counts only while its source is on. Stocks fall back to Yahoo Finance's own deadline (it answers every
// 60 s, so its latest answer before 09:30 is under 2 min old); futures have no other source.
test("turning Yahoo 奇摩股市 off drops its no-trades note at once", async () => {
  const host = taiwanHost(ONLY_YAHOOTW, { yahootw: () => stockList(CLOSE_1110), yahoo: (s) => twYahooAt(s, CLOSE_1110, "2026-11-11") });
  await soleRun(host, async (w) => {
    await advance(host, at("2026-11-11T01:10:15Z"));
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.deepEqual([w.standIn("2330.TW", host.clock).closure, w.notes()], [null, []]);
    await advance(host, at("2026-11-11T01:30:01Z"));
    assert.deepEqual(w.notes(), noTradesToday("yahoo"));
  }, at("2026-11-11T01:04:30Z"));
  const futures = futuresHost(["WTX&"], { yahootw: () => futuresAt(NIGHT_0459) });
  await soleRun(futures, async (w) => {
    await advance(futures, at("2026-11-11T00:55:01Z"));
    assert.deepEqual(w.notes(), noTradesToday("yahootw"));
    futures.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.deepEqual(w.notes(), []);
    assert.equal(w.errors["WTX&"].code, "yahootw.futuresNeedSource");
  }, at("2026-11-11T00:44:30Z"));
});
