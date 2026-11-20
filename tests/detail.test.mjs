// node --test tests/  (detail.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_WAKE_CAP_MS,
  activityCells,
  chartQuote,
  detailBook,
  detailSource,
  detailWakeAt,
  followDetail,
  innerOuter,
  secondRow,
} from "../mods/wickline/detail.js";
import { decodeStockList } from "../mods/wickline/providers/yahootw.js";
import {
  SCENARIO_BOOK,
  advance,
  at,
  day,
  fakeHost,
  jsonFixture,
  levels,
  ok,
  say,
  wakes,
  wtxDetail,
  yq,
} from "./helpers.mjs";

const AAPL_Q = {
  symbol: "AAPL",
  price: 230,
  previousClose: 225,
  currency: "USD",
  volume: 48_213_500,
  sizeUnit: "share",
};
const BTC_Q = {
  symbol: "BTC/USDT",
  price: 65_000,
  previousClose: 64_000,
  currency: "USDT",
  volume: 1234.5,
  sizeUnit: "BTC",
};
const text = (cell) => [cell.label, cell.value, cell.unit].filter(Boolean).join(" ");

test("Another market", () => {
  assert.equal(text(secondRow(AAPL_Q, false, "en", say("en"))[0]), "Volume 48.2M");
  assert.deepEqual(
    secondRow(BTC_Q, false, "en", say("en")).map((c) => c && text(c)),
    ["24h volume 1,234.5 BTC", null, null],
  );
  assert.deepEqual(
    secondRow(AAPL_Q, false, "en", say("en")).map((c) => c && text(c)),
    ["Volume 48.2M", null, null, null],
  );
});

test("Detail at limit-up", () => {
  const q = { symbol: "6488.TWO", price: 563, previousClose: 512, limitUp: 563, limitDown: 461 };
  assert.deepEqual(
    secondRow(q, false, "zh-TW", say("zh-TW")).map((c) => c && text(c)),
    [null, "漲停價 563.00", "跌停價 461.00", null],
  );
});

test("Limits without the limit", () => {
  const q = { symbol: "2330.TW", price: 2240, previousClose: 2170, limitUp: 2345, limitDown: 1925 };
  const row = secondRow(q, false, "zh-TW", say("zh-TW"));
  assert.equal(text(row[1]), "漲停價 2,345.00");
  assert.equal(text(row[2]), "跌停價 1,925.00");
  // A stock without daily limits (MIS's 9999.95) has none to show.
  assert.equal(secondRow({ ...q, limitUp: 9999.95, limitDown: null }, false, "zh-TW", say("zh-TW")), null);
});

test("Layout unchanged", () => {
  assert.equal(secondRow({ symbol: "^GSPC", price: 6000, previousClose: 5990 }, false, "en", say("en")), null);
});

// The recorded 2026-11-18 rows (2330.TW after the close, WTX& in the day session) as Yahoo 奇摩股市's decoder gives them.
const DETAIL_NOW = at("2026-11-18T06:05:00Z");
const ytw = (name, symbol) => decodeStockList([symbol], ok(jsonFixture(name)), DETAIL_NOW).quotes[symbol];
const YTW_2330 = ytw("ytw-detail-close", "2330.TW");
const YTW_WTX = ytw("ytw-detail-mixed", "WTX&");
const texts = (cells) => cells.map((cell) => cell && text(cell));

test("Yahoo 奇摩股市's activity", () => {
  assert.deepEqual(texts(activityCells(YTW_2330, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "昨日成交量 54,723 張",
    "成交值 920.47 億",
    "最後一筆 4,869 張",
  ]);
  // Below 1 億, 萬.
  assert.equal(
    text(activityCells({ ...YTW_2330, turnover: 48_213_500 }, "zh-TW", say("zh-TW"))[2]),
    "成交值 4,821.35 萬",
  );
});

test("Other languages", () => {
  const en = activityCells(YTW_2330, "en", say("en"));
  assert.equal(text(en[0]), "Volume 42,269 lots");
  assert.equal(text(en[2]), "Turnover 92.05B");
  const cn = activityCells(YTW_2330, "zh-CN", say("zh-CN"));
  assert.equal(text(cn[0]), "成交量 42,269 张");
  assert.equal(text(cn[2]), "成交额 920.47 亿");
});

test("MIS alone", () => {
  const mis = {
    symbol: "2330.TW",
    source: "mis",
    price: 2175,
    previousClose: 2170,
    volume: 42_269,
    lastSize: 4_869,
    sizeUnit: "lot",
  };
  assert.deepEqual(texts(activityCells(mis, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "昨日成交量 —",
    "成交值 —",
    "最後一筆 4,869 張",
  ]);
});

test("Before the open", () => {
  // Yahoo Finance's earlier-day quote, its activity stripped under MIS: every label stays, each value `—`.
  const bare = { symbol: "2330.TW", source: "yahoo", price: 2215, previousClose: 2200, high: 2220, low: 2190 };
  assert.deepEqual(texts(activityCells(bare, "zh-TW", say("zh-TW"))), [
    "成交量 —",
    "昨日成交量 —",
    "成交值 —",
    "最後一筆 —",
  ]);
  assert.deepEqual(texts(secondRow({ ...bare, high: null, low: null }, true, "zh-TW", say("zh-TW"))), [
    "均價 —",
    "漲停價 —",
    "跌停價 —",
    "振幅 —",
  ]);
  assert.deepEqual(texts(activityCells(bare, "en", say("en"))), [
    "Volume —",
    "Prev volume —",
    "Turnover —",
    "Last size —",
  ]);
  // One column is unchanged: nothing to show, no row.
  assert.equal(secondRow({ ...bare, high: null, low: null }, false, "zh-TW", say("zh-TW")), null);
});

test("A future", () => {
  assert.deepEqual(texts(activityCells(YTW_WTX, "zh-TW", say("zh-TW"))), [
    "成交量 82,587 口",
    "昨日成交量 170,139 口",
    "成交值 —",
    "最後一筆 3 口",
  ]);
  const row = secondRow(YTW_WTX, true, "zh-TW", say("zh-TW"));
  assert.equal(text(row[0]), "均價 —");
  assert.equal(row.length, 4);
});

test("The bar", () => {
  const tw = innerOuter(YTW_2330, say("zh-TW"));
  assert.equal(tw.left, "內盤 39.1% 15,147");
  assert.equal(tw.right, "外盤 60.9% 23,585");
  assert.ok(Math.abs(tw.innerShare - 0.391) < 0.0005);
  assert.ok(Math.abs(tw.outerShare - 0.609) < 0.0005);
  const cn = innerOuter(YTW_2330, say("zh-CN"));
  assert.deepEqual([cn.left, cn.right], ["内盘 39.1% 15,147", "外盘 60.9% 23,585"]);
  const en = innerOuter(YTW_2330, say("en"));
  assert.deepEqual([en.left, en.right], ["At bid 39.1% 15,147", "At ask 60.9% 23,585"]);
});

test("an inner volume of 0 reads 0.0%", () => {
  const io = innerOuter({ ...YTW_2330, inner: 0, outer: 38_732 }, say("zh-TW"));
  assert.deepEqual([io.left, io.right, io.innerShare, io.outerShare], ["內盤 0.0% 0", "外盤 100.0% 38,732", 0, 1]);
});

test("no inner/outer line without both, or with both at 0", () => {
  const { inner, outer, ...rest } = YTW_2330;
  assert.equal(innerOuter(rest, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, inner }, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, outer }, say("zh-TW")), null);
  assert.equal(innerOuter({ ...rest, inner: 0, outer: 0 }, say("zh-TW")), null);
});

test("The second row's places", () => {
  const q = {
    symbol: "2330.TW",
    price: 2175,
    high: 2210,
    low: 2150,
    previousClose: 2170,
    avgPrice: 2177,
    limitUp: 2385,
    limitDown: 1955,
    volume: 42_269,
    sizeUnit: "lot",
  };
  assert.deepEqual(texts(secondRow(q, true, "zh-TW", say("zh-TW"))), [
    "均價 2,177.00",
    "漲停價 2,385.00",
    "跌停價 1,955.00",
    "振幅 2.76%",
  ]);
  // One column keeps its volume under open, and no amplitude.
  assert.deepEqual(texts(secondRow(q, false, "zh-TW", say("zh-TW"))), [
    "成交量 42,269 張",
    "漲停價 2,385.00",
    "跌停價 1,955.00",
    null,
  ]);
  assert.equal(text(secondRow(YTW_2330, true, "zh-TW", say("zh-TW"))[0]), "均價 2,177.00");
});

const AUCTION_BOOK = { bids: levels([[2185, 1]]), asks: levels([[2200, 73]]), auction: true };

test("In a call auction", () => {
  const q = { symbol: "2330.TW", book: AUCTION_BOOK };
  assert.deepEqual(detailBook(q, true), { title: "detail.auctionBook", book: AUCTION_BOOK, line: null });
  assert.equal(detailBook(q, false).book, null);
});

test("Before any order", () => {
  // MIS answered at 08:20 with the stock's name and no level: not an auction.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: { bids: [], asks: [] } }, false), {
    title: "detail.book",
    book: null,
    line: "detail.bookEmpty",
  });
});

test("The auction ends in a paused detail", () => {
  // At 09:01:57 the flag is 2 minutes old: the auction book no longer shows.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: AUCTION_BOOK }, false), {
    title: "detail.book",
    book: null,
    line: "detail.bookNone",
  });
});

test("Yahoo 奇摩股市 alone before the open", () => {
  assert.equal(detailBook({ symbol: "2330.TW" }, true).line, "detail.bookNone");
  // A book from before the auction never shows in it.
  assert.deepEqual(detailBook({ symbol: "2330.TW", book: SCENARIO_BOOK }, true), {
    title: "detail.book",
    book: null,
    line: "detail.bookNone",
  });
});

test("A failure without a book", () => {
  const fallback = { code: "mis.timeout", params: {} };
  assert.equal(detailBook({ symbol: "2330.TW", fallback, error: null }, false).line, "reason");
  // A cached price's own failure says why too; an error under a current price does not.
  assert.equal(detailBook({ symbol: "2330.TW", cached: true, error: fallback, fallback: null }, false).line, "reason");
  assert.equal(detailBook({ symbol: "2330.TW", error: fallback, fallback: null }, false).line, "detail.bookNone");
  // A book to show wins over the reason.
  assert.equal(detailBook({ symbol: "2330.TW", fallback, book: SCENARIO_BOOK }, false).book, SCENARIO_BOOK);
});

test("chartQuote is the line's quote, with the line's own cached flag", () => {
  const q = {
    symbol: "AAPL",
    source: "finnhub",
    exchange: "NMS",
    timestamp: 9,
    chartSource: "yahoo",
    chartTimestamp: 5,
    chartFetchedAt: 7,
    chartCached: true,
    cached: undefined,
  };
  assert.deepEqual(
    [
      chartQuote(q).source,
      chartQuote(q).timestamp,
      chartQuote(q).fetchedAt,
      chartQuote(q).cached,
      chartQuote(q).exchange,
    ],
    ["yahoo", 5, 7, true, "NMS"],
  );
});

test("the detail names Yahoo's state and keeps a delay while closed", () => {
  const NOW = 1794188480000;
  assert.deepEqual(detailSource(yq("AAPL", "NMS", NOW - 40_000), "open", NOW, say("en")), [
    ["Price: Live · Yahoo Finance"],
  ]);
  assert.deepEqual(detailSource(yq("0700.HK", "HKG", NOW - 40_000), "closed", NOW, say("en")), [
    ["Yahoo Finance · regular session", "delayed 15 min"],
  ]);
});

// A closed 2330.TW (Yahoo 奇摩股市, 11/10's periods, 13:30 trade) opened at 21:00 Taipei: its next wake is 00:00, 3 h on.
const CLOSED_2330 = {
  symbol: "2330.TW",
  source: "yahootw",
  price: 1_000,
  timestamp: at("2026-11-10T05:30:00Z"),
  periods: day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z"),
  chartSource: "yahootw",
};
const NINE_PM = at("2026-11-10T13:00:00Z");
const MIDNIGHT_TPE = at("2026-11-10T16:00:00Z");

test("followDetail sleeps in 10-minute steps to a far wake and redraws only when it is reached", async () => {
  const { redraws, asked } = await wakes(CLOSED_2330, NINE_PM, MIDNIGHT_TPE + 1_000);
  assert.equal(asked.length, 19);
  assert.ok(
    asked.every((ms) => ms > 0 && ms <= DETAIL_WAKE_CAP_MS),
    asked.join(),
  );
  assert.deepEqual(redraws, [MIDNIGHT_TPE]);
});

test("followDetail after a system sleep past its wake redraws once and computes the next wake from the new now", async () => {
  // The machine slept through the 00:00 wake: the first sleep returns with the clock at 01:00, an hour past it.
  let clock = NINE_PM;
  const asked = [];
  const redraws = [];
  const sleep = (ms) => {
    asked.push(ms);
    if (asked.length === 1) {
      clock = MIDNIGHT_TPE + 3_600_000;
      return Promise.resolve();
    }
    return Promise.reject(new Error("closed"));
  };
  await followDetail(() => CLOSED_2330, {
    now: () => clock,
    sleep,
    changed: () => redraws.push(clock),
    woken: () => new Promise(() => {}),
  }).catch(() => {});
  assert.deepEqual(redraws, [MIDNIGHT_TPE + 3_600_000]);
  assert.equal(asked[1], DETAIL_WAKE_CAP_MS);
});

test("followDetail ends when its sleep rejects, with no later redraw", async () => {
  const redraws = [];
  const done = followDetail(() => CLOSED_2330, {
    now: () => NINE_PM,
    sleep: () => Promise.reject(new Error("closed")),
    changed: () => redraws.push(1),
    woken: () => new Promise(() => {}),
  });
  await assert.rejects(done);
  assert.deepEqual(redraws, []);
});

test("a wake recomputes from the quote the getter gives now", async () => {
  // CLOSED_2330 at 21:00 sleeps toward 00:00. After one tick the getter gives a live night WTX& traded at 21:00, which
  // turns stale at 21:02:00.001, and the wake fires: the pending sleep is abandoned and the redraw comes at 21:02.
  const live = wtxDetail({ timestamp: NINE_PM, tradeTime: NINE_PM });
  assert.equal(detailWakeAt(CLOSED_2330, NINE_PM), MIDNIGHT_TPE);
  assert.equal(detailWakeAt(live, NINE_PM + 1_000), NINE_PM + 120_001);
  const host = fakeHost(() => ok({}));
  host.clock = NINE_PM;
  const redraws = [];
  let detail = CLOSED_2330;
  let wake;
  const run = followDetail(() => detail, {
    now: host.now,
    sleep: host.sleep,
    changed: () => redraws.push(host.clock),
    woken: () =>
      new Promise((resolve) => {
        wake = resolve;
      }),
  });
  run.catch(() => {});
  await new Promise((r) => setImmediate(r));
  detail = live;
  wake();
  await advance(host, NINE_PM + 130_000);
  assert.deepEqual(redraws, [NINE_PM + 120_001]);
});

test("a mark's end alone wakes the detail: row 7's 今日無成交 at 15:10", () => {
  // No closureDeadline, so nothing but closureUntil falls at 15:10 (nextEdge gives 00:00 here).
  const fifteen = at("2026-11-11T07:00:00Z");
  const end = at("2026-11-11T07:10:00Z");
  const d = wtxDetail({
    timestamp: at("2026-11-10T05:44:00Z"),
    closure: { kind: "noTrades", source: "yahootw" },
    closureUntil: end,
  });
  assert.equal(detailWakeAt(d, fifteen), end);
});
