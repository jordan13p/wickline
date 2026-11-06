// node --test tests/  (one refresh loop per source, on a fake clock)
import test from "node:test";
import assert from "node:assert/strict";
import { REQUEST_TIMEOUT_MS, Watchlist } from "../mods/wickline/watchlist.js";
import { LIVE_MAX_AGE_MS, freshness } from "../mods/wickline/freshness.js";
import { advance, chart, fakeHost, ok, start, stop } from "./helpers.mjs";
import { binance } from "../mods/wickline/providers/binance.js";
import { yahoo } from "../mods/wickline/providers/yahoo.js";

const AAPL = { symbol: "AAPL", regularMarketPrice: 230.1, regularMarketTime: 1_760_000_000, previousClose: 225, currency: "USD" };
const ticker = (url) => ok(JSON.parse(decodeURIComponent(url.split("symbols=")[1]))
  .map((symbol) => ({ symbol, lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 })));
const lines = () => ok([[1, "1", "2", "0.5", "1.5"], [2, "1.5", "2", "1", "1.75"]]);
const yahooChart = (url) => chart({ ...AAPL, symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]) });
const never = () => new Promise(() => {});

const count = (host, part) => host.requests.filter((url) => url.includes(part)).length;

test("one loop per source", () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  assert.deepEqual(w.providerIds(), ["binance", "mis", "finnhub", "yahoo"]);
  assert.equal(REQUEST_TIMEOUT_MS, 10_000);
});

test("a hung Yahoo does not delay Binance", async () => {
  const host = fakeHost(() => ok({}));
  host.fetch = (url) => {
    host.requests.push(url);
    if (url.includes("yahoo")) return never();
    const r = url.includes("ticker/24hr") ? ticker(url) : lines();
    return Promise.resolve({ ...r, text: async () => r.text });
  };
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 31_000);
  assert.ok(count(host, "ticker/24hr") >= 3, `${count(host, "ticker/24hr")} ticker requests`);
  // Lines only once a minute.
  assert.equal(count(host, "klines"), 1);
  await stop(w, host, runs);
});

test("a request times out after 10 s", async () => {
  let answer;
  const host = fakeHost(() => ok({}));
  host.fetch = (url) => {
    host.requests.push(url);
    return new Promise((resolve) => { answer = () => { const r = yahooChart(url); resolve({ ...r, text: async () => r.text }); }; });
  };
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 9_999);
  assert.equal(w.errors.AAPL, undefined);
  await advance(host, 10_000);
  assert.equal(w.errors.AAPL.code, "request.timeout");
  assert.deepEqual(w.problems(), [{ provider: "yahoo", code: "request.timeout", params: { source: "yahoo", seconds: 10 } }]);
  answer();
  await advance(host, 10_001);
  assert.equal(w.quotes.AAPL, undefined);
  assert.equal(w.errors.AAPL.code, "request.timeout");
  await stop(w, host, runs);
});

test("backoff is per provider", async () => {
  const host = fakeHost((url) => url.includes("binance") ? { status: 429, ok: false, text: "" } : yahooChart(url));
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.problems(), [{ provider: "binance", code: "binance.rateLimited", params: {} }]);
  assert.ok(w.sources.binance.retryAt >= 60_000);
  assert.ok(w.quotes.AAPL);
  await advance(host, 121_000);
  assert.equal(count(host, "yahoo"), 3);
  // Binance waited at least a minute, then its second 429 doubled the wait.
  assert.equal(count(host, "ticker/24hr"), 2);
  assert.ok(w.sources.binance.retryAt >= 60_000 + 120_000);
  await stop(w, host, runs);
});

test("451 says the region is blocked", async () => {
  const host = fakeHost((url) => url.includes("binance") ? { status: 451, ok: false, text: "" } : yahooChart(url));
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT"); w.add("ETH/USDT");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.errors["BTC/USDT"].code, "binance.region");
  assert.equal(w.errors["ETH/USDT"].code, "binance.region");
  assert.equal(w.errors.AAPL, undefined);
  assert.ok(w.quotes.AAPL);
  assert.deepEqual(w.problems(), [{ provider: "binance", code: "binance.region", params: {} }]);
  await stop(w, host, runs);
});

test("recovers after an outage", async () => {
  let down = true;
  const host = fakeHost(() => ok({}));
  host.fetch = async (url) => {
    host.requests.push(url);
    if (down) throw new Error("offline");
    const r = url.includes("ticker/24hr") ? ticker(url) : url.includes("klines") ? lines() : yahooChart(url);
    return { ...r, text: async () => r.text };
  };
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.errors.AAPL.code, "yahoo.unreachable");
  assert.equal(w.errors["BTC/USDT"].code, "binance.unreachable");
  assert.equal(w.problems().length, 2);
  down = false;
  await advance(host, 60_001);
  assert.ok(w.quotes.AAPL && w.quotes["BTC/USDT"]);
  assert.equal(w.errors.AAPL, undefined);
  assert.deepEqual(w.problems(), []);
  await stop(w, host, runs);
});

test("the busiest session sets the cadence", async () => {
  const w = new Watchlist(fakeHost(() => ok({})));
  w.add("AAPL"); w.add("MSFT");
  const day = { pre: [0, 100], regular: [100, 200], post: [200, 300] };
  w.quotes.AAPL = { symbol: "AAPL", periods: day };
  w.quotes.MSFT = { symbol: "MSFT", periods: day };
  assert.equal(w.sessionFor(["AAPL", "MSFT"], 50), "pre");
  assert.equal(w.sessionFor(["AAPL", "MSFT"], 500), "closed");
  delete w.quotes.MSFT;
  // Not known yet beats pre-market and closed.
  assert.equal(w.sessionFor(["AAPL", "MSFT"], 500), "unknown");
  assert.equal(w.sessionFor(["AAPL", "MSFT"], 150), "open");
  assert.equal(w.sessionFor(["BTC/USDT"], 500), "unknown");
  w.quotes["BTC/USDT"] = { symbol: "BTC/USDT", periods: null };
  // A pair's "24h" counts as open.
  assert.equal(w.sessionFor(["AAPL", "BTC/USDT"], 500), "open");
});

test("each loop asks its provider for the interval of its busiest session", async () => {
  const host = fakeHost((url) => url.includes("ticker/24hr") ? ticker(url) : url.includes("klines") ? lines() : yahooChart(url));
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const asked = { yahoo: [], binance: [] };
  const original = {};
  for (const provider of [yahoo, binance]) {
    original[provider.id] = provider.intervalMs;
    provider.intervalMs = (session) => { asked[provider.id].push(session); return original[provider.id](session); };
  }
  try {
    const runs = start(w, host);
    await advance(host, 1);
    // The Yahoo fixture has no trading periods, so its session is not known yet.
    assert.ok(asked.yahoo.length > 0 && asked.yahoo.every((session) => session === "unknown"), asked.yahoo.join());
    // Before its first quote a pair is not known either; once quoted it trades around the clock.
    assert.deepEqual([asked.binance[0], asked.binance.at(-1)], ["unknown", "open"]);
    await stop(w, host, runs);
  } finally {
    for (const provider of [yahoo, binance]) provider.intervalMs = original[provider.id];
  }
});

test("a paused list redraws when a live quote turns stale", async () => {
  const host = fakeHost((url) => url.includes("ticker/24hr") ? ticker(url) : lines());
  const redraws = [];
  host.changed = () => redraws.push(host.clock);
  const w = new Watchlist(host);
  w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 0);
  const quote = w.quotes["BTC/USDT"];
  assert.equal(freshness(quote, "24h", host.clock).state, "live");
  w.pause(true);
  await advance(host, 0);
  const requests = host.requests.length;
  redraws.length = 0;
  await advance(host, 121_000);
  // No request while paused, but a redraw once the price is too old to read as live.
  assert.equal(host.requests.length, requests);
  const turned = redraws.find((at) => freshness(quote, "24h", at).state === "stalled");
  assert.ok(turned !== undefined && turned <= quote.timestamp + LIVE_MAX_AGE_MS + 1, redraws.join());
  await stop(w, host, runs);
});

test("a hung source ends its round at the first timeout", async () => {
  const host = fakeHost(() => ok({}));
  host.fetch = (url) => { host.requests.push(url); return never(); };
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("MSFT"); w.add("NVDA");
  const runs = start(w, host);
  await advance(host, 69_999);
  assert.equal(count(host, "yahoo"), 1);
  assert.deepEqual(w.problems(), [{ provider: "yahoo", code: "request.timeout", params: { source: "yahoo", seconds: 10 } }]);
  for (const symbol of ["AAPL", "MSFT", "NVDA"]) assert.equal(w.errors[symbol].code, "request.timeout", symbol);
  // The next round runs one interval after the failed one ended.
  await advance(host, 70_000);
  assert.equal(count(host, "yahoo"), 2);
  await stop(w, host, runs);
});

test("a rate-limit cooldown still redraws when a live quote turns stale", async () => {
  let limited = false;
  const host = fakeHost((url) => limited ? { status: 429, ok: false, text: "" } : url.includes("ticker/24hr") ? ticker(url) : lines());
  const redraws = [];
  host.changed = () => redraws.push(host.clock);
  const w = new Watchlist(host);
  w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 0);
  const quote = w.quotes["BTC/USDT"];
  assert.equal(freshness(quote, "24h", host.clock).state, "live");
  limited = true;
  // A second refusal in a row: the next round (15 s) starts a two-minute cooldown.
  w.sources.binance.failures = 1;
  await advance(host, 15_000);
  assert.equal(w.problems()[0].code, "binance.rateLimited");
  const requests = host.requests.length;
  const retryAt = w.sources.binance.retryAt;
  assert.ok(retryAt > quote.timestamp + LIVE_MAX_AGE_MS + 1, `retryAt ${retryAt}`);
  redraws.length = 0;
  await advance(host, quote.timestamp + LIVE_MAX_AGE_MS + 1);
  // A redraw once the price is too old to read as live, and no request before the cooldown ends.
  const turned = redraws.find((at) => freshness(quote, "24h", at).state === "stalled");
  assert.ok(turned !== undefined, redraws.join());
  assert.equal(host.requests.length, requests);
  await advance(host, retryAt - 1);
  assert.equal(host.requests.length, requests);
  await stop(w, host, runs);
});

test("a rate-limited line request backs Binance off and ends the round", async () => {
  for (const status of [429, 418]) {
    const host = fakeHost((url) => url.includes("klines") ? { status, ok: false, text: "" } : ticker(url));
    const w = new Watchlist(host);
    w.add("BTC/USDT"); w.add("ETH/USDT");
    const runs = start(w, host);
    await advance(host, 1);
    // No second line request that round.
    assert.equal(count(host, "klines"), 1, `${status}`);
    assert.deepEqual(w.problems(), [{ provider: "binance", code: "binance.rateLimited", params: {} }]);
    assert.ok(w.sources.binance.retryAt >= 60_000);
    // The cooldown holds: no ticker request before it ends.
    await advance(host, 59_000);
    assert.equal(count(host, "ticker/24hr"), 1);
    assert.equal(count(host, "klines"), 1);
    await stop(w, host, runs);
  }
});

test("an unexpected error in a loop shows as the source's problem and the loop goes on", async () => {
  const host = fakeHost(yahooChart);
  const w = new Watchlist(host);
  w.add("AAPL");
  const decode = yahoo.decode;
  // A decoder bug that escapes the request's own handling: an answer with no `errors`.
  let broken = true;
  yahoo.decode = (...args) => (broken ? { quotes: {} } : decode(...args));
  try {
    const runs = start(w, host);
    await advance(host, 1);
    assert.deepEqual(w.problems(), [{ provider: "yahoo", code: "yahoo.unreachable", params: {} }]);
    assert.equal(count(host, "yahoo"), 1);
    // A Refresh that fails the same way does not stay "refreshing".
    w.refreshNow();
    await advance(host, 1_001);
    assert.equal(count(host, "yahoo"), 2);
    assert.equal(w.refreshing, false);
    assert.equal(w.sources.yahoo.refreshing, false);
    broken = false;
    // The next round comes after the interval and recovers.
    await advance(host, 60_000);
    assert.equal(count(host, "yahoo"), 2);
    await advance(host, 62_000);
    assert.equal(count(host, "yahoo"), 3);
    assert.ok(w.quotes.AAPL);
    assert.deepEqual(w.problems(), []);
    await stop(w, host, runs);
  } finally {
    yahoo.decode = decode;
  }
});

test("a hidden docked copy sends nothing", async () => {
  const host = fakeHost((url) => url.includes("binance") ? ticker(url) : yahooChart(url));
  host.shown = () => false;
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 300_000);
  assert.equal(host.requests.length, 0);
  await stop(w, host, runs);
});

test("shown again, only the stale sources fetch at once", async () => {
  const host = fakeHost((url) => url.includes("binance") ? (url.includes("klines") ? lines() : ticker(url)) : yahooChart(url));
  let shown = true;
  host.shown = () => shown;
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BTC/USDT");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(count(host, "yahoo"), 1);
  assert.equal(count(host, "ticker/24hr"), 1);
  // Hidden after the first round: at 15 s Binance is due and skips its round, Yahoo (60 s) is not due yet.
  shown = false;
  await advance(host, 40_000);
  assert.equal(count(host, "ticker/24hr"), 1);
  assert.equal(count(host, "yahoo"), 1);
  shown = true;
  // The render that shows it again wakes the loops.
  w.wakeMissed();
  await advance(host, 40_001);
  assert.equal(count(host, "ticker/24hr"), 2);
  assert.equal(count(host, "yahoo"), 1);
  // Yahoo goes on at its own pace.
  await advance(host, 60_001);
  assert.equal(count(host, "yahoo"), 2);
  await stop(w, host, runs);
});

test("shown again while a round just ended, nothing fetches early", async () => {
  const host = fakeHost((url) => yahooChart(url));
  let shown = true;
  host.shown = () => shown;
  // Yahoo answers after 2 s.
  host.fetch = async (url) => {
    host.requests.push(url);
    await host.sleep(2_000);
    const r = yahooChart(url);
    return { url, ...r, text: async () => r.text };
  };
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(count(host, "yahoo"), 1);
  // Hidden while the round is out, shown again at 5 s.
  shown = false;
  await advance(host, 5_000);
  shown = true;
  w.wakeMissed();
  await advance(host, 61_999);
  assert.equal(count(host, "yahoo"), 1);
  await advance(host, 62_100);
  assert.equal(count(host, "yahoo"), 2);
  await stop(w, host, runs);
});

// A shown copy redraws after every change, a little later, and as a card does, asks to catch up on each render.
function rendering(host, w) {
  const seen = { changes: 0 };
  host.changed = () => { seen.changes++; setImmediate(() => w.wakeMissed()); };
  return seen;
}

test("a paused card copy that is shown does not redraw in a loop", async () => {
  const host = fakeHost(yahooChart);
  host.store.paused = true;
  const w = new Watchlist(host);
  w.add("AAPL");
  host.store.paused = true;
  w.sync();
  const seen = rendering(host, w);
  const runs = start(w, host);
  await advance(host, 300_000);
  assert.equal(host.requests.length, 0);
  assert.ok(seen.changes < 20, `${seen.changes} redraws`);
  await stop(w, host, runs);
});

test("a round that threw is not asked again on every render", async () => {
  const host = fakeHost(yahooChart);
  const w = new Watchlist(host);
  w.add("AAPL");
  const seen = rendering(host, w);
  const redraw = host.changed;
  let threw = false;
  // A bug in the first round, once its quote is in (the round's own redraw).
  host.changed = () => {
    redraw();
    if (w.quotes.AAPL && !threw) { threw = true; throw new Error("bug"); }
  };
  const runs = start(w, host);
  await advance(host, 59_000);
  assert.equal(threw, true);
  assert.equal(count(host, "yahoo"), 1);
  assert.ok(seen.changes < 20, `${seen.changes} redraws`);
  await advance(host, 61_000);
  assert.equal(count(host, "yahoo"), 2);
  await stop(w, host, runs);
});

test("an edit made while hidden is fetched as soon as the copy is shown", async () => {
  const host = fakeHost(yahooChart);
  let shown = true;
  host.shown = () => shown;
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(count(host, "yahoo"), 1);
  shown = false;
  await advance(host, 5_000);
  w.add("NVDA");
  await advance(host, 6_000);
  assert.equal(count(host, "yahoo"), 1);
  shown = true;
  w.wakeMissed();
  await advance(host, 6_001);
  assert.equal(count(host, "yahoo"), 2);
  await stop(w, host, runs);
});
