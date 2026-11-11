// Test helpers shared by the watchlist, scheduler and provider tests: canned responses, recorded
// fixtures, and a fake host with a virtual clock, a scripted network and a shared store.
import { readFileSync } from "node:fs";
import { YAHOOTW_BASE } from "../mods/wickline/providers/yahootw.js";

export const ok = (body) => ({ status: 200, ok: true, text: JSON.stringify(body) });
// A recorded answer under tests/fixtures/, parsed.
export const jsonFixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));
// A Yahoo 奇摩股市 line request, and the one symbol it asks for.
export const isLine = (url) => url.startsWith(YAHOOTW_BASE) && url.includes("ApacLibraCharts");
export const lineSymbol = (url) => JSON.parse(decodeURIComponent(url.split("symbols=")[1]))[0];
// The symbol a Yahoo Finance chart request asks for.
export const chartSymbol = (url) => decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
export const chart = (meta) => ok({ chart: { result: [{ meta }], error: null } });
// Fixed clocks in UTC, a regular session between two of them as Yahoo's periods, and a Yahoo Finance quote.
export const at = (iso) => Date.parse(iso);
export const day = (open, close) => ({ pre: null, regular: [at(open), at(close)], post: null });
export const yq = (symbol, exchange, timestamp, periods = null) => ({ symbol, source: "yahoo", exchange, timestamp, periods });

/**
 * Runs `run` with process.env.TZ set to `zone` (Node honours a change at run time) and restores the old value after,
 * also on a throw; when `run` returns a promise, the old value comes back once it settles. Returns run's result.
 */
export function withTZ(zone, run) {
  const before = process.env.TZ;
  // Assigning undefined would store the string "undefined": an unset zone is deleted instead.
  const restore = () => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; };
  process.env.TZ = zone;
  let result;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (typeof result?.then === "function") return result.finally(restore);
  restore();
  return result;
}

// Yahoo 奇摩股市 recorded at 08:14 in Taipei on 2026-11-10, trimmed to the fields Wickline reads: ^TWOII and ^TWII
// still carry the day before's 13:31 close (delay 0), and ^TWOII's line still carries that day's periods and minutes.
export const EARLIER_ROWS = jsonFixture("yahootw-stocklist-earlier-day");
export const EARLIER_TICK = jsonFixture("yahootw-tick-earlier-day");
// 02:00 in Taipei on 2026-11-10, the night after the recorded close.
export const NIGHT = Date.parse("2026-11-09T18:00:00Z");
// The recorded close, 13:31 in Taipei on 2026-11-09.
export const CLOSE_0509 = Date.parse("2026-11-09T05:31:00Z");
// Yahoo 奇摩股市 futures rows recorded at 13:35 in Taipei on Tuesday 2026-11-10 (day session): WTX& 台指期近一 at 42 604
// (13:35:37, limits 45 625 / 37 331, previous close 41 478), WTX@, WMT&, WTF&, WTE&, all on TFE with delay 0; and
// the US ticker WTX (NMS), which is what WTX without & answers.
export const FUTURES_ROWS = jsonFixture("yahootw-stocklist-futures");
// 13:36:30 in Taipei on 2026-11-10, just after both futures recordings.
export const FUT_NOW = at("2026-11-10T05:36:30Z");
// Yahoo 奇摩股市's WTX& line recorded at 13:36 on 2026-11-10: 1 133 one-minute points from 15:00 the day before (the
// first without a trade) to 13:36, currentTradingPeriod 15:00 → 13:45, sourceTradingPeriods [15:00 → 05:00], [08:45 → 13:45].
export const FUTURES_TICK = jsonFixture("yahootw-tick-futures");
// The same line recorded in the night session on 2026-11-10: every minute of the trading day from 15:00 to 13:43 the
// next day (1 140 timestamps), its closes up to 22:20 and `null` for the 700 minutes still to come.
export const FUTURES_NIGHT_TICK = jsonFixture("yahootw-tick-futures-night");
// That line's sessions for Tuesday 2026-11-10's trading day: Monday 15:00 → Tuesday 05:00, 08:45 → 13:45 (Taipei); and
// its periods as decoded, with those segments.
export const SEGMENTS = [[1794207600000, 1794258000000], [1794271500000, 1794289500000]];
export const LINE_PERIODS = { pre: null, regular: [1794207600000, 1794289500000], post: null, segments: SEGMENTS };
// Yahoo 奇摩股市 rows probed at 15:19 in Taipei on 2026-11-10, the night session open: WTX& 42 459 (15:19:54) and WMT&
// 42 456 (15:19:52), their limits reset to the new trading day (46 910 / 38 382, previous close 42 646), and 2330.TW at
// its 14:30 after-hours trade. marketStatus still reads close.
export const FUTURES_NIGHT_ROWS = jsonFixture("yahootw-stocklist-futures-night");

export function fakeHost(respond) {
  const host = {
    store: { version: 1, symbols: [], paused: false }, clock: 0, sleeps: [], requests: [], headers: [],
    load: () => host.store,
    // The saved settings (shared state in Herdr); nothing saved yet.
    prefs: undefined,
    settings: () => host.prefs,
    save: (p) => { host.store = JSON.parse(JSON.stringify(p)); },
    now: () => host.clock,
    sleep: (ms) => new Promise((resolve) => host.sleeps.push({ at: host.clock + ms, resolve })),
    fetch: async (url, headers) => {
      host.requests.push(url);
      host.headers.push(headers);
      const r = await respond(url);
      // Herdr's fetch gives the final address; here the one asked, unless the test answers with another.
      return { url, ...r, text: async () => r.text };
    },
    // The secrets file (main.js reads it from Herdr's data folder): `secret` by name, or a broken file.
    secrets: {}, secretsBroken: false, secretReads: 0,
    loadSecret: async (name) => {
      host.secretReads++;
      if (host.secretsBroken) throw new SyntaxError("broken");
      return host.secrets[name] ?? null;
    },
    changed: () => {},
  };
  return host;
}

// Advance the clock to the next sleeper and let the loop run.
export async function tick(host) {
  await new Promise((r) => setImmediate(r));
  host.sleeps.sort((a, b) => a.at - b.at);
  const next = host.sleeps.shift();
  if (!next) return false;
  host.clock = Math.max(host.clock, next.at);
  next.resolve();
  await new Promise((r) => setImmediate(r));
  return true;
}

// Every source's loop, as main.js starts them.
export function start(w, host) {
  return w.providerIds().map((id) => w.runProvider(id, { sleep: host.sleep, changed: host.changed }));
}

export async function stop(w, host, runs) {
  w.stop();
  for (let i = 0; i < 50 && host.sleeps.length; i++) await tick(host);
  await Promise.all(runs);
}

// Runs every sleeper due by `until` (virtual ms), in time order.
export async function advance(host, until) {
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setImmediate(r));
    host.sleeps.sort((a, b) => a.at - b.at);
    if (!host.sleeps.length || host.sleeps[0].at > until) break;
    await tick(host);
  }
  host.clock = Math.max(host.clock, until);
  await new Promise((r) => setImmediate(r));
}
