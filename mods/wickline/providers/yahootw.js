// Yahoo 奇摩股市: the data interface behind tw.stock.yahoo.com, real time and not public, laid over
// Yahoo Finance's delayed Taiwan quotes ahead of TWSE MIS. Off until the person turns it on and consents.
// This file holds the host, limits and decoder; the switch and consent live in settings.js and the
// settings dialog. No Herdr imports, so tests run it under Node.
import {
  HEADERS, QuoteError, cleanText, currencyCode, exchangeCode, limitPair, positive, positiveOrNull, withinLimits,
} from "../quotes.js";
import { MINUTE_MS, TAIFEX_HOURS, kindOf, localDay, weekdayOf } from "../markets.js";
import { failEach, parseJson } from "./provider.js";
import { period } from "./yahoo.js";

// Fixed: the person cannot point it elsewhere.
export const YAHOOTW_BASE = "https://tw.stock.yahoo.com/_td-stock/api/resource/";
export const YAHOOTW_BATCH = 50;
// Raise it with any change in substance to the statement or consent text (zh-TW prevails): a consent
// given to an older text no longer turns it on. Independent of MIS's.
export const YAHOOTW_CONSENT_VERSION = 2;

// The open of the TAIFEX session that runs past midnight (the night's, 15:00) is the next day's 00:00 once this is
// added.
const NIGHT_TO_NEXT_DAY_MS = (24 * 60 - TAIFEX_HOURS.sessions.find(({ to }) => to > 24 * 60).from) * MINUTE_MS;
// How far a future's trade may be ahead of the local clock and still count, on any trading day (a clock a little
// behind Yahoo's, which at 15:00 stamps the next trading day); a trade further ahead is a bad time, never the feed time.
const FUTURE_AHEAD_MS = 5 * MINUTE_MS;

/** @typedef {import("./provider.js").Provider} Provider */

/** The day number in Taipei (UTC+8, no daylight saving; Taipei's clock is TAIFEX's) of a time in ms. */
export const taipeiDay = (ms) => localDay(TAIFEX_HOURS.offsetMin, ms);

/**
 * A symbol's trading day number. A future's starts at 15:00 Taipei and belongs to the next trading weekday:
 * taipeiDay(ms + 9 h), moved past the days TAIFEX does not trade (a Saturday or a Sunday) to the Monday after, so
 * Friday's night session (Saturday 00:00–05:00 included) is Monday's. Holidays are not known. Any other symbol's is
 * its Taipei day.
 */
export function tradingDay(symbol, ms) {
  return dayOf(symbol)(ms);
}

// A future's trading day (see tradingDay).
function futuresDay(ms) {
  let day = taipeiDay(ms + NIGHT_TO_NEXT_DAY_MS);
  while (!TAIFEX_HOURS.weekdays.includes(weekdayOf(day))) day++;
  return day;
}

// A symbol's trading day of a time in ms, its kind read once: for a decoder that asks it for many times.
const dayOf = (symbol) => (kindOf(symbol) === "future" ? futuresDay : taipeiDay);

/**
 * The trading periods a quote of a symbol this source prices alone is read by (Watchlist#baseQuote):
 * - `periods` (its last line's) while their regular session starts on the quote's own trading day or later (a
 *   future's night session, begun at 15:00 the day before, is that day's); a future's without their `segments`
 *   once `now` is on a later trading day than theirs, since those describe only their own day: its session is
 *   then read from the TAIFEX hours (futuresSegment), so a feed that stops at the day close reads stalled in the
 *   night, and closed between sessions;
 * - else, for a quote from an earlier trading day than `now`'s, a session that ended at its own trade, so it reads
 *   closed with its date;
 * - else null: today's price without today's periods reads unconfirmed, never closed.
 * Before the open the line still gives the day before's periods, and a feed that stalls must never be taken for
 * the close.
 */
export function ownPeriods(quote, periods, now) {
  const dayAt = dayOf(quote.symbol);
  const day = dayAt(quote.tradeTime);
  const periodsDay = periods?.regular ? dayAt(periods.regular[0]) : null;
  if (periodsDay !== null && periodsDay >= day) {
    if (!periods.segments || periodsDay >= dayAt(now)) return periods;
    const { pre, regular, post } = periods;
    return { pre, regular, post };
  }
  return day < dayAt(now) ? { pre: null, regular: [quote.tradeTime, quote.tradeTime], post: null } : null;
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
 * Overlays by requested symbol. A row is priced only when its price is positive, its trade is from today's
 * trading day (see tradingDay; a future's also from a later one, and on any day only while at most 5 minutes ahead
 * of `now`, as the local clock may be a little behind Yahoo's at 15:00; for a symbol in `anyDay`, which only this
 * source prices, also from an earlier day) and it is not delayed; a price outside the row's own limits gets an error instead,
 * except a future's (TAIFEX's limits are not checked; they are still kept). A futures-form row from any exchange
 * but TFE gives nothing, not even its name. A priced row of a symbol in `anyDay` refused as delayed or too far ahead
 * gets `yahootw.noLiveRows`. Any other row (a placeholder `-`, yesterday's close, delayed data), or a requested
 * symbol missing from the answer, has no overlay and no error. Each quote priced today is timed at the
 * newest trade among today's on its own market clock (the feed's time): futures on theirs, every other row
 * (stocks and indices, TAI and TWO together) on the stock clock, so a quiet stock is as current as the stock
 * feed and never stamped with a night futures trade. An earlier day's quote keeps its own trade's time, so it
 * reads closed with its date. The own last trade is `tradeTime`, and `day` its trading day, which a line must
 * share to be drawn with it. An answer with prices but none accepted for today (all delayed, or none from
 * today) carries `noLive`, so the source can say why it shows nothing live; one with no price at all (before
 * the open, every stock halted) does not.
 */
export function decodeStockList(symbols, response, now, anyDay = []) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  if (!Array.isArray(body)) throw new QuoteError("yahootw.unreadable");
  const wanted = new Set(symbols);
  const anyDaySymbols = new Set(anyDay);
  // Today's trading day on each market clock.
  const todayOn = { future: futuresDay(now), stock: taipeiDay(now) };
  // Every accepted quote, each with its own trade's trading day, and with its market clock when priced for today.
  const priced = [];
  const errors = {};
  // A placeholder row still names its stock.
  const names = {};
  let anyPrice = false;
  for (const row of body) {
    const symbol = typeof row?.symbol === "string" && wanted.has(row.symbol) ? row.symbol : null;
    if (!symbol) continue;
    const future = kindOf(symbol) === "future";
    const clock = future ? "future" : "stock";
    // A futures code answered from another exchange is not the TAIFEX contract asked for: not even its name is taken.
    if (future && exchangeCode(row.exchange) !== "TFE") continue;
    const name = cleanText(row.symbolName);
    if (name) names[symbol] = name;
    const price = number(row.price);
    if (price) anyPrice = true;
    const tradeTime = time(row.regularMarketTime);
    const day = tradeTime === null ? null : (future ? futuresDay : taipeiDay)(tradeTime);
    const today = todayOn[clock];
    const aheadOk = !future || tradeTime - now <= FUTURE_AHEAD_MS;
    const isToday = aheadOk && (day === today || (future && day > today));
    const soleHere = anyDaySymbols.has(symbol);
    const dayOk = day !== null && aheadOk && (isToday || (day < today && soleHere));
    const delayed = row.exchangeDataDelayedBy !== 0;
    // A symbol only this source prices has no other row to fall back on: a price refused as not real time says so,
    // so the kept price reads cached rather than taken for a name-only answer.
    if (price && soleHere && (delayed || !aheadOk)) errors[symbol] = new QuoteError("yahootw.noLiveRows");
    if (!price || !dayOk || delayed) continue;
    const limits = limitPair(number(row.limitUpPrice), number(row.limitDownPrice));
    if (!future && !withinLimits(price, limits.limitUp, limits.limitDown)) {
      errors[symbol] = new QuoteError("yahootw.outOfLimits");
      continue;
    }
    priced.push([isToday && clock, {
      symbol,
      source: "yahootw",
      name,
      price,
      previousClose: number(row.regularMarketPreviousClose),
      open: number(row.regularMarketOpen),
      high: number(row.regularMarketDayHigh),
      low: number(row.regularMarketDayLow),
      ...limits,
      // An instrument only this source prices takes its market and currency from here.
      exchange: exchangeCode(row.exchange),
      currency: currencyCode(row.currency),
      tradeTime,
      day,
      fetchedAt: now,
    }]);
  }
  // The newest trade on each market clock among today's quotes.
  const feedTime = {};
  for (const [clock, quote] of priced) if (clock) feedTime[clock] = Math.max(feedTime[clock] ?? 0, quote.tradeTime);
  const quotes = Object.fromEntries(priced.map(([clock, quote]) =>
    [quote.symbol, { ...quote, timestamp: clock ? feedTime[clock] : quote.tradeTime }]));
  const anyToday = priced.some(([clock]) => clock);
  return { quotes, errors, names, ...(anyPrice && !anyToday && { noLive: new QuoteError("yahootw.noLiveRows") }) };
}

// `sourceTradingPeriods`' periods, at any depth, as sorted `[start, end]` pairs; none when it is not an array.
const futuresSegments = (periods) => (Array.isArray(periods) ? periods.flat(Infinity) : [])
  .map(period).filter(Boolean).sort((a, b) => a[0] - b[0]);

/**
 * One symbol's line, `{ day, series, lastAt }`: the one-minute closes of today's trading day (see tradingDay:
 * a future's from 15:00 the day before, so the night's minutes stay past midnight), oldest first, that day as
 * its day, and its last minute's time in ms (to tell a frozen answer from a quiet stock). A minute
 * without a trade carries the previous close; minutes before the first trade are dropped. With no point
 * from today, no line. `periods`: the answer's trading periods (`meta.currentTradingPeriod`, as Yahoo
 * Finance's), also without a point from today, for a symbol only this source prices; none without a
 * regular one. A future's also carry `segments`, its sessions (`meta.sourceTradingPeriods`, nested by day) as
 * sorted `[start, end]` pairs in ms; the key is absent without any.
 */
export function decodeTick(symbol, response, now) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  const chart = Array.isArray(body) ? body[0]?.chart : null;
  if (!chart) throw new QuoteError("yahootw.unreadable");
  if (chart.meta?.symbol !== symbol) throw new QuoteError("yahootw.otherTicker");
  const times = Array.isArray(chart.timestamp) ? chart.timestamp : [];
  const closes = chart.indicators?.quote?.[0]?.close;
  const dayAt = dayOf(symbol);
  const today = dayAt(now);
  const series = [];
  let last = null;
  let lastAt = null;
  times.forEach((seconds, i) => {
    // Checked before the close is taken, so yesterday's last close never fills today's first minutes.
    if (dayAt(seconds * 1000) !== today) return;
    if (positive(closes?.[i])) last = closes[i];
    if (last === null) return;
    series.push(last);
    lastAt = seconds * 1000;
  });
  const trading = chart.meta.currentTradingPeriod;
  const regular = period(trading?.regular);
  const segments = kindOf(symbol) === "future" ? futuresSegments(chart.meta.sourceTradingPeriods) : [];
  return {
    quotes: {}, errors: {},
    ...(series.length && { lines: { [symbol]: { day: today, series, lastAt } } }),
    ...(regular && { periods: { [symbol]: {
      pre: period(trading.pre), regular, post: period(trading.post), ...(segments.length && { segments }),
    } } }),
  };
}

/** @type {Provider} */
export const yahootw = {
  id: "yahootw",
  markets: ["tw"],
  // A Taiwan index (^TWII) is live here, 20 minutes late on Yahoo Finance; a TAIFEX future (WTX&) is only here.
  kinds: ["stock", "index", "future"],
  overlay: true,
  spacingMs: () => 0,
  intervalMs: (session) => (session === "open" || session === "unknown" ? 10_000 : 60_000),
  // A line request per symbol is too many for every round: each line waits `linesMs`, and a round
  // sends at most `linesPerRound` of the due ones, longest-waiting first.
  linesMs: (session) => (session === "open" || session === "unknown" ? 120_000 : 600_000),
  linesPerRound: 3,
  // The price batches, then a line request per symbol; the round picks the lines once the prices are in.
  // A batch's symbols this source prices alone (`config.anyDay`) go with it as `anyDay`: see decodeStockList.
  requests(symbols, config) {
    const anyDay = new Set(config?.anyDay ?? []);
    const requests = [];
    for (let i = 0; i < symbols.length; i += YAHOOTW_BATCH) {
      const batch = symbols.slice(i, i + YAHOOTW_BATCH);
      const url = `${YAHOOTW_BASE}StockServices.stockList;symbols=${batch.map(encodeURIComponent).join(",")}`;
      requests.push({ url, headers: HEADERS, symbols: batch, kind: "quote", anyDay: batch.filter((symbol) => anyDay.has(symbol)) });
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
      return decodeStockList(request.symbols, response, now, request.anyDay);
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
