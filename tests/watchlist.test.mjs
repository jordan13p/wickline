// node --test tests/  (watchlist.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_SYMBOLS, USER_AGENT } from "../mods/wickline/quotes.js";
import { yahooUrl } from "../mods/wickline/providers/yahoo.js";
import { binanceKlinesUrl, binanceUrl } from "../mods/wickline/providers/binance.js";
import { Watchlist, WATCHLIST_KEY, pickOverlay, readPreferences } from "../mods/wickline/watchlist.js";
import { t } from "../mods/wickline/i18n.js";
import { freshness, sessionOf } from "../mods/wickline/freshness.js";
import { formatStaleDate, formatTime, freshnessLabel } from "../mods/wickline/format.js";
import {
  CLOSE_0509, EARLIER_ROWS, EARLIER_TICK, NIGHT, advance, chart, chartSymbol, fakeHost, isLine, jsonFixture, lineSymbol, ok, start, stop,
} from "./helpers.mjs";
import { MIS_CONSENT_VERSION, MIS_URL } from "../mods/wickline/providers/mis.js";
import { YAHOOTW_BASE, YAHOOTW_CONSENT_VERSION, taipeiDay } from "../mods/wickline/providers/yahootw.js";

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

// Taiwan's two real-time sources over Yahoo Finance, on a clock set to a trading morning in Taipei.
const TW_NOW = 1794188480000;
const TW_ROWS = jsonFixture("yahootw-stocklist");
const MIS_ROW = jsonFixture("mis-open").msgArray[0];
const BOTH = { version: 1, sources: { tw: {
  yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION }, mis: true, misAck: { version: MIS_CONSENT_VERSION },
} } };
const ONLY_YAHOOTW = { version: 1, sources: { tw: { yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION } } } };
// The recorded Yahoo 奇摩股市 rows, each one that has a trade traded at `time`, with some rows' fields replaced.
const stockList = (time, bySymbol = {}) => ok(TW_ROWS.map((row) => ({
  ...row, ...(row.regularMarketTime !== "-" && { regularMarketTime: new Date(time).toISOString() }), ...bySymbol[row.symbol],
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
    assert.deepEqual([quote.source, quote.chartSource, quote.chartDelaySeconds], ["yahootw", "yahootw", 0]);
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
async function twOnlyRun(host, check, from = TW_NOW) {
  host.clock = from;
  const w = new Watchlist(host);
  host.changed = () => w.sync();
  const runs = start(w, host);
  await advance(host, from + 5_000);
  await check(w, host);
  await stop(w, host, runs);
}

test("^TWOII, unknown to Yahoo Finance, is priced by Yahoo 奇摩股市 alone", async () => {
  await twOnlyRun(twOnlyHost(), (w, host) => {
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
    await twOnlyRun(host, async (w) => {
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
  await twOnlyRun(twOnlyHost(["^TWZZ"]), async (w, host) => {
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
  await twOnlyRun(twOnlyHost(["^TWOII"], { yahootw: () => limited }), (w) => {
    assert.equal(w.errors["^TWOII"].code, "yahootw.rateLimited");
  });
  // A rate-limited line drops the price it was asked beside: the row says why.
  await twOnlyRun(twOnlyHost(["^TWOII"], { line: () => limited }), (w) => {
    assert.equal(w.shown("^TWOII"), undefined);
    assert.equal(w.errors["^TWOII"].code, "request.deferred");
  });
});

// During the session, a TW-only row still from the day before is no real-time price.
test("a lone earlier-day row does not hide that nothing is real time", async () => {
  const yesterday = { "^TWOII": { regularMarketTime: "2026-11-08T05:31:00Z" } };
  await twOnlyRun(twOnlyHost(["^TWOII"], { yahootw: () => stockList(TW_NOW - 5_000, yesterday) }), (w) => {
    assert.equal(w.shown("^TWOII").timestamp, Date.parse("2026-11-08T05:31:00Z"));
    assert.deepEqual(w.problems().map(({ provider, code }) => [provider, code]), [["yahootw", "yahootw.noLiveRows"]]);
  });
});

test("the move to TW-only does not restart Yahoo's round", async () => {
  await twOnlyRun(twOnlyHost(["2330.TW", "^TWOII"]), (w, host) => {
    assert.equal(w.shown("^TWOII").source, "yahootw");
    // The renders' sync() found nothing changed: the TW-only set is not part of config().
    assert.equal(w.sync(), false);
    assert.equal(charts(host, "2330.TW"), 1);
    assert.equal(charts(host, "^TWOII"), 1);
  });
});

test("a mistyped symbol never reaches the Taiwan host", async () => {
  await twOnlyRun(twOnlyHost(["APPL"]), (w, host) => {
    assert.equal(w.errors.APPL.code, "yahoo.notFound");
    assert.deepEqual(host.requests.filter((url) => isYahootw(url) && url.includes("APPL")), []);
  });
});

test("with Yahoo 奇摩股市 off, ^TWOII is not found", async () => {
  const host = twOnlyHost();
  host.prefs = undefined;
  await twOnlyRun(host, (w) => {
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
    assert.equal(w.marketFor("^TWOII"), "other");
    assert.deepEqual(host.requests.filter(isYahootw), []);
  });
});

test("turning Yahoo 奇摩股市 off, then on, starts over", async () => {
  await twOnlyRun(twOnlyHost(), async (w, host) => {
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
  await twOnlyRun(host, async (w) => {
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
    await twOnlyRun(twOnlyHost(["^TWOII"], { yahootw: () => stockList(TW_NOW - 5_000), line }), async (w, host) => {
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
  await twOnlyRun(twOnlyHost(["^TWOII"], { yahootw: () => ok(EARLIER_ROWS), line: offline }), (w) => {
    const quote = w.shown("^TWOII", NIGHT + 5_000);
    assert.equal(sessionOf(quote, NIGHT + 5_000), "closed");
  }, NIGHT);
});

test("turning Yahoo 奇摩股市 off while paused says not found at once", async () => {
  await twOnlyRun(twOnlyHost(), (w, host) => {
    assert.equal(w.errors["^TWOII"], undefined);
    w.pause(true);
    host.prefs = undefined;
    assert.equal(w.sync(), true);
    assert.equal(w.errors["^TWOII"].code, "yahoo.notFound");
  });
});
