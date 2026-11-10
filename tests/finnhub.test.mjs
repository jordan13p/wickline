// node --test tests/  (providers/finnhub.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGES_EN, USER_AGENT } from "../mods/wickline/quotes.js";
import { STRINGS } from "../mods/wickline/i18n.js";
import { Watchlist } from "../mods/wickline/watchlist.js";
import { freshness, sessionOf } from "../mods/wickline/freshness.js";
import { SECRET_KEY_FINNHUB } from "../mods/wickline/settings.js";
import { advance, at, chart, chartSymbol, day, fakeHost, ok, start, stop, yq } from "./helpers.mjs";
import { FINNHUB_URL, finnhub, finnhubCap, finnhubSymbol } from "../mods/wickline/providers/finnhub.js";
import { binance } from "../mods/wickline/providers/binance.js";
import { MIS_CONSENT_VERSION, mis } from "../mods/wickline/providers/mis.js";
import { yahoo } from "../mods/wickline/providers/yahoo.js";

// An obvious fake: no real key is ever in a test.
const KEY = "test-key";
const cfg = { finnhubUrl: FINNHUB_URL, finnhubKey: KEY };
const QUOTE = { c: 231.2, pc: 228, o: 229, h: 232, l: 227.5, t: 1_760_000_000 };
// Answered from the request's own address unless the test gives another `url`, as Herdr's fetch does.
const decode = (symbol, response, now = 1) => {
  const [request] = finnhub.requests([symbol], cfg);
  return finnhub.decode(request, { url: request.url, ...response }, now);
};

test("constants", () => {
  assert.equal(FINNHUB_URL, "https://finnhub.io/api/v1");
  assert.equal(finnhub.id, "finnhub");
  assert.deepEqual(finnhub.markets, ["us"]);
  assert.equal(finnhub.overlay, true);
  assert.equal(finnhub.intervalMs("open"), 15_000);
  assert.equal(finnhub.intervalMs("unknown"), 15_000);
  for (const session of ["closed", "pre", "post"]) assert.equal(finnhub.intervalMs(session), 60_000, session);
  assert.equal(finnhub.spacingMs(15, 15_000), 1000);
  assert.equal(finnhub.spacingMs(30, 15_000), 1000);
  assert.equal(finnhub.spacingMs(3, 15_000), 5000);
  assert.equal(finnhub.spacingMs(1, 60_000), 60_000);
});

test("key in header, not URL", () => {
  const [request, ...rest] = finnhub.requests(["AAPL"], { finnhubUrl: FINNHUB_URL, finnhubKey: "k" });
  assert.equal(rest.length, 0);
  assert.equal(request.url, "https://finnhub.io/api/v1/quote?symbol=AAPL");
  assert.ok(!request.url.includes("k", request.url.indexOf("?")), request.url);
  assert.equal(request.headers["X-Finnhub-Token"], "k");
  assert.equal(request.headers["User-Agent"], USER_AGENT);
  assert.equal(request.headers.Accept, "application/json");
  assert.deepEqual(request.symbols, ["AAPL"]);
  assert.equal(request.kind, "quote");
  // One request per symbol; the person's address is used without a trailing slash.
  const two = finnhub.requests(["AAPL", "BRK-B"], { finnhubUrl: "https://finnhub.io/api/v2/", finnhubKey: "k" });
  assert.deepEqual(two.map((r) => r.url), ["https://finnhub.io/api/v2/quote?symbol=AAPL", "https://finnhub.io/api/v2/quote?symbol=BRK.B"]);
});

test("symbol mapping", () => {
  assert.equal(finnhubSymbol("BRK-B"), "BRK.B");
  assert.equal(finnhubSymbol("AAPL"), "AAPL");
});

test("decodes a quote", () => {
  const result = decode("AAPL", ok(QUOTE), 42);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.quotes.AAPL, {
    symbol: "AAPL", source: "finnhub", price: 231.2, previousClose: 228, open: 229, high: 232, low: 227.5,
    timestamp: 1_760_000_000_000, fetchedAt: 42,
  });
  // Finnhub answers an unknown symbol with zeros: no quote, no error.
  assert.deepEqual(decode("AAPL", ok({ ...QUOTE, c: 0 })), { quotes: {}, errors: {} });
  assert.deepEqual(decode("AAPL", ok({ ...QUOTE, t: 0 })), { quotes: {}, errors: {} });
});

test("HTML answer fails visibly", () => {
  const html = decode("AAPL", { status: 200, ok: true, text: "<html>" });
  assert.deepEqual(html.quotes, {});
  assert.equal(html.errors.AAPL.code, "finnhub.unreadable");
  for (const body of ["{}", "[]", "null", JSON.stringify({ error: "x" })]) {
    assert.equal(decode("AAPL", { status: 200, ok: true, text: body }).errors.AAPL.code, "finnhub.unreadable", body);
  }
  const refused = decode("AAPL", { status: 503, ok: false, text: "" });
  assert.deepEqual([refused.errors.AAPL.code, refused.errors.AAPL.params], ["finnhub.http", { status: 503 }]);
  assert.equal(decode("AAPL", { status: 429, ok: false, text: "" }).errors.AAPL.retryAfterMs, 60_000);
  for (const status of [401, 403]) {
    const error = decode("AAPL", { status, ok: false, text: "" }).errors.AAPL;
    assert.equal(error.code, "finnhub.invalidKey", String(status));
    assert.equal(error.stopsSource, true);
    // The message names no key.
    assert.ok(!error.message.includes(KEY));
  }
});

test("a saved Finnhub address off https://finnhub.io sends no request: the key never leaves", async () => {
  for (const finnhubUrl of ["http://finnhub.io/api/v1", "https://evil.test", "https://finnhub.io.evil.test/api/v1", "https://user@finnhub.io/api/v1"]) {
    const host = usHost({ finnhubUrl });
    const w = new Watchlist(host);
    w.add("AAPL");
    const runs = start(w, host);
    await advance(host, 62_000);
    assert.equal(finnhubCount(host), 0, finnhubUrl);
    for (const headers of host.headers) assert.equal(headers?.["X-Finnhub-Token"], undefined, finnhubUrl);
    assert.ok(host.requests.length > 0, "Yahoo still asked");
    assert.equal(w.shown("AAPL").source, "yahoo", finnhubUrl);
    // On the status line and the US card (the dialog shows problems()).
    assert.deepEqual(w.problems().filter((p) => p.provider === "finnhub"), [{ provider: "finnhub", code: "finnhub.badUrl", params: {}, stopped: true }], finnhubUrl);
    // Fixed in Settings: Finnhub runs.
    host.prefs = finnhubOn({ finnhubUrl: FINNHUB_URL });
    w.sync();
    await advance(host, 65_000);
    assert.ok(finnhubCount(host) > 0, finnhubUrl);
    assert.deepEqual(w.problems().filter((p) => p.provider === "finnhub"), []);
    await stop(w, host, runs);
  }
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["finnhub.badUrl"], lang);
});

test("an answer from another address stops Finnhub: the key is not sent again", async () => {
  for (const finalUrl of ["https://evil.test/quote?symbol=AAPL", "http://finnhub.io/api/v1/quote?symbol=AAPL", "https://finnhub.io.evil.test/x"]) {
    const error = decode("AAPL", { ...ok(QUOTE), url: finalUrl }).errors.AAPL;
    assert.equal(error.code, "finnhub.redirected", finalUrl);
    assert.equal(error.stopsSource, true);
  }
  // The same host: decoded as usual.
  assert.equal(decode("AAPL", { ...ok(QUOTE), url: `${FINNHUB_URL}/quote?symbol=AAPL` }).quotes.AAPL.price, QUOTE.c);
  // No final address, or not a string: fails closed, as a redirect.
  for (const url of [undefined, null, "", 42]) {
    const error = decode("AAPL", { ...ok(QUOTE), url }).errors.AAPL;
    assert.equal(error.code, "finnhub.redirected", String(url));
    assert.equal(error.stopsSource, true);
  }
  const host = usHost();
  host.finnhub = (url) => ({ ...ok(QUOTE), url: url.replace("https://finnhub.io", "https://evil.test") });
  const w = new Watchlist(host);
  w.add("MSFT"); w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 120_000);
  assert.equal(finnhubCount(host), 1);
  assert.equal(w.sources.finnhub.disabled, true);
  assert.deepEqual(w.problems().find((p) => p.provider === "finnhub"), { provider: "finnhub", code: "finnhub.redirected", params: {}, stopped: true });
  await stop(w, host, runs);
  assert.ok("finnhub.redirected" in MESSAGES_EN);
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["finnhub.redirected"], lang);
});

test("cap of 15 at the default budget", async () => {
  assert.equal(finnhubCap(60), 15);
  assert.equal(finnhubCap(4), 1);
  assert.equal(finnhubCap(63), 15);
  const host = usHost();
  const w = new Watchlist(host);
  const us = ["AAPL", "MSFT", "NVDA", "BRK-B", ...Array.from({ length: 12 }, (_, i) => `T${i}`)];
  // An index and a Taiwan stock in between do not count.
  w.add("^GSPC"); w.add("2330.TW");
  // Each add goes to the top, so add them last to first to list them in order.
  for (const symbol of [...us].reverse()) w.add(symbol);
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.finnhubSymbols(), us.slice(0, 15));
  assert.equal(w.overCap(us[15]), true);
  for (const symbol of [...us.slice(0, 15), "^GSPC", "2330.TW"]) assert.equal(w.overCap(symbol), false, symbol);
  // One round: 15 requests, one second apart.
  await advance(host, 14_500);
  assert.equal(finnhubCount(host), 15);
  assert.ok(!finnhubUrls(host).some((url) => url.endsWith(`=${us[15]}`)));
  assert.equal(w.shown(us[0]).source, "finnhub");
  assert.equal(w.overlays[us[15]]?.finnhub, undefined);
  // A budget of 8 per minute: two symbols.
  host.prefs = finnhubOn({ budgetPerMinute: 8 });
  w.sync();
  assert.deepEqual(w.finnhubSymbols(), us.slice(0, 2));
  await stop(w, host, runs);
});

test("adding past the cap names the symbol it pushed out", async () => {
  const host = usHost({ budgetPerMinute: 8 });
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.add("AAPL"), { code: "notice.added", params: { symbol: "AAPL" } });
  assert.deepEqual(w.add("MSFT"), { code: "notice.added", params: { symbol: "MSFT" } });
  // The new symbol goes to the top, so the one that was last under the cap loses its place.
  assert.deepEqual(w.add("NVDA"), { code: "notice.overCapPushed", params: { symbol: "NVDA", pushed: "AAPL", cap: 2 } });
  assert.deepEqual(w.finnhubSymbols(), ["NVDA", "MSFT"]);
  assert.equal(w.overCap("AAPL"), true);
  // Not a US stock: no cap, and it pushes nobody.
  assert.deepEqual(w.add("2330.TW"), { code: "notice.added", params: { symbol: "2330.TW" } });
  assert.deepEqual(w.add("BTC/USDT"), { code: "notice.added", params: { symbol: "BTC/USDT" } });
  for (const lang of Object.keys(STRINGS)) {
    for (const code of ["notice.overCap", "notice.overCapPushed", "finnhub.overCap"]) assert.ok(STRINGS[lang][code], `${lang} ${code}`);
  }
  await stop(w, host, runs);
});

test("only a US symbol is pushed past the cap, and only US symbols count toward it", async () => {
  // `budget` sets the cap (a quarter of it); `list` is saved in that order; then `symbol` is added on top.
  const addTo = async (budget, list, symbol) => {
    const host = usHost({ budgetPerMinute: budget });
    host.store = { version: 1, symbols: list, paused: false };
    const w = new Watchlist(host);
    const runs = start(w, host);
    await advance(host, 1);
    const notice = w.add(symbol);
    await stop(w, host, runs);
    return notice;
  };
  // Cap 3: the third US symbol loses its place; cap 5 has room.
  assert.deepEqual(await addTo(12, ["AAPL", "MSFT", "NVDA"], "TSLA"), { code: "notice.overCapPushed", params: { symbol: "TSLA", pushed: "NVDA", cap: 3 } });
  assert.deepEqual(await addTo(20, ["AAPL", "MSFT", "NVDA"], "TSLA"), { code: "notice.added", params: { symbol: "TSLA" } });
  // Cap 2: a Taiwan stock in between neither counts nor gets pushed.
  assert.deepEqual(await addTo(8, ["AAPL", "2330.TW", "MSFT"], "NVDA"), { code: "notice.overCapPushed", params: { symbol: "NVDA", pushed: "MSFT", cap: 2 } });
  assert.deepEqual(await addTo(8, ["AAPL", "MSFT"], "0050.TW"), { code: "notice.added", params: { symbol: "0050.TW" } });
  // An empty list: nobody to push.
  assert.deepEqual(await addTo(8, [], "NVDA"), { code: "notice.added", params: { symbol: "NVDA" } });
});

test("the 16th US symbol at the default budget pushes the old 15th", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 1);
  const us = Array.from({ length: 16 }, (_, i) => `T${i}`);
  for (const symbol of us.slice(0, 15).reverse()) w.add(symbol);
  assert.deepEqual(w.add(us[15]), { code: "notice.overCapPushed", params: { symbol: us[15], pushed: us[14], cap: 15 } });
  assert.deepEqual(w.finnhubSymbols(), [us[15], ...us.slice(0, 14)]);
  await stop(w, host, runs);
});

test("a new symbol that is itself past the cap keeps the plain over-cap notice", async () => {
  // A budget under 4 a minute prices no symbol (the settings refuse it, a hand-edited file may not).
  const host = usHost({ budgetPerMinute: 3 });
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.add("AAPL"), { code: "notice.overCap", params: { symbol: "AAPL", cap: 0 } });
  await stop(w, host, runs);
});

test("with room under the cap, adding says nothing about it; with Finnhub off, neither", async () => {
  const host = usHost({ budgetPerMinute: 8 });
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.add("AAPL"), { code: "notice.added", params: { symbol: "AAPL" } });
  await stop(w, host, runs);
  const off = fakeHost(() => ok({}));
  const v = new Watchlist(off);
  for (const symbol of ["AAPL", "MSFT", "NVDA", "BRK-B", "T1", "T2"]) assert.equal(v.add(symbol).code, "notice.added", symbol);
});

test("Finnhub stays off without its choice and a key", async () => {
  for (const [prefs, secrets, problem] of [
    [undefined, { [SECRET_KEY_FINNHUB]: KEY }, null],
    [{ version: 1, sources: { us: { provider: "yahoo" } } }, { [SECRET_KEY_FINNHUB]: KEY }, null],
    [finnhubOn(), {}, "finnhub.noKey"],
    [finnhubOn(), { [SECRET_KEY_FINNHUB]: "  " }, "finnhub.noKey"],
  ]) {
    const host = usHost();
    host.prefs = prefs;
    host.secrets = secrets;
    const w = new Watchlist(host);
    w.add("AAPL");
    const runs = start(w, host);
    await advance(host, 61_000);
    assert.equal(finnhubCount(host), 0, JSON.stringify(prefs));
    assert.equal(w.shown("AAPL").source, "yahoo");
    assert.equal(w.overCap("AAPL"), false);
    assert.deepEqual(w.problems(), problem ? [{ provider: "finnhub", code: problem, params: {}, stopped: true }] : []);
    await stop(w, host, runs);
  }
});

test("an unreadable secrets file is a visible problem", async () => {
  const host = usHost();
  host.secretsBroken = true;
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 31_000);
  assert.equal(finnhubCount(host), 0);
  assert.deepEqual(w.problems(), [{ provider: "finnhub", code: "finnhub.secretUnreadable", params: {}, stopped: true }]);
  assert.ok(STRINGS.en["finnhub.secretUnreadable"]);
  await stop(w, host, runs);
});

test("Finnhub overlays Yahoo with the key in the header", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("BRK-B"); w.add("AAPL");
  const runs = start(w, host);
  // Two symbols: spread over the 15 s interval.
  await advance(host, 7_501);
  assert.deepEqual(finnhubUrls(host), [`${FINNHUB_URL}/quote?symbol=AAPL`, `${FINNHUB_URL}/quote?symbol=BRK.B`]);
  for (const [i, url] of host.requests.entries()) {
    assert.ok(!url.includes(KEY), url);
    assert.equal(host.headers[i]["X-Finnhub-Token"], url.startsWith(FINNHUB_URL) ? KEY : undefined, url);
  }
  const quote = w.shown("AAPL");
  assert.deepEqual([quote.source, quote.price, quote.chartSource, quote.currency], ["finnhub", 231.2, "yahoo", "USD"]);
  assert.equal(w.quotes.AAPL.source, "yahoo");
  // The key stays out of what the watchlist exposes.
  assert.ok(!JSON.stringify(w.config()).includes(KEY));
  assert.ok(!w.configKey.includes(KEY));
  assert.ok(!JSON.stringify(host.prefs).includes(KEY));
  assert.deepEqual(w.problems(), []);
  await stop(w, host, runs);
});

test("401 stops Finnhub until the key changes", async () => {
  for (const status of [401, 403]) {
    const host = usHost();
    host.finnhub = () => ({ status, ok: false, text: "" });
    const w = new Watchlist(host);
    w.add("AAPL"); w.add("MSFT");
    const runs = start(w, host);
    await advance(host, 1_001);
    // Refused: the source cannot run until its settings change, which the settings dialog reads.
    assert.deepEqual(w.problems(), [{ provider: "finnhub", code: "finnhub.invalidKey", params: {}, stopped: true }]);
    // The round stops at the first refusal; both rows fall back with the reason.
    assert.equal(finnhubCount(host), 1);
    for (const symbol of ["AAPL", "MSFT"]) {
      assert.equal(w.shown(symbol).source, "yahoo", symbol);
      assert.equal(w.overlayError(symbol).code, "finnhub.invalidKey", symbol);
    }
    await advance(host, 61_000);
    assert.equal(finnhubCount(host), 1);
    // Any other edit leaves it stopped.
    w.add("NVDA");
    await advance(host, 62_000);
    assert.equal(finnhubCount(host), 1);
    // A new key: every copy reads the file again when keyRev changes.
    host.finnhub = () => ok(QUOTE);
    host.secrets = { [SECRET_KEY_FINNHUB]: "test-key-2" };
    host.prefs = finnhubOn({}, 2);
    assert.equal(w.sync(), true);
    await advance(host, 64_000);
    assert.ok(finnhubCount(host) > 1);
    const last = host.requests.findLastIndex((url) => url.includes("/quote?symbol="));
    assert.equal(host.headers[last]["X-Finnhub-Token"], "test-key-2");
    // NVDA, added last, is first in list order and so the first one the round quotes.
    assert.equal(w.shown("NVDA").source, "finnhub");
    assert.deepEqual(w.problems(), []);
    await stop(w, host, runs);
  }
});

test("a change to the US source settings also lifts the stop", async () => {
  const host = usHost();
  host.finnhub = () => ({ status: 401, ok: false, text: "" });
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.sources.finnhub.disabled, true);
  host.finnhub = () => ok(QUOTE);
  host.prefs = finnhubOn({ finnhubUrl: "https://finnhub.io/api/v2" });
  w.sync();
  await advance(host, 2);
  assert.equal(w.sources.finnhub.disabled, false);
  // Still one request per interval since the last one.
  await advance(host, 15_001);
  assert.ok(host.requests.includes("https://finnhub.io/api/v2/quote?symbol=AAPL"));
  await stop(w, host, runs);
});

test("the key is read once per keyRev", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 61_000);
  assert.equal(host.secretReads, 1);
  host.prefs = finnhubOn({}, 1);
  w.sync();
  await advance(host, 62_000);
  assert.equal(host.secretReads, 2);
  await stop(w, host, runs);
});

test("manual refresh adds no Finnhub calls", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1_000);
  assert.equal(finnhubCount(host), 1);
  const yahooBefore = yahooCount(host);
  w.refreshNow();
  await advance(host, 14_000);
  assert.equal(finnhubCount(host), 1);
  // Yahoo still refreshes.
  assert.ok(yahooCount(host) > yahooBefore);
  await advance(host, 15_100);
  assert.equal(finnhubCount(host), 2);
  // While paused, Refresh runs a round of the other sources only.
  w.pause(true);
  const paused = finnhubCount(host);
  w.refreshNow();
  await advance(host, 120_000);
  assert.equal(finnhubCount(host), paused);
  await stop(w, host, runs);
});

test("a Finnhub rate limit falls back to Yahoo for the cooldown", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("AAPL").source, "finnhub");
  host.finnhub = () => ({ status: 429, ok: false, text: "" });
  await advance(host, 15_001);
  assert.equal(w.shown("AAPL").source, "yahoo");
  // Limited, not stopped: the key still works after the cooldown.
  assert.deepEqual(w.problems(), [{ provider: "finnhub", code: "finnhub.rateLimited", params: {} }]);
  assert.ok(w.sources.finnhub.retryAt >= 75_000);
  await stop(w, host, runs);
});

test("turning Finnhub off drops the overlay at once", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("AAPL");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("AAPL").source, "finnhub");
  host.prefs = { version: 1, keyRev: 0, sources: { us: { provider: "yahoo" } } };
  assert.equal(w.sync(), true);
  assert.equal(w.shown("AAPL").source, "yahoo");
  const sent = finnhubCount(host);
  await advance(host, 61_000);
  assert.equal(finnhubCount(host), sent);
  await stop(w, host, runs);
});

test("only Finnhub's requests carry the key", async () => {
  // Every source on: Finnhub with a key, MIS with consent (answering 500), Binance and Yahoo.
  const host = fakeHost((url) => {
    if (url.includes("/quote?symbol=")) return ok(QUOTE);
    if (url.includes("mis.twse")) return { status: 500, ok: false, text: "" };
    if (url.includes("ticker/24hr")) {
      return ok(JSON.parse(decodeURIComponent(url.split("symbols=")[1]))
        .map((symbol) => ({ symbol, lastPrice: "65000", prevClosePrice: "64000", closeTime: 5 })));
    }
    if (url.includes("klines")) return ok([[1, "1", "2", "0.5", "1.5"]]);
    return yahooUs(chartSymbol(url));
  });
  host.prefs = { version: 1, keyRev: 0, sources: { us: { provider: "finnhub" }, tw: { provider: "mis", misAck: { version: MIS_CONSENT_VERSION } } } };
  host.secrets = { [SECRET_KEY_FINNHUB]: KEY };
  const saved = [];
  const save = host.save;
  host.save = (p) => { saved.push(JSON.stringify(p)); save(p); };
  // What each other provider is handed to build its requests.
  const given = [];
  const originals = [yahoo, mis, binance].map((provider) => [provider, provider.requests]);
  for (const [provider, requests] of originals) {
    provider.requests = (symbols, config) => { given.push([provider.id, JSON.stringify(config)]); return requests(symbols, config); };
  }
  try {
    const w = new Watchlist(host);
    for (const symbol of ["AAPL", "2330.TW", "BTC/USDT"]) w.add(symbol);
    const runs = start(w, host);
    await advance(host, 61_000);
    assert.ok(finnhubCount(host) > 0);
    for (const id of ["yahoo", "mis", "binance"]) assert.ok(given.some(([p]) => p === id), id);
    for (const [id, config] of given) assert.ok(!config.includes(KEY), id);
    for (const [i, url] of host.requests.entries()) {
      assert.ok(!url.includes(KEY), url);
      if (!url.includes("/quote?symbol=")) assert.ok(!JSON.stringify(host.headers[i]).includes(KEY), url);
    }
    assert.ok(Object.keys(w.overlayErrors).length > 0);
    for (const exposed of [w.problems(), w.errors, w.overlayErrors, saved]) assert.ok(!JSON.stringify(exposed).includes(KEY));
    await stop(w, host, runs);
  } finally {
    for (const [provider, requests] of originals) provider.requests = requests;
  }
});

test("a removed key leaves every copy's memory", async () => {
  // Removed with Yahoo chosen (the dialog's way) or with Finnhub still chosen (the file deleted, keyRev bumped).
  for (const provider of ["yahoo", "finnhub"]) {
    const host = usHost();
    const w = new Watchlist(host);
    w.add("AAPL");
    const runs = start(w, host);
    await advance(host, 1_000);
    assert.equal(w.finnhubKey, KEY);
    assert.ok(finnhubCount(host) > 0);
    host.secrets = {};
    host.prefs = { version: 1, keyRev: 1, sources: { us: { provider } } };
    assert.equal(w.sync(), true);
    await advance(host, 2_000);
    assert.equal(w.finnhubKey, null, provider);
    const sent = host.requests.length;
    await advance(host, 62_000);
    assert.ok(host.requests.length > sent);
    for (const [i, url] of host.requests.entries()) {
      if (i >= sent) assert.equal(host.headers[i]["X-Finnhub-Token"], undefined, url);
    }
    assert.equal(w.shown("AAPL").source, "yahoo");
    await stop(w, host, runs);
  }
});

test("choosing Finnhub again with the same saved key starts it at once", async () => {
  // A round trip (Finnhub, Yahoo, Finnhub) and a cold start on Yahoo; keyRev never changes.
  for (const first of ["finnhub", "yahoo"]) {
    const host = usHost();
    host.prefs = { version: 1, keyRev: 0, sources: { us: { provider: first } } };
    const w = new Watchlist(host);
    w.add("AAPL");
    const runs = start(w, host);
    await advance(host, 1_000);
    if (first === "finnhub") {
      host.prefs = { version: 1, keyRev: 0, sources: { us: { provider: "yahoo" } } };
      assert.equal(w.sync(), true);
      await advance(host, 2_000);
    }
    const sent = finnhubCount(host);
    host.prefs = finnhubOn();
    assert.equal(w.sync(), true, first);
    // At once on a cold start; within Finnhub's own request spacing after a round trip.
    await advance(host, first === "yahoo" ? 3_000 : 32_000);
    assert.ok(finnhubCount(host) > sent, first);
    assert.equal(w.shown("AAPL").source, "finnhub", first);
    await stop(w, host, runs);
  }
});

// An index is not a stock: once Yahoo names its exchange it counts as US, but Finnhub never asks for it, and it
// never takes a place under the cap.
test("an index never takes Finnhub's place", async () => {
  const host = usHost({ budgetPerMinute: 4 }, { yahoo: (symbol) => yahooUs(symbol, symbol === "^DJI" ? { exchangeName: "DJI" } : {}) });
  host.store = { version: 1, symbols: ["^DJI", "AAPL"], paused: false };
  assert.equal(finnhubCap(4), 1);
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 62_000);
  assert.equal(w.exchangeOf("^DJI"), "DJI");
  assert.ok(finnhubUrls(host).length > 0);
  assert.ok(finnhubUrls(host).every((url) => url.endsWith("symbol=AAPL")), finnhubUrls(host).join(" "));
  assert.equal(w.overCap("AAPL"), false);
  assert.equal(w.overCap("^DJI"), false);
  assert.equal(w.add("^GSPC").code, "notice.added");
  await stop(w, host, runs);
});

test("a row past the cap shows its Yahoo quote as live", async () => {
  // Budget 8: a cap of 2. Yahoo's quotes are from NMS, timed 1 s, the session open until 100 000 s.
  const meta = { exchangeName: "NMS", currentTradingPeriod: { regular: { start: 0, end: 100_000 } } };
  const host = usHost({ budgetPerMinute: 8 }, { yahoo: (symbol) => yahooUs(symbol, meta) });
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("MSFT"); // each add goes to the top
  const runs = start(w, host);
  await advance(host, 20_000);
  assert.equal(w.shown("AAPL", host.clock).source, "finnhub");
  w.add("NVDA"); // pushes AAPL past the cap
  await advance(host, 21_000);
  assert.equal(w.overCap("AAPL"), true);
  assert.equal(w.overlays.AAPL?.finnhub, undefined);
  const shown = w.shown("AAPL", host.clock);
  assert.equal(shown.source, "yahoo");
  assert.equal(freshness(shown, sessionOf(shown, host.clock), host.clock).state, "live");
  await stop(w, host, runs);
});

test("a Finnhub price held back gives way to a fresh Yahoo quote", () => {
  const w = new Watchlist(usHost());
  const now = at("2026-11-10T15:00:00Z"); // 10:00 in New York
  w.quotes.AAPL = { ...yq("AAPL", "NMS", now - 10_000, day("2026-11-10T14:30:00Z", "2026-11-10T21:00:00Z")), price: 230.1, fetchedAt: now };
  // Finnhub in a rate limit's cooldown: its last price, 3 minutes old, stays among the overlays.
  w.overlays.AAPL = { finnhub: { symbol: "AAPL", source: "finnhub", price: 231.2, timestamp: now - 180_000, fetchedAt: now - 180_000 } };
  const shown = w.shown("AAPL", now);
  assert.deepEqual([shown.source, shown.price], ["yahoo", 230.1]);
  assert.equal(freshness(shown, sessionOf(shown, now), now).state, "live");
});

// ---- helpers ----

function finnhubOn(us = {}, keyRev = 0) {
  return { version: 1, keyRev, sources: { us: { provider: "finnhub", ...us } } };
}

// Yahoo Finance's answer for `symbol`, with `fields` added to its meta.
const yahooUs = (symbol, fields = {}) => chart({
  symbol, regularMarketPrice: 230.1, regularMarketTime: 1, previousClose: 228, currency: "USD", ...fields,
});

// `yahoo` answers Yahoo Finance per symbol.
function usHost(us = {}, { yahoo = (symbol) => yahooUs(symbol) } = {}) {
  const host = fakeHost((url) => (url.includes("/quote?symbol=") ? host.finnhub(url)
    : host.yahoo(chartSymbol(url))));
  host.finnhub = () => ok(QUOTE);
  host.yahoo = yahoo;
  host.prefs = finnhubOn(us);
  host.secrets = { [SECRET_KEY_FINNHUB]: KEY };
  return host;
}

const finnhubUrls = (host) => host.requests.filter((url) => url.includes("/quote?symbol="));
const finnhubCount = (host) => finnhubUrls(host).length;
const yahooCount = (host) => host.requests.filter((url) => url.includes("/chart/")).length;
