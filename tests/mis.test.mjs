// node --test tests/  (providers/mis.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { USER_AGENT, displayName } from "../mods/bellwether/quotes.js";
import { detailSource } from "../mods/bellwether/freshness.js";
import { t } from "../mods/bellwether/i18n.js";
import { Watchlist, mergeOverlay } from "../mods/bellwether/watchlist.js";
import { advance, chart, fakeHost, start, stop } from "./helpers.mjs";
import { MIS_BATCH, MIS_CONSENT_VERSION, MIS_URL, mis, misChannel, withinLimits } from "../mods/bellwether/providers/mis.js";

// Recorded answers from MIS during trading hours (2026-11-05), only these symbols' rows.
const fixture = (name) => readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8");
const OPEN = fixture("mis-open");
const LIMITS = fixture("mis-limits");
const cfg = { misUrl: MIS_URL };
const answer = (text) => ({ status: 200, ok: true, text });
const decode = (symbols, response, now = 1) => mis.decode(mis.requests(symbols, cfg)[0], response, now);
// The recorded 2330 row with some fields replaced.
const row2330 = (fields) => {
  const body = JSON.parse(OPEN);
  return answer(JSON.stringify({ ...body, msgArray: [{ ...body.msgArray[0], ...fields }] }));
};

test("constants", () => {
  assert.equal(MIS_URL, "https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
  assert.equal(MIS_BATCH, 50);
  assert.equal(MIS_CONSENT_VERSION, 1);
  assert.equal(mis.id, "mis");
  assert.deepEqual(mis.markets, ["tw"]);
  assert.equal(mis.overlay, true);
  assert.equal(mis.spacingMs(3, 10_000), 0);
  assert.equal(mis.intervalMs("open"), 10_000);
  assert.equal(mis.intervalMs("unknown"), 10_000);
  for (const session of ["closed", "pre", "post"]) assert.equal(mis.intervalMs(session), 60_000, session);
});

test("channels keep case", () => {
  assert.equal(misChannel("2330.TW"), "tse_2330.tw");
  assert.equal(misChannel("6488.TWO"), "otc_6488.tw");
  assert.equal(misChannel("00632R.TW"), "tse_00632R.tw");
});

test("batches of 50 and none when empty", () => {
  assert.deepEqual(mis.requests([], cfg), []);
  const symbols = Array.from({ length: 51 }, (_, i) => `${1000 + i}.TW`);
  const requests = mis.requests(symbols, cfg);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.symbols.length), [50, 1]);
  for (const request of requests) {
    assert.ok(request.url.startsWith(cfg.misUrl + "?"), request.url);
    assert.equal(request.kind, "quote");
    assert.equal(request.headers["User-Agent"], USER_AGENT);
  }
  assert.equal(mis.requests(["2330.TW", "6488.TWO"], cfg)[0].url, `${MIS_URL}?ex_ch=tse_2330.tw|otc_6488.tw&json=1&delay=0`);
  // The person's address is used as written.
  assert.ok(mis.requests(["2330.TW"], { misUrl: "https://mirror.test/mis" })[0].url.startsWith("https://mirror.test/mis?ex_ch="));
});

test("decodes the recorded answer", () => {
  const body = JSON.parse(OPEN);
  const result = decode(["2330.TW", "0050.TW"], answer(OPEN), 42);
  assert.deepEqual(Object.keys(result.quotes).sort(), ["0050.TW", "2330.TW"]);
  // 00632R.TW is in the answer but was not asked for.
  assert.equal(result.quotes["00632R.TW"], undefined);
  assert.deepEqual(result.errors, {});
  const etf = result.quotes["0050.TW"];
  const row = body.msgArray[1];
  assert.equal(etf.price, Number(row.z));
  assert.equal(etf.timestamp, Number(row.tlong));
  assert.deepEqual(etf, {
    symbol: "0050.TW", source: "mis", name: row.n, price: 98.7, previousClose: 99.85,
    open: 99.4, high: 99.75, low: 97.6, timestamp: Number(row.tlong), fetchedAt: 42,
  });
  // No trade in the last snapshot: the best bid/ask midpoint.
  assert.equal(result.quotes["2330.TW"].price, (2265 + 2270) / 2);
});

test("midpoint and no price", () => {
  assert.equal(decode(["2330.TW"], row2330({ z: "-", b: "100.5_100_", a: "101.5_102_", u: "-", w: "-" })).quotes["2330.TW"].price, 101);
  const none = decode(["2330.TW"], row2330({ z: "-", b: "-", a: "0.0000" }));
  assert.deepEqual(none, { quotes: {}, errors: {} });
  // One side only is not a midpoint.
  assert.deepEqual(decode(["2330.TW"], row2330({ z: "-", b: "-", a: "2270.0000_" })), { quotes: {}, errors: {} });
  assert.deepEqual(decode(["2330.TW"], row2330({ tlong: "-" })), { quotes: {}, errors: {} });
});

test("limit check", () => {
  assert.equal(withinLimits(2600, 2520, 2070), false);
  assert.equal(withinLimits(2000, 2520, 2070), false);
  assert.equal(withinLimits(2500, 2520, 2070), true);
  assert.equal(withinLimits(2520, 2520, 2070), true);
  assert.equal(withinLimits(80, 9999.95, null), true);
  assert.equal(withinLimits(80, null, 70), true);
  assert.equal(withinLimits(80, undefined, undefined), true);
  const above = decode(["2330.TW"], row2330({ z: "2600.0000" }));
  assert.deepEqual(above.quotes, {});
  assert.equal(above.errors["2330.TW"].code, "mis.outOfLimits");
  // A fund without limits (limit-up 9999.95, no limit-down) is used unchecked.
  const free = decode(["00646.TW"], answer(LIMITS));
  assert.equal(free.quotes["00646.TW"].price, (79.55 + 79.65) / 2);
  assert.deepEqual(free.errors, {});
});

test("HTML answer fails visibly", () => {
  const result = decode(["2330.TW", "0050.TW"], { status: 200, ok: true, text: "<html>" });
  assert.deepEqual(result.quotes, {});
  for (const symbol of ["2330.TW", "0050.TW"]) assert.equal(result.errors[symbol].code, "mis.unreadable", symbol);
  assert.equal(decode(["2330.TW"], answer("{}")).errors["2330.TW"].code, "mis.unreadable");
  const refused = decode(["2330.TW"], { status: 503, ok: false, text: "" });
  assert.deepEqual([refused.errors["2330.TW"].code, refused.errors["2330.TW"].params], ["mis.http", { status: 503 }]);
  assert.equal(decode(["2330.TW"], { status: 429, ok: false, text: "" }).errors["2330.TW"].retryAfterMs, 60_000);
});

// ---- Overlay over Yahoo, and routing through the scheduler ----

const YAHOO_2330 = {
  symbol: "2330.TW", source: "yahoo", name: "Taiwan Semiconductor", price: 2200, changePercent: -2.65, currency: "TWD",
  timestamp: 1_000, fetchedAt: 2_000, delaySeconds: null, series: [2190, 2200], open: 2250, high: 2260, low: 2180,
  previousClose: 2260, periods: { pre: null, regular: [0, 10_000], post: null },
};
const MIS_2330 = {
  symbol: "2330.TW", source: "mis", name: "台積電", price: 2267.5, previousClose: 2260, open: 2250, high: 2285, low: null,
  timestamp: 5_000, fetchedAt: 5_500,
};

test("overlay merges over Yahoo", () => {
  const merged = mergeOverlay(YAHOO_2330, MIS_2330);
  assert.equal(merged.price, 2267.5);
  assert.equal(merged.timestamp, 5_000);
  assert.equal(merged.fetchedAt, 5_500);
  assert.equal(merged.source, "mis");
  // The name stays Yahoo's; MIS's Chinese name rides along for the Chinese interfaces.
  assert.equal(merged.name, "Taiwan Semiconductor");
  assert.equal(merged.localName, "台積電");
  assert.equal(merged.high, 2285);
  // A field MIS did not send keeps Yahoo's.
  assert.equal(merged.low, 2180);
  assert.equal(merged.changePercent, (2267.5 - 2260) / 2260 * 100);
  assert.equal(merged.delaySeconds, 0);
  assert.deepEqual(merged.series, YAHOO_2330.series);
  assert.deepEqual(merged.periods, YAHOO_2330.periods);
  assert.equal(merged.currency, "TWD");
  assert.equal(merged.chartSource, "yahoo");
  // Without a Yahoo quote yet: MIS's price, no line, no session.
  const alone = mergeOverlay(undefined, MIS_2330);
  assert.equal(alone.price, MIS_2330.price);
  assert.deepEqual(alone.series, []);
  assert.equal(alone.periods, null);
  assert.equal(alone.chartSource, null);
  assert.equal(alone.name, null);
  assert.equal(alone.localName, "台積電");
  assert.equal(mergeOverlay(YAHOO_2330, undefined), YAHOO_2330);
  assert.equal(mergeOverlay(undefined, undefined), undefined);
});

const CONSENTED = { version: 1, sources: { tw: { provider: "mis", misAck: { version: MIS_CONSENT_VERSION } } } };
const yahooTw = (url) => chart({
  symbol: decodeURIComponent(url.split("/chart/")[1].split("?")[0]), regularMarketPrice: 2200,
  regularMarketTime: 1, previousClose: 2260, currency: "TWD",
});
const misCount = (host) => host.requests.filter((url) => url.startsWith(MIS_URL)).length;

function twHost(prefs, misAnswer = () => answer(OPEN)) {
  const host = fakeHost((url) => (url.startsWith(MIS_URL) ? host.mis(url) : yahooTw(url)));
  host.mis = misAnswer;
  host.prefs = prefs;
  return host;
}

test("MIS stays off until the current consent is given", async () => {
  for (const prefs of [undefined, { version: 1, sources: { tw: { provider: "mis", misAck: null } } },
    { version: 1, sources: { tw: { provider: "mis", misAck: { version: MIS_CONSENT_VERSION - 1 } } } }]) {
    const host = twHost(prefs);
    const w = new Watchlist(host);
    w.add("2330.TW");
    const runs = start(w, host);
    await advance(host, 61_000);
    assert.equal(misCount(host), 0, JSON.stringify(prefs));
    assert.equal(w.shown("2330.TW").source, "yahoo");
    const asked = prefs?.sources.tw.provider === "mis";
    assert.deepEqual(w.problems(), asked ? [{ provider: "mis", code: "mis.reconfirm", params: {} }] : []);
    await stop(w, host, runs);
  }
});

test("MIS overlays Yahoo every 10 s, even while Yahoo hangs", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW"); w.add("0050.TW");
  const runs = start(w, host);
  await advance(host, 1);
  // One request for both symbols.
  assert.equal(host.requests.filter((url) => url.startsWith(MIS_URL))[0], `${MIS_URL}?ex_ch=tse_2330.tw|tse_0050.tw&json=1&delay=0`);
  const quote = w.shown("2330.TW");
  assert.deepEqual([quote.source, quote.price, quote.chartSource, quote.currency], ["mis", 2267.5, "yahoo", "TWD"]);
  assert.equal(w.quotes["2330.TW"].source, "yahoo");
  assert.deepEqual(w.problems(), []);
  await stop(w, host, runs);

  const hung = twHost(CONSENTED);
  const fetch = hung.fetch;
  hung.fetch = (url, headers) => (url.startsWith(MIS_URL) ? fetch(url, headers) : (hung.requests.push(url), new Promise(() => {})));
  const v = new Watchlist(hung);
  v.add("2330.TW");
  const hungRuns = start(v, hung);
  await advance(hung, 31_000);
  assert.ok(misCount(hung) >= 3, `${misCount(hung)} MIS requests`);
  // No Yahoo quote yet: the MIS price shows, with no session.
  assert.equal(v.shown("2330.TW").source, "mis");
  await stop(v, hung, hungRuns);
});

test("any MIS failure drops the overlay at once", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "mis");
  host.mis = () => { throw new Error("offline"); };
  await advance(host, 10_001);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  assert.equal(w.shown("2330.TW").price, 2200);
  assert.equal(w.overlayErrors["2330.TW"].code, "mis.unreachable");
  // Yahoo's own quote is fine, so the row has no error of its own.
  assert.equal(w.errors["2330.TW"], undefined);
  assert.deepEqual(w.problems(), [{ provider: "mis", code: "mis.unreachable", params: {} }]);
  // Back: the overlay returns, the reason goes.
  host.mis = () => answer(OPEN);
  await advance(host, 20_002);
  assert.equal(w.shown("2330.TW").source, "mis");
  assert.equal(w.overlayErrors["2330.TW"], undefined);
  assert.deepEqual(w.problems(), []);
  await stop(w, host, runs);
});

test("a price outside the limits falls back for that symbol only", async () => {
  const host = twHost(CONSENTED, () => {
    const body = JSON.parse(OPEN);
    body.msgArray[0].z = "2600.0000";
    return answer(JSON.stringify(body));
  });
  const w = new Watchlist(host);
  w.add("2330.TW"); w.add("0050.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  assert.equal(w.overlayErrors["2330.TW"].code, "mis.outOfLimits");
  assert.equal(w.shown("0050.TW").source, "mis");
  // One symbol's price, not the source: no status line for MIS.
  assert.deepEqual(w.problems(), []);
  await stop(w, host, runs);
});

test("no price drops the overlay without an error", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "mis");
  host.mis = () => row2330({ z: "-", b: "-", a: "0.0000" });
  await advance(host, 10_001);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  assert.equal(w.overlayErrors["2330.TW"], undefined);
  await stop(w, host, runs);
});

test("turning MIS off drops the overlay at once", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "mis");
  host.prefs = { version: 1, sources: { tw: { provider: "yahoo", misAck: { version: MIS_CONSENT_VERSION } } } };
  assert.equal(w.sync(), true);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  const sent = misCount(host);
  await advance(host, 61_000);
  assert.equal(misCount(host), sent);
  await stop(w, host, runs);
});

test("an MIS address change is used at once", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  host.prefs = { version: 1, sources: { tw: { ...CONSENTED.sources.tw, misUrl: "https://mirror.test/mis" } } };
  assert.equal(w.sync(), true);
  await advance(host, 2);
  assert.ok(host.requests.some((url) => url.startsWith("https://mirror.test/mis?ex_ch=tse_2330.tw")));
  await stop(w, host, runs);
});

// An answer with a valid row for every requested channel.
const rowsFor = (url) => {
  const template = JSON.parse(OPEN).msgArray[1];
  const channels = decodeURIComponent(url.split("ex_ch=")[1].split("&")[0]).split("|");
  return answer(JSON.stringify({ msgArray: channels.map((channel) => {
    const [ex, rest] = channel.split("_");
    return { ...template, ex, c: rest.replace(/\.tw$/, "") };
  }) }));
};

test("a MIS timeout drops the overlay", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "mis");
  host.mis = () => new Promise(() => {});
  const fetch = host.fetch;
  host.fetch = (url, headers) => (url.startsWith(MIS_URL) ? (host.requests.push(url), host.mis(url)) : fetch(url, headers));
  // The next round starts at 10 s and times out 10 s later.
  await advance(host, 20_001);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  assert.equal(w.overlayErrors["2330.TW"].code, "request.timeout");
  assert.deepEqual(w.problems(), [{ provider: "mis", code: "request.timeout", params: { source: "mis", seconds: 10 } }]);
  await stop(w, host, runs);
});

test("a MIS rate limit keeps Yahoo's quote for the whole cooldown", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.shown("2330.TW").source, "mis");
  host.mis = () => ({ status: 429, ok: false, text: "" });
  await advance(host, 10_001);
  const retryAt = w.sources.mis.retryAt;
  assert.ok(retryAt >= 10_000 + 60_000, `retryAt ${retryAt}`);
  const sent = misCount(host);
  host.mis = () => answer(OPEN);
  for (const at of [10_001, 30_000, retryAt - 1]) {
    await advance(host, at);
    assert.equal(w.shown("2330.TW").source, "yahoo", `at ${at}`);
    assert.equal(w.overlayErrors["2330.TW"].code, "mis.rateLimited");
    assert.deepEqual(w.problems(), [{ provider: "mis", code: "mis.rateLimited", params: {} }]);
  }
  assert.equal(misCount(host), sent);
  await stop(w, host, runs);
});

test("a later batch loses its overlays when an earlier one fails", async () => {
  const symbols = Array.from({ length: 51 }, (_, i) => `${1101 + i}.TW`);
  const failures = [
    [() => { throw new Error("offline"); }, "mis.unreachable"],
    [() => ({ status: 429, ok: false, text: "" }), "request.deferred"],
  ];
  for (const [failure, later] of failures) {
    const host = twHost(CONSENTED, rowsFor);
    const w = new Watchlist(host);
    for (const symbol of symbols) w.add(symbol);
    const runs = start(w, host);
    await advance(host, 1);
    assert.ok(symbols.every((symbol) => w.shown(symbol)?.source === "mis"));
    let batch = 0;
    host.mis = (url) => (batch++ === 0 ? failure() : rowsFor(url));
    await advance(host, 10_001);
    for (const symbol of symbols) {
      assert.equal(w.overlays[symbol], undefined, symbol);
      assert.ok(w.overlayErrors[symbol], symbol);
    }
    // The second batch (the 51st symbol) was never asked: down means the same reason, limited means deferred.
    assert.equal(batch, 1);
    assert.equal(w.overlayErrors[symbols[50]].code, later);
    await stop(w, host, runs);
  }
});

test("a Taiwan name follows the interface language", () => {
  const merged = mergeOverlay(YAHOO_2330, MIS_2330);
  for (const lang of ["zh-TW", "zh-CN"]) assert.equal(displayName(merged, lang), "台積電", lang);
  // English, Japanese and Korean keep Yahoo's name, with MIS on or off.
  for (const lang of ["en", "ja", "ko"]) {
    assert.equal(displayName(merged, lang), "Taiwan Semiconductor", lang);
    assert.equal(displayName(YAHOO_2330, lang), "Taiwan Semiconductor", lang);
  }
  assert.equal(displayName(YAHOO_2330, "zh-TW"), "Taiwan Semiconductor");
  const alone = mergeOverlay(undefined, MIS_2330);
  assert.equal(displayName(alone, "zh-TW"), "台積電");
  assert.equal(displayName(alone, "en"), null);
});

test("the detail line puts the chart's delay on the chart", () => {
  const say = (lang) => (key, params) => t(lang, key, params);
  const merged = mergeOverlay(YAHOO_2330, MIS_2330);
  assert.deepEqual(detailSource(merged, "open", 5_000, say("zh-TW")), ["價格：證交所 MIS", "走勢：Yahoo（延遲 20 分鐘）"]);
  assert.deepEqual(detailSource(merged, "open", 5_000, say("en")), ["Price: TWSE MIS", "Line: Yahoo (delayed 20 min)"]);
  // The base's own delay is kept for the chart: Yahoo's reported value, or none.
  const us = { ...YAHOO_2330, symbol: "AAPL", delaySeconds: 900 };
  // Any real-time overlay over a US Yahoo quote (Finnhub's case).
  const over = { ...MIS_2330, symbol: "AAPL" };
  assert.equal(mergeOverlay(us, over).chartDelaySeconds, 900);
  assert.deepEqual(detailSource(mergeOverlay(us, over), "open", 5_000, say("en")), ["Price: TWSE MIS", "Line: Yahoo (delayed 15 min)"]);
  assert.deepEqual(detailSource(mergeOverlay({ ...us, delaySeconds: null }, over), "open", 5_000, say("en"))[1], "Line: Yahoo (delay not provided)");
  // A real-time price before Yahoo's first quote; a plain Yahoo row keeps its wording.
  assert.deepEqual(detailSource(mergeOverlay(undefined, MIS_2330), "unknown", 5_000, say("en")), ["Price: TWSE MIS"]);
  assert.deepEqual(detailSource(YAHOO_2330, "open", 5_000, say("en")), ["Yahoo Finance · regular session", "delayed 20 min"]);
  assert.deepEqual(detailSource({ ...YAHOO_2330, symbol: "BTC/USDT", source: "binance", periods: null }, "24h", 5_000, say("en")), ["Binance Spot · 24h"]);
});

test("a Chinese interface keeps the last MIS name while MIS fails", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  const yahooName = w.quotes["2330.TW"].name;
  assert.equal(displayName(w.shown("2330.TW"), "zh-TW"), "台積電");
  host.mis = () => { throw new Error("offline"); };
  await advance(host, 10_001);
  assert.equal(w.shown("2330.TW").source, "yahoo");
  for (const lang of ["zh-TW", "zh-CN"]) assert.equal(displayName(w.shown("2330.TW"), lang), "台積電", lang);
  for (const lang of ["en", "ja", "ko"]) assert.equal(displayName(w.shown("2330.TW"), lang), yahooName, lang);
  // Turned off: Yahoo's name again.
  host.prefs = { version: 1, sources: { tw: { provider: "yahoo", misAck: { version: MIS_CONSENT_VERSION } } } };
  w.sync();
  assert.equal(displayName(w.shown("2330.TW"), "zh-TW"), yahooName);
  assert.deepEqual(w.localNames, {});
  await stop(w, host, runs);
});

test("a removed symbol forgets its MIS name", async () => {
  const host = twHost(CONSENTED);
  const w = new Watchlist(host);
  w.add("2330.TW");
  const runs = start(w, host);
  await advance(host, 1);
  assert.equal(w.localNames["2330.TW"], "台積電");
  w.remove("2330.TW");
  assert.equal(w.localNames["2330.TW"], undefined);
  await stop(w, host, runs);
});
