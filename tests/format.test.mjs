// node --test tests/  (format.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { chartGeometry, detailTimes, formatBandPrice, formatChange, formatPrice, formatStaleDate, formatTime, freshnessLabel, rowName } from "../mods/wickline/format.js";
import { freshness } from "../mods/wickline/freshness.js";
import { t } from "../mods/wickline/i18n.js";

test("formats without Intl", () => {
  assert.equal(formatPrice({ price: 1234567.891, currency: "USD" }), "1,234,567.89 USD");
  assert.equal(formatPrice({ price: 0.00000441, currency: null }), "0.00000441");
  assert.equal(formatPrice({ price: 0.5, currency: null }), "0.50");
  assert.equal(formatPrice({ price: 0.123456, currency: null }), "0.1235");
  assert.equal(formatBandPrice({ symbol: "AAPL", price: 230.1, currency: "USD" }), "230.10");
  assert.equal(formatBandPrice({ symbol: "BTC/USDT", price: 65000, currency: "USDT" }), "65,000.00");
  assert.equal(formatBandPrice({ symbol: "0700.HK", price: 600, currency: "HKD" }), "600.00 HKD");
  assert.equal(formatChange(1.234), "+1.23%");
  assert.equal(formatChange(-0.5), "-0.50%");
  assert.equal(formatChange(null), "—");
  const now = new Date(2026, 10, 2, 12).getTime();
  assert.equal(formatStaleDate(new Date(2026, 10, 2, 9).getTime(), now), "");
  assert.equal(formatStaleDate(new Date(2026, 9, 31, 16).getTime(), now), "Oct 31");
});

test("dates by language, times in 24 hours", () => {
  const now = new Date(2026, 10, 2, 12).getTime();
  const oct31 = new Date(2026, 9, 31, 16).getTime();
  assert.equal(formatStaleDate(oct31, now, "en"), "Oct 31");
  for (const lang of ["zh-TW", "zh-CN", "ja", "ko"]) assert.equal(formatStaleDate(oct31, now, lang), "10/31", lang);
  assert.equal(formatStaleDate(new Date(2026, 10, 2, 9).getTime(), now, "zh-TW"), "");
  assert.equal(formatTime(new Date(2026, 10, 2, 21, 5, 7).getTime()), "21:05");
  assert.equal(formatTime(new Date(2026, 10, 2, 9, 5, 7).getTime(), true), "09:05:07");
});

test("scales a line into its box", () => {
  assert.equal(chartGeometry([1], 1), null);
  const g = chartGeometry([10, 20], 15);
  assert.deepEqual(g.points.map((p) => p[0]), [0, 100]);
  assert.ok(g.points[0][1] > g.points[1][1]);
  assert.ok(g.reference > g.points[1][1] && g.reference < g.points[0][1]);
  assert.ok(g.points.every(([, y]) => y > 0 && y < 100));
  const flat = chartGeometry([5, 5, 5], null);
  assert.equal(flat.reference, null);
  assert.equal(flat.points[0][1], 50);
  assert.match(formatTime(new Date(2026, 10, 2, 9, 5).getTime()), /^09:05$/);
});

test("a name that begins with the live label keeps both", () => {
  const live = t("en", "freshness.live");
  assert.deepEqual(rowName("LYV", live, "Live Nation Entertainment"), { label: "Live", name: "Live Nation Entertainment" });
});

test("a pair has no instrument name: its venue never becomes a name line", () => {
  assert.deepEqual(rowName("BTC/USDT", "Live", "Binance Spot"), { label: "Live", name: "" });
  assert.deepEqual(rowName("BTC/USDT", "quote stopped at 13:05", "Binance Spot"), { label: "quote stopped at 13:05", name: "" });
});

test("a stock's name gets its own line", () => {
  assert.deepEqual(rowName("2330.TW", "已收盤 · 11/5 13:30", "台積電"), { label: "已收盤 · 11/5 13:30", name: "台積電" });
  // Finnhub keeps the Yahoo name, so a US row reads the same with either source.
  assert.deepEqual(rowName("AAPL", "Finnhub", "Apple Inc."), { label: "Finnhub", name: "Apple Inc." });
  assert.deepEqual(rowName("AAPL", "Yahoo · delayed", "Apple Inc."), { label: "Yahoo · delayed", name: "Apple Inc." });
});

test("a row's name that only repeats the ticker, or is missing, is left out", () => {
  assert.deepEqual(rowName("^GSPC", "delayed 15 min", "^GSPC"), { label: "delayed 15 min", name: "" });
  assert.deepEqual(rowName("AAPL", "Yahoo", null), { label: "Yahoo", name: "" });
});

test("the live label names the state, not the source", () => {
  const now = new Date(2026, 10, 9, 9, 41, 20).getTime();
  const at = (source, symbol) => ({ symbol, source, timestamp: now - 10_000 });
  for (const lang of ["en", "zh-TW", "zh-CN", "ja", "ko"]) {
    const tx = (key, params) => t(lang, key, params);
    const label = (quote, session) => freshnessLabel(quote, freshness(quote, session, now), now, lang, tx);
    for (const [source, symbol, session] of [["mis", "2330.TW", "open"], ["yahootw", "2330.TW", "open"], ["finnhub", "AAPL", "open"], ["binance", "BTC/USDT", "24h"]]) {
      assert.equal(label(at(source, symbol), session), t(lang, "freshness.live"), `${lang} ${source}`);
    }
    // A session not known yet keeps the source name: nothing says it is live.
    assert.equal(label(at("mis", "2330.TW"), "unknown"), t(lang, "src.mis"), lang);
    assert.equal(label({ ...at("yahootw", "2330.TW"), timestamp: now - 180_000 }, "open"),
      t(lang, "freshness.stalled", { time: formatTime(now - 180_000) }), lang);
  }
});

test("the detail times: quoted, the last trade when it differs, fetched", () => {
  const tx = (key, params) => t("en", key, params);
  const at = (h, m, s) => new Date(2026, 10, 9, h, m, s).getTime();
  const now = at(9, 41, 20);
  // 0050.TW from Yahoo 奇摩股市: quoted at the feed's time, its own last trade earlier.
  const quiet = { timestamp: at(9, 41, 13), tradeTime: at(9, 17, 12), fetchedAt: at(9, 41, 19) };
  assert.deepEqual(detailTimes(quiet, now, "en", tx), ["Quote at 09:41:13", "last trade 09:17:12", "Fetched 09:41:19"]);
  assert.deepEqual(detailTimes({ ...quiet, tradeTime: quiet.timestamp }, now, "en", tx), ["Quote at 09:41:13", "Fetched 09:41:19"]);
  const { tradeTime, ...plain } = quiet;
  assert.deepEqual(detailTimes(plain, now, "en", tx), ["Quote at 09:41:13", "Fetched 09:41:19"]);
  // An earlier day puts its date before the quote time.
  assert.deepEqual(detailTimes({ ...plain, timestamp: at(9, 41, 13) - 86_400_000 }, now, "en", tx)[0], "Quote at Nov 8 09:41:13");
});
