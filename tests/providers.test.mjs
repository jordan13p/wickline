// node --test tests/  (the providers import nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT } from "../mods/bellwether/quotes.js";
import { decodeYahoo, yahoo, yahooUrl } from "../mods/bellwether/providers/yahoo.js";
import { binance, binanceKlinesUrl, binanceUrl } from "../mods/bellwether/providers/binance.js";

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

test("binance batches quotes and asks lines per pair", () => {
  const requests = binance.requests(["BTC/USDT", "ETH/USDT"], {});
  assert.equal(requests.length, 3);
  assert.deepEqual(
    { kind: requests[0].kind, url: requests[0].url },
    { kind: "quote", url: binanceUrl(["BTC/USDT", "ETH/USDT"]) },
  );
  assert.deepEqual(requests.slice(1).map((r) => [r.kind, r.url]), [
    ["line", binanceKlinesUrl("BTC/USDT")], ["line", binanceKlinesUrl("ETH/USDT")],
  ]);
  for (const request of requests) assert.equal(request.headers["User-Agent"], USER_AGENT);
});

test("binance keeps each batch's lines before the next batch", () => {
  const pairs = Array.from({ length: 101 }, (_, i) => `P${i}/USDT`);
  const first = pairs.slice(0, 100);
  assert.deepEqual(binance.requests(pairs, {}).map((r) => [r.kind, r.url]), [
    ["quote", binanceUrl(first)],
    ...first.map((pair) => ["line", binanceKlinesUrl(pair)]),
    ["quote", binanceUrl([pairs[100]])],
    ["line", binanceKlinesUrl(pairs[100])],
  ]);
});

test("errors carry codes and the old English text", () => {
  assert.throws(() => decodeYahoo("AAPL", { status: 429, ok: false, text: "" }, 1), (e) =>
    e.code === "yahoo.rateLimited" && e.message === "Yahoo rate limited requests." && e.retryAfterMs === 60_000);
});
