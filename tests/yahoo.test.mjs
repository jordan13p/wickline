// node --test tests/  (the Yahoo provider imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT } from "../mods/wickline/quotes.js";
import { marketSession } from "../mods/wickline/freshness.js";
import { decodeYahoo, yahoo, yahooUrl } from "../mods/wickline/providers/yahoo.js";
import { ok, chart } from "./helpers.mjs";

const AAPL = { symbol: "AAPL", regularMarketPrice: 230.1, regularMarketTime: 1_760_000_000, previousClose: 225, currency: "USD", longName: "Apple Inc." };

test("builds the request URL", () => {
  assert.equal(yahooUrl("^GSPC"), "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=5m&range=1d&includePrePost=false");
});

test("decodes Yahoo quotes and refuses another ticker", () => {
  const q = decodeYahoo("AAPL", chart(AAPL), 1);
  assert.equal(q.name, "Apple Inc.");
  assert.ok(Math.abs(q.changePercent - 2.2667) < 0.001);
  assert.throws(() => decodeYahoo("MSFT", chart(AAPL), 1), /different ticker/);
  // The exchange it reports gives an index its market; anything but a short code is dropped.
  assert.equal(decodeYahoo("AAPL", chart({ ...AAPL, exchangeName: "NMS" }), 1).exchange, "NMS");
  assert.equal(decodeYahoo("AAPL", chart(AAPL), 1).exchange, null);
  for (const bad of ["nms", "TOOLONGX", "N", 7, "N M"]) assert.equal(decodeYahoo("AAPL", chart({ ...AAPL, exchangeName: bad }), 1).exchange, null, String(bad));
  assert.throws(() => decodeYahoo("AAPL", { status: 429, ok: false, text: "" }, 1), (e) => e.retryAfterMs === 60_000);
  assert.throws(() => decodeYahoo("AAPL", { status: 200, ok: true, text: "<html>" }, 1), /unreadable/);
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

test("yahoo requests one symbol at a time", () => {
  const requests = yahoo.requests(["AAPL", "MSFT"], {});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, yahooUrl("AAPL"));
  assert.equal(requests[1].url, yahooUrl("MSFT"));
  assert.deepEqual(requests.map((r) => r.symbols), [["AAPL"], ["MSFT"]]);
  for (const request of requests) {
    assert.equal(request.kind, "quote");
    assert.equal(request.headers["User-Agent"], USER_AGENT);
  }
});

test("errors carry codes and the old English text", () => {
  assert.throws(() => decodeYahoo("AAPL", { status: 429, ok: false, text: "" }, 1), (e) =>
    e.code === "yahoo.rateLimited" && e.message === "Yahoo rate limited requests." && e.retryAfterMs === 60_000);
});
