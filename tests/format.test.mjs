// node --test tests/  (format.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { chartGeometry, dropBefore, formatBandPrice, formatChange, formatPrice, formatStaleDate, formatTime, rowName } from "../mods/wickline/format.js";

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

test("a row's name and label: a name that begins with the label replaces it", () => {
  assert.deepEqual(rowName("BTC/USDT", "Binance", "Binance Spot"), { label: "Binance Spot", name: "" });
  assert.deepEqual(rowName("AAPL", "Yahoo · delayed", "Apple Inc."), { label: "Yahoo · delayed", name: "Apple Inc." });
});

test("a pair has no instrument name: its venue never becomes a name line", () => {
  // Live: the venue merges into the label, as before.
  assert.deepEqual(rowName("BTC/USDT", "Binance", "Binance Spot"), { label: "Binance Spot", name: "" });
  // Stalled: the label does not merge, and the venue still is no name.
  assert.deepEqual(rowName("BTC/USDT", "quote stopped at 13:05", "Binance Spot"), { label: "quote stopped at 13:05", name: "" });
});

test("a stock's name gets its own line", () => {
  assert.deepEqual(rowName("2330.TW", "已收盤 · 11/5 13:30", "台積電"), { label: "已收盤 · 11/5 13:30", name: "台積電" });
  // Finnhub keeps the Yahoo name, so a US row reads the same with either source.
  assert.deepEqual(rowName("AAPL", "Finnhub", "Apple Inc."), { label: "Finnhub", name: "Apple Inc." });
});

test("a row's name that only repeats the ticker, or is missing, is left out", () => {
  assert.deepEqual(rowName("^GSPC", "delayed 15 min", "^GSPC"), { label: "delayed 15 min", name: "" });
  assert.deepEqual(rowName("AAPL", "Yahoo", null), { label: "Yahoo", name: "" });
});

test("a drop in the visible list maps to a place in the full list", () => {
  const full = ["2330.TW", "AAPL", "0050.TW", "NVDA"];
  const visible = ["2330.TW", "0050.TW"];
  assert.equal(dropBefore(full, visible, "2330.TW"), "2330.TW");
  assert.equal(dropBefore(full, visible, "0050.TW"), "0050.TW");
  // After the last visible row: in front of that row's successor in the full list.
  assert.equal(dropBefore(full, visible, null), "NVDA");
  // The last visible row is also the last overall.
  assert.equal(dropBefore(["AAPL", "2330.TW"], ["2330.TW"], null), null);
  // No filter: the full list is the visible one.
  assert.equal(dropBefore(full, full, null), null);
});
