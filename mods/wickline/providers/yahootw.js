// Yahoo 奇摩股市: the data interface behind tw.stock.yahoo.com, real time and not public, laid over
// Yahoo Finance's delayed Taiwan quotes ahead of TWSE MIS. Off until the person turns it on and consents.
// This file holds the host, limits and decoder; the switch and consent live in settings.js and the
// settings dialog. No Herdr imports, so tests run it under Node.
import { HEADERS, QuoteError, cleanText, limitPair, positive, positiveOrNull, withinLimits } from "../quotes.js";
import { failEach, parseJson } from "./provider.js";

// Fixed: the person cannot point it elsewhere.
export const YAHOOTW_BASE = "https://tw.stock.yahoo.com/_td-stock/api/resource/";
export const YAHOOTW_BATCH = 50;
// Raise it with any change in substance to the statement or consent text (zh-TW prevails): a consent
// given to an older text no longer turns it on. Independent of MIS's.
export const YAHOOTW_CONSENT_VERSION = 1;

const TAIPEI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** @typedef {import("./provider.js").Provider} Provider */

/** The day number in Taipei (UTC+8, no daylight saving) of a time in ms; computed by hand, as QuickJS has no `Intl`. */
export function taipeiDay(ms) {
  return Math.floor((ms + TAIPEI_OFFSET_MS) / DAY_MS);
}

// `{ raw: "2240" }` → 2240; `"-"` (no value yet) or anything not positive → null.
const number = (field) => positiveOrNull(field?.raw);

const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Both requests' status codes. A refusal (403) is backed off like a rate limit; Herdr's fetch has no
// Retry-After, so wait at least a minute.
function checkStatus(response) {
  if (response.status === 403) throw new QuoteError("yahootw.refused", {}, { retryAfterMs: 60_000 });
  if (response.status === 429) throw new QuoteError("yahootw.rateLimited", {}, { retryAfterMs: 60_000 });
  if (!response.ok) throw new QuoteError("yahootw.http", { status: response.status });
}

/**
 * Overlays by requested symbol. A row is priced only when its price is positive, its trade is from today
 * in Taipei and it is not delayed; a price outside the row's own limits gets an error instead. Any other
 * row (a placeholder `-`, yesterday's close, delayed data), or a requested symbol missing from the answer,
 * has no overlay and no error. Each quote's time is the newest trade among the answer's priced rows (the
 * feed's time), so a quiet stock is as current as the feed; its own last trade is `tradeTime`, and `day`
 * its Taipei day, which a line must share to be drawn with it. An answer with prices but none accepted
 * (all delayed, or none from today) carries `noLive`, so the source can say why it shows nothing; one
 * with no price at all (before the open, every stock halted) does not.
 */
export function decodeStockList(symbols, response, now) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  if (!Array.isArray(body)) throw new QuoteError("yahootw.unreadable");
  const wanted = new Set(symbols);
  const today = taipeiDay(now);
  const accepted = [];
  const errors = {};
  // A placeholder row still names its stock.
  const names = {};
  let priced = false;
  for (const row of body) {
    const symbol = typeof row?.symbol === "string" && wanted.has(row.symbol) ? row.symbol : null;
    if (!symbol) continue;
    const name = cleanText(row.symbolName);
    if (name) names[symbol] = name;
    const price = number(row.price);
    if (price) priced = true;
    const tradeTime = time(row.regularMarketTime);
    if (!price || tradeTime === null || taipeiDay(tradeTime) !== today || row.exchangeDataDelayedBy !== 0) continue;
    const limits = limitPair(number(row.limitUpPrice), number(row.limitDownPrice));
    if (!withinLimits(price, limits.limitUp, limits.limitDown)) {
      errors[symbol] = new QuoteError("yahootw.outOfLimits");
      continue;
    }
    accepted.push({
      symbol,
      source: "yahootw",
      name,
      price,
      previousClose: number(row.regularMarketPreviousClose),
      open: number(row.regularMarketOpen),
      high: number(row.regularMarketDayHigh),
      low: number(row.regularMarketDayLow),
      ...limits,
      tradeTime,
      day: today,
      fetchedAt: now,
    });
  }
  // Unused when nothing was accepted (Math.max of none is -Infinity, but no quote takes it).
  const feedTime = Math.max(...accepted.map((quote) => quote.tradeTime));
  const quotes = Object.fromEntries(accepted.map((quote) => [quote.symbol, { ...quote, timestamp: feedTime }]));
  return { quotes, errors, names, ...(priced && !accepted.length && { noLive: new QuoteError("yahootw.noLiveRows") }) };
}

/**
 * One symbol's line, `{ day, series, lastAt }`: today's (Taipei) one-minute closes, oldest first, today
 * as its day, and its last minute's time in ms (to tell a frozen answer from a quiet stock). A minute
 * without a trade carries the previous close; minutes before the first trade are dropped. With no point
 * from today, no line.
 */
export function decodeTick(symbol, response, now) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  const chart = Array.isArray(body) ? body[0]?.chart : null;
  if (!chart) throw new QuoteError("yahootw.unreadable");
  if (chart.meta?.symbol !== symbol) throw new QuoteError("yahootw.otherTicker");
  const times = Array.isArray(chart.timestamp) ? chart.timestamp : [];
  const closes = chart.indicators?.quote?.[0]?.close;
  const today = taipeiDay(now);
  const series = [];
  let last = null;
  let lastAt = null;
  times.forEach((seconds, i) => {
    // Checked before the close is taken, so yesterday's last close never fills today's first minutes.
    if (taipeiDay(seconds * 1000) !== today) return;
    if (positive(closes?.[i])) last = closes[i];
    if (last === null) return;
    series.push(last);
    lastAt = seconds * 1000;
  });
  return { quotes: {}, errors: {}, ...(series.length && { lines: { [symbol]: { day: today, series, lastAt } } }) };
}

/** @type {Provider} */
export const yahootw = {
  id: "yahootw",
  markets: ["tw"],
  // A Taiwan index (^TWII) is live here, 20 minutes late on Yahoo Finance.
  kinds: ["stock", "index"],
  overlay: true,
  spacingMs: () => 0,
  intervalMs: (session) => (session === "open" || session === "unknown" ? 10_000 : 60_000),
  // A line request per symbol is too many for every round: each line waits `linesMs`, and a round
  // sends at most `linesPerRound` of the due ones, longest-waiting first.
  linesMs: (session) => (session === "open" || session === "unknown" ? 120_000 : 600_000),
  linesPerRound: 3,
  // The price batches, then a line request per symbol; the round picks the lines once the prices are in.
  requests(symbols) {
    const requests = [];
    for (let i = 0; i < symbols.length; i += YAHOOTW_BATCH) {
      const batch = symbols.slice(i, i + YAHOOTW_BATCH);
      requests.push({ url: `${YAHOOTW_BASE}StockServices.stockList;symbols=${batch.map(encodeURIComponent).join(",")}`, headers: HEADERS, symbols: batch, kind: "quote" });
    }
    for (const symbol of symbols) {
      const url = `${YAHOOTW_BASE}FinanceChartService.ApacLibraCharts;type=tick;symbols=${encodeURIComponent(JSON.stringify([symbol]))}`;
      requests.push({ url, headers: HEADERS, symbols: [symbol], kind: "line" });
    }
    return requests;
  },
  decode(request, response, now) {
    try {
      if (request.kind === "line") return decodeTick(request.symbols[0], response, now);
      return decodeStockList(request.symbols, response, now);
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
