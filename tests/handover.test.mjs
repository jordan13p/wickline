// node --test tests/  (handover.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { DETAIL_KEY, adopt, clearsOnClose, makeToken, nextWrite, packTimes, startHandover, unpackTimes } from "../mods/wickline/handover.js";
import { Watchlist } from "../mods/wickline/watchlist.js";
import { detailSource, sessionOf } from "../mods/wickline/freshness.js";
import { heldMarks, taipeiDay } from "../mods/wickline/calendar.js";
import { failureNote } from "../mods/wickline/format.js";
import { MIS_URL, mis } from "../mods/wickline/providers/mis.js";
import { yahootw } from "../mods/wickline/providers/yahootw.js";
import { BOTH_ON, LISTED_2026, MIS_ON, at, day, fakeHost, jsonFixture, ok, say, taipei, withTZ, yq } from "./helpers.mjs";

// Herdr's shared state: what is written is persisted, so a read gives a copy, never the object written.
function memoryStore() {
  let value;
  return {
    read: () => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
    write: (next) => { value = JSON.parse(JSON.stringify(next)); },
  };
}

// A Watchlist with the settings `prefs` on and `symbols` listed, its records set by hand: `quotes` the base quotes,
// `overlays` each symbol's overlays by source.
function watchWith(prefs, { quotes = {}, overlays = {} } = {}, symbols = ["2330.TW"]) {
  const host = fakeHost(() => ok({}));
  host.prefs = prefs;
  host.store = { version: 1, symbols, paused: false };
  const w = new Watchlist(host);
  Object.assign(w.quotes, quotes);
  Object.assign(w.overlays, overlays);
  return w;
}

// The hand-over as main.js wires it: `open` is openDetail (the token in the detail's props as `held`), `pass` the
// handOver each loop runs where it calls changed(), `render` the detail's adoptDetail, `close` the detail's close().
function glue(w, store) {
  let mine = null;
  return {
    get mine() { return mine; },
    open(symbol, now, random = 0.5) {
      const token = makeToken(now, random);
      const started = startHandover(symbol, token, w.detailQuote(symbol, now));
      store.write(started.value);
      mine = started.mine;
      return { token, seq: 1 };
    },
    pass(now, paused = w.preferences.paused) {
      if (!mine) return null;
      const next = nextWrite(store.read(), mine, w.detailQuote(mine.symbol, now), paused);
      mine = next.mine;
      if (next.write) store.write(next.write);
      return next.write;
    },
  };
}
const render = (store, held) => {
  const got = adopt(store.read(), held);
  if (got) held.seq = got.seq;
  return got?.quote ?? null;
};
const close = (store, held) => {
  if (held && clearsOnClose(store.read(), held.token)) store.write({});
};

// Tuesday 2026-11-17 in Taipei: Yahoo Finance's delayed 2330.TW under today's periods, and a MIS or Yahoo 奇摩股市 price.
const TW_TODAY = day("2026-11-17T01:00:00Z", "2026-11-17T05:30:00Z");
const yahooDelayed = (time, symbol = "2330.TW") => ({ ...yq(symbol, "TAI", time, TW_TODAY), price: 2180, series: [2190, 2180], fetchedAt: time });
const yahooClose = () => ({ ...yq("2330.TW", "TAI", taipei("13:30:00", "2026-11-16"), TW_TODAY), price: 2215, series: [2200, 2215] });
const misPrice = (time, fields = {}) => ({ symbol: "2330.TW", source: "mis", price: 2172.5, timestamp: time, fetchedAt: time, ...fields });
const ytwTrade = (price, time) => ({ symbol: "2330.TW", source: "yahootw", price, timestamp: time, tradeTime: time, day: taipeiDay(time), fetchedAt: time });
// What the open detail shows at `time` from the quote it holds.
const sourceAt = (q, time) => {
  const held = heldMarks(q, time);
  return detailSource(held, sessionOf(held, time), time, say("zh-TW"));
};

test("the key is wickline.detail", () => {
  assert.equal(DETAIL_KEY, "wickline.detail");
});

test("makeToken differs by time and by chance", () => {
  assert.notEqual(makeToken(1_794_979_440_000, 0.25), makeToken(1_794_979_440_000, 0.26));
  assert.notEqual(makeToken(1_794_979_440_000, 0.25), makeToken(1_794_979_440_001, 0.25));
  assert.match(makeToken(1_794_979_440_000, 0.25), /^[0-9a-z]+-[0-9a-z]+$/);
});

test("Current while open", () => {
  const w = watchWith(MIS_ON, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) },
    overlays: { "2330.TW": { mis: misPrice(taipei("10:00:00")) } } });
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("2330.TW", taipei("10:00:02"));
  assert.equal(render(store, held), null, "nothing newer than what it opened with");
  w.overlays["2330.TW"].mis = misPrice(taipei("10:00:10"), { price: 2175 });
  const t = taipei("10:00:12");
  x.pass(t);
  assert.equal(store.read().seq, 2);
  const q = render(store, held);
  assert.equal(q.price, 2175);
  assert.equal(sourceAt(q, t)[0][0], "價格：即時 · 證交所 MIS");
  assert.equal(held.seq, 2);
  // The panel's own requests are all there are: the hand-over asks nothing.
  assert.equal(w.host.requests.length, 0);
});

test("A failed round while open", () => {
  const traded = taipei("22:00:00");
  const own = { symbol: "WTX&", source: "yahootw", exchange: "TFE", price: 23_000, timestamp: traded, tradeTime: traded,
    day: taipeiDay(traded), fetchedAt: traded + 2_000, periods: null };
  const w = watchWith(BOTH_ON, { overlays: { "WTX&": { yahootw: own } } }, ["WTX&"]);
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("WTX&", traded + 5_000);
  w.fail(yahootw, "WTX&", { code: "yahootw.unreachable", params: {} });
  const t = traded + 15_000;
  assert.ok(x.pass(t), "the failure is handed");
  const q = render(store, held);
  assert.equal(q.cached, true);
  assert.equal(failureNote(q, q.error), "quote.cached");
  withTZ("Asia/Taipei", () => assert.ok(sourceAt(q, t)[0][0].includes("報價停在 22:00 · Yahoo 奇摩股市"), sourceAt(q, t)[0][0]));
});

test("A fallback while open", () => {
  const w = watchWith(MIS_ON, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) },
    overlays: { "2330.TW": { mis: misPrice(taipei("09:59:50")) } } });
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("2330.TW", taipei("09:59:55"));
  assert.equal(store.read().quote.source, "mis");
  w.fail(mis, "2330.TW", { code: "mis.timeout", params: {} });
  x.pass(taipei("10:00:00"));
  const q = render(store, held);
  assert.equal(q.source, "yahoo");
  assert.equal(q.fallback.code, "mis.timeout");
});

test("Another detail takes over", () => {
  const records = () => ({ quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")), "0050.TW": yahooDelayed(taipei("09:40:00"), "0050.TW") } });
  const wx = watchWith(undefined, records(), ["2330.TW", "0050.TW"]);
  const wy = watchWith(undefined, records(), ["2330.TW", "0050.TW"]);
  const store = memoryStore();
  const x = glue(wx, store);
  const y = glue(wy, store);
  const heldX = x.open("2330.TW", taipei("10:00:00"), 0.1);
  close(store, heldX);
  assert.deepEqual(store.read(), {});
  const heldY = y.open("0050.TW", taipei("10:00:05"), 0.2);
  // X's next round brings 2330.TW a newer price: the key holds Y's token, so X drops its own.
  wx.quotes["2330.TW"] = yahooDelayed(taipei("10:00:30"));
  assert.equal(x.pass(taipei("10:00:40")), null);
  assert.equal(x.mine, null);
  assert.equal(store.read().token, heldY.token);
  wy.quotes["0050.TW"] = yahooDelayed(taipei("10:00:30"), "0050.TW");
  assert.equal(y.pass(taipei("10:00:41")).seq, 2);
  assert.equal(render(store, heldY).timestamp, taipei("10:00:30"));
  // X writes no more, whatever changes.
  wx.quotes["2330.TW"] = yahooDelayed(taipei("10:01:30"));
  assert.equal(x.pass(taipei("10:01:40")), null);
  assert.equal(store.read().token, heldY.token);
});

test("Closing clears it", () => {
  const w = watchWith(undefined, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")), "0050.TW": yahooDelayed(taipei("09:40:00"), "0050.TW") } },
    ["2330.TW", "0050.TW"]);
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("2330.TW", taipei("10:00:00"));
  close(store, held);
  assert.deepEqual(store.read(), {});
  w.quotes["2330.TW"] = yahooDelayed(taipei("10:00:30"));
  assert.equal(x.pass(taipei("10:00:40")), null);
  assert.deepEqual(store.read(), {});
  // A detail opened in the meantime keeps its own: A's close leaves B's hand-over.
  const a = x.open("2330.TW", taipei("10:01:00"), 0.3);
  const b = x.open("0050.TW", taipei("10:01:01"), 0.4);
  assert.equal(clearsOnClose(store.read(), a.token), false);
  close(store, a);
  assert.equal(store.read().token, b.token);
});

test("Paused or removed", () => {
  const w = watchWith(MIS_ON, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) },
    overlays: { "2330.TW": { mis: misPrice(taipei("10:00:00")) } } });
  w.pause(true);
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", taipei("10:00:05"));
  // No round while paused: nothing the row reads has changed.
  assert.equal(x.pass(taipei("10:01:05")), null);
  // Refresh runs a round: its new fetch time is handed.
  w.overlays["2330.TW"].mis = misPrice(taipei("10:00:00"), { fetchedAt: taipei("10:01:10") });
  assert.equal(x.pass(taipei("10:01:11")).seq, 2);
  // Removed: nothing to hand, and the copy keeps its token for a symbol listed again.
  const mine = x.mine;
  w.adopt({ ...w.preferences, symbols: [] });
  assert.equal(x.pass(taipei("10:01:20")), null);
  assert.equal(x.mine, mine);
  assert.equal(store.read().seq, 2);
});

// LISTED_2026 lists Thursday 2/12 and Friday 2/13; 2330.TW last traded on 2/11 at 13:30.
function secondClosedDay() {
  const w = watchWith(MIS_ON, { quotes: { "2330.TW": { ...yq("2330.TW", "TAI", at("2026-02-11T05:30:00Z"),
    day("2026-02-11T01:00:00Z", "2026-02-11T05:30:00Z")), price: 1_000, series: [990, 1_000] } } });
  w.holidays.days = LISTED_2026;
  return w;
}
const MIDNIGHT_0213 = at("2026-02-12T16:00:00Z");

test("A second closed day: the paused panel hands nothing at midnight", () => {
  const w = secondClosedDay();
  w.pause(true);
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", at("2026-02-12T14:00:00Z"));                                  // 22:00 on 2/12
  assert.equal(store.read().quote.closure?.kind, "listed");
  // Only the marks differ at 00:00:01 on 2/13.
  const { closure: _a, closureUntil: _b, ...before } = store.read().quote;
  const { closure: _c, closureUntil: _d, ...after } = JSON.parse(JSON.stringify(w.detailQuote("2330.TW", MIDNIGHT_0213 + 1_000)));
  assert.deepEqual(after, before);
  assert.equal(x.pass(MIDNIGHT_0213 + 1_000), null);
  assert.equal(store.read().seq, 1);
});

test("unpaused, a closure change is handed at once", () => {
  const w = secondClosedDay();
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", at("2026-02-12T14:00:00Z"));
  const write = x.pass(MIDNIGHT_0213 + 1_000);
  assert.equal(write.seq, 2);
  assert.equal(write.quote.closure?.kind, "listed");
  assert.equal(write.quote.closureUntil, at("2026-02-13T16:00:00Z"));               // 00:00 on 2/14
});

test("opened unpaused, then paused: no mark change is handed", () => {
  const w = secondClosedDay();
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", MIDNIGHT_0213 - 30_000);                                       // 23:59:30 on 2/12
  w.pause(true);
  assert.equal(x.pass(MIDNIGHT_0213 + 1_000), null);
});

test("a paused list hands a fallback as its overlay ages", () => {
  const w = watchWith(BOTH_ON, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) },
    overlays: { "2330.TW": { yahootw: ytwTrade(2190, taipei("10:00:00")) } } });
  w.fail(mis, "2330.TW", { code: "mis.timeout", params: {} });
  w.pause(true);
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", taipei("10:00:00"));
  assert.equal(store.read().quote.fallback, null);
  assert.equal(x.pass(taipei("10:01:00")), null);
  const write = x.pass(taipei("10:02:01"));
  assert.equal(write.quote.fallback.code, "mis.timeout");
  assert.equal(write.seq, 2);
});

test("A flag nobody refreshes: the paused panel hands nothing when the flag ends", () => {
  const w = watchWith(MIS_ON, { quotes: { "2330.TW": yahooClose() } });
  w.auctionAt["2330.TW"] = taipei("08:59:57");
  w.pause(true);
  const store = memoryStore();
  const x = glue(w, store);
  x.open("2330.TW", taipei("09:00:30"));
  assert.equal(x.pass(taipei("09:01:58")), null);
});

test("a copy that opened no detail never writes", () => {
  const wx = watchWith(undefined, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) } });
  const wy = watchWith(undefined, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")) } });
  const store = memoryStore();
  glue(wx, store).open("2330.TW", taipei("10:00:00"));
  wy.quotes["2330.TW"] = yahooDelayed(taipei("10:00:30"));
  assert.deepEqual(nextWrite(store.read(), null, wy.detailQuote("2330.TW", taipei("10:00:40")), false), { write: null, mine: null });
  assert.equal(store.read().seq, 1);
});

const Q = { symbol: "2330.TW", source: "mis", price: 2172.5, timestamp: 1 };

test("adopt ignores what is not its own newer hand-over", () => {
  const held = { token: "a", seq: 2 };
  for (const stored of [undefined, null, {}, "x", { token: "a" }, { symbol: "2330.TW", token: "a", seq: "3", quote: Q },
    { symbol: "2330.TW", token: "a", seq: 3, quote: null }, { symbol: "0050.TW", token: "a", seq: 3, quote: Q },
    { symbol: "2330.TW", token: "b", seq: 3, quote: Q }, { symbol: "2330.TW", token: "a", seq: 2, quote: Q }]) {
    assert.equal(adopt(stored, held), null);
  }
  assert.deepEqual(adopt({ symbol: "2330.TW", token: "a", seq: 3, quote: Q }, held), { quote: Q, seq: 3 });
  assert.equal(adopt({ symbol: "2330.TW", token: "a", seq: 3, quote: Q }, null), null);   // a detail opened without a token
});

test("clearsOnClose only for its own token", () => {
  const own = { symbol: "2330.TW", token: "a", seq: 3, quote: Q };
  assert.equal(clearsOnClose(own, "a"), true);
  for (const stored of [{ ...own, token: "b" }, {}, undefined, null, { token: "a" }, { ...own, seq: 0 }, { ...own, quote: null }]) {
    assert.equal(clearsOnClose(stored, "a"), false);
  }
  assert.equal(clearsOnClose(own, null), false);
});

test("nextWrite drops its token for any value but its own", () => {
  const { mine } = startHandover("2330.TW", "a", Q);
  const newer = { ...Q, price: 2175 };
  for (const stored of [{}, undefined, null, "x", { symbol: "2330.TW", token: "b", seq: 9, quote: Q }, { token: "a", seq: 1 }]) {
    assert.deepEqual(nextWrite(stored, mine, newer, false), { write: null, mine: null });
  }
  const stored = { symbol: "2330.TW", token: "a", seq: 1, quote: Q };
  assert.deepEqual(nextWrite(stored, mine, null, false), { write: null, mine });
  assert.deepEqual(nextWrite(stored, mine, { ...Q }, false), { write: null, mine });
  const next = nextWrite(stored, mine, newer, false);
  assert.deepEqual(next.write, { symbol: "2330.TW", token: "a", seq: 2, quote: newer });
  assert.deepEqual(next.mine, { symbol: "2330.TW", token: "a", seq: 2, quote: newer });
  assert.deepEqual(startHandover("2330.TW", "a", Q).value, { symbol: "2330.TW", token: "a", seq: 1, quote: Q });
});

// Five levels a side and every activity field the detail shows.
const BOOK = {
  bids: [2175, 2170, 2165, 2160, 2155].map((price, i) => ({ price, size: 1_234 + i })),
  asks: [2180, 2185, 2190, 2195, 2200].map((price, i) => ({ price, size: 2_345 + i })),
};
const ACTIVITY = { volume: 38_211, previousVolume: 41_502, turnover: 83_123_456_789, avgPrice: 2177.35, lastSize: 12, inner: 18_002,
  outer: 20_209, sizeUnit: "lot" };

test("a full-day 2330.TW value stays under 16 KB", () => {
  const series = Array.from({ length: 271 }, (_, i) => 2150 + (i % 121) * 0.5);
  const quote = { ...yahooDelayed(taipei("13:30:00")), ...misPrice(taipei("13:30:00")), ...ACTIVITY, book: BOOK, series, name: "Taiwan Semiconductor Manufacturing Company Limited",
    localName: "台積電", previousClose: 2170, changePercent: 0.12, open: 2160, high: 2210, low: 2150, limitUp: 2385, limitDown: 1955,
    currency: "TWD", chartSource: "yahoo", chartTimestamp: taipei("13:30:00"), chartFetchedAt: taipei("13:30:05"), twRealtime: true,
    closure: null, error: null, fallback: null };
  const size = JSON.stringify(startHandover("2330.TW", makeToken(taipei("13:30:00"), 0.5), quote).value).length;
  assert.ok(size < 16_384, `${size}`);
});

test("a future's full trading day stays under 16 KB too", () => {
  const series = Array.from({ length: 1_140 }, (_, i) => 40_000 + ((i * 37) % 400) - 200);
  const traded = taipei("13:44:00");
  const quote = { symbol: "WTX&", source: "yahootw", exchange: "TFE", price: 40_123, timestamp: traded, tradeTime: traded, fetchedAt: traded,
    day: taipeiDay(traded), ...ACTIVITY, sizeUnit: "contract", book: BOOK, series, name: "台指期近一", localName: "台指期近一",
    previousClose: 39_900, changePercent: 0.56, open: 39_950, high: 40_210, low: 39_800, limitUp: 43_890, limitDown: 35_910,
    periods: { pre: null, regular: [taipei("15:00:00", "2026-11-16"), taipei("13:45:00")], post: null,
      segments: [[taipei("15:00:00", "2026-11-16"), taipei("05:00:00")], [taipei("08:45:00"), taipei("13:45:00")]] },
    chartSource: "yahootw", chartTimestamp: traded, chartFetchedAt: traded, closure: null, error: null, fallback: null };
  const size = JSON.stringify(startHandover("WTX&", makeToken(traded, 0.5), quote).value).length;
  assert.ok(size < 16_384, `${size}`);
});

// A night WTX&: 840 night minutes from 15:00, the 13,500 s break, 299 day minutes from 08:45 with 09:00 skipped, and the
// appended live price at 13:44:20 — 1,140 points, `.5` prices.
const NIGHT_TIMES = [
  ...Array.from({ length: 840 }, (_, i) => taipei("15:00:00", "2026-11-16") + i * 60_000),
  ...Array.from({ length: 300 }, (_, i) => taipei("08:45:00") + i * 60_000).filter((t) => t !== taipei("09:00:00")),
  taipei("13:44:20"),
];
test("packTimes stores whole seconds and deltas; unpackTimes gives the same times back", () => {
  const q = { ...Q, series: NIGHT_TIMES.map((_, i) => 40_000.5 + i), times: NIGHT_TIMES };
  const packed = packTimes(q);
  assert.equal("times" in packed, false);
  assert.equal(packed.timesPacked.t0, NIGHT_TIMES[0] / 1000);
  assert.deepEqual(new Set(packed.timesPacked.d), new Set([60, 13_560, 120, 20]));   // minute, 05:00→08:45 after 04:59, the skip, 13:44→13:44:20
  assert.deepEqual(unpackTimes(JSON.parse(JSON.stringify(packed))), q);
  assert.equal(packTimes(Q), Q);
  assert.equal("timesPacked" in packTimes({ ...Q, series: [1], times: [1_500] }), false);  // not a whole second: no times at all
});
test("unpackTimes refuses what it cannot decode", () => {
  const good = packTimes({ ...Q, series: [1, 2, 3], times: [60_000, 120_000, 180_000] });
  for (const timesPacked of [null, "x", { t0: 60.5, d: [60, 60] }, { t0: 60, d: "60" }, { t0: 60, d: [60, "60"] }, { t0: 60, d: [60] }, { t0: 60, d: [60, 1.5] }]) {
    const out = unpackTimes({ ...good, timesPacked });
    assert.equal("times" in out || "timesPacked" in out, false, JSON.stringify(timesPacked));
    assert.deepEqual(out.series, [1, 2, 3]);
  }
  assert.equal("times" in unpackTimes({ ...Q, series: [1, 2], times: [1, 2] }), false);   // a plain array is never read
});
test("a timed quote is handed packed, kept plain, adopted with its times and not written again", () => {
  const timed = { ...yahooDelayed(taipei("10:00:00")), times: [taipei("09:55:00"), taipei("10:00:00")] };
  const w = watchWith(undefined, { quotes: { "2330.TW": timed } });
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("2330.TW", taipei("10:00:10"));
  assert.deepEqual(store.read().quote.timesPacked, { t0: taipei("09:55:00") / 1000, d: [300] });
  assert.deepEqual(x.mine.quote.times, timed.times);
  assert.equal(x.pass(taipei("10:00:20")), null);                       // the same quote: nothing written
  w.quotes["2330.TW"] = { ...timed, price: 2185, series: [2190, 2185] };
  assert.ok(x.pass(taipei("10:00:30")));
  assert.deepEqual(render(store, held).times, timed.times);
  assert.equal(x.pass(taipei("10:00:40")), null);
});
test("a future's full trading day with its times stays under 16 KB", () => {
  const traded = taipei("13:44:20");
  const series = NIGHT_TIMES.map((_, i) => 40_000.5 + ((i * 37) % 400) - 200);
  const quote = { symbol: "WTX&", source: "yahootw", exchange: "TFE", price: 40_123.5, timestamp: traded, tradeTime: traded, fetchedAt: traded,
    day: taipeiDay(traded), ...ACTIVITY, sizeUnit: "contract", book: BOOK, series, times: NIGHT_TIMES, name: "台指期近一", localName: "台指期近一",
    previousClose: 39_900, changePercent: 0.56, open: 39_950, high: 40_210, low: 39_800, limitUp: 43_890, limitDown: 35_910,
    periods: { pre: null, regular: [taipei("15:00:00", "2026-11-16"), taipei("13:45:00")], post: null,
      segments: [[taipei("15:00:00", "2026-11-16"), taipei("05:00:00")], [taipei("08:45:00"), taipei("13:45:00")]] },
    chartSource: "yahootw", chartTimestamp: traded, chartFetchedAt: traded, closure: null, error: null, fallback: null };
  const { value } = startHandover("WTX&", makeToken(traded, 0.5), quote);
  const size = JSON.stringify(value).length;
  assert.ok(size < 16_384, `${size}`);                                // about 13,700 B (plain ms would be about 26,200)
  assert.deepEqual(unpackTimes(JSON.parse(JSON.stringify(value.quote))).times, NIGHT_TIMES);
});

test("a second open from the same copy replaces the first", () => {
  const w = watchWith(undefined, { quotes: { "2330.TW": yahooDelayed(taipei("09:40:00")), "0050.TW": yahooDelayed(taipei("09:40:00"), "0050.TW") } },
    ["2330.TW", "0050.TW"]);
  const store = memoryStore();
  const x = glue(w, store);
  const a = x.open("2330.TW", taipei("10:00:00"), 0.1);
  const b = x.open("0050.TW", taipei("10:00:01"), 0.2);
  w.quotes["2330.TW"] = yahooDelayed(taipei("10:00:30"));
  w.quotes["0050.TW"] = yahooDelayed(taipei("10:00:30"), "0050.TW");
  assert.equal(x.pass(taipei("10:00:40")).symbol, "0050.TW");
  assert.equal(render(store, a), null);
  assert.equal(render(store, b).symbol, "0050.TW");
  assert.equal(clearsOnClose(store.read(), a.token), false);
});

test("A newer answer", () => {
  // Wednesday 2026-11-18 at 13:30: MIS's recorded answer, then one whose best bid holds more.
  const w = watchWith(MIS_ON);
  const now = taipei("13:30:02", "2026-11-18");
  const body = jsonFixture("mis-detail-1330");
  const answer = (g) => {
    const request = mis.requests(["2330.TW"], { misUrl: MIS_URL })[0];
    const rows = body.msgArray.map((row) => (row.c === "2330" ? { ...row, g } : row));
    w.apply(mis, request, mis.decode(request, ok({ ...body, msgArray: rows }), now));
  };
  w.host.clock = now;
  answer("2280_208_394_467_1280_");
  const store = memoryStore();
  const x = glue(w, store);
  const held = x.open("2330.TW", now);
  answer("2300_208_394_467_1280_");
  assert.equal(x.pass(now + 1_000).seq, 2);
  assert.equal(render(store, held).book.bids[0].size, 2300);
});
