// Yahoo 奇摩股市: the data interface behind tw.stock.yahoo.com, real time and not public, laid over Yahoo Finance's
// delayed Taiwan quotes ahead of TWSE MIS. Off until the user turns it on and consents. This file holds the host,
// limits and decoder; the switch and consent live in settings.js and the settings dialog.
import {
  BOOK_LEVELS,
  HEADERS,
  QuoteError,
  cleanText,
  currencyCode,
  exchangeCode,
  limitPair,
  positive,
  positiveOrNull,
  withinLimits,
} from "../quotes.js";
import { dayOf, futuresDay, taipeiDay } from "../calendar.js";
import { fastPace, kindOf } from "../markets.js";
import { MINUTE_MS } from "../time.js";
import { RATE_LIMIT_RETRY_MS, failEach, parseJson } from "./provider.js";
import { period } from "./yahoo.js";

// Fixed: the user cannot point it elsewhere.
export const YAHOOTW_BASE = "https://tw.stock.yahoo.com/_td-stock/api/resource/";
export const YAHOOTW_BATCH = 50;
// Raise it with any change in substance to the statement or consent text (zh-TW prevails), so a consent given to an
// older text no longer turns it on. Independent of MIS's.
export const YAHOOTW_CONSENT_VERSION = 2;

// How far a future's trade may be ahead of the local clock and still count: a clock a little behind Yahoo's, which
// at 15:00 stamps the next trading day. A trade further ahead is a bad time, never the feed time.
const FUTURE_AHEAD_MS = 5 * MINUTE_MS;

/** @typedef {import("./provider.js").Provider} Provider */

/**
 * The trading periods a sole-source quote is read by (Watchlist#unmarkedBase):
 * - its last line's `periods`, while their regular session starts on the quote's trading day or later. A future's
 *   lose their `segments` once `now` is on a later trading day, as those describe only their own day; TAIFEX's hours
 *   then apply, so a feed that stopped at the day close reads stalled at night;
 * - else, for a quote from an earlier trading day, a session that ended at its own trade, so it reads closed with
 *   its date;
 * - else null, so the session comes from the exchange's hours and a feed that stalled before the close keeps
 *   reading stalled. Before the open the line still gives the day before's periods.
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

// `{ raw: "2240" }` → 2240; `"-"` (no value yet) or anything not positive is null.
const rawNumber = (field) => positiveOrNull(field?.raw);

// A shown count, null unless positive. `volumeK` is in thousands of shares (a stock's lots) or of contracts (a
// future's, so 82.587 is 82,587).
const count = (value, future) => {
  const n = Number(value);
  return positive(n) ? Math.round(future ? n * 1000 : n) : null;
};

// A total as sent, for the activity checks: a number or a plain numeric string at or above 0 (0 kept), in count's
// units. Anything else (" ", "", "-", null) is null, never the 0 that `Number(" ")` gives.
const amount = (value, future) => {
  const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(future ? n * 1000 : n) : null;
};

/**
 * One side (`side`: "bid" or "ask") of `orderbook` as at most BOOK_LEVELS levels `{ price, size }`, in the order sent.
 * Null when the sizes do not add up to the answer's own `total`; a priced level with an unreadable size fails the
 * side, and an empty level counts 0. A level without a positive size is skipped. One with a size and no positive
 * price is a market order, with a null `price`.
 */
function bookSide(orderbook, side, total, future) {
  const size = `${side}VolK`;
  let sum = 0;
  for (const level of orderbook) {
    const n = amount(level?.[size], future);
    if (n === null && positiveOrNull(level?.[side]) !== null) return null;
    sum += n ?? 0;
  }
  if (sum !== amount(total, future)) return null;
  return orderbook
    .map((level) => ({ price: positiveOrNull(level?.[side]), size: amount(level?.[size], future) }))
    .filter((level) => level.size > 0)
    .slice(0, BOOK_LEVELS);
}

// The row's book, `{ bids, asks }`, only when both sides add up; null without an `orderbook` list.
function book(row, future) {
  if (!Array.isArray(row.orderbook)) return null;
  const bids = bookSide(row.orderbook, "bid", row.sumBidVolK, future);
  const asks = bookSide(row.orderbook, "ask", row.sumAskVolK, future);
  return bids && asks ? { bids, asks } : null;
}

/**
 * A stock's or future's activity; a field is absent when the row does not send it or sends 0 or `-`. Counts are in
 * lots or contracts, turnover in the currency (`turnoverM` is in millions). Inner and outer volume come only when
 * they add up exactly to the continuous-trading total.
 */
function activity(row, future) {
  const counts = {
    volume: count(row.volumeK, future),
    previousVolume: count(row.previousVolumeK, future),
    lastSize: count(row.singleVolumeK, future),
  };
  const millions = positiveOrNull(row.turnoverM);
  const inner = amount(row.inMarket, future);
  const outer = amount(row.outMarket, future);
  const total = amount(row.totalMarketVolK, future);
  const fields = {
    ...counts,
    sizeUnit: Object.values(counts).some((n) => n !== null) ? (future ? "contract" : "lot") : null,
    turnover: millions === null ? null : millions * 1e6,
    avgPrice: positiveOrNull(row.avgPrice),
    ...(inner !== null && outer !== null && total !== null && inner + outer === total && { inner, outer }),
    book: book(row, future),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Both requests' status codes. A refusal (403) is backed off like a rate limit.
function checkStatus(response) {
  if (response.status === 403) throw new QuoteError("yahootw.refused", {}, { retryAfterMs: RATE_LIMIT_RETRY_MS });
  if (response.status === 429) throw new QuoteError("yahootw.rateLimited", {}, { retryAfterMs: RATE_LIMIT_RETRY_MS });
  if (!response.ok) throw new QuoteError("yahootw.http", { status: response.status });
}

/**
 * One stock-list answer, by requested symbol. A row is priced when its price is positive, it is not delayed, and its
 * trade is from today's trading day. A future's may be up to FUTURE_AHEAD_MS ahead, and an `anyDay` symbol (one only
 * this source prices) may be from an earlier day. A future's limits are kept but not checked.
 * A quote priced today is timed by the feed: the newest of today's trades on its market clock (futures, or stocks and
 * indices together), so a quiet stock is as current as the feed. `day` is its trade's trading day, which a line must
 * share to be drawn with it.
 * Optional keys:
 * - `noLive`: prices came but none was accepted for today, so the source can say why it shows nothing live.
 * - `newestTrade`: per market clock, the newest accepted trade time, earlier days included, so a session without
 *   trades yet can be told apart.
 * - `auctionBook`: by symbol, the book of a stock in the opening auction; such a row is never a price.
 * Before the open an `anyDay` index's previous close is its quote, timed `previousCloseAt` (the previous TWSE trading
 * day's close, which the caller knows from the holiday schedule) and marked `fromPreviousClose`; none without it.
 */
export function decodeStockList(symbols, response, now, anyDay = [], previousCloseAt = null) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  if (!Array.isArray(body)) throw new QuoteError("yahootw.unreadable");
  const wanted = new Set(symbols);
  const anyDaySymbols = new Set(anyDay);
  const todayOn = { future: futuresDay(now), stock: taipeiDay(now) };
  // Every accepted quote, each with its own trade's trading day, and with its market clock when priced for today.
  const priced = [];
  const errors = {};
  // A placeholder row still names its stock.
  const names = {};
  let anyPrice = false;
  const newestTrade = {};
  const auctionBook = {};
  for (const row of body) {
    const symbol = typeof row?.symbol === "string" && wanted.has(row.symbol) ? row.symbol : null;
    if (!symbol) continue;
    const future = kindOf(symbol) === "future";
    const clock = future ? "future" : "stock";
    // A futures code answered from another exchange is not the TAIFEX contract asked for: not even its name is taken.
    if (future && exchangeCode(row.exchange) !== "TFE") continue;
    const name = cleanText(row.symbolName);
    if (name) names[symbol] = name;
    const price = rawNumber(row.price);
    if (price) anyPrice = true;
    const tradeTime = time(row.regularMarketTime);
    const day = tradeTime === null ? null : (future ? futuresDay : taipeiDay)(tradeTime);
    const today = todayOn[clock];
    const aheadOk = !future || tradeTime - now <= FUTURE_AHEAD_MS;
    const isToday = aheadOk && (day === today || (future && day > today));
    const soleHere = anyDaySymbols.has(symbol);
    const dayOk = day !== null && aheadOk && (isToday || (day < today && soleHere));
    const delayed = row.exchangeDataDelayedBy !== 0;
    // A trade counts only with a time the decoder accepts: a future's at most FUTURE_AHEAD_MS ahead, a stock's on
    // today's trading day or earlier. A time further ahead is a bad time, never a trade.
    const timeOk = future ? aheadOk : day <= today;
    if (price && tradeTime !== null && timeOk && !delayed)
      newestTrade[clock] = Math.max(newestTrade[clock] ?? tradeTime, tradeTime);
    // A symbol only this source prices has no other row to fall back on, so a price refused as not real time says
    // so, and the kept price reads cached. A price with no trade time is refused the same way: nothing dates it.
    if (price && soleHere && (delayed || !aheadOk || tradeTime === null))
      errors[symbol] = new QuoteError("yahootw.noLiveRows");
    // A stock in the opening auction (`preopen`, no price yet) sends the trial match's book: an auction book, never a
    // price.
    if (!price && !delayed && kindOf(symbol) === "stock" && row.marketStatus === "preopen") {
      const levels = book(row, false);
      if (levels && levels.bids.length + levels.asks.length > 0) auctionBook[symbol] = { ...levels, auction: true };
    }
    // Before the open (`preopen`) an index only this source prices comes with its previous close alone. With no other
    // source, that close is its quote, at the previous TWSE trading day's close, so it reads closed on that day as a
    // Yahoo Finance row does. A future's rows keep their last trade, so it never needs one.
    const closeOnly =
      !price && soleHere && !future && !delayed && row.marketStatus === "preopen" && previousCloseAt !== null
        ? rawNumber(row.regularMarketPreviousClose)
        : null;
    if (closeOnly) {
      anyPrice = true;
      priced.push([
        false,
        {
          symbol,
          source: "yahootw",
          name,
          price: closeOnly,
          previousClose: null,
          open: null,
          high: null,
          low: null,
          limitUp: null,
          limitDown: null,
          exchange: exchangeCode(row.exchange),
          currency: currencyCode(row.currency),
          tradeTime: previousCloseAt,
          day: taipeiDay(previousCloseAt),
          fetchedAt: now,
          fromPreviousClose: true,
        },
      ]);
    }
    if (!price || !dayOk || delayed) continue;
    const limits = limitPair(rawNumber(row.limitUpPrice), rawNumber(row.limitDownPrice));
    if (!future && !withinLimits(price, limits.limitUp, limits.limitDown)) {
      errors[symbol] = new QuoteError("yahootw.outOfLimits");
      continue;
    }
    priced.push([
      isToday && clock,
      {
        symbol,
        source: "yahootw",
        name,
        price,
        previousClose: rawNumber(row.regularMarketPreviousClose),
        open: rawNumber(row.regularMarketOpen),
        high: rawNumber(row.regularMarketDayHigh),
        low: rawNumber(row.regularMarketDayLow),
        ...limits,
        // An instrument only this source prices takes its market and currency from here.
        exchange: exchangeCode(row.exchange),
        currency: currencyCode(row.currency),
        ...(kindOf(symbol) !== "index" && activity(row, future)),
        tradeTime,
        day,
        fetchedAt: now,
      },
    ]);
  }
  const feedTime = {};
  for (const [clock, quote] of priced) if (clock) feedTime[clock] = Math.max(feedTime[clock] ?? 0, quote.tradeTime);
  const quotes = Object.fromEntries(
    priced.map(([clock, quote]) => [quote.symbol, { ...quote, timestamp: clock ? feedTime[clock] : quote.tradeTime }]),
  );
  const anyToday = priced.some(([clock]) => clock);
  return {
    quotes,
    errors,
    names,
    ...(anyPrice && !anyToday && { noLive: new QuoteError("yahootw.noLiveRows") }),
    ...(Object.keys(newestTrade).length && { newestTrade }),
    ...(Object.keys(auctionBook).length && { auctionBook }),
  };
}

// `sourceTradingPeriods`' periods, at any depth, as sorted `[start, end]` pairs; none when it is not an array.
const futuresSegments = (periods) =>
  (Array.isArray(periods) ? periods.flat(Infinity) : [])
    .map(period)
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

/**
 * One symbol's tick answer: its line, only with a point from today's trading day, and its trading periods, line or
 * not. The line holds one-minute closes; a minute without a trade carries the previous close.
 * - `lastAt`: the last minute with a trade. A carried minute never moves it, so it tells a frozen answer from a quiet
 *   stock.
 * - `endAt`: when today's regular session ends, so a later trade (a stock's 14:30 fixed-price one) is never expected
 *   in the line.
 */
export function decodeTick(symbol, response, now) {
  checkStatus(response);
  const body = parseJson(response.text, "yahootw.unreadable");
  const chart = Array.isArray(body) ? body[0]?.chart : null;
  if (!chart) throw new QuoteError("yahootw.unreadable");
  if (chart.meta?.symbol !== symbol) throw new QuoteError("yahootw.otherTicker");
  const stamps = Array.isArray(chart.timestamp) ? chart.timestamp : [];
  const closes = chart.indicators?.quote?.[0]?.close;
  const dayAt = dayOf(symbol);
  const today = dayAt(now);
  const series = [];
  const times = [];
  let last = null;
  let lastAt = null;
  stamps.forEach((seconds, i) => {
    // Checked before the close is taken, so yesterday's last close never fills today's first minutes. A minute after
    // `now` is still to come (a futures answer lists the whole trading day), so it is never filled.
    if (seconds * 1000 > now || dayAt(seconds * 1000) !== today) return;
    if (positive(closes?.[i])) {
      last = closes[i];
      lastAt = seconds * 1000;
    }
    if (last === null) return;
    series.push(last);
    times.push(seconds * 1000);
  });
  const trading = chart.meta.currentTradingPeriod;
  const regular = period(trading?.regular);
  const segments = kindOf(symbol) === "future" ? futuresSegments(chart.meta.sourceTradingPeriods) : [];
  return {
    quotes: {},
    errors: {},
    ...(series.length && {
      lines: {
        [symbol]: {
          day: today,
          series,
          times,
          lastAt,
          ...(regular && dayAt(regular[1] - 1) === today && { endAt: regular[1] }),
        },
      },
    }),
    ...(regular && {
      periods: {
        [symbol]: {
          pre: period(trading.pre),
          regular,
          post: period(trading.post),
          ...(segments.length && { segments }),
        },
      },
    }),
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
  intervalMs: (session) => (fastPace(session) ? 10_000 : 60_000),
  // A line request per symbol is too many for every round: each line waits `linesMs`, and a round sends at most
  // `linesPerRound` of the due ones, longest-waiting first.
  linesMs: (session) => (fastPace(session) ? 120_000 : 600_000),
  linesPerRound: 3,
  // The price batches, then a line request per symbol; the round picks the lines once the prices are in. A batch's
  // sole-source symbols (`config.anyDay`) go with it as `anyDay`, and `config.previousCloseAt` with every batch; see
  // decodeStockList.
  requests(symbols, config) {
    const anyDay = new Set(config?.anyDay ?? []);
    const previousCloseAt = config?.previousCloseAt ?? null;
    const requests = [];
    for (let i = 0; i < symbols.length; i += YAHOOTW_BATCH) {
      const batch = symbols.slice(i, i + YAHOOTW_BATCH);
      const url = `${YAHOOTW_BASE}StockServices.stockList;symbols=${batch.map(encodeURIComponent).join(",")}`;
      requests.push({
        url,
        headers: HEADERS,
        symbols: batch,
        kind: "quote",
        anyDay: batch.filter((symbol) => anyDay.has(symbol)),
        previousCloseAt,
      });
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
      return decodeStockList(request.symbols, response, now, request.anyDay, request.previousCloseAt);
    } catch (error) {
      return failEach(request.symbols, error);
    }
  },
};
