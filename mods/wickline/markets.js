// Which market a symbol trades on, the exchanges' hours, Yahoo Finance's delay per exchange, and the order of the
// market filters.
import { isCryptoPair, isFutureForm } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/**
 * A symbol's kind, by its form:
 * - "pair": a Binance pair (BTC/USDT)
 * - "index": a leading ^
 * - "future": a TAIFEX code as Yahoo 奇摩股市 writes it (WTX&)
 * - "other": has =, a currency or a Yahoo future (ES=F)
 * - "stock": anything else
 */
export function kindOf(symbol) {
  if (isCryptoPair(symbol)) return "pair";
  if (symbol.startsWith("^")) return "index";
  if (isFutureForm(symbol)) return "future";
  return symbol.includes("=") ? "other" : "stock";
}

/**
 * A symbol's market by its form alone: "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other". Indices, currencies
 * and other exchanges are "other"; a future is TAIFEX's, "tw".
 */
export function marketOf(symbol) {
  const kind = kindOf(symbol);
  if (kind === "pair") return "crypto";
  if (kind === "future") return "tw";
  if (kind !== "stock") return "other";
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "us";
  return SUFFIXES[symbol.slice(dot + 1)] ?? "other";
}

/** Whether an index has Taiwan's form (^TW…); Yahoo 奇摩股市 may know one that Yahoo Finance does not. */
export const isTaiwanForm = (symbol) => symbol.startsWith("^TW");

// The exchanges a source reports (Yahoo's exchangeName, Yahoo 奇摩股市's exchange) whose market is known.
// Closed on purpose: any other exchange leaves an index under "other", never a guess.
const EXCHANGES = {
  us: ["DJI", "SNP", "NIM", "NMS", "NYQ", "PCX", "CXI", "NYS", "WCB"],
  tw: ["TAI", "TWO", "TFE"],
  hk: ["HKG"],
  cn: ["SHH", "SHZ"],
  jp: ["JPX", "OSA"],
  kr: ["KSC", "KOE"],
};
const EXCHANGE_MARKET = Object.fromEntries(
  Object.entries(EXCHANGES).flatMap(([market, codes]) => codes.map((code) => [code, market])),
);

/** The market an exchange code belongs to, or null. */
export const exchangeMarket = (exchange) => EXCHANGE_MARKET[exchange] ?? null;

/**
 * A symbol's market. An index takes the market of the `exchange` its source reports, and is "other" until then or
 * when the exchange is not in the table. Every other symbol takes its form's market.
 */
export function resolvedMarket(symbol, exchange) {
  return symbol.startsWith("^") ? (exchangeMarket(exchange) ?? "other") : marketOf(symbol);
}

// Lunch breaks in local minutes since midnight; `offsetMin` is the exchange clock's fixed UTC offset (no DST).
const TOKYO_LUNCH = { offsetMin: 540, from: 690, to: 750 };
const HONG_KONG_LUNCH = { offsetMin: 480, from: 720, to: 780 };
const CHINA_LUNCH = { offsetMin: 480, from: 690, to: 780 };

// TAIFEX's published hours in Taipei minutes since midnight, Monday to Friday (Sunday 0). The night session runs
// past midnight into the next day. Holidays are known only from the data.
export const TAIFEX_HOURS = Object.freeze({
  offsetMin: 480,
  weekdays: [1, 2, 3, 4, 5],
  sessions: [
    { from: 525, to: 825 }, // day, 08:45–13:45
    { from: 900, to: 1740 }, // night, 15:00–05:00 the next day
  ],
});
export const DAY_SESSION = TAIFEX_HOURS.sessions[0];
export const NIGHT_SESSION = TAIFEX_HOURS.sessions[1];

/** Whether a source polls at its fast pace in `session` (from Watchlist#sessionFor): open, auction or unknown. */
export const fastPace = (session) => session === "open" || session === "auction" || session === "unknown";

// Regular hours, in exchange-local minutes, used only for a Taiwan or US quote with no trading periods yet.
// TWSE and TPEx: 09:00–13:30 Taipei.
export const TWSE_HOURS = Object.freeze({ offsetMin: 480, weekdays: [1, 2, 3, 4, 5], from: 540, to: 810 });
export const US_HOURS = Object.freeze({ weekdays: [1, 2, 3, 4, 5], from: 570, to: 960 }); // 09:30–16:00 New York

const LIVE = { realtime: true, delayS: null };
const late = (delayS, lunch = null) => ({ delayS, lunch });

// How Yahoo Finance serves each exchange it reports. Closed on purpose: any other code reads as a delay not
// provided, never a guess. It mixes Yahoo's facts (realtime, delayS) with the exchange's own (lunch, fx), and stays
// here rather than in a provider because the view reads both together.
// Most delays were measured against live quotes and win over Yahoo's help pages where they differ; WCB follows the
// help pages and CBT follows CME.
const RULES = {
  NMS: LIVE,
  NYQ: LIVE,
  PCX: LIVE,
  NGM: LIVE,
  NCM: LIVE,
  ASE: LIVE,
  BTS: LIVE,
  SNP: LIVE,
  DJI: LIVE,
  NIM: LIVE,
  CCY: { ...LIVE, fx: true }, // indicative quotes
  TAI: late(1200),
  TWO: late(1200),
  KSC: late(1200),
  KOE: late(1200),
  JPX: late(900, TOKYO_LUNCH),
  OSA: late(900, TOKYO_LUNCH),
  HKG: late(900, HONG_KONG_LUNCH),
  SHH: late(900, CHINA_LUNCH),
  SHZ: late(900, CHINA_LUNCH),
  CXI: late(1200),
  PNK: late(900),
  NYS: late(900),
  WCB: late(900),
  CME: { ...late(600), futures: true },
  NYM: { ...late(600), futures: true },
  CMX: { ...late(600), futures: true },
  CBT: { ...late(600), futures: true },
};

// Every rule in full, built once and shared by every caller, so frozen.
const NONE = Object.freeze({ realtime: false, delayS: null, lunch: null, futures: false, fx: false });
const FULL = new Map(Object.entries(RULES).map(([code, rule]) => [code, Object.freeze({ ...NONE, ...rule })]));
const FUTURE_BY_FORM = Object.freeze({ ...NONE, futures: true });
const FX_BY_FORM = Object.freeze({ ...NONE, ...LIVE, fx: true });

// A Taiwan stock's suffix. It keeps TAI's 20 min when Yahoo reports no exchange, or one not in the table.
const TAIWAN_SUFFIX = /\.TWO?$/;

/**
 * How fresh Yahoo Finance's quotes are for `exchange`: `realtime` or a `delayS` (null when not provided), the
 * exchange's `lunch` break or null, and whether it trades `futures` or `fx`.
 * A `.TW`/`.TWO` symbol whose exchange is missing or unknown takes TAI's rule. With no reported exchange, `=F` is a
 * future with no known delay and `=X` is real-time FX.
 */
export function exchangeRule(exchange, symbol) {
  const listed = exchange ? FULL.get(exchange) : undefined;
  if (listed) return listed;
  if (TAIWAN_SUFFIX.test(symbol)) return FULL.get("TAI");
  if (exchange) return NONE;
  if (symbol.endsWith("=F")) return FUTURE_BY_FORM;
  if (symbol.endsWith("=X")) return FX_BY_FORM;
  return NONE;
}

// The exchange a settings page's Yahoo fallback describes for its market.
export const TYPICAL_EXCHANGE = { us: "NMS", tw: "TAI" };

// The order of the filters, fixed per interface language so it never depends on the list. Japanese and Korean put
// their own market first, both Chinese put Taiwan first, and English starts with the US.
const MARKET_ORDER = {
  en: ["us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-TW": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-CN": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  ja: ["jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"],
  ko: ["kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"],
};

/** Every market in `lang`'s fixed order; a language without its own order takes English's. */
export const marketOrder = (lang) => MARKET_ORDER[lang] ?? MARKET_ORDER.en;
