// node --test tests/  (the Binance provider imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT } from "../mods/bellwether/quotes.js";
import { binance, binanceKlinesUrl, binanceUrl, decodeBinance, decodeKlines } from "../mods/bellwether/providers/binance.js";
import { ok } from "./helpers.mjs";

const BASE = "https://data-api.binance.vision";

test("builds the ticker URL", () => {
  assert.equal(binanceUrl(BASE, ["BTC/USDT", "ETH/USDT"]), "https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent('["BTCUSDT","ETHUSDT"]'));
});

test("decodes Binance tickers", () => {
  const quotes = decodeBinance(["BTC/USDT", "ETH/USDT"], ok([
    { symbol: "BTCUSDT", lastPrice: "65000.5", prevClosePrice: "64000", closeTime: 1_760_000_000_000 },
  ]), 1);
  assert.equal(quotes["BTC/USDT"].currency, "USDT");
  assert.equal(quotes["ETH/USDT"], undefined);
  assert.throws(() => decodeBinance(["X/Y"], { status: 400, ok: false, text: "" }, 1), (e) => e.invalidSymbol);
});

test("reads Binance's 24-hour line", () => {
  assert.equal(binanceKlinesUrl(BASE, "BTC/USDT"), "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=96");
  assert.deepEqual(decodeKlines(ok([[1, "1", "2", "0.5", "1.5"], [2, "1.5", "2", "1", "1.75"], "junk"])), [1.5, 1.75]);
  assert.throws(() => decodeKlines({ status: 400, ok: false, text: "" }));
});

test("binance batches quotes and asks lines per pair", () => {
  const requests = binance.requests(["BTC/USDT", "ETH/USDT"], { binanceUrl: BASE });
  assert.equal(requests.length, 3);
  assert.deepEqual(
    { kind: requests[0].kind, url: requests[0].url },
    { kind: "quote", url: binanceUrl(BASE, ["BTC/USDT", "ETH/USDT"]) },
  );
  assert.deepEqual(requests.slice(1).map((r) => [r.kind, r.url]), [
    ["line", binanceKlinesUrl(BASE, "BTC/USDT")], ["line", binanceKlinesUrl(BASE, "ETH/USDT")],
  ]);
  for (const request of requests) assert.equal(request.headers["User-Agent"], USER_AGENT);
});

test("binance keeps each batch's lines before the next batch", () => {
  const pairs = Array.from({ length: 101 }, (_, i) => `P${i}/USDT`);
  const first = pairs.slice(0, 100);
  assert.deepEqual(binance.requests(pairs, { binanceUrl: BASE }).map((r) => [r.kind, r.url]), [
    ["quote", binanceUrl(BASE, first)],
    ...first.map((pair) => ["line", binanceKlinesUrl(BASE, pair)]),
    ["quote", binanceUrl(BASE, [pairs[100]])],
    ["line", binanceKlinesUrl(BASE, pairs[100])],
  ]);
});

test("binance uses the configured base for tickers and lines", () => {
  const requests = binance.requests(["BTC/USDT"], { binanceUrl: "https://mirror.test" });
  assert.ok(requests[0].url.startsWith("https://mirror.test/api/v3/ticker/24hr?symbols="));
  assert.ok(requests[1].url.startsWith("https://mirror.test/api/v3/klines?symbol=BTCUSDT&interval=15m"));
  // A trailing slash or a path prefix still makes a clean address.
  assert.ok(binanceUrl("https://mirror.test/", ["BTC/USDT"]).startsWith("https://mirror.test/api/v3/ticker/24hr?"));
  assert.ok(binanceKlinesUrl("https://mirror.test/proxy//", "BTC/USDT").startsWith("https://mirror.test/proxy/api/v3/klines?"));
});
