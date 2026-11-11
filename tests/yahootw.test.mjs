// node --test tests/  (providers/yahootw.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { USER_AGENT, priceLimit } from "../mods/wickline/quotes.js";
import {
  YAHOOTW_BASE, YAHOOTW_BATCH, YAHOOTW_CONSENT_VERSION, decodeStockList, decodeTick, ownPeriods, taipeiDay, tradingDay, yahootw,
} from "../mods/wickline/providers/yahootw.js";
import { t } from "../mods/wickline/i18n.js";
import { freshness, sessionOf } from "../mods/wickline/freshness.js";
import {
  CLOSE_0509, EARLIER_ROWS, EARLIER_TICK, FUTURES_NIGHT_ROWS, FUTURES_NIGHT_TICK, FUTURES_ROWS, FUTURES_TICK, FUT_NOW, LINE_PERIODS, NIGHT, at, day,
  jsonFixture, ok,
} from "./helpers.mjs";

// A recorded price answer (2026-11-09, during trading hours), trimmed to the fields Wickline reads. Its last two
// rows, ^TWII and ^TWOII, were recorded after that day's close and keep their `exchange`.
const ROWS = jsonFixture("yahootw-stocklist");
// 09:41:20 in Taipei, seven seconds after the answer's newest trade.
const NOW = 1794188480000;
const SYMBOLS = ["2330.TW", "0056.TW", "0050.TW", "6488.TWO"];
// The recorded rows with some rows' fields replaced, by symbol.
const changed = (bySymbol, rows = ROWS) => ok(rows.map((row) => ({ ...row, ...bySymbol[row.symbol] })));
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
  assert.deepEqual(yahootw.requests(["2330.TW", "^TWOII"], { anyDay: ["^TWOII", "^TWZZ"] }).map((r) => r.anyDay),
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
    { "0050.TW": { day: taipeiDay(NOW), series: [10.05], lastAt: Date.parse("2026-11-09T01:18:00Z"),
      endAt: Date.parse("2026-11-09T05:30:00Z") } }); // its regular session ends at 13:30
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
  yahootw.decode(yahootw.requests(symbols, { anyDay })[0], response, now);

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
  const close = day("2026-11-09T01:00:00Z", "2026-11-09T05:30:00Z");
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

test("a TW-only row with a price but no trade time gives no quote", () => {
  assert.equal(twOnly(["^TWOII"], changed({ "^TWOII": { regularMarketTime: "-" } }), NOW).quotes["^TWOII"], undefined);
});

test("a TW-only row with a price but no trade time says it is not real time; a stock others price stays silent", () => {
  const noTime = changed({ "^TWOII": { regularMarketTime: "-" }, "2330.TW": { regularMarketTime: "-" } });
  const sole = twOnly(["^TWOII", "2330.TW"], noTime, NOW);
  assert.equal(sole.errors["^TWOII"].code, "yahootw.noLiveRows");
  assert.equal(sole.errors["2330.TW"], undefined);
  assert.equal(sole.quotes["2330.TW"], undefined);
  // A row with no price at all is a name-only answer: no error.
  assert.equal(twOnly(["^TWOII"], changed({ "^TWOII": { price: "-", regularMarketTime: "-" } }), NOW).errors["^TWOII"], undefined);
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
const futures = (response, now = FUT_NOW, symbols = FUTURES) => yahootw.decode(yahootw.requests(symbols, { anyDay: symbols })[0], response, now);

test("a priced row refused as delayed or far ahead says why for a symbol only this source prices, never for an overlay", () => {
  const delayed = futures(changed({ "WTX&": { exchangeDataDelayedBy: 15 } }, FUTURES_ROWS));
  assert.equal(delayed.quotes["WTX&"], undefined);
  assert.equal(delayed.errors["WTX&"].code, "yahootw.noLiveRows");
  const ahead = futures(changed({ "WTX&": { regularMarketTime: "2026-11-10T06:36:30Z" } }, FUTURES_ROWS)); // an hour ahead
  assert.equal(ahead.errors["WTX&"].code, "yahootw.noLiveRows");
  // A placeholder only names it.
  const placeholder = futures(changed({ "WTX&": { price: { raw: "-" } } }, FUTURES_ROWS));
  assert.equal(placeholder.errors["WTX&"], undefined);
  assert.equal(placeholder.names["WTX&"], "台指期近一");
  // A stock's delayed row stays silent: another source prices it.
  assert.equal(decode(changed({ "2330.TW": { exchangeDataDelayedBy: 20 } })).errors["2330.TW"], undefined);
});

test("a future's trading day starts at 15:00 in Taipei, and Friday night is Monday's", () => {
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
  const newest = at("2026-11-10T05:35:37Z");
  assert.deepEqual(Object.keys(quotes).sort(), [...FUTURES].sort());
  assert.deepEqual(errors, {});
  assert.deepEqual(quotes["WTX&"], {
    symbol: "WTX&", source: "yahootw", name: "台指期近一", price: 42604, previousClose: 41478, open: 41240, high: 43108, low: 40715,
    limitUp: 45625, limitDown: 37331, exchange: "TFE", currency: "TWD", timestamp: newest, tradeTime: newest,
    day: tradingDay("WTX&", FUT_NOW), fetchedAt: FUT_NOW,
  });
  assert.equal(quotes["WTF&"].timestamp, newest);
  assert.equal(quotes["WTF&"].tradeTime, at("2026-11-10T05:33:19Z"));
});

test("a future past its reported limit is shown, not discarded, and not lit", () => {
  const above = futures(changed({ "WTX&": { price: { raw: "46000" } } }, FUTURES_ROWS));
  assert.equal(above.quotes["WTX&"].price, 46000);
  assert.equal(above.errors["WTX&"], undefined);
  assert.equal(priceLimit(above.quotes["WTX&"]), null);
  assert.equal(futures(changed({ "WTX&": { price: { raw: "36000" } } }, FUTURES_ROWS)).quotes["WTX&"].price, 36000);
  assert.equal(priceLimit(futures(changed({ "WTX&": { price: { raw: "45625" } } }, FUTURES_ROWS)).quotes["WTX&"]), "up");
  // A stock is still checked.
  assert.equal(decode(changed({ "2330.TW": { price: { raw: "2400" } } })).errors["2330.TW"].code, "yahootw.outOfLimits");
});

test("a futures-form row not on TAIFEX gives nothing, not even its name", () => {
  for (const exchange of ["NMS", null, "-"]) {
    const { quotes, errors, names } = futures(changed({ "WTX&": { exchange } }, FUTURES_ROWS));
    assert.equal(quotes["WTX&"], undefined, String(exchange));
    assert.equal(errors["WTX&"], undefined, String(exchange));
    assert.equal(names["WTX&"], undefined, String(exchange));
    assert.ok(quotes["WTX@"], String(exchange));
  }
});

test("quiet rows keep their own market's clock: a 20:00 future never times a stock", () => {
  const now = at("2026-11-10T12:00:05Z"); // 20:00:05 in Taipei
  const stock = { ...ROWS[0], exchange: "TAI", regularMarketTime: "2026-11-10T05:30:00Z" };
  const future = { ...FUTURES_ROWS[0], regularMarketTime: "2026-11-10T12:00:00Z" };
  const { quotes } = yahootw.decode(yahootw.requests(["2330.TW", "WTX&"], { anyDay: ["WTX&"] })[0], ok([stock, future]), now);
  assert.equal(quotes["2330.TW"].timestamp, at("2026-11-10T05:30:00Z"));
  assert.equal(quotes["WTX&"].timestamp, at("2026-11-10T12:00:00Z"));
});

// It fails an implementation that groups the feed time by exchange.
test("a quiet TPEx stock still takes the batch's newest stock trade", () => {
  const { quotes } = decode(changed({ "2330.TW": { exchange: "TAI" }, "0050.TW": { exchange: "TAI" }, "6488.TWO": { exchange: "TWO" } }));
  assert.equal(quotes["6488.TWO"].timestamp, at("2026-11-09T01:41:13Z"));
  assert.equal(quotes["6488.TWO"].tradeTime, at("2026-11-09T01:28:59Z"));
  assert.equal(quotes["0050.TW"].timestamp, at("2026-11-09T01:41:13Z"));
});

test("the night's first rows: a new trading day with new limits, and a stock beside them keeps its own trade", () => {
  const now = at("2026-11-10T07:20:00Z"); // 15:20 in Taipei
  const request = yahootw.requests(["WTX&", "WMT&", "2330.TW"], { anyDay: ["WTX&", "WMT&"] })[0];
  const { quotes, noLive } = yahootw.decode(request, ok(FUTURES_NIGHT_ROWS), now);
  const wtx = quotes["WTX&"];
  assert.deepEqual([wtx.price, wtx.limitUp, wtx.limitDown, wtx.previousClose], [42459, 46910, 38382, 42646]);
  assert.equal(wtx.day, tradingDay("WTX&", now));
  assert.notEqual(wtx.day, taipeiDay(now));
  assert.equal(wtx.timestamp, at("2026-11-10T07:19:54Z"));
  // The futures clock times WMT& at WTX&'s trade; the stock clock leaves 2330.TW at its 14:30 trade.
  assert.equal(quotes["WMT&"].timestamp, at("2026-11-10T07:19:54Z"));
  assert.equal(quotes["2330.TW"].timestamp, at("2026-11-10T06:30:00Z"));
  assert.equal(noLive, undefined);
});

test("a night trade stamped just past 15:00 by Yahoo's clock counts while the local clock still reads 14:59", () => {
  const now = at("2026-11-10T06:59:58Z"); // 14:59:58 locally
  const { quotes, noLive } = futures(changed({ "WTX&": { regularMarketTime: "2026-11-10T07:00:01Z" } }, FUTURES_ROWS), now, ["WTX&"]);
  assert.equal(quotes["WTX&"].day, tradingDay("WTX&", now) + 1);
  assert.equal(quotes["WTX&"].timestamp, at("2026-11-10T07:00:01Z"));
  assert.equal(noLive, undefined);
});

test("a futures trade far ahead of the local clock is not today's and never sets the feed time", () => {
  const now = at("2026-11-10T06:59:58Z"); // 14:59:58 locally
  const { quotes } = futures(changed({ "WTX&": { regularMarketTime: "2026-11-10T07:59:58Z" } }, FUTURES_ROWS), now); // an hour ahead
  assert.equal(quotes["WTX&"], undefined);
  const others = FUTURES.filter((symbol) => symbol !== "WTX&").map((symbol) => quotes[symbol].tradeTime);
  assert.equal(quotes["WTX@"].timestamp, Math.max(...others));
});

// The bound holds on the trading day too: 04:00 Wednesday is Wednesday's trading day as 16:00 Tuesday is, and still a bad time.
test("a futures trade far ahead of the local clock on today's trading day is refused and never sets the feed time", () => {
  const now = at("2026-11-10T08:00:00Z"); // 16:00 Tuesday, Wednesday's trading day
  const { quotes } = futures(changed({
    "WTX&": { regularMarketTime: "2026-11-10T20:00:00Z" }, // 04:00 Wednesday
    "WMT&": { regularMarketTime: "2026-11-10T07:59:50Z" },
  }, FUTURES_ROWS), now);
  assert.equal(quotes["WTX&"], undefined);
  assert.equal(quotes["WMT&"].timestamp, at("2026-11-10T07:59:50Z"));
});

test("a night trade after midnight is the same trading day: priced live, no noLive", () => {
  const now = at("2026-11-10T16:00:30Z"); // 00:00:30 Wednesday
  const { quotes, noLive } = futures(changed({ "WTX&": { regularMarketTime: "2026-11-10T15:59:50Z" } }, FUTURES_ROWS), now, ["WTX&"]);
  assert.equal(quotes["WTX&"].day, tradingDay("WTX&", now));
  assert.equal(quotes["WTX&"].timestamp, at("2026-11-10T15:59:50Z"));
  assert.equal(noLive, undefined);
});

test("a future's line keeps its trading day from 15:00, also after midnight", () => {
  const recorded = yahootw.decode(yahootw.requests(["WTX&"]).find((r) => r.kind === "line"), ok(FUTURES_TICK), FUT_NOW);
  const { day, series, lastAt } = recorded.lines["WTX&"];
  assert.equal(day, tradingDay("WTX&", FUT_NOW));
  assert.deepEqual([series.length, series[0], series.at(-1), lastAt], [1132, 41235, 42599, 1794288960000]);
  assert.deepEqual(recorded.periods["WTX&"].regular, LINE_PERIODS.regular);
  // 01:00: ten hours of night minutes since 15:00 the day before, none cut at midnight.
  const one = at("2026-11-09T17:00:00Z");
  const start = at("2026-11-09T07:00:00Z") / 1000;
  const closes = Array.from({ length: 600 }, (_, i) => 42000 + i);
  const night = decodeTick("WTX&", ok([{ symbol: "WTX&", chart: { meta: { symbol: "WTX&" },
    timestamp: closes.map((_, i) => start + i * 60), indicators: { quote: [{ close: closes }] } } }]), one);
  assert.deepEqual([night.lines["WTX&"].series.length, night.lines["WTX&"].series[0]], [600, 42000]);
  assert.equal(night.lines["WTX&"].day, tradingDay("WTX&", one));
});

// Yahoo 奇摩股市 lists the minutes still to come, without closes: a line never runs past `now`. Read at its own time, as
// here, its last minute is its last trade's; read later, the minutes up to now carry that close (see the next test).
test("a line ends at its last close at or before now, never at the minutes still to come", () => {
  const request = yahootw.requests(["WTX&"]).find((r) => r.kind === "line");
  const chart = FUTURES_NIGHT_TICK[0].chart;
  const closes = chart.indicators.quote[0].close;
  for (const now of [at("2026-11-10T14:17:30Z"), at("2026-11-10T14:20:30Z")]) { // 22:17:30, 22:20:30
    const label = new Date(now).toISOString();
    const { series, lastAt } = yahootw.decode(request, ok(FUTURES_NIGHT_TICK), now).lines["WTX&"];
    const last = chart.timestamp.findLastIndex((seconds, i) => seconds * 1000 <= now && closes[i] !== null);
    assert.equal(lastAt, chart.timestamp[last] * 1000, label);
    assert.ok(lastAt <= now, label);
    assert.equal(series.at(-1), closes[last], label);
    // One point a minute from the first close, none past now.
    const first = closes.findIndex((close) => close !== null);
    assert.equal(series.length, last - first + 1, label);
  }
});

// An answer that stopped at 22:20, read half an hour later: its minutes since then carry 22:20's close, but its last
// trade stays at 22:20, so the watchlist can tell it is frozen.
test("a line's last trade is its last close, not the minutes filled up to now", () => {
  const request = yahootw.requests(["WTX&"]).find((r) => r.kind === "line");
  const chart = FUTURES_NIGHT_TICK[0].chart;
  const closes = chart.indicators.quote[0].close;
  const last = closes.findLastIndex((close) => close !== null);
  const lastClose = chart.timestamp[last] * 1000;
  const now = lastClose + 30 * 60_000 + 30_000; // 22:50:30
  const { series, lastAt, endAt } = yahootw.decode(request, ok(FUTURES_NIGHT_TICK), now).lines["WTX&"];
  assert.equal(lastAt, lastClose);
  // Its trading day's regular session ends at 13:45 the next day: no night trade is capped.
  assert.equal(endAt, at("2026-11-11T05:45:00Z"));
  // The series still runs to now's minute, flat after 22:20.
  const first = closes.findIndex((close) => close !== null);
  assert.equal(series.length, last + 30 - first + 1);
  assert.deepEqual(series.slice(-31), Array(31).fill(closes[last]));
});

test("a future's line gives its sessions from sourceTradingPeriods", () => {
  const { periods } = yahootw.decode(yahootw.requests(["WTX&"]).find((r) => r.kind === "line"), ok(FUTURES_TICK), FUT_NOW);
  assert.deepEqual(periods["WTX&"], LINE_PERIODS);
});

// A line's segments describe only their own trading day: from 15:00 a day session's segments say nothing of the night, so
// the TAIFEX hours decide, and a feed that stops at the day close reads stalled in the night, never closed.
test("a future's line segments are read only on their own trading day", () => {
  const close = at("2026-11-10T05:44:59Z"); // 13:44:59 Tuesday
  const quote = { symbol: "WTX&", day: tradingDay("WTX&", close), tradeTime: close, timestamp: close, source: "yahootw" };
  // The 13:45–15:00 break: Tuesday's own segments, closed.
  const two = at("2026-11-10T06:00:00Z");
  assert.equal(ownPeriods(quote, LINE_PERIODS, two), LINE_PERIODS);
  assert.equal(sessionOf({ ...quote, periods: LINE_PERIODS }, two), "closed");
  // 15:10: Wednesday's trading day, so Tuesday's segments go; the night session is open, and the 13:44:59 price stalled.
  const night = at("2026-11-10T07:10:00Z");
  const periods = ownPeriods(quote, LINE_PERIODS, night);
  assert.deepEqual(periods, { pre: null, regular: LINE_PERIODS.regular, post: null });
  const shown = { ...quote, periods };
  assert.equal(sessionOf(shown, night), "open");
  assert.equal(freshness(shown, "open", night).state, "stalled");
  // Friday's day session, seen on Saturday: Monday's trading day, and the TAIFEX hours read closed.
  const friday = at("2026-11-13T05:44:59Z");
  const fridayQuote = { ...quote, day: tradingDay("WTX&", friday), tradeTime: friday, timestamp: friday };
  const fridayPeriods = { pre: null, regular: [at("2026-11-12T07:00:00Z"), at("2026-11-13T05:45:00Z")], post: null,
    segments: [[at("2026-11-12T07:00:00Z"), at("2026-11-12T21:00:00Z")], [at("2026-11-13T00:45:00Z"), at("2026-11-13T05:45:00Z")]] };
  const saturday = at("2026-11-14T02:00:00Z");
  assert.equal(sessionOf({ ...fridayQuote, periods: ownPeriods(fridayQuote, fridayPeriods, saturday) }, saturday), "closed");
  // Friday night's segments are Monday's trading day's, so on Sunday they still hold.
  const lastNight = at("2026-11-13T20:59:59Z");
  const nightQuote = { ...quote, day: tradingDay("WTX&", lastNight), tradeTime: lastNight, timestamp: lastNight };
  const mondayPeriods = { pre: null, regular: [at("2026-11-13T07:00:00Z"), at("2026-11-16T05:45:00Z")], post: null,
    segments: [[at("2026-11-13T07:00:00Z"), at("2026-11-13T21:00:00Z")], [at("2026-11-16T00:45:00Z"), at("2026-11-16T05:45:00Z")]] };
  const sunday = at("2026-11-15T14:00:00Z");
  assert.equal(ownPeriods(nightQuote, mondayPeriods, sunday), mondayPeriods);
});

test("a future's line periods belong to its trading day, which began at 15:00 the day before", () => {
  const nine = at("2026-11-10T01:00:00Z"); // 09:00 Tuesday
  const quote = { symbol: "WTX&", day: tradingDay("WTX&", nine - 10_000), tradeTime: nine - 10_000 };
  const periods = { pre: null, regular: LINE_PERIODS.regular, post: null };
  assert.equal(ownPeriods(quote, periods, nine), periods);
});
