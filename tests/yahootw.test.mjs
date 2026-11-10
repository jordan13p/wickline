// node --test tests/  (providers/yahootw.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, priceLimit } from "../mods/wickline/quotes.js";
import {
  YAHOOTW_BASE, YAHOOTW_BATCH, YAHOOTW_CONSENT_VERSION, decodeStockList, decodeTick, taipeiDay, tradingDay, yahootw,
} from "../mods/wickline/providers/yahootw.js";
import { t } from "../mods/wickline/i18n.js";
import {
  CLOSE_0509, EARLIER_ROWS, EARLIER_TICK, FUTURES_NIGHT_ROWS, FUTURES_ROWS, FUTURES_TICK, FUT_NOW, NIGHT, jsonFixture, ok,
} from "./helpers.mjs";
import { ownPeriods } from "../mods/wickline/providers/yahootw.js";

// A recorded price answer (2026-11-09, during trading hours), trimmed to the fields Wickline reads. Its last two
// rows, ^TWII and ^TWOII, were recorded after that day's close and keep their `exchange`.
const ROWS = jsonFixture("yahootw-stocklist");
// 09:41:20 in Taipei, seven seconds after the answer's newest trade.
const NOW = 1794188480000;
const SYMBOLS = ["2330.TW", "0056.TW", "0050.TW", "6488.TWO"];
// The recorded rows with some rows' fields replaced, by symbol.
const changed = (bySymbol) => ok(ROWS.map((row) => ({ ...row, ...bySymbol[row.symbol] })));
const decode = (response, symbols = SYMBOLS) => yahootw.decode(yahootw.requests(symbols)[0], response, NOW);

test("constants and cadence", () => {
  assert.equal(YAHOOTW_BASE, "https://tw.stock.yahoo.com/_td-stock/api/resource/");
  assert.equal(YAHOOTW_BATCH, 50);
  assert.equal(YAHOOTW_CONSENT_VERSION, 2);
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
  // A TW-only symbol may be priced from an earlier day: the batch's own ones ride on its price request.
  assert.deepEqual(yahootw.requests(["2330.TW", "^TWOII"], { twOnly: ["^TWOII", "^TWZZ"] }).map((r) => r.anyDay),
    [["^TWOII"], undefined, undefined]);
  assert.deepEqual(yahootw.requests(["2330.TW"])[0].anyDay, []);
  // The host is fixed: no address in the settings changes it.
  assert.equal(yahootw.requests(["2330.TW"], { misUrl: "https://mirror.test" })[0].url,
    "https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;symbols=2330.TW");
});

// An index's symbol starts with ^, which a URL must not carry bare.
test("stockList symbols are URL-encoded", () => {
  assert.ok(yahootw.requests(["^TWII", "2330.TW"])[0].url.endsWith("symbols=%5ETWII,2330.TW"));
});

// An index has no price limits: its rows say "-".
test("recorded index rows decode as overlays without limits", () => {
  const { quotes } = decode(ok(ROWS), ["^TWII"]);
  const index = quotes["^TWII"];
  assert.deepEqual([index.price, index.name, index.limitUp, index.limitDown], [41661.7, "加權指數", null, null]);
  assert.equal(priceLimit(index), null);
});

// An instrument only Yahoo 奇摩股市 has takes its market and currency from its row.
test("a row's exchange and currency reach the overlay; a malformed one is null", () => {
  const index = decode(ok(ROWS), ["^TWOII"]).quotes["^TWOII"];
  assert.deepEqual([index.exchange, index.currency], ["TWO", "TWD"]);
  const odd = decode(changed({ "^TWOII": { exchange: "two!", currency: "twd" } }), ["^TWOII"]).quotes["^TWOII"];
  assert.deepEqual([odd.exchange, odd.currency], [null, null]);
});

test("prices today's rows with the answer's newest trade as their time", () => {
  const { quotes } = decode(ok(ROWS));
  const newest = Date.parse("2026-11-09T01:41:13Z");
  assert.deepEqual(quotes["2330.TW"], {
    symbol: "2330.TW", source: "yahootw", name: "台積電", price: 2240, previousClose: 2135, open: 2210, high: 2240, low: 2190,
    limitUp: 2345, limitDown: 1925, exchange: null, currency: "TWD", timestamp: newest, tradeTime: newest, day: taipeiDay(NOW),
    fetchedAt: NOW,
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
  const { quotes, errors, names } = decode(ok(ROWS));
  assert.equal(quotes["0056.TW"], undefined);
  assert.equal(errors["0056.TW"], undefined);
  assert.equal(names["0056.TW"], "元大高股息");
});

test("a stock locked at limit-up is priced at the limit", () => {
  assert.equal(decode(ok(ROWS)).quotes["6488.TWO"].price, 563);
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

test("an answer with prices but none accepted says so; one with no price at all does not", () => {
  const delayed = decode(changed(Object.fromEntries(SYMBOLS.map((symbol) => [symbol, { exchangeDataDelayedBy: 1200 }]))));
  assert.deepEqual(delayed.quotes, {});
  assert.deepEqual(delayed.errors, {});
  assert.equal(delayed.noLive.code, "yahootw.noLiveRows");
  assert.equal(t("zh-TW", "yahootw.noLiveRows"), "Yahoo 奇摩股市回傳的報價都不是即時資料。");
  assert.equal(t("en", "yahootw.noLiveRows"), "Yahoo TW Stock returned no real-time prices.");
  const yesterday = decode(changed(Object.fromEntries(SYMBOLS.map((symbol) => [symbol, { regularMarketTime: "2026-11-08T05:30:00Z" }]))));
  assert.equal(yesterday.noLive.code, "yahootw.noLiveRows");
  // Before the open, or every stock halted: placeholders only.
  assert.equal(decode(ok([ROWS[1]])).noLive, undefined);
  // One live row is enough.
  assert.equal(decode(changed({ "2330.TW": { exchangeDataDelayedBy: 1200 } })).noLive, undefined);
  assert.equal(decode(ok(ROWS)).noLive, undefined);
});

test("only requested rows are accepted", () => {
  const { quotes, names } = decode(ok(ROWS), ["2330.TW"]);
  assert.deepEqual(Object.keys(quotes), ["2330.TW"]);
  assert.deepEqual(Object.keys(names), ["2330.TW"]);
});

test("a symbol missing from the answer has no overlay and no error", () => {
  const { quotes, errors } = decode(ok(ROWS), ["2936.TW"]);
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
  assert.equal(decodeStockList(SYMBOLS, ok(ROWS), NOW).quotes["2330.TW"].price, 2240);
});

// A line answer: one minute per close from 09:00 Taipei on the clock's day (`start`, epoch seconds).
const TODAY_0900 = 1794186000;
const tick = (symbol, closes, start = TODAY_0900, answered = symbol) => ok([{
  symbol, chart: { meta: { symbol: answered }, timestamp: closes.map((_, i) => start + i * 60), indicators: { quote: [{ close: closes }] } },
}]);
const lineOf = (symbol, response) => yahootw.decode(yahootw.requests([symbol]).find((r) => r.kind === "line"), response, NOW);

test("keeps today's minutes, carrying the last close over quiet minutes", () => {
  assert.deepEqual(lineOf("2330.TW", tick("2330.TW", [null, 10.05, null, null, 10.10])).lines,
    { "2330.TW": { day: taipeiDay(NOW), series: [10.05, 10.05, 10.05, 10.10], lastAt: (TODAY_0900 + 240) * 1000 } });
});

test("the liquid fixture", () => {
  const { quotes, errors, lines } = lineOf("2330.TW", ok(jsonFixture("yahootw-tick")));
  assert.deepEqual([quotes, errors], [{}, {}]);
  const { day, series } = lines["2330.TW"];
  assert.equal(day, taipeiDay(NOW));
  // 31 minutes, the first without a trade.
  assert.equal(series.length, 30);
  assert.equal(series[0], 2200);
  assert.equal(series.at(-1), 2210);
  // The last minute's time, 09:30 in Taipei.
  assert.equal(lines["2330.TW"].lastAt, Date.parse("2026-11-09T01:30:00Z"));
});

test("the quiet fixture", () => {
  assert.deepEqual(lineOf("0050.TW", ok(jsonFixture("yahootw-tick-quiet"))).lines,
    { "0050.TW": { day: taipeiDay(NOW), series: [10.05], lastAt: Date.parse("2026-11-09T01:18:00Z") } });
});

test("yesterday's points are dropped", () => {
  const { errors, lines } = lineOf("2330.TW", tick("2330.TW", [2200, 2205], TODAY_0900 - 86_400));
  assert.deepEqual(errors, {});
  assert.equal(lines?.["2330.TW"], undefined);
  // Yesterday's last close is not carried into today's first quiet minute.
  assert.deepEqual(decodeTick("2330.TW", ok([{ symbol: "2330.TW", chart: {
    meta: { symbol: "2330.TW" }, timestamp: [TODAY_0900 - 86_400, TODAY_0900, TODAY_0900 + 60],
    indicators: { quote: [{ close: [2200, null, 2210] }] },
  } }]), NOW).lines["2330.TW"].series, [2210]);
});

test("another symbol is refused", () => {
  const { errors, lines } = lineOf("2330.TW", tick("2330.TW", [2200], TODAY_0900, "2317.TW"));
  assert.equal(errors["2330.TW"].code, "yahootw.otherTicker");
  assert.equal(lines, undefined);
  assert.equal(t("zh-TW", "yahootw.otherTicker"), "Yahoo 奇摩股市回傳了不同的代號。");
});

test("a line answer that is empty or has no chart is unreadable", () => {
  for (const body of [[], [{ symbol: "2330.TW" }], { chart: {} }]) {
    assert.equal(lineOf("2330.TW", ok(body)).errors["2330.TW"].code, "yahootw.unreadable", JSON.stringify(body));
  }
});

test("404 gives yahootw.http", () => {
  const { errors } = lineOf("2330.TW", { status: 404, ok: false, text: "" });
  assert.deepEqual([errors["2330.TW"].code, errors["2330.TW"].params], ["yahootw.http", { status: 404 }]);
  assert.equal(errors["2330.TW"].retryAfterMs, undefined);
  for (const status of [403, 429]) assert.equal(lineOf("2330.TW", { status, ok: false, text: "" }).errors["2330.TW"].retryAfterMs, 60_000);
});

// The recorded answer has 6488.TWO at its limit-up (563/563) and 2330.TW at +4.9%, short of its 2345 (+9.84%, not 10%).
test("a Yahoo 奇摩股市 price at its own limit is at the limit", () => {
  const { quotes } = decode(ok(ROWS));
  assert.equal(quotes["6488.TWO"].limitUp, 563);
  assert.equal(quotes["6488.TWO"].limitDown, 461);
  assert.equal(priceLimit(quotes["6488.TWO"]), "up");
  assert.equal(priceLimit(quotes["2330.TW"]), null);
  assert.equal(priceLimit(quotes["0050.TW"]), null);
  const down = decode(changed({ "2330.TW": { price: { raw: "1925", fmt: "1,925", sort: 1925 } } })).quotes["2330.TW"];
  assert.equal(priceLimit(down), "down");
  const none = decode(changed({ "2330.TW": { limitUpPrice: { raw: "-", fmt: "-", sort: null } } })).quotes["2330.TW"];
  assert.equal(none.limitUp, null);
  assert.equal(none.limitDown, null);
});

// The earlier-day answers (EARLIER_ROWS, EARLIER_TICK) are described in helpers.mjs.
const twOnly = (symbols, response, now, anyDay = ["^TWOII"]) =>
  yahootw.decode(yahootw.requests(symbols, { twOnly: anyDay })[0], response, now);

test("a line answer gives its trading periods, also without a point from today", () => {
  const S = TODAY_0900;
  const E = TODAY_0900 + 16_200;
  const answer = (start) => ok([{ symbol: "^TWOII", chart: {
    meta: { symbol: "^TWOII", currentTradingPeriod: { pre: { start: S, end: S }, regular: { start: S, end: E }, post: { start: E, end: E } } },
    timestamp: [start], indicators: { quote: [{ close: [321.97] }] },
  } }]);
  for (const start of [TODAY_0900, TODAY_0900 - 86_400]) {
    const { periods } = lineOf("^TWOII", answer(start));
    assert.deepEqual(periods["^TWOII"], { pre: null, regular: [S * 1000, E * 1000], post: null }, String(start));
  }
  const recorded = yahootw.decode(yahootw.requests(["^TWOII"]).find((r) => r.kind === "line"), ok(EARLIER_TICK), NIGHT);
  assert.equal(recorded.lines, undefined);
  assert.deepEqual(recorded.periods["^TWOII"].regular, [Date.parse("2026-11-09T01:00:00Z"), Date.parse("2026-11-09T05:30:00Z")]);
  // Without periods, none.
  assert.equal(lineOf("2330.TW", tick("2330.TW", [2200])).periods, undefined);
});

test("a TW-only quote's periods: its line's from its own day, else closed for an earlier day, else none", () => {
  const S = TODAY_0900 * 1000;
  const E = (TODAY_0900 + 16_200) * 1000;
  const own = { pre: null, regular: [S, E], post: null };
  const before = { pre: null, regular: [S - 86_400_000, E - 86_400_000], post: null };
  const today = { symbol: "^TWOII", day: taipeiDay(NOW), tradeTime: NOW - 60_000 };
  assert.equal(ownPeriods(today, own, NOW), own);
  assert.equal(ownPeriods(today, before, NOW), null);
  assert.equal(ownPeriods(today, null, NOW), null);
  const earlier = { symbol: "^TWOII", day: taipeiDay(CLOSE_0509), tradeTime: CLOSE_0509 };
  assert.deepEqual(ownPeriods(earlier, null, NIGHT), { pre: null, regular: [CLOSE_0509, CLOSE_0509], post: null });
  // Its own day's line periods win over the closed session.
  const close = { pre: null, regular: [Date.parse("2026-11-09T01:00:00Z"), Date.parse("2026-11-09T05:30:00Z")], post: null };
  assert.equal(ownPeriods(earlier, close, NIGHT), close);
});

test("an earlier day's row is a TW-only symbol's quote, stamped with its own time", () => {
  const { quotes } = twOnly(["^TWOII", "^TWII"], ok(EARLIER_ROWS), NIGHT);
  assert.deepEqual(Object.keys(quotes), ["^TWOII"]);
  const index = quotes["^TWOII"];
  assert.deepEqual([index.price, index.previousClose, index.exchange, index.currency], [321.97, 304.02, "TWO", "TWD"]);
  assert.deepEqual([index.timestamp, index.tradeTime, index.day], [CLOSE_0509, CLOSE_0509, taipeiDay(CLOSE_0509)]);
  // Not a TW-only symbol: the earlier day is refused, as for any row.
  assert.deepEqual(twOnly(["^TWOII"], ok(EARLIER_ROWS), NIGHT, []).quotes, {});
});

test("earlier-day rows keep their own time and leave feed time and noLive alone", () => {
  const yesterday = "2026-11-08T05:31:00Z";
  const { quotes, noLive } = twOnly(["2330.TW", "^TWOII"], changed({ "^TWOII": { regularMarketTime: yesterday } }), NOW);
  assert.equal(quotes["2330.TW"].timestamp, Date.parse("2026-11-09T01:41:13Z"));
  assert.equal(quotes["^TWOII"].timestamp, Date.parse(yesterday));
  assert.equal(quotes["^TWOII"].day, taipeiDay(Date.parse(yesterday)));
  assert.equal(noLive, undefined);
  // With no row from today, an earlier-day quote does not hide that nothing is real time.
  const night = twOnly(["^TWOII", "^TWII"], ok(EARLIER_ROWS), NIGHT);
  assert.ok(night.quotes["^TWOII"]);
  assert.equal(night.noLive.code, "yahootw.noLiveRows");
});

const FUTURES = ["WTX&", "WTX@", "WMT&", "WTF&", "WTE&"];
const futures = (response, now = FUT_NOW, symbols = FUTURES) => yahootw.decode(yahootw.requests(symbols, { twOnly: symbols })[0], response, now);
const changedFutures = (bySymbol) => ok(FUTURES_ROWS.map((row) => ({ ...row, ...bySymbol[row.symbol] })));

test("a future's trading day starts at 15:00 in Taipei, and Friday night is Monday's", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(tradingDay("WTX&", at("2026-11-09T07:00:00Z")), taipeiDay(at("2026-11-10T05:35:37Z"))); // Mon 15:00 → Tue's
  assert.equal(tradingDay("WTX&", at("2026-11-09T06:59:59Z")), taipeiDay(at("2026-11-09T06:59:59Z"))); // Mon 14:59:59 → Mon's
  assert.equal(tradingDay("WTX&", at("2026-11-10T15:59:59Z")), tradingDay("WTX&", at("2026-11-10T16:00:00Z"))); // midnight
  const monday = taipeiDay(at("2026-11-16T01:00:00Z"));
  for (const iso of [
    "2026-11-13T07:00:00Z", // Fri 15:00
    "2026-11-13T16:00:00Z", // Sat 00:00
    "2026-11-13T20:59:59Z", // Sat 04:59:59
    "2026-11-14T02:00:00Z", // Sat 10:00
    "2026-11-15T14:00:00Z", // Sun 22:00
    "2026-11-15T16:30:00Z", // Mon 00:30
    "2026-11-16T01:00:00Z", // Mon 09:00
  ]) assert.equal(tradingDay("WTX&", at(iso)), monday, iso);
  assert.equal(tradingDay("WTX&", at("2026-11-13T06:59:59Z")), taipeiDay(at("2026-11-13T06:59:59Z"))); // Fri 14:59:59 → Fri's
  assert.equal(tradingDay("2330.TW", at("2026-11-09T07:00:00Z")), taipeiDay(at("2026-11-09T07:00:00Z")));
  assert.equal(tradingDay("2330.TW", at("2026-11-14T02:00:00Z")), taipeiDay(at("2026-11-14T02:00:00Z"))); // a stock keeps Saturday
});

test("futures rows from TAIFEX are priced, timed at TAIFEX's newest trade", () => {
  const { quotes, errors } = futures(ok(FUTURES_ROWS));
  const newest = Date.parse("2026-11-10T05:35:37Z");
  assert.deepEqual(Object.keys(quotes).sort(), [...FUTURES].sort());
  assert.deepEqual(errors, {});
  assert.deepEqual(quotes["WTX&"], {
    symbol: "WTX&", source: "yahootw", name: "台指期近一", price: 42604, previousClose: 41478, open: 41240, high: 43108, low: 40715,
    limitUp: 45625, limitDown: 37331, exchange: "TFE", currency: "TWD", timestamp: newest, tradeTime: newest,
    day: tradingDay("WTX&", FUT_NOW), fetchedAt: FUT_NOW,
  });
  assert.equal(quotes["WTF&"].timestamp, newest);
  assert.equal(quotes["WTF&"].tradeTime, Date.parse("2026-11-10T05:33:19Z"));
});

test("a future past its reported limit is shown, not discarded, and not lit", () => {
  const above = futures(changedFutures({ "WTX&": { price: { raw: "46000" } } }));
  assert.equal(above.quotes["WTX&"].price, 46000);
  assert.equal(above.errors["WTX&"], undefined);
  assert.equal(priceLimit(above.quotes["WTX&"]), null);
  assert.equal(futures(changedFutures({ "WTX&": { price: { raw: "36000" } } })).quotes["WTX&"].price, 36000);
  assert.equal(priceLimit(futures(changedFutures({ "WTX&": { price: { raw: "45625" } } })).quotes["WTX&"]), "up");
  // A stock is still checked.
  assert.equal(decode(changed({ "2330.TW": { price: { raw: "2400" } } })).errors["2330.TW"].code, "yahootw.outOfLimits");
});

test("a futures-form row not on TAIFEX gives nothing, not even its name", () => {
  for (const exchange of ["NMS", null, "-"]) {
    const { quotes, errors, names } = futures(changedFutures({ "WTX&": { exchange } }));
    assert.equal(quotes["WTX&"], undefined, String(exchange));
    assert.equal(errors["WTX&"], undefined, String(exchange));
    assert.equal(names["WTX&"], undefined, String(exchange));
    assert.ok(quotes["WTX@"], String(exchange));
  }
});

test("quiet rows keep their own market's clock: a 20:00 future never times a stock", () => {
  const now = Date.parse("2026-11-10T12:00:05Z"); // 20:00:05 in Taipei
  const stock = { ...ROWS[0], exchange: "TAI", regularMarketTime: "2026-11-10T05:30:00Z" };
  const future = { ...FUTURES_ROWS[0], regularMarketTime: "2026-11-10T12:00:00Z" };
  const { quotes } = yahootw.decode(yahootw.requests(["2330.TW", "WTX&"], { twOnly: ["WTX&"] })[0], ok([stock, future]), now);
  assert.equal(quotes["2330.TW"].timestamp, Date.parse("2026-11-10T05:30:00Z"));
  assert.equal(quotes["WTX&"].timestamp, Date.parse("2026-11-10T12:00:00Z"));
});

// Passes before and after this task: it fails an implementation that groups the feed time by exchange.
test("a quiet TPEx stock still takes the batch's newest stock trade", () => {
  const { quotes } = decode(changed({ "2330.TW": { exchange: "TAI" }, "0050.TW": { exchange: "TAI" }, "6488.TWO": { exchange: "TWO" } }));
  assert.equal(quotes["6488.TWO"].timestamp, Date.parse("2026-11-09T01:41:13Z"));
  assert.equal(quotes["6488.TWO"].tradeTime, Date.parse("2026-11-09T01:28:59Z"));
  assert.equal(quotes["0050.TW"].timestamp, Date.parse("2026-11-09T01:41:13Z"));
});

test("the night's first rows: a new trading day with new limits, and a stock beside them keeps its own trade", () => {
  const now = Date.parse("2026-11-10T07:20:00Z"); // 15:20 in Taipei
  const request = yahootw.requests(["WTX&", "WMT&", "2330.TW"], { twOnly: ["WTX&", "WMT&"] })[0];
  const { quotes, noLive } = yahootw.decode(request, ok(FUTURES_NIGHT_ROWS), now);
  const wtx = quotes["WTX&"];
  assert.deepEqual([wtx.price, wtx.limitUp, wtx.limitDown, wtx.previousClose], [42459, 46910, 38382, 42646]);
  assert.equal(wtx.day, tradingDay("WTX&", now));
  assert.notEqual(wtx.day, taipeiDay(now));
  assert.equal(wtx.timestamp, Date.parse("2026-11-10T07:19:54Z"));
  // The futures clock times WMT& at WTX&'s trade; the stock clock leaves 2330.TW at its 14:30 trade.
  assert.equal(quotes["WMT&"].timestamp, Date.parse("2026-11-10T07:19:54Z"));
  assert.equal(quotes["2330.TW"].timestamp, Date.parse("2026-11-10T06:30:00Z"));
  assert.equal(noLive, undefined);
});

test("a night trade stamped just past 15:00 by Yahoo's clock counts while the local clock still reads 14:59", () => {
  const now = Date.parse("2026-11-10T06:59:58Z"); // 14:59:58 locally
  const { quotes, noLive } = futures(changedFutures({ "WTX&": { regularMarketTime: "2026-11-10T07:00:01Z" } }), now, ["WTX&"]);
  assert.equal(quotes["WTX&"].day, tradingDay("WTX&", now) + 1);
  assert.equal(quotes["WTX&"].timestamp, Date.parse("2026-11-10T07:00:01Z"));
  assert.equal(noLive, undefined);
});

test("a night trade after midnight is the same trading day: priced live, no noLive", () => {
  const now = Date.parse("2026-11-10T16:00:30Z"); // 00:00:30 Wednesday
  const { quotes, noLive } = futures(changedFutures({ "WTX&": { regularMarketTime: "2026-11-10T15:59:50Z" } }), now, ["WTX&"]);
  assert.equal(quotes["WTX&"].day, tradingDay("WTX&", now));
  assert.equal(quotes["WTX&"].timestamp, Date.parse("2026-11-10T15:59:50Z"));
  assert.equal(noLive, undefined);
});

test("a future's line keeps its trading day from 15:00, also after midnight", () => {
  const recorded = yahootw.decode(yahootw.requests(["WTX&"]).find((r) => r.kind === "line"), ok(FUTURES_TICK), FUT_NOW);
  const { day, series, lastAt } = recorded.lines["WTX&"];
  assert.equal(day, tradingDay("WTX&", FUT_NOW));
  assert.deepEqual([series.length, series[0], series.at(-1), lastAt], [1132, 41235, 42599, 1794288960000]);
  assert.deepEqual(recorded.periods["WTX&"].regular, [1794207600000, 1794289500000]);
  // 01:00: ten hours of night minutes since 15:00 the day before, none cut at midnight.
  const one = Date.parse("2026-11-09T17:00:00Z");
  const start = Date.parse("2026-11-09T07:00:00Z") / 1000;
  const closes = Array.from({ length: 600 }, (_, i) => 42000 + i);
  const night = decodeTick("WTX&", ok([{ symbol: "WTX&", chart: { meta: { symbol: "WTX&" },
    timestamp: closes.map((_, i) => start + i * 60), indicators: { quote: [{ close: closes }] } } }]), one);
  assert.deepEqual([night.lines["WTX&"].series.length, night.lines["WTX&"].series[0]], [600, 42000]);
  assert.equal(night.lines["WTX&"].day, tradingDay("WTX&", one));
});

test("a future's line periods belong to its trading day, which began at 15:00 the day before", () => {
  const nine = Date.parse("2026-11-10T01:00:00Z"); // 09:00 Tuesday
  const quote = { symbol: "WTX&", day: tradingDay("WTX&", nine - 10_000), tradeTime: nine - 10_000 };
  const periods = { pre: null, regular: [1794207600000, 1794289500000], post: null };
  assert.equal(ownPeriods(quote, periods, nine), periods);
});
