// Which market a symbol trades on (from its form, or for an index from the exchange its source reports), the
// exchanges' hours, Yahoo Finance's delays per exchange and the market order of the filters. No Herdr imports.
import { isCryptoPair, isFutureForm } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/**
 * "pair", "index" (a leading ^), "future" (letters then & or @: a TAIFEX code at Yahoo 奇摩股市), "other" (has =: a
 * currency or a Yahoo future such as ES=F) or "stock".
 */
export function kindOf(symbol) {
  if (isCryptoPair(symbol)) return "pair";
  if (symbol.startsWith("^")) return "index";
  if (isFutureForm(symbol)) return "future";
  return symbol.includes("=") ? "other" : "stock";
}

/**
 * "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other" (indices, currencies, other exchanges), by form alone. A
 * future is TAIFEX's: "tw".
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

/** An index of Taiwan form (^TW…): Yahoo 奇摩股市 may know one that Yahoo Finance does not. */
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
 * A symbol's market: its form's, except an index, which takes its source's reported `exchange` (other until
 * one is reported, or when it is not in the table). A currency or a Yahoo future (=) stays other.
 */
export function resolvedMarket(symbol, exchange) {
  return symbol.startsWith("^") ? (exchangeMarket(exchange) ?? "other") : marketOf(symbol);
}

// Lunch breaks in local minutes since midnight; `offsetMin` is the exchange clock's fixed UTC offset (no DST).
const TOKYO_LUNCH = { offsetMin: 540, from: 690, to: 750 };
const HONG_KONG_LUNCH = { offsetMin: 480, from: 720, to: 780 };
const CHINA_LUNCH = { offsetMin: 480, from: 690, to: 780 };

// TAIFEX's published hours (Taipei, +8 h, no DST), in minutes since midnight; each session opens Monday to
// Friday (Sunday 0). The night session runs past midnight into the next day. Holidays follow the data only.
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

/** Whether a source polls at its fast pace in `session` (Watchlist#sessionFor's): open, a call auction, or not yet known. */
export const fastPace = (session) => session === "open" || session === "auction" || session === "unknown";

// Regular hours used only for a Taiwan or US quote with no trading periods yet; exchange-local minutes.
export const TWSE_HOURS = Object.freeze({ offsetMin: 480, weekdays: [1, 2, 3, 4, 5], from: 540, to: 810 }); // 09:00–13:30 Taipei, TWSE and TPEx
export const US_HOURS = Object.freeze({ weekdays: [1, 2, 3, 4, 5], from: 570, to: 960 }); // 09:30–16:00 New York

const LIVE = { realtime: true, delayS: null };
const late = (delayS, lunch = null) => ({ delayS, lunch });

// How Yahoo Finance serves each exchange it reports. Closed on purpose: any other code reads as a delay not
// provided, never a guess. It mixes Yahoo's facts (realtime, delayS) with the exchange's own (lunch, fx), and
// stays here rather than in a provider, since the view reads both together.
const RULES = {
  NMS: LIVE,
  NYQ: LIVE,
  PCX: LIVE, // measured 2026-11-09, lag 1–16 s
  NGM: LIVE,
  NCM: LIVE,
  ASE: LIVE,
  BTS: LIVE, // measured 2026-11-10 in a US session: NGM, NCM, ASE and BTS real time (0–34 s)
  SNP: LIVE,
  DJI: LIVE,
  NIM: LIVE, // measured 2026-11-09
  CCY: { ...LIVE, fx: true }, // measured 2026-11-10, lag 2–31 s; indicative quotes
  TAI: late(1200),
  TWO: late(1200), // measured 2026-11-10, 1198–1220 s
  KSC: late(1200),
  KOE: late(1200), // measured 2026-11-10, 1197–1210 s
  JPX: late(900, TOKYO_LUNCH),
  OSA: late(900, TOKYO_LUNCH), // measured 2026-11-10 (899–901 s, after lunch); Yahoo help says 20
  HKG: late(900, HONG_KONG_LUNCH), // measured 2026-11-10, 896–907 s
  SHH: late(900, CHINA_LUNCH),
  SHZ: late(900, CHINA_LUNCH), // measured 2026-11-10, 898–901 s (help says 30)
  CXI: late(1200), // measured 2026-11-09, 1117 s (over 15 min)
  PNK: late(900),
  NYS: late(900),
  WCB: late(900), // Yahoo help (SLN2310)
  CME: { ...late(600), futures: true },
  NYM: { ...late(600), futures: true },
  CMX: { ...late(600), futures: true }, // measured 2026-11-10, 592–611 s
  CBT: { ...late(600), futures: true }, // CME Group, as CME; not measured
};

// Every rule in full, built once and shared by every caller, so frozen.
const NONE = Object.freeze({ realtime: false, delayS: null, lunch: null, futures: false, fx: false });
const FULL = new Map(Object.entries(RULES).map(([code, rule]) => [code, Object.freeze({ ...NONE, ...rule })]));
const FUTURE_BY_FORM = Object.freeze({ ...NONE, futures: true });
const FX_BY_FORM = Object.freeze({ ...NONE, ...LIVE, fx: true });

// A Taiwan stock's suffix, which keeps TAI's 20 min when Yahoo reports no exchange or one not in the table.
const TAIWAN_SUFFIX = /\.TWO?$/;

/**
 * How fresh Yahoo Finance's quotes are for `exchange`: `realtime`, else `delayS` (null: not provided), the
 * exchange's `lunch` break or null, and whether it trades `futures` or `fx`. A `.TW`/`.TWO` symbol whose
 * exchange is missing or not in the table takes TAI's rule. Only without a reported exchange does any other
 * form decide: `=F` is a future with no delay known, `=X` real-time FX.
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

// The order of the filters, fixed per interface language so it never depends on what the list holds or how
// it is ordered: Japanese and Korean put their own market first, both Chinese put Taiwan first, and English
// starts with the US.
const MARKET_ORDER = {
  en: ["us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-TW": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  "zh-CN": ["tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"],
  ja: ["jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"],
  ko: ["kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"],
};

/** Every market in `lang`'s fixed order; a language without its own order takes English's. */
export const marketOrder = (lang) => MARKET_ORDER[lang] ?? MARKET_ORDER.en;
