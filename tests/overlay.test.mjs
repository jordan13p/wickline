// node --test tests/  (overlay.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { mergeOverlay, pickOverlay } from "../mods/wickline/overlay.js";
import { DAY, at, day, line0050, taipei, withTZ, ytw0050, yq } from "./helpers.mjs";

test("pickOverlay: first live in order, else newest, ties keep order, none → null", () => {
  const NOW = 1_000_000;
  const order = ["yahootw", "mis"];
  const pick = (yahootw, mis) =>
    pickOverlay({ yahootw: { timestamp: yahootw }, mis: { timestamp: mis } }, order, NOW)?.id;
  assert.equal(pick(NOW - 10_000, NOW - 5_000), "yahootw");
  assert.equal(pick(NOW - 180_000, NOW - 5_000), "mis");
  // Live up to LIVE_MAX_AGE_MS old, inclusive.
  assert.equal(pick(NOW - 120_000, NOW - 5_000), "yahootw");
  assert.equal(pick(NOW - 120_001, NOW - 5_000), "mis");
  assert.equal(pick(NOW - 180_000, NOW - 300_000), "yahootw");
  assert.equal(pick(NOW - 180_000, NOW - 180_000), "yahootw");
  assert.equal(pickOverlay({}, order, NOW), null);
});

test("pickOverlay: with none live, a real-time base no older than the newest overlay shows instead", () => {
  const NOW = 1_000_000;
  const stale = { finnhub: { timestamp: NOW - 180_000 } };
  const pick = (base, byProvider = stale) => pickOverlay(byProvider, ["finnhub"], NOW, base)?.id ?? null;
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 10_000), fetchedAt: NOW }), null);
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 180_000), fetchedAt: NOW }), null); // a tie keeps the base
  // An older base, a delayed one or a live overlay: the overlay still shows.
  assert.equal(pick({ ...yq("AAPL", "NMS", NOW - 180_001), fetchedAt: NOW }), "finnhub");
  assert.equal(pick({ ...yq("2330.TW", "TAI", NOW - 10_000), fetchedAt: NOW }), "finnhub");
  assert.equal(
    pick({ ...yq("AAPL", "NMS", NOW - 1_000), fetchedAt: NOW }, { finnhub: { timestamp: NOW - 60_000 } }),
    "finnhub",
  );
  assert.equal(pick(undefined), "finnhub");
});

test("mergeOverlay: a quote over itself keeps its own name, currency and periods, and no line but its own", () => {
  const own = {
    symbol: "^TWOII",
    source: "yahootw",
    name: "櫃檯指數",
    currency: "TWD",
    price: 321.97,
    previousClose: 304.02,
    timestamp: 1,
    fetchedAt: 2,
    day: 5,
  };
  const periods = { pre: null, regular: [0, 1], post: null };
  const row = mergeOverlay({ ...own, periods }, own, null);
  assert.deepEqual([row.name, row.localName, row.currency, row.periods], ["櫃檯指數", "櫃檯指數", "TWD", periods]);
  assert.deepEqual([row.series, row.chartSource, row.chartTimestamp, row.chartFetchedAt], [[], null, null, null]);
  const line = { day: 5, series: [320, 321], lastAt: 0 };
  assert.deepEqual(mergeOverlay({ ...own, periods }, own, line).series, [320, 321, 321.97]);
  assert.equal(mergeOverlay({ ...own, periods }, own, line).chartSource, "yahootw");
});

test("mergeOverlay: a fresh overlay never inherits the base's cached flag; the line's is chartCached", () => {
  const base = {
    ...yq("2330.TW", "TAI", 1_000, day("2026-11-10T01:00:00Z", "2026-11-10T05:30:00Z")),
    series: [1, 2],
    cached: true,
  };
  const mis = { symbol: "2330.TW", source: "mis", price: 500, timestamp: 2_000 };
  const row = mergeOverlay(base, mis, null);
  assert.deepEqual([row.source, row.cached, row.chartCached, row.chartSource], ["mis", undefined, true, "yahoo"]);
  // A sole source over itself keeps its own cached flag and has no chart flag.
  const own = { symbol: "^TWOII", source: "yahootw", price: 300, timestamp: 3_000 };
  const sole = mergeOverlay({ ...own, cached: true }, own, null);
  assert.deepEqual([sole.cached, sole.chartCached], [true, undefined]);
  // Not cached: neither key.
  const { cached, ...plain } = base;
  assert.ok(!("cached" in mergeOverlay(plain, mis, null)));
  assert.ok(!("chartCached" in mergeOverlay(plain, mis, null)));
});

const TW_TODAY = day("2026-11-17T01:00:00Z", "2026-11-17T05:30:00Z");
test("mergeOverlay: the live price is appended at its own trade time", () => {
  assert.equal(
    mergeOverlay(undefined, ytw0050({ tradeTime: taipei("10:31:40") }), line0050).times.at(-1),
    taipei("10:31:40"),
  );
  assert.equal(mergeOverlay(undefined, ytw0050({}), line0050).times.at(-1), taipei("10:32:05")); // no trade time: the quote's
});
test("mergeOverlay: a quiet stock's appended price is never before the line's last point", () => {
  const merged = mergeOverlay(undefined, ytw0050({ tradeTime: taipei("09:17:12") }), line0050);
  assert.deepEqual(merged.times, [...line0050.times, taipei("10:31:00")]);
  assert.equal(merged.times.length, merged.series.length);
});
test("mergeOverlay: a real-time price over Yahoo Finance's line keeps its bar times", () => {
  const base = {
    ...yq("2330.TW", "TAI", taipei("10:30:00"), TW_TODAY),
    price: 2170,
    series: [2165, 2170],
    times: [taipei("10:20:00"), taipei("10:25:00")],
  };
  const mis = mergeOverlay(base, { symbol: "2330.TW", source: "mis", price: 2175, timestamp: taipei("10:32:00") });
  assert.deepEqual([mis.series, mis.times], [base.series, base.times]);
  const ytw = mergeOverlay(base, { ...ytw0050({ tradeTime: taipei("10:31:40") }), symbol: "2330.TW" }, { ...line0050 });
  assert.equal(ytw.times.length, line0050.series.length + 1);
  assert.ok(base.times.every((time) => !ytw.times.includes(time)));
});
test("mergeOverlay: no times without a timed line", () => {
  const { times: _t, ...untimed } = line0050;
  assert.equal("times" in mergeOverlay(undefined, ytw0050({ tradeTime: taipei("10:31:40") }), untimed), false);
  assert.equal("times" in mergeOverlay(undefined, ytw0050({}), null), false);
  assert.equal("times" in mergeOverlay(undefined, ytw0050({}), { ...line0050, times: [taipei("10:31:00")] }), false); // misaligned
});
test("mergeOverlay: the base's times never go with any line but the base's", () => {
  const base = {
    ...yq("2330.TW", "TAI", taipei("10:30:00"), TW_TODAY),
    price: 2170,
    series: [1, 2],
    times: [taipei("10:20:00"), taipei("10:25:00")],
  };
  const untimed = { day: DAY, series: [189.1, 189.2] };
  const cases = {
    "an own line without times": mergeOverlay(
      base,
      { ...ytw0050({ tradeTime: taipei("10:31:40") }), symbol: "2330.TW" },
      untimed,
    ),
    "a price from another period": mergeOverlay(base, {
      symbol: "2330.TW",
      source: "mis",
      price: 2175,
      timestamp: taipei("08:59:00"),
    }),
    "a quote over its own source": mergeOverlay(base, { ...base, price: 2175, timestamp: taipei("10:32:00") }, null),
  };
  for (const [name, merged] of Object.entries(cases)) assert.equal("times" in merged, false, name);
});

test("A line only under its own session's price: a US row past local midnight", () => {
  // On a Taipei clock, 22:30 and 00:30 are one New York session (09:30 and 11:30); the periods are epoch ms.
  withTZ("Asia/Taipei", () => {
    const NY_DAY = day("2026-11-17T14:30:00Z", "2026-11-17T21:00:00Z");
    const base = {
      ...yq("AAPL", "NMS", taipei("22:30:00"), NY_DAY),
      price: 230,
      previousClose: 228,
      series: [228, 230],
    };
    const row = mergeOverlay(
      base,
      { symbol: "AAPL", source: "finnhub", price: 231, timestamp: taipei("00:30:00", "2026-11-18") },
      null,
    );
    assert.deepEqual([row.series, row.chartSource], [[228, 230], "yahoo"]);
  });
});

test("AAPL priced by Finnhub shows Yahoo Finance's live volume, and never a delayed one", () => {
  const finnhubQuote = { symbol: "AAPL", source: "finnhub", price: 231.2, timestamp: 1_000_000, fetchedAt: 1_000_000 };
  const base = {
    symbol: "AAPL",
    source: "yahoo",
    exchange: "NMS",
    price: 230,
    timestamp: 990_000,
    fetchedAt: 990_000,
    volume: 48_213_500,
    sizeUnit: "share",
  };
  const merged = mergeOverlay(base, finnhubQuote, null);
  assert.equal(merged.volume, 48_213_500);
  assert.equal(merged.sizeUnit, "share");
  // A base that is not real time lends none.
  const delayed = mergeOverlay(
    { ...base, symbol: "0700.HK", exchange: "HKG" },
    { ...finnhubQuote, symbol: "0700.HK" },
    null,
  );
  assert.equal("volume" in delayed, false);
  assert.equal("sizeUnit" in delayed, false);
  // An overlay's own volume replaces the base's, unit with it.
  const own = mergeOverlay(base, { ...finnhubQuote, volume: 1_000, sizeUnit: "share" }, null);
  assert.equal(own.volume, 1_000);
});

test("a Finnhub price never shows a cached or an earlier session's Yahoo Finance volume", () => {
  // Monday's close (11/16 21:00 UTC) with that day's whole volume; Tuesday's first Finnhub price.
  const finnhubQuote = {
    symbol: "AAPL",
    source: "finnhub",
    price: 231.2,
    timestamp: at("2026-11-17T14:30:05Z"),
    fetchedAt: at("2026-11-17T14:30:05Z"),
  };
  const monday = {
    symbol: "AAPL",
    source: "yahoo",
    exchange: "NMS",
    price: 230,
    timestamp: at("2026-11-16T21:00:00Z"),
    fetchedAt: at("2026-11-16T21:00:00Z"),
    volume: 48_213_500,
    sizeUnit: "share",
    periods: day("2026-11-16T14:30:00Z", "2026-11-16T21:00:00Z"),
  };
  // Its last fetch failed: the volume is the kept one, whatever its periods.
  const cached = mergeOverlay({ ...monday, cached: true }, finnhubQuote, null);
  assert.equal("volume" in cached, false);
  assert.equal("sizeUnit" in cached, false);
  // Fetched before the open with Tuesday's periods: Monday's volume, not today's.
  const tuesday = day("2026-11-17T14:30:00Z", "2026-11-17T21:00:00Z");
  const before = mergeOverlay(
    { ...monday, fetchedAt: at("2026-11-17T14:00:00Z"), periods: tuesday },
    finnhubQuote,
    null,
  );
  assert.equal("volume" in before, false);
  // A live base in the price's own period still lends its volume.
  const live = mergeOverlay(
    { ...monday, timestamp: at("2026-11-17T14:30:00Z"), fetchedAt: at("2026-11-17T14:30:00Z"), periods: tuesday },
    finnhubQuote,
    null,
  );
  assert.equal(live.volume, 48_213_500);
});
