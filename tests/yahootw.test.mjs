// node --test tests/  (providers/yahootw.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { USER_AGENT } from "../mods/wickline/quotes.js";
import {
  YAHOOTW_BASE, YAHOOTW_BATCH, YAHOOTW_CONSENT_VERSION, decodeStockList, decodeTick, taipeiDay, yahootw,
} from "../mods/wickline/providers/yahootw.js";
import { t } from "../mods/wickline/i18n.js";

// A recorded price answer (2026-11-09, during trading hours), trimmed to the fields Wickline reads.
const ROWS = JSON.parse(readFileSync(new URL("fixtures/yahootw-stocklist.json", import.meta.url), "utf8"));
// 09:41:20 in Taipei, seven seconds after the answer's newest trade.
const NOW = 1794188480000;
const SYMBOLS = ["2330.TW", "0056.TW", "0050.TW", "6488.TWO"];
const answer = (rows) => ({ status: 200, ok: true, text: JSON.stringify(rows) });
// The recorded rows with some rows' fields replaced, by symbol.
const changed = (bySymbol) => answer(ROWS.map((row) => ({ ...row, ...bySymbol[row.symbol] })));
const decode = (response, symbols = SYMBOLS) => yahootw.decode(yahootw.requests(symbols)[0], response, NOW);

test("constants and cadence", () => {
  assert.equal(YAHOOTW_BASE, "https://tw.stock.yahoo.com/_td-stock/api/resource/");
  assert.equal(YAHOOTW_BATCH, 50);
  assert.equal(YAHOOTW_CONSENT_VERSION, 1);
  assert.equal(yahootw.id, "yahootw");
  assert.deepEqual(yahootw.markets, ["tw"]);
  assert.equal(yahootw.overlay, true);
  assert.equal(yahootw.spacingMs(3, 10_000), 0);
  assert.equal(yahootw.intervalMs("open"), 10_000);
  assert.equal(yahootw.intervalMs("unknown"), 10_000);
  for (const session of ["closed", "pre", "post"]) assert.equal(yahootw.intervalMs(session), 60_000, session);
});

test("line cadence", () => {
  assert.equal(yahootw.linesPerRound, 3);
  assert.equal(yahootw.linesMs("open"), 120_000);
  assert.equal(yahootw.linesMs("unknown"), 120_000);
  assert.equal(yahootw.linesMs("closed"), 600_000);
});

test("a Taipei day turns at midnight in Taipei, not UTC", () => {
  assert.equal(taipeiDay(Date.parse("2026-11-08T16:00:00Z")), taipeiDay(Date.parse("2026-11-09T15:59:59Z")));
  assert.equal(taipeiDay(Date.parse("2026-11-08T15:59:59Z")) + 1, taipeiDay(Date.parse("2026-11-08T16:00:00Z")));
  assert.equal(taipeiDay(NOW), taipeiDay(Date.parse("2026-11-09T01:41:13Z")));
});

test("requests: batches of 50 to the fixed host, then one line request per symbol", () => {
  assert.deepEqual(yahootw.requests([]), []);
  const symbols = Array.from({ length: 51 }, (_, i) => `${1101 + i}.TW`);
  const all = yahootw.requests(symbols);
  const requests = all.filter((r) => r.kind === "quote");
  assert.deepEqual(all.slice(0, 2), requests);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.symbols.length), [50, 1]);
  const lines = all.slice(2);
  assert.deepEqual(lines.map((r) => [r.kind, r.symbols]), symbols.map((symbol) => ["line", [symbol]]));
  assert.equal(lines[0].url, YAHOOTW_BASE + "FinanceChartService.ApacLibraCharts;type=tick;symbols=%5B%221101.TW%22%5D");
  for (const request of lines) assert.equal(request.headers["User-Agent"], USER_AGENT);
  assert.equal(requests[0].url, YAHOOTW_BASE + "StockServices.stockList;symbols=" + symbols.slice(0, 50).join(","));
  for (const request of requests) {
    assert.equal(request.kind, "quote");
    assert.equal(request.headers["User-Agent"], USER_AGENT);
  }
  // The host is fixed: no address in the settings changes it.
  assert.equal(yahootw.requests(["2330.TW"], { misUrl: "https://mirror.test" })[0].url,
    "https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;symbols=2330.TW");
});

test("prices today's rows with the answer's newest trade as their time", () => {
  const { quotes } = decode(answer(ROWS));
  const newest = Date.parse("2026-11-09T01:41:13Z");
  assert.deepEqual(quotes["2330.TW"], {
    symbol: "2330.TW", source: "yahootw", name: "台積電", price: 2240, previousClose: 2135, open: 2210, high: 2240, low: 2190,
    timestamp: newest, tradeTime: newest, fetchedAt: NOW,
  });
  // A quiet stock is as current as the feed; its own last trade is kept apart.
  assert.equal(quotes["0050.TW"].price, 10.05);
  assert.equal(quotes["0050.TW"].timestamp, newest);
  assert.equal(quotes["0050.TW"].tradeTime, Date.parse("2026-11-09T01:17:12Z"));
  for (const quote of Object.values(quotes)) {
    assert.equal(quote.source, "yahootw");
    assert.equal(quote.fetchedAt, NOW);
  }
});

test("a placeholder row gives a name only", () => {
  const { quotes, errors, names } = decode(answer(ROWS));
  assert.equal(quotes["0056.TW"], undefined);
  assert.equal(errors["0056.TW"], undefined);
  assert.equal(names["0056.TW"], "元大高股息");
});

test("a stock locked at limit-up is priced at the limit", () => {
  assert.equal(decode(answer(ROWS)).quotes["6488.TWO"].price, 563);
});

test("a price above limit-up is refused with a reason", () => {
  const { quotes, errors } = decode(changed({ "2330.TW": { price: { raw: "2400" } } }));
  assert.equal(quotes["2330.TW"], undefined);
  assert.equal(errors["2330.TW"].code, "yahootw.outOfLimits");
  // The other rows are not affected.
  assert.ok(quotes["0050.TW"] && quotes["6488.TWO"]);
});

test("yesterday's row and delayed data give no overlay, and do not move the feed time", () => {
  const { quotes, errors } = decode(changed({
    "2330.TW": { regularMarketTime: "2026-11-08T05:30:00Z" },
    "0050.TW": { exchangeDataDelayedBy: 1200 },
  }));
  for (const symbol of ["2330.TW", "0050.TW"]) {
    assert.equal(quotes[symbol], undefined, symbol);
    assert.equal(errors[symbol], undefined, symbol);
  }
  assert.equal(quotes["6488.TWO"].timestamp, Date.parse("2026-11-09T01:28:59Z"));
});

test("only requested rows are accepted", () => {
  const { quotes, names } = decode(answer(ROWS), ["2330.TW"]);
  assert.deepEqual(Object.keys(quotes), ["2330.TW"]);
  assert.deepEqual(Object.keys(names), ["2330.TW"]);
});

test("a symbol missing from the answer has no overlay and no error", () => {
  const { quotes, errors } = decode(answer(ROWS), ["2936.TW"]);
  assert.deepEqual(quotes, {});
  assert.deepEqual(errors, {});
});

test("403 and 429 back off with their own codes", () => {
  for (const [status, code] of [[403, "yahootw.refused"], [429, "yahootw.rateLimited"]]) {
    const { quotes, errors } = decode({ status, ok: false, text: "" });
    assert.deepEqual(quotes, {});
    for (const symbol of SYMBOLS) {
      assert.equal(errors[symbol].code, code, `${status} ${symbol}`);
      assert.equal(errors[symbol].retryAfterMs, 60_000, `${status} ${symbol}`);
    }
  }
  const { errors } = decode({ status: 500, ok: false, text: "" });
  assert.deepEqual([errors["2330.TW"].code, errors["2330.TW"].params], ["yahootw.http", { status: 500 }]);
  assert.equal(errors["2330.TW"].retryAfterMs, undefined);
});

test("an unreadable answer", () => {
  for (const text of ["<html>", JSON.stringify({ message: "x" })]) {
    const { errors } = decode({ status: 200, ok: true, text });
    for (const symbol of SYMBOLS) assert.equal(errors[symbol].code, "yahootw.unreadable", `${text} ${symbol}`);
  }
});

test("decodeStockList throws what the round shows for each symbol", () => {
  assert.throws(() => decodeStockList(SYMBOLS, { status: 200, ok: true, text: "<html>" }, NOW), (e) => e.code === "yahootw.unreadable");
  assert.equal(decodeStockList(SYMBOLS, answer(ROWS), NOW).quotes["2330.TW"].price, 2240);
});

// A line answer: one minute per close from 09:00 Taipei on the clock's day (`start`, epoch seconds).
const TODAY_0900 = 1794186000;
const tick = (symbol, closes, start = TODAY_0900, answered = symbol) => answer([{
  symbol, chart: { meta: { symbol: answered }, timestamp: closes.map((_, i) => start + i * 60), indicators: { quote: [{ close: closes }] } },
}]);
const TICK = readFileSync(new URL("fixtures/yahootw-tick.json", import.meta.url), "utf8");
const TICK_QUIET = readFileSync(new URL("fixtures/yahootw-tick-quiet.json", import.meta.url), "utf8");
const lineOf = (symbol, response) => yahootw.decode(yahootw.requests([symbol]).find((r) => r.kind === "line"), response, NOW);

test("keeps today's minutes, carrying the last close over quiet minutes", () => {
  assert.deepEqual(lineOf("2330.TW", tick("2330.TW", [null, 10.05, null, null, 10.10])).lines,
    { "2330.TW": [10.05, 10.05, 10.05, 10.10] });
});

test("the liquid fixture", () => {
  const { quotes, errors, lines } = lineOf("2330.TW", { status: 200, ok: true, text: TICK });
  assert.deepEqual([quotes, errors], [{}, {}]);
  // 31 minutes, the first without a trade.
  assert.equal(lines["2330.TW"].length, 30);
  assert.equal(lines["2330.TW"][0], 2200);
  assert.equal(lines["2330.TW"].at(-1), 2210);
});

test("the quiet fixture", () => {
  assert.deepEqual(lineOf("0050.TW", { status: 200, ok: true, text: TICK_QUIET }).lines, { "0050.TW": [10.05] });
});

test("yesterday's points are dropped", () => {
  const { errors, lines } = lineOf("2330.TW", tick("2330.TW", [2200, 2205], TODAY_0900 - 86_400));
  assert.deepEqual(errors, {});
  assert.equal(lines?.["2330.TW"], undefined);
  // Yesterday's last close is not carried into today's first quiet minute.
  assert.deepEqual(decodeTick("2330.TW", answer([{ symbol: "2330.TW", chart: {
    meta: { symbol: "2330.TW" }, timestamp: [TODAY_0900 - 86_400, TODAY_0900, TODAY_0900 + 60],
    indicators: { quote: [{ close: [2200, null, 2210] }] },
  } }]), NOW).lines, { "2330.TW": [2210] });
});

test("another symbol is refused", () => {
  const { errors, lines } = lineOf("2330.TW", tick("2330.TW", [2200], TODAY_0900, "2317.TW"));
  assert.equal(errors["2330.TW"].code, "yahootw.otherTicker");
  assert.equal(lines, undefined);
  assert.equal(t("zh-TW", "yahootw.otherTicker"), "Yahoo 奇摩股市回傳了不同的代號。");
});

test("a line answer that is empty or has no chart is unreadable", () => {
  for (const body of [[], [{ symbol: "2330.TW" }], { chart: {} }]) {
    assert.equal(lineOf("2330.TW", answer(body)).errors["2330.TW"].code, "yahootw.unreadable", JSON.stringify(body));
  }
});

test("404 gives yahootw.http", () => {
  const { errors } = lineOf("2330.TW", { status: 404, ok: false, text: "" });
  assert.deepEqual([errors["2330.TW"].code, errors["2330.TW"].params], ["yahootw.http", { status: 404 }]);
  assert.equal(errors["2330.TW"].retryAfterMs, undefined);
  for (const status of [403, 429]) assert.equal(lineOf("2330.TW", { status, ok: false, text: "" }).errors["2330.TW"].retryAfterMs, 60_000);
});
