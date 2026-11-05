// node --test tests/  (providers/finnhub.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT } from "../mods/bellwether/quotes.js";
import { STRINGS } from "../mods/bellwether/i18n.js";
import { Watchlist } from "../mods/bellwether/watchlist.js";
import { SECRET_KEY_FINNHUB } from "../mods/bellwether/settings.js";
import { advance, chart, fakeHost, ok, start, stop } from "./helpers.mjs";
import { FINNHUB_URL, finnhub, finnhubCap, finnhubSymbol } from "../mods/bellwether/providers/finnhub.js";
import { binance } from "../mods/bellwether/providers/binance.js";
import { MIS_CONSENT_VERSION, mis } from "../mods/bellwether/providers/mis.js";
import { yahoo } from "../mods/bellwether/providers/yahoo.js";

// An obvious fake: no real key is ever in a test.
const KEY = "test-key";
const cfg = { finnhubUrl: FINNHUB_URL, finnhubKey: KEY };
const QUOTE = { c: 231.2, pc: 228, o: 229, h: 232, l: 227.5, t: 1_760_000_000 };
const decode = (symbol, response, now = 1) => finnhub.decode(finnhub.requests([symbol], cfg)[0], response, now);

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
  const two = finnhub.requests(["AAPL", "BRK-B"], { finnhubUrl: "https://mirror.test/fh/", finnhubKey: "k" });
  assert.deepEqual(two.map((r) => r.url), ["https://mirror.test/fh/quote?symbol=AAPL", "https://mirror.test/fh/quote?symbol=BRK.B"]);
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

test("cap of 15 at the default budget", async () => {
  assert.equal(finnhubCap(60), 15);
  assert.equal(finnhubCap(4), 1);
  assert.equal(finnhubCap(63), 15);
  const host = usHost();
  const w = new Watchlist(host);
  const us = ["AAPL", "MSFT", "NVDA", "BRK-B", ...Array.from({ length: 12 }, (_, i) => `T${i}`)];
  // An index and a Taiwan stock in between do not count.
  w.add("^GSPC"); w.add("2330.TW");
  for (const symbol of us) w.add(symbol);
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
  assert.equal(w.overlays[us[15]], undefined);
  // A budget of 8 per minute: two symbols.
  host.prefs = finnhubOn({ budgetPerMinute: 8 });
  w.sync();
  assert.deepEqual(w.finnhubSymbols(), us.slice(0, 2));
  await stop(w, host, runs);
});

test("adding past the cap says so", async () => {
  const host = usHost({ budgetPerMinute: 8 });
  const w = new Watchlist(host);
  const runs = start(w, host);
  await advance(host, 1);
  assert.deepEqual(w.add("AAPL"), { code: "notice.added", params: { symbol: "AAPL" } });
  assert.deepEqual(w.add("MSFT"), { code: "notice.added", params: { symbol: "MSFT" } });
  assert.deepEqual(w.add("NVDA"), { code: "notice.overCap", params: { symbol: "NVDA", cap: 2 } });
  // Not a US stock: no cap.
  assert.deepEqual(w.add("2330.TW"), { code: "notice.added", params: { symbol: "2330.TW" } });
  for (const lang of Object.keys(STRINGS)) {
    for (const code of ["notice.overCap", "finnhub.overCap"]) assert.ok(STRINGS[lang][code], `${lang} ${code}`);
  }
  await stop(w, host, runs);
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
    assert.deepEqual(w.problems(), problem ? [{ provider: "finnhub", code: problem, params: {} }] : []);
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
  assert.deepEqual(w.problems(), [{ provider: "finnhub", code: "finnhub.secretUnreadable", params: {} }]);
  assert.ok(STRINGS.en["finnhub.secretUnreadable"]);
  await stop(w, host, runs);
});

test("Finnhub overlays Yahoo with the key in the header", async () => {
  const host = usHost();
  const w = new Watchlist(host);
  w.add("AAPL"); w.add("BRK-B");
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
    assert.deepEqual(w.problems(), [{ provider: "finnhub", code: "finnhub.invalidKey", params: {} }]);
    // The round stops at the first refusal; both rows fall back with the reason.
    assert.equal(finnhubCount(host), 1);
    for (const symbol of ["AAPL", "MSFT"]) {
      assert.equal(w.shown(symbol).source, "yahoo", symbol);
      assert.equal(w.overlayErrors[symbol].code, "finnhub.invalidKey", symbol);
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
    assert.equal(w.shown("AAPL").source, "finnhub");
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
  host.prefs = finnhubOn({ finnhubUrl: "https://mirror.test/fh" });
  w.sync();
  await advance(host, 2);
  assert.equal(w.sources.finnhub.disabled, false);
  // Still one request per interval since the last one.
  await advance(host, 15_001);
  assert.ok(host.requests.includes("https://mirror.test/fh/quote?symbol=AAPL"));
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
    return yahooUs(url);
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

// ---- helpers ----

function finnhubOn(us = {}, keyRev = 0) {
  return { version: 1, keyRev, sources: { us: { provider: "finnhub", ...us } } };
}

const yahooUs = (url) => chart({
  symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]), regularMarketPrice: 230.1,
  regularMarketTime: 1, previousClose: 228, currency: "USD",
});

function usHost(us = {}) {
  const host = fakeHost((url) => (url.includes("/quote?symbol=") ? host.finnhub(url) : yahooUs(url)));
  host.finnhub = () => ok(QUOTE);
  host.prefs = finnhubOn(us);
  host.secrets = { [SECRET_KEY_FINNHUB]: KEY };
  return host;
}

const finnhubUrls = (host) => host.requests.filter((url) => url.includes("/quote?symbol="));
const finnhubCount = (host) => finnhubUrls(host).length;
const yahooCount = (host) => host.requests.filter((url) => url.includes("/chart/")).length;
