// node --test tests/  (watchlist.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_SYMBOLS, USER_AGENT } from "../mods/bellwether/quotes.js";
import { yahooUrl } from "../mods/bellwether/providers/yahoo.js";
import { binanceKlinesUrl, binanceUrl } from "../mods/bellwether/providers/binance.js";
import { Watchlist, WATCHLIST_KEY, readPreferences } from "../mods/bellwether/watchlist.js";
import { t } from "../mods/bellwether/i18n.js";
import { advance, chart, fakeHost, ok, start, stop } from "./helpers.mjs";

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

test("refreshing means a round the person asked for, not an automatic one", async () => {
  const host = fakeHost((url) => chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) }));
  const w = new Watchlist(host);
  w.add("AAPL");
  // What the view would draw on each redraw: [loading, refreshing].
  const seen = [];
  host.changed = () => seen.push([w.loading, w.refreshing]);
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

test("identity", () => {
  assert.equal(WATCHLIST_KEY, "bellwether.watchlist.v1");
});
