// The watchlist and its refresh loops, one per provider. Herdr's APIs come in through `host` and each loop's `io`,
// so tests drive it under Node with a fake clock and network.
import { HEADERS, QuoteError, STARTER_SYMBOLS, normalizeSymbol, timedByTrade, withoutActivity } from "./quotes.js";
import { HOLIDAYS_URL, listsYearOf, parseHolidays, taipeiDay, taipeiMinute, tradingDay } from "./calendar.js";
import { closureOf, currentOpen, twMarket, withClosure } from "./closures.js";
import {
  LIVE_MAX_AGE_MS,
  REALTIME_SOURCES,
  TW_TRIAL_MATCH,
  auctionFlagged,
  auctionWindowStart,
  isRealtime,
  nextEdge,
  sessionOf,
  staleAt,
} from "./freshness.js";
import { isTaiwanForm, kindOf, marketOf, resolvedMarket } from "./markets.js";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.js";
import { mergeOverlay, pickOverlay } from "./overlay.js";
import { binance } from "./providers/binance.js";
import { finnhub, finnhubAddressOk, finnhubCap } from "./providers/finnhub.js";
import { mis } from "./providers/mis.js";
import {
  SECRET_KEY_FINNHUB,
  finnhubChosen,
  misEnabled,
  misReconfirm,
  readSettings,
  yahootwEnabled,
  yahootwReconfirm,
} from "./settings.js";
import { yahoo } from "./providers/yahoo.js";
import { ownPeriods, yahootw } from "./providers/yahootw.js";

// The watchlist lives in Herdr's persisted shared state, so every copy sees one list.
export const WATCHLIST_KEY = "wickline.watchlist.v1";
// Herdr's fetch cannot be aborted: a request that has not answered by then counts as failed.
export const REQUEST_TIMEOUT_MS = 10_000;
// Started in this order, so their first requests go out in this order too. The order also sets the overlay sources'
// priority.
const PROVIDERS = [binance, yahootw, mis, finnhub, yahoo];
// The overlay sources in priority order (Yahoo 奇摩股市, then TWSE MIS); with several live ones for a symbol, the first
// wins.
const OVERLAYS = PROVIDERS.filter((provider) => provider.overlay);
const OVERLAY_ORDER = OVERLAYS.map((provider) => provider.id);
// The sources the user turns on in Settings. For each:
// - `on`: whether it runs now (the watchlist holds the key read from the secrets file);
// - `notice`: what its settings row and status line say while it is chosen but cannot run;
// - `retryOn`: for a source that can refuse the key, the settings whose change lets it try again.
const SWITCHES = {
  yahootw: { on: yahootwEnabled, notice: (settings) => (yahootwReconfirm(settings) ? "yahootw.reconfirm" : null) },
  mis: { on: misEnabled, notice: (settings) => (misReconfirm(settings) ? "mis.reconfirm" : null) },
  finnhub: {
    // The address is checked again here: shared state may hold one the dialog never accepted.
    on: (settings, w) =>
      finnhubChosen(settings) && finnhubAddressOk(settings.sources.us.finnhubUrl) && Boolean(w.finnhubKey),
    // The key file's problems only once this copy has read it for the saved keyRev.
    notice: (settings, w) => {
      if (!finnhubChosen(settings)) return null;
      if (!finnhubAddressOk(settings.sources.us.finnhubUrl)) return "finnhub.badUrl";
      if (w.keyRev !== settings.keyRev) return null;
      if (w.keyUnreadable) return "finnhub.secretUnreadable";
      return w.finnhubKey ? null : "finnhub.noKey";
    },
    retryOn: (settings) => JSON.stringify([settings.sources.us, settings.keyRev]),
  },
};
// A provider refreshes at the pace of its busiest symbol. A pair's "24h" counts as open; a lunch break ranks below a
// session not yet known but above pre/post. A listed closed day and a day without trades pace as closed, so the line
// is not asked again. A call auction paces as open: the closing auction's end brings the close.
const SESSION_RANK = {
  open: 4,
  "24h": 4,
  auction: 4,
  unknown: 3,
  lunch: 2,
  pre: 1,
  post: 1,
  closed: 0,
  holiday: 0,
  noTrades: 0,
};
// Errors about the source itself, not one symbol: shown as the source's problem.
const SOURCE_FAILURE = /\.(unreachable|timeout|rateLimited|region|http|unreadable)$/;
// The source is down or hung: the rest of the round would only wait out more timeouts.
const SOURCE_DOWN = /\.(unreachable|timeout)$/;
const TIMED_OUT = {};
// How long a traded minute may take to show in a line after it ends, and how far a line's last traded minute may end
// before a trade it must hold.
const LINE_LAG_MS = 120_000;
// How many trade times a line is judged by: the newest settled one and the ones still settling (see lineFrozen).
const LINE_TRADES = 4;
// A provider's backoff after a rate limit (see backOff).
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 900_000;
const BACKOFF_MAX_DOUBLINGS = 4;
// After a failed holiday schedule fetch, how long until it is asked again.
const HOLIDAY_RETRY_MS = HOUR_MS;
// How long a session's trade observation is kept (Watchlist#seen): a session is never open longer.
const SEEN_KEEP_MS = 2 * DAY_MS;

// The status line's note for each inferred closure; a listed one has none.
const NOTE_CODES = { noTrades: "closure.noTradesToday", nightNoTrades: "closure.noTradesNight" };

const notice = (code, params = {}) => ({ code, params });
const coded = (error) => notice(error.code, error.params);
// A quote-less sole-source symbol's session, read from its stand-in (see sessionFor); "closed" when it gives none.
const soleSession = (standIn, now) => {
  const session = sessionOf(standIn, now);
  return session === "unknown" ? "closed" : session;
};

// Ends a loop's wait now.
function wake(state) {
  const resolve = state.wake;
  state.wake = null;
  resolve?.();
}

/** The saved watchlist from any stored value; a bad entry is skipped, not the whole list. */
export function readPreferences(value) {
  // Nothing saved yet: a starter list, until the first edit saves the user's own.
  if (value === undefined || value === null) return { version: 1, symbols: [...STARTER_SYMBOLS], paused: false };
  const saved = typeof value === "object" ? value : null;
  const symbols = [];
  if (saved?.version === 1 && Array.isArray(saved.symbols)) {
    for (const raw of saved.symbols) {
      if (typeof raw !== "string") continue;
      try {
        const symbol = normalizeSymbol(raw);
        if (!symbols.includes(symbol)) symbols.push(symbol);
      } catch {
        /* Skip one bad entry, not the whole list. */
      }
    }
  }
  return { version: 1, symbols, paused: saved?.version === 1 && saved.paused === true };
}

/**
 * The watchlist, its quotes and one refresh loop per provider. `host` gives:
 * - `load()`, `save(preferences)`: the saved watchlist; `settings()`: the saved settings (read only);
 * - `fetch(url, headers)`: a GET resolving to `{ status, ok, text() }`;
 * - `loadSecret(name)`: the secrets file's value, null without one; rejects when the file cannot be read;
 * - `now()`, and `shown()`: whether this copy is on screen (default yes). A copy that is not shown sends nothing.
 * Each loop gets its own io: `{ sleep(ms), changed() }`, where `changed` asks for a redraw.
 */
export class Watchlist {
  constructor(host) {
    this.host = host;
    this.isShown = () => host.shown?.() ?? true;
    // The Finnhub key as read from the secrets file for `keyRev`, null until read. Only in memory: never in the
    // config, the shared state or an error.
    this.finnhubKey = null;
    this.keyRev = null;
    this.keyUnreadable = false;
    this.preferences = readPreferences(host.load());
    this.configKey = JSON.stringify(this.config());
    // By symbol: the base quote (Yahoo for stocks, Binance for pairs), and the real-time overlays over it by provider
    // id. A symbol with a sole source has no base quote; its price stays in that source's overlay slot.
    this.quotes = {};
    this.overlays = {};
    // By symbol, while MIS flags it as in a call auction: the time of the snapshot that flagged it. Kept with MIS's
    // held price, which the flag leaves in place.
    this.auctionAt = {};
    // By symbol: the levels of MIS's newest flag (decodeMis `auctionBook`), kept and dropped with `auctionAt`.
    this.auctionBooks = {};
    // By symbol: true while MIS's latest answer named it with no price, flag or level. It answered before any order,
    // so the row's book is empty rather than unknown.
    this.noLevels = {};
    // By symbol: `{ book, fetchedAt }`, the opening auction's book from Yahoo 奇摩股市's latest answer. rowBook shows
    // it only inside the auction window it was fetched in.
    this.ytwAuctionBooks = {};
    // By provider id, then symbol: an overlay source's own line, `{ day, series, times }` (`day` is its trading day).
    // Kept only while that source's price for the symbol is.
    this.lines = {};
    // By provider id, then symbol: the trade times seen at an overlay line's recent arrivals, oldest first, which the
    // line is judged against (see lineFrozen). Kept through a dropped price, as each is a past trade; dropped when the
    // symbol leaves the source.
    this.lineTrades = {};
    // By symbol: the last name an overlay gave (its Chinese name), kept while that source fails.
    this.localNames = {};
    // By symbol: `{ code, params }` for the view to translate. An overlay's errors are kept apart, by provider id,
    // since its symbol still has the base quote.
    this.errors = {};
    this.overlayErrors = {};
    // TW-only symbols: a ^TW… index Yahoo Finance answered not found, which Yahoo 奇摩股市 then prices alone while it
    // is on. Only in memory, so each start learns them again with one Yahoo Finance request.
    this.twOnly = new Set();
    // By symbol: the trading periods the last line answer gave a sole-source symbol, which has no base quote to give
    // them (see ownPeriods).
    this.linePeriods = {};
    // TWSE's holiday schedule, only in memory (see loadHolidays):
    // - `days`: its closed weekdays, Taipei day number → name;
    // - `day`, `tried`: the Taipei dates of the last success and the last attempt;
    // - `retryAt`: when a failed fetch may be tried again; `pending`: the fetch in flight, shared by the loops.
    this.holidays = { days: {}, day: null, tried: null, retryAt: 0, pending: null };
    // Per Taiwan market, by a session's open (ms): what this copy saw of it since, `{ newest, answers }`.
    // `newest` is the newest trade time any answer carried; the session has traded once it is at or after the open.
    // `answers` holds each source's latest answer, `{ at, realtime }`. Entries older than SEEN_KEEP_MS are dropped on
    // write. Written by noteTrade, read only through observed.
    this.seen = { stock: {}, future: {} };
    // Each Taiwan market's reading at one `now` (closureAt), and the revision of its inputs. The revision is bumped by
    // noteTrade, a new schedule and a change of config(), so a read in the same ms as such a change never gets the
    // reading from before it.
    this.closures = { now: null, rev: 0, byMarket: {} };
    this.closureRev = 0;
    this.revision = 0;
    this.stopped = false;
    // Per provider: its backoff, its current problem, its round and its own wake-up.
    // `lineFailures`: by symbol, the source failure of its last line request (a provider with `linesPerRound`).
    // `noLive`: while the market is open, why an overlay source that answers prices nothing.
    this.sources = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider.id,
        {
          retryAt: 0,
          failures: 0,
          disabled: false,
          problem: null,
          noLive: null,
          loading: false,
          manual: false,
          refreshing: false,
          dirty: true,
          wake: null,
          lastRequestAt: -Infinity,
          missed: false,
          linesAt: {},
          lineFailures: {},
          configKey: null,
          disabledFor: null,
        },
      ]),
    );
  }

  /**
   * What the providers are given: the saved addresses and budget, and which sources are on. The key is added only to
   * a round's requests, so it never reaches `configKey`.
   */
  config() {
    const settings = readSettings(this.host.settings());
    return {
      binanceUrl: settings.sources.crypto.binanceUrl,
      misUrl: settings.sources.tw.misUrl,
      finnhubUrl: settings.sources.us.finnhubUrl,
      budgetPerMinute: settings.sources.us.budgetPerMinute,
      keyRev: settings.keyRev,
      // Choosing Finnhub must wake its loop to read the key, also when keyRev did not change.
      usProvider: settings.sources.us.provider,
      on: Object.fromEntries(Object.entries(SWITCHES).map(([id, { on }]) => [id, on(settings, this)])),
      // Yahoo 奇摩股市 switched on but awaiting consent again: a row only it can price says so (unpricedReason).
      yahootwPending: yahootwReconfirm(settings),
    };
  }

  /**
   * Reads the Finnhub key again when Finnhub is chosen and keyRev changed; a broken file is no key. With Finnhub not
   * chosen no key is held, so a key removed from the file leaves memory too.
   */
  async loadKey(settings) {
    if (!finnhubChosen(settings)) {
      this.finnhubKey = null;
      this.keyRev = null;
      this.keyUnreadable = false;
      return;
    }
    if (this.keyRev === settings.keyRev) return;
    this.keyRev = settings.keyRev;
    try {
      const value = await this.host.loadSecret(SECRET_KEY_FINNHUB);
      this.finnhubKey = typeof value === "string" && value.trim() ? value.trim() : null;
      this.keyUnreadable = false;
    } catch {
      this.finnhubKey = null;
      this.keyUnreadable = true;
    }
  }

  /** The US stocks Finnhub prices: the first `finnhubCap(budget)` in list order. */
  finnhubSymbols() {
    return this.symbolsFor(finnhub);
  }

  /** Whether a listed US stock is left on Yahoo because the ones before it use up Finnhub's budget. */
  overCap(symbol) {
    const config = this.config();
    return (
      config.on.finnhub &&
      this.serves(finnhub, symbol, config) &&
      this.preferences.symbols.includes(symbol) &&
      !this.symbolsFor(finnhub, config).includes(symbol)
    );
  }

  /**
   * The exchange a symbol's quote reports, else its Yahoo 奇摩股市 overlay's (a sole-source symbol's own quote is in
   * that slot), else null.
   */
  exchangeOf(symbol) {
    return this.quotes[symbol]?.exchange ?? this.overlays[symbol]?.[yahootw.id]?.exchange ?? null;
  }

  /** A symbol's market; an index's comes from the exchange its quote reports. */
  marketFor(symbol) {
    return resolvedMarket(symbol, this.exchangeOf(symbol));
  }

  /**
   * Whether an index is still waiting for its first quote, with no quote, overlay or error yet, so its market is
   * unknown.
   */
  pendingIndex(symbol) {
    return kindOf(symbol) === "index" && !this.quotes[symbol] && !this.overlays[symbol] && !this.errors[symbol];
  }

  /**
   * What a row shows: its base quote with its overlay, if any, then its closure (marked, once). A sole-source symbol
   * shows its own quote over itself, so the name, currency, periods and line are all its own.
   */
  shown(symbol, now = this.host.now()) {
    const pick = this.pick(symbol, now);
    const quote = mergeOverlay(this.unmarkedBase(symbol, now), pick?.overlay, pick && this.lines[pick.id]?.[symbol]);
    const localName = this.localNames[symbol];
    return this.marked(symbol, quote && localName && !quote.localName ? { ...quote, localName } : quote, now);
  }

  /**
   * What the detail dialog opens on and is handed, all read at one `now`, or null without a quote: the row as shown,
   * with its `error` and its overlay's (`fallback`). It drops `closureDeadline`: the detail gets no answers of its
   * own, so `closureUntil` alone ends its mark.
   */
  detailQuote(symbol, now) {
    const quote = this.shown(symbol, now);
    if (!quote) return null;
    const { closureDeadline: _deadline, ...held } = quote;
    return { ...held, error: this.errors[symbol] ?? null, fallback: this.overlayError(symbol, now) };
  }

  /**
   * The source that prices `symbol` alone, else null: Yahoo 奇摩股市, for a TW-only symbol or a future while it is on.
   * `config` is read only for such a symbol, since this is asked for every row.
   */
  soleSource(symbol, config) {
    if (!this.twOnly.has(symbol) && kindOf(symbol) !== "future") return null;
    return (config ?? this.config()).on[yahootw.id] ? yahootw : null;
  }

  /**
   * Why a symbol only Yahoo 奇摩股市 can price has no price while it is off. While consent is awaited again, it says
   * so. Otherwise a future says the source must be turned on, and a TW-only index says what Yahoo Finance said: not
   * found.
   */
  unpricedReason(symbol, config) {
    if (config.yahootwPending) return notice("yahootw.reconfirm");
    return notice(kindOf(symbol) === "future" ? "yahootw.futuresNeedSource" : "yahoo.notFound");
  }

  /** What a row is built on (unmarkedBase), with its closure (marked). */
  baseQuote(symbol, now = this.host.now()) {
    return this.marked(symbol, this.unmarkedBase(symbol, now), now);
  }

  /**
   * What a row is built on, before its closure: the base quote, or a sole source's own quote with the periods
   * ownPeriods gives it. Kept through a failure, it is marked `cached`, so freshness ages it to now rather than to its
   * last good fetch.
   */
  unmarkedBase(symbol, now) {
    const sole = this.soleSource(symbol);
    const own = sole && this.overlays[symbol]?.[sole.id];
    const quote = !sole
      ? this.quotes[symbol]
      : own && { ...own, periods: ownPeriods(own, this.linePeriods[symbol] ?? null, now) };
    return quote && this.errors[symbol] ? { ...quote, cached: true } : quote;
  }

  /**
   * `quote` with a Taiwan symbol's marks: its closure, `twRealtime`, `auctionAt` and its book. This is the one place a
   * quote gets them, so whatever reads a row reads the same closure and call auction. A stock priced by Yahoo Finance
   * while a real-time source is on loses its activity, so a 20-minute-late volume never stands beside a live price.
   */
  marked(symbol, quote, now) {
    if (!quote || this.marketFor(symbol) !== "tw") return quote;
    const reading = this.closureAt(twMarket(symbol), now);
    const twRealtime = reading.twRealtime && kindOf(symbol) === "stock";
    const flaggedAt = this.auctionAt[symbol];
    const held = (quote.tradeTime ?? quote.timestamp) < flaggedAt;
    const priced = twRealtime && quote.source === "yahoo" ? withoutActivity(quote) : quote;
    const { book: _book, ...own } = priced;
    const book = this.rowBook(symbol, priced, held, now);
    const closed = withClosure(book ? { ...own, book } : own, reading);
    if (!twRealtime && !held) return closed;
    return { ...closed, ...(twRealtime && { twRealtime: true }), ...(held && { auctionAt: flaggedAt }) };
  }

  /**
   * The book a Taiwan row shows, or null. A Yahoo 奇摩股市 stock book fetched inside a call auction is that auction's.
   * It shows only while `now` is in the same window and the stock traded that day, so it never passes for the
   * market's book, another auction's or an earlier day's. A quote without a book shows an empty one while MIS's
   * latest answer named the stock before any order (noLevels), else none.
   */
  rowBook(symbol, quote, held, now) {
    if (held && this.auctionBooks[symbol]) return this.auctionBooks[symbol];
    const opening = this.ytwAuctionBooks[symbol];
    const auctionNow = auctionWindowStart(now);
    if (opening && auctionNow !== null && auctionWindowStart(opening.fetchedAt) === auctionNow) return opening.book;
    const { book } = quote;
    if (book) {
      const fetchedIn =
        quote.source === yahootw.id && kindOf(symbol) === "stock" ? auctionWindowStart(quote.fetchedAt) : null;
      if (fetchedIn === null) return book;
      // An earlier day's last book, still sent before today's first trade, is never this auction's.
      const tradedToday = taipeiDay(quote.tradeTime ?? quote.timestamp) === taipeiDay(quote.fetchedAt);
      return tradedToday && fetchedIn === auctionWindowStart(now) ? { ...book, auction: true } : null;
    }
    return this.noLevels[symbol] ? { bids: [], asks: [] } : null;
  }

  /**
   * A Taiwan `market`'s reading at `now` (closureOf), plus `twRealtime`: whether MIS or Yahoo 奇摩股市 is on. Every
   * row of a market reads the same, so it is worked out once per market and `now`, until closureRev moves.
   */
  closureAt(market, now) {
    if (this.closures.now !== now || this.closures.rev !== this.closureRev) {
      this.closures = { now, rev: this.closureRev, byMarket: {} };
    }
    const { byMarket } = this.closures;
    if (!byMarket[market]) {
      const { on } = this.config();
      const reading = closureOf(
        market,
        now,
        (day) => this.holidays.days[day] ?? null,
        (m, open) => this.observed(m, open, on),
      );
      byMarket[market] = { ...reading, twRealtime: Boolean(on[mis.id] || on[yahootw.id]) };
    }
    return byMarket[market];
  }

  /**
   * The observation of `market`'s session opened at `open`, as closureOf reads it, or undefined without one. Answers
   * are ordered real-time first, then by PROVIDERS. An overlay source that is off now is left out, so its answers stop
   * counting the moment it is turned off.
   */
  observed(market, open, on) {
    const entry = this.seen[market][open];
    if (!entry) return undefined;
    const answers = PROVIDERS.filter(({ id }) => entry.answers[id] && (!OVERLAY_ORDER.includes(id) || on[id])).map(
      ({ id }) => ({ source: id, ...entry.answers[id] }),
    );
    const ofKind = (realtime) => answers.filter((answer) => answer.realtime === realtime);
    return { traded: entry.newest >= open, newest: entry.newest, answers: [...ofKind(true), ...ofKind(false)] };
  }

  /**
   * The status line's no-trades notes at `now`: one per inferred closure of a listed Taiwan market, by code and
   * source. Kept apart from problems(), which the settings' health shows, since a source that answers is working.
   */
  notes(now = this.host.now()) {
    const markets = new Set(this.preferences.symbols.filter((symbol) => this.marketFor(symbol) === "tw").map(twMarket));
    const lines = new Map();
    for (const market of markets) {
      const { closure } = this.closureAt(market, now);
      const code = NOTE_CODES[closure?.kind];
      if (!code) continue;
      lines.set(`${code} ${closure.source}`, notice(code, { source: closure.source }));
    }
    return [...lines.values()];
  }

  /** Whether `symbols` hold a Taiwan symbol, a ^TW… index still waiting for its first quote included. */
  holdsTaiwan(symbols) {
    return symbols.some(
      (symbol) => this.marketFor(symbol) === "tw" || (isTaiwanForm(symbol) && this.pendingIndex(symbol)),
    );
  }

  /**
   * Notes an answer arriving at `now` in a Taiwan `market`, on the session `now` belongs to. Keeps the newest trade
   * time (a time that is not a number is none) and the answer's arrival for its source, `{ source, realtime }`, which
   * closureOf reads to tell a session without trades.
   */
  noteTrade(market, tradeTime, answer, now) {
    const open = currentOpen(market, now);
    if (open === null) return;
    const seen = this.seen[market];
    const entry = (seen[open] ??= { newest: null, answers: {} });
    this.closureRev++;
    if (Number.isFinite(tradeTime)) entry.newest = Math.max(entry.newest ?? tradeTime, tradeTime);
    entry.answers[answer.source] = { at: now, realtime: answer.realtime };
    for (const key of Object.keys(seen)) if (Number(key) < now - SEEN_KEEP_MS) delete seen[key];
  }

  /**
   * Fetches TWSE's holiday schedule when due: not yet fetched this Taipei date, and past `retryAt`.
   * - One GET at a time per copy, shared by every loop and raced against REQUEST_TIMEOUT_MS.
   * - Only a date's first attempt is waited for, so it holds a Taiwan round by the timeout at most; a retry runs
   *   beside the rounds.
   * - A failure (no answer, an error, an unreadable list, or none for this year) keeps the schedule held and tries
   *   again HOLIDAY_RETRY_MS after the failed attempt started.
   * Never throws and never shows a problem: without the schedule, rows read by inference alone.
   */
  async loadHolidays(io) {
    const holidays = this.holidays;
    const now = this.host.now();
    const today = taipeiDay(now);
    if (holidays.day === today || now < holidays.retryAt) return;
    holidays.pending ??= this.fetchHolidays(io, now);
    if (holidays.tried !== today) await holidays.pending;
  }

  // One schedule fetch, started at `now` (see loadHolidays).
  async fetchHolidays(io, now) {
    const holidays = this.holidays;
    let days = null;
    try {
      const response = await this.getWithin({ url: HOLIDAYS_URL, headers: HEADERS }, io);
      if (response !== TIMED_OUT && response.ok) days = parseHolidays(response.text);
      if (days && !listsYearOf(days, now)) days = null;
    } catch {
      /* No schedule: tried again after HOLIDAY_RETRY_MS. */
    }
    holidays.tried = taipeiDay(now);
    holidays.pending = null;
    if (days) {
      holidays.days = days;
      this.closureRev++;
      holidays.day = taipeiDay(now);
    } else {
      holidays.retryAt = now + HOLIDAY_RETRY_MS;
    }
  }

  /**
   * What a symbol without a quote is read by at `now`, for its session and edges alike: its form and its closure.
   * Without periods, sessionOf reads it by its exchange's hours.
   */
  standIn(symbol, now) {
    return this.marked(symbol, { symbol, periods: null }, now);
  }

  pick(symbol, now) {
    const flagged = auctionFlagged(this.auctionAt[symbol], now);
    return pickOverlay(this.overlays[symbol] ?? {}, OVERLAY_ORDER, now, this.quotes[symbol], flagged);
  }

  /**
   * Why a symbol has no live overlay: the first overlay source's error, in priority order; null while a live one
   * shows. A sole source never writes one: with no base to fall back to, its row's own error says why.
   */
  overlayError(symbol, now = this.host.now()) {
    const pick = this.pick(symbol, now);
    if (pick && now - pick.overlay.timestamp <= LIVE_MAX_AGE_MS) return null;
    const errors = this.overlayErrors[symbol] ?? {};
    const id = OVERLAY_ORDER.find((candidate) => errors[candidate]);
    return id ? errors[id] : null;
  }

  providerIds() {
    return PROVIDERS.map((provider) => provider.id);
  }

  /** Whether a round the user asked for (Refresh) is running; automatic rounds do not count. */
  get refreshing() {
    return Object.values(this.sources).some((state) => state.loading && state.refreshing);
  }

  /**
   * One entry per provider that has a problem now (rate limited, unreachable, timed out, refused), or that is chosen
   * but cannot run (consent to give again). `stopped: true` marks a source that makes no request until its settings
   * change, so the settings dialog reads that here instead of from a list of codes.
   */
  problems() {
    const settings = readSettings(this.host.settings());
    return PROVIDERS.flatMap((provider) => {
      const state = this.sources[provider.id];
      const code = SWITCHES[provider.id]?.notice(settings, this);
      const problem = code ? notice(code) : state.problem;
      if (!problem) return [];
      return [{ provider: provider.id, ...problem, ...(code || state.disabled ? { stopped: true } : {}) }];
    });
  }

  // Edits are synchronous (the store is Herdr's shared state) and return a short notice, `{ code, params }`, for the
  // view to translate. A change that returns null changed nothing, so nothing is saved.
  edit(change) {
    const preferences = readPreferences(this.host.load());
    const message = change(preferences);
    if (message === null) return null;
    this.host.save(preferences);
    this.adoptAndRestart(preferences);
    return message;
  }

  add(input) {
    const symbol = normalizeSymbol(input);
    let before;
    const message = this.edit((p) => {
      if (p.symbols.includes(symbol)) return notice("notice.duplicate", { symbol });
      before = [...p.symbols];
      p.symbols.unshift(symbol);
      return notice("notice.added", { symbol });
    });
    if (message.code !== "notice.added") return message;
    const config = this.config();
    const cap = finnhubCap(config.budgetPerMinute);
    if (this.overCap(symbol)) return notice("notice.overCap", { symbol, cap });
    // The symbol went to the top, so a US stock Finnhub priced before may have lost its place under the cap. With
    // Finnhub off, or a symbol Finnhub does not price, both lists are the same.
    const kept = new Set(this.symbolsFor(finnhub, config));
    const pushed = this.symbolsFor(finnhub, config, before).find((s) => !kept.has(s));
    return pushed ? notice("notice.overCapPushed", { symbol, pushed, cap }) : message;
  }

  // A removal's notice carries `undo`, the symbol and its place in the list before, for `restore`. Any later notice
  // replaces it, which ends the Undo.
  remove(symbol) {
    return this.edit((p) => {
      const index = p.symbols.indexOf(symbol);
      if (index < 0) return notice("notice.notListed", { symbol });
      p.symbols.splice(index, 1);
      return { ...notice("notice.removed", { symbol }), undo: { symbol, index } };
    });
  }

  // Puts a removed symbol back at `index`, or at the end when the list has grown shorter since. Null, and nothing
  // saved, when it is listed again already (another copy added it).
  restore(symbol, index) {
    return this.edit((p) => {
      if (p.symbols.includes(symbol)) return null;
      p.symbols.splice(index, 0, symbol);
      return notice("notice.restored", { symbol });
    });
  }

  /**
   * Moves `symbol` before `beforeSymbol` (null for the end), judged against the list as saved now. A drop in a copy
   * that has not synced yet then still lands beside the symbol it was dropped on. Null, and nothing saved, when
   * either symbol is gone or the order would stay.
   */
  move(symbol, beforeSymbol) {
    return this.edit((p) => {
      const rest = p.symbols.filter((s) => s !== symbol);
      const at = beforeSymbol === null ? rest.length : rest.indexOf(beforeSymbol);
      if (rest.length === p.symbols.length || at < 0 || beforeSymbol === symbol) return null;
      rest.splice(at, 0, symbol);
      if (rest.every((s, i) => s === p.symbols[i])) return null;
      p.symbols = rest;
      return notice("notice.moved", { symbol });
    });
  }

  pause(paused) {
    return this.edit((p) => {
      p.paused = paused;
      return notice(paused ? "notice.paused" : "notice.resumed");
    });
  }

  /**
   * One round of every source now, also while paused; a source's cooldown still holds. A source on a request budget
   * (Finnhub) keeps its own pace. A source already in a round marks that round as asked for instead of queuing
   * another, so a second click costs no extra request.
   */
  refreshNow() {
    for (const provider of PROVIDERS) {
      if (provider.manualRefresh === false) continue;
      const state = this.sources[provider.id];
      if (state.loading) {
        state.refreshing = true;
        continue;
      }
      state.manual = true;
      wake(state);
    }
  }

  stop() {
    this.stopped = true;
    this.revision++;
    this.poke();
  }

  poke() {
    for (const state of Object.values(this.sources)) wake(state);
  }

  /**
   * Starts at once the round a hidden copy skipped, in each source that skipped one. The view calls it on render,
   * which is when a hidden docked copy is shown again. A source that missed nothing keeps its own pace.
   * A copy still judged hidden wakes nothing. It can render anyway (a second card block, a stack with no active
   * child), and each wake would mark the round missed again and redraw, in a loop.
   */
  wakeMissed() {
    // Most renders find nothing missed, so shown(), which reads the layout for a docked copy, is not asked.
    const missed = Object.values(this.sources).filter((state) => state.missed && state.wake);
    if (!missed.length || !this.isShown()) return;
    for (const state of missed) {
      state.missed = false;
      wake(state);
    }
  }

  // Drops every round in flight and starts new ones at once.
  restart() {
    this.revision++;
    for (const state of Object.values(this.sources)) state.dirty = true;
    this.poke();
  }

  /** Picks up another copy's edit of the shared list or settings at once; the view calls it on render. */
  sync() {
    const preferences = readPreferences(this.host.load());
    const configKey = JSON.stringify(this.config());
    if (JSON.stringify(preferences) === JSON.stringify(this.preferences) && configKey === this.configKey) return false;
    const configChanged = configKey !== this.configKey;
    if (configChanged) this.closureRev++;
    this.configKey = configKey;
    this.adoptAndRestart(preferences, configChanged);
    return true;
  }

  /** What the loops act on: whether paused, and the symbols each provider quotes (order does not matter). */
  loopKey() {
    return JSON.stringify([this.preferences.paused, this.symbolLists(PROVIDERS).map((symbols) => [...symbols].sort())]);
  }

  /** The symbols each of `providers` quotes, in that order. */
  symbolLists(providers) {
    const config = this.config();
    return providers.map((provider) => this.symbolsFor(provider, config));
  }

  /**
   * Takes `preferences` as the list, and starts new rounds only when something the loops act on changed (or on
   * `restart`). A pure reorder leaves the rounds in flight alone.
   */
  adoptAndRestart(preferences, restart = false) {
    const before = this.loopKey();
    this.adopt(preferences);
    if (restart || before !== this.loopKey()) this.restart();
  }

  adopt(preferences) {
    this.preferences = preferences;
    const keep = new Set(preferences.symbols);
    for (const record of [this.quotes, this.errors]) {
      for (const key of Object.keys(record)) if (!keep.has(key)) delete record[key];
    }
    const config = this.config();
    if (!config.on[yahootw.id]) {
      // Off: every TW-only symbol goes back to Yahoo Finance, so turning the source on again starts over.
      // Until Yahoo Finance answers again, the row says what it last said (not found), or that consent is awaited.
      // No other source prices a future, so its row says why. A stale "consent awaited" reason is worked out again,
      // so it goes once nothing awaits consent.
      for (const [symbol, error] of Object.entries(this.errors)) {
        if (error.code === "yahootw.reconfirm") this.errors[symbol] = this.unpricedReason(symbol, config);
      }
      for (const symbol of preferences.symbols) {
        if (this.twOnly.has(symbol) || kindOf(symbol) === "future")
          this.errors[symbol] = this.unpricedReason(symbol, config);
      }
      this.twOnly.clear();
    } else {
      // On: those reasons go at once.
      for (const [symbol, error] of Object.entries(this.errors)) {
        if (error.code === "yahootw.futuresNeedSource" || error.code === "yahootw.reconfirm")
          delete this.errors[symbol];
      }
    }
    for (const symbol of [...this.twOnly]) if (!keep.has(symbol)) this.twOnly.delete(symbol);
    for (const symbol of Object.keys(this.linePeriods)) {
      if (!keep.has(symbol) || !this.soleSource(symbol, config)) delete this.linePeriods[symbol];
    }
    // An overlay goes as soon as its source no longer covers the symbol (removed, or turned off).
    const covered = new Set();
    for (const provider of OVERLAYS) {
      const symbols = new Set(this.symbolsFor(provider, config));
      for (const symbol of symbols) covered.add(symbol);
      const held = [
        this.overlays,
        this.overlayErrors,
        this.lines[provider.id] ?? {},
        this.lineTrades[provider.id] ?? {},
        ...(provider === mis ? [this.auctionAt, this.auctionBooks, this.noLevels] : []),
        ...(provider === yahootw ? [this.ytwAuctionBooks] : []),
      ];
      for (const symbol of held.flatMap(Object.keys)) {
        if (symbols.has(symbol)) continue;
        this.forgetOverlay(provider, symbol, undefined);
        if (provider === yahootw) delete this.ytwAuctionBooks[symbol];
        if (this.lineTrades[provider.id]) delete this.lineTrades[provider.id][symbol];
      }
    }
    for (const symbol of Object.keys(this.localNames)) if (!covered.has(symbol)) delete this.localNames[symbol];
  }

  /**
   * Whether `provider` prices `symbol`: it declares the symbol's market and kind. A sole-source symbol is priced by
   * that source alone, whatever its market reads.
   */
  serves(provider, symbol, config) {
    const sole = this.soleSource(symbol, config);
    if (sole) return provider === sole;
    const kind = kindOf(symbol);
    return (
      provider.kinds.includes(kind) &&
      provider.markets.includes(kind === "index" ? this.marketFor(symbol) : marketOf(symbol))
    );
  }

  /** The listed symbols (or `list`'s) a provider quotes, up to its cap; none for an overlay source that is off. */
  symbolsFor(provider, config = this.config(), list = this.preferences.symbols) {
    if (provider.overlay && !config.on[provider.id]) return [];
    const symbols = list.filter((symbol) => this.serves(provider, symbol, config));
    return provider.cap ? symbols.slice(0, Math.max(0, provider.cap(config))) : symbols;
  }

  /**
   * The busiest session among `symbols`, by SESSION_RANK (open wins a tie with auction), read from the base quotes.
   * - A symbol MIS still flags reads "auction" whatever its session; "auction" reads "closed" before 09:00 Taipei.
   * - A sole-source symbol with nothing to show takes its form's session: a future's by TAIFEX's hours, anything
   *   else "closed", so it is never polled at the fast pace.
   * - One that source answered as not found reads "closed", so a mistyped code never holds the batch at the fast
   *   pace; the wake at each TAIFEX opening still asks for it.
   */
  sessionFor(symbols, now) {
    let best = "closed";
    for (const symbol of symbols) {
      const quote = this.baseQuote(symbol, now);
      let session = quote
        ? sessionOf(quote, now)
        : this.soleSource(symbol)
          ? this.errors[symbol]?.code === "yahootw.notFound"
            ? "closed"
            : soleSession(this.standIn(symbol, now), now)
          : "unknown";
      // MIS's flag keeps the pace also where a delayed price from today reads its own session. Before 09:00 Taipei (the
      // trial match's end) a call auction paces as closed: its answers show nothing new, the fast pace is for trading
      // hours only, and the 09:00 opening starts a round.
      if (session === "auction" || (quote && auctionFlagged(quote.auctionAt, now))) {
        session = taipeiMinute(now) < TW_TRIAL_MATCH.to ? "closed" : "auction";
      }
      if (session === "24h") session = "open";
      // On a tie, open wins over an auction, so a flagged stock listed first never hides that the market is open.
      const rank = SESSION_RANK[session] - SESSION_RANK[best];
      if (rank > 0 || (rank === 0 && session === "open")) best = session;
    }
    return symbols.length ? best : "unknown";
  }

  /**
   * How long until the first of `symbols`' shown quotes turns stale; at most LIVE_MAX_AGE_MS, also when none ever
   * does. A quote that cannot turn stale in its session is skipped: inside a lunch window its age stands still, also
   * after a half day's close. The cap still wakes the loop for the reopening, or for the trading hours a delayed
   * quote has not been given yet.
   */
  staleInMs(symbols, now) {
    let wait = LIVE_MAX_AGE_MS;
    for (const symbol of symbols) {
      const quote = this.shown(symbol, now);
      const at = quote ? staleAt(quote, sessionOf(quote, now), now) : null;
      if (at !== null && at - now < wait) wait = at - now;
    }
    return wait;
  }

  /** The earliest nextEdge among `symbols`' shown quotes, or null; a symbol without one is read by its standIn. */
  edgeAt(symbols, now, mode) {
    let earliest = null;
    for (const symbol of symbols) {
      const edge = nextEdge(this.shown(symbol, now) ?? this.standIn(symbol, now), now, mode);
      if (edge !== null && (earliest === null || edge < earliest)) earliest = edge;
    }
    return earliest;
  }

  /**
   * One provider's loop, until stop(). Each round starts the provider's interval after the previous one ends, or when
   * its cooldown ends if later; an edit starts one at once.
   */
  async runProvider(id, io) {
    const provider = PROVIDERS.find((p) => p.id === id);
    const state = this.sources[id];
    while (!this.stopped) {
      const manual = state.manual;
      state.manual = false;
      state.dirty = false;
      let symbols = [];
      let hidden = false;
      try {
        const settings = readSettings(this.host.settings());
        if (provider === finnhub) await this.loadKey(settings);
        if (this.stopped) return;
        // A refused key stops the source until its own settings change (a new key, address or budget).
        if (state.disabled && state.disabledFor !== SWITCHES[id]?.retryOn?.(settings)) {
          state.disabled = false;
          state.problem = null;
        }
        this.adopt(readPreferences(this.host.load()));
        const configKey = JSON.stringify(this.config());
        if (configKey !== this.configKey) this.closureRev++;
        this.configKey = configKey;
        symbols = this.symbolsFor(provider);
        if (!symbols.length) {
          state.problem = null;
          state.lineFailures = {};
          state.noLive = null;
        }
        // A hidden copy never renders, but its loops run, so they ask here. A skipped round is marked missed, and the
        // loop waits as idle until wakeMissed() on the render that shows the copy again.
        hidden = !this.isShown();
        const due = symbols.length && !state.disabled && (manual || !this.preferences.paused);
        state.missed = hidden && Boolean(due);
        if (due && !hidden) {
          state.refreshing = manual;
          if (this.holdsTaiwan(symbols)) {
            await this.loadHolidays(io);
            // A change during that wait (a source turned off, a pause, a removed symbol) restarted the loops, so these
            // symbols and settings are old. Start again from the top, keeping a Refresh asked for: it may be the only
            // reason a paused list has a round.
            if (state.dirty) {
              state.manual ||= manual;
              continue;
            }
          }
          await this.round(provider, state, symbols, io);
        }
      } catch {
        // A bug must not end the loop unseen: the source shows a problem and tries again after its interval.
        state.problem = notice(`${id}.unreachable`);
      } finally {
        state.refreshing = false;
      }
      if (this.stopped) return;
      const { paused } = this.preferences;
      io.changed();
      if (state.manual || state.dirty) continue;
      const idle = paused || !symbols.length || state.disabled || hidden;
      const now = this.host.now();
      let due = now;
      if (!idle) {
        // A break's interval ends at the next opening (a session's start, a lunch's end, the FX week's start), so a
        // session's first price is not up to an interval late.
        const opens = this.edgeAt(symbols, now, { openings: true });
        due += Math.max(
          Math.min(provider.intervalMs(this.sessionFor(symbols, now)), opens === null ? Infinity : opens - now),
          state.retryAt - now,
        );
      }
      await this.rest(state, symbols, due, io, hidden);
    }
  }

  /**
   * Sleeps until `due`, or until poked; an idle loop sleeps until a shown price turns stale. A long wait, such as a
   * rate-limit cooldown, is cut where a shown price turns stale or a row reaches its next edge; those wakes only
   * redraw. A hidden copy never renders, so it skips the edges and waits for wakeMissed().
   */
  async rest(state, symbols, due, io, hidden) {
    for (;;) {
      const now = this.host.now();
      const edge = hidden ? null : this.edgeAt(symbols, now);
      const stale = this.staleInMs(symbols, now);
      const redraw = edge === null ? stale : Math.min(stale, edge - now);
      const wait = due > now ? Math.min(due - now, redraw) : redraw;
      const poked = await new Promise((resolve) => {
        state.wake = () => resolve(true);
        io.sleep(wait).then(() => resolve(false));
      });
      state.wake = null;
      if (poked || this.stopped || this.host.now() >= due) return;
      io.changed();
    }
  }

  async round(provider, state, symbols, io) {
    const revision = this.revision;
    const current = () => !this.stopped && revision === this.revision;
    if (this.host.now() < state.retryAt) return;
    const config = this.config();
    const configKey = JSON.stringify(config);
    // A new address asks every line again.
    if (state.configKey !== configKey) {
      state.configKey = configKey;
      state.linesAt = {};
    }
    // Only Finnhub's requests carry the key; no other source is ever handed it. The symbols Yahoo 奇摩股市 prices alone
    // go to its requests only, never to config(), where a change would make sync() restart every round.
    const asked =
      provider === finnhub
        ? { ...config, finnhubKey: this.finnhubKey }
        : provider === yahootw
          ? { ...config, anyDay: symbols.filter((symbol) => this.soleSource(symbol, config)) }
          : config;
    const requests = provider.requests(symbols, asked);
    const quoteCount = requests.filter((request) => request.kind === "quote").length;
    const spacing = provider.spacingMs(quoteCount, provider.intervalMs(this.sessionFor(symbols, this.host.now())));
    let problem = null;
    let live = false;
    let noLive = null;
    // A provider with `linesPerRound` lists its lines after its prices: this loop sends the prices, and the due lines
    // are picked once they are in. Any other provider's requests go out as listed.
    const listed = provider.linesPerRound ? quoteCount : requests.length;
    state.loading = true;
    io.changed();
    try {
      for (let index = 0; index < listed; index++) {
        if (!current()) return;
        const request = requests[index];
        if (request.kind === "line") {
          const failed = await this.line(provider, state, request, io, current);
          if (this.endsRound(provider, failed)) {
            this.endOnLine(provider, state, requests, index, failed);
            return;
          }
          continue;
        }
        const wait = spacing - (this.host.now() - state.lastRequestAt);
        if (wait > 0) await io.sleep(wait);
        if (!current()) return;
        state.lastRequestAt = this.host.now();
        const result = await this.quote(provider, request, io, current, asked);
        if (!result) return;
        const failures = Object.values(result.errors);
        const refused = failures.find((error) => error.stopsSource);
        const limited = failures.find((error) => error.retryAfterMs !== undefined);
        const down = failures.find((error) => SOURCE_DOWN.test(error.code));
        if (!problem) problem = failures.find((error) => SOURCE_FAILURE.test(error.code)) ?? null;
        // An answer that prices only an earlier day's close (TW-only) is not live: it carries noLive.
        if (result.noLive) noLive ??= result.noLive;
        else if (Object.keys(result.quotes).length) live = true;
        this.apply(provider, request, result);
        if (refused) {
          // No more requests with this key: the rest fall back with the same reason.
          state.disabled = true;
          state.disabledFor = SWITCHES[provider.id]?.retryOn?.(readSettings(this.host.settings())) ?? null;
          state.problem = coded(refused);
          this.failRest(provider, requests, index, coded(refused));
          return;
        }
        if (limited) {
          this.backOff(provider, state, requests, index, limited);
          return;
        }
        if (down) {
          // Retry at the next interval; the rest keep their cached quotes, marked with the reason.
          state.problem = coded(down);
          this.failRest(provider, requests, index, coded(down));
          return;
        }
        io.changed();
      }
      for (const request of provider.linesPerRound ? this.dueLines(provider, state, requests) : []) {
        if (!current()) return;
        const failed = await this.line(provider, state, request, io, current);
        if (this.endsRound(provider, failed)) {
          this.endOnLine(provider, state, requests, requests.indexOf(request), failed);
          return;
        }
        if (!current()) return;
        // A failure of the source itself (an HTTP error, an unreadable answer) shows, as a price's would. A line is
        // asked only every `linesMs`, so the failure stays shown until that symbol's next line comes in; otherwise a
        // line that always fails would blink.
        if (failed && SOURCE_FAILURE.test(failed.code)) state.lineFailures[request.symbols[0]] = failed;
        else delete state.lineFailures[request.symbols[0]];
      }
      if (!current()) return;
      // A symbol no longer priced by this source is not asked for a line again, so its failure goes.
      for (const symbol of Object.keys(state.lineFailures))
        if (!this.priced(provider, symbol)) delete state.lineFailures[symbol];
      // An answer that prices nothing live while the market is open is shown, or the user sees only delayed rows with
      // no word why. It stays until an answer prices a row again.
      if (live || this.sessionFor(symbols, this.host.now()) !== "open") state.noLive = null;
      else if (noLive) state.noLive = noLive;
      problem ??= state.noLive ?? Object.values(state.lineFailures)[0] ?? null;
      state.failures = 0;
      state.retryAt = 0;
      state.problem = problem && coded(problem);
    } finally {
      state.loading = false;
    }
  }

  /** The due line requests of `requests`, longest-waiting (or never asked) first, at most `linesPerRound`. */
  dueLines(provider, state, requests) {
    const now = this.host.now();
    const askedAt = (request) => state.linesAt[request.symbols[0]] ?? 0;
    return requests
      .filter((request) => request.kind === "line" && this.lineDue(provider, state, request.symbols[0], now))
      .sort((a, b) => askedAt(a) - askedAt(b))
      .slice(0, provider.linesPerRound);
  }

  /**
   * Whether a symbol's line is due: the symbol has this provider's price and its line waited `linesMs`. After the
   * close, a line already held for its price's day is the whole day, so it is not asked again.
   */
  lineDue(provider, state, symbol, now) {
    const priced = this.priced(provider, symbol);
    if (!priced) return false;
    const session = this.sessionFor([symbol], now);
    const line = this.lines[provider.id]?.[symbol];
    if ((session === "closed" || session === "post") && line && line.day === priced.day) return false;
    return now - (state.linesAt[symbol] ?? -Infinity) >= provider.linesMs(session);
  }

  // What a line is drawn beside: this provider's overlay (a sole-source symbol's own quote), or the base quote.
  priced(provider, symbol) {
    return provider.overlay ? this.overlays[symbol]?.[provider.id] : this.quotes[symbol];
  }

  // Whether a line's error ends the round: when the source rate limited it, or when it is down or hung for a provider
  // with `linesPerRound`. That provider's lines come after all its prices, so more line timeouts would only hold up
  // the next price round.
  endsRound(provider, error) {
    if (!error) return false;
    return error.retryAfterMs !== undefined || (Boolean(provider.linesPerRound) && SOURCE_DOWN.test(error.code));
  }

  // A line that ends the round. Rate limited: the source backs off. Down or hung: its prices are in, so a backoff ends
  // as after a clean round, and the round ends with the problem shown.
  endOnLine(provider, state, requests, index, failed) {
    if (failed.retryAfterMs !== undefined) {
      this.backOff(provider, state, requests, index, failed);
      return;
    }
    state.failures = 0;
    state.retryAt = 0;
    state.problem = coded(failed);
    state.lineFailures[requests[index].symbols[0]] = failed;
  }

  // Backs off this provider only: BACKOFF_BASE_MS, doubling with each further failure, never over BACKOFF_MAX_MS.
  // The rest of the round's quote requests are deferred. A rate-limited line of an overlay source defers all its
  // prices, sent or not, so its rows fall to the next source; a sole-source row keeps its price, cached.
  backOff(provider, state, requests, index, limited) {
    state.failures++;
    const backoff = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** Math.min(state.failures - 1, BACKOFF_MAX_DOUBLINGS),
    );
    state.retryAt = this.host.now() + Math.max(backoff, limited.retryAfterMs);
    state.problem = coded(limited);
    const from = provider.overlay && requests[index].kind === "line" ? -1 : index;
    this.failRest(provider, requests, from, notice("request.deferred", { source: provider.id }));
  }

  apply(provider, request, result) {
    const now = this.host.now();
    if (provider.overlay) {
      // A name can come without a price (before the open): remember it all the same.
      for (const symbol of request.symbols) if (result.names?.[symbol]) this.localNames[symbol] = result.names[symbol];
      // Only this answer's prices are laid over the base: a symbol without one shows the base at once.
      for (const symbol of request.symbols) {
        const overlay = result.quotes[symbol];
        const error = result.errors[symbol] ? coded(result.errors[symbol]) : undefined;
        const had = this.overlays[symbol]?.[provider.id];
        if (overlay) this.setEntry(this.overlays, symbol, provider.id, overlay);
        // Whether MIS's latest answer named it with no level, answer by answer.
        if (provider === mis) {
          if (result.noLevels?.[symbol]) this.noLevels[symbol] = true;
          else delete this.noLevels[symbol];
        }
        // Yahoo 奇摩股市's opening-auction book, answer by answer: a priced answer, or one without it, drops it.
        if (provider === yahootw) {
          const book = result.auctionBook?.[symbol];
          if (book) this.ytwAuctionBooks[symbol] = { book, fetchedAt: now };
          else delete this.ytwAuctionBooks[symbol];
        }
        if (this.soleSource(symbol) === provider) {
          // A sole-source symbol has no base, so it keeps its last price and line, as a base quote does, and its row
          // says why. A failure is shown as itself, never as not found. Not found is this source's once it priced the
          // symbol, so the kept price reads cached, and always for a future, which Yahoo Finance never sees.
          if (overlay || (!error && result.names?.[symbol])) delete this.errors[symbol];
          else
            this.errors[symbol] =
              error ?? notice(had || kindOf(symbol) === "future" ? "yahootw.notFound" : "yahoo.notFound");
          continue;
        }
        // A symbol in a call auction (MIS's flag) keeps the price held from before it. A flag from a snapshot older
        // than that price is an answer MIS's cache served late, and is ignored. The auction book is the newest
        // flag's: an older flag changes nothing, and a newer one without levels drops it.
        const flaggedAt = result.auction?.[symbol];
        if (flaggedAt === undefined) {
          if (!overlay) this.dropOverlay(provider, symbol);
          else if (provider === mis) this.dropAuction(symbol);
        } else if (!(had?.timestamp > flaggedAt)) {
          if (flaggedAt >= (this.auctionAt[symbol] ?? 0)) {
            const book = result.auctionBook?.[symbol];
            if (book) this.auctionBooks[symbol] = book;
            else delete this.auctionBooks[symbol];
          }
          this.auctionAt[symbol] = Math.max(this.auctionAt[symbol] ?? 0, flaggedAt);
        }
        this.setEntry(this.overlayErrors, symbol, provider.id, overlay ? undefined : error);
      }
      this.observe(provider, result, now);
      return;
    }
    // Only an index's exchange, or its TW-only mark, can hand a symbol to another source.
    const routes = request.symbols.some((symbol) => kindOf(symbol) === "index");
    const before = routes ? this.overlaySymbols() : null;
    for (const [symbol, quote] of Object.entries(result.quotes)) {
      // A source with its own line requests keeps the last line, and its times, until a new one arrives.
      if (provider.linesMs) {
        const previous = this.quotes[symbol];
        quote.series = previous?.series ?? [];
        if (previous?.times) quote.times = previous.times;
      }
      this.quotes[symbol] = quote;
      delete this.errors[symbol];
    }
    this.observe(provider, result, now);
    const config = this.config();
    for (const [symbol, error] of Object.entries(result.errors)) {
      this.errors[symbol] = coded(error);
      if (error.code !== "yahoo.notFound" || !isTaiwanForm(symbol)) continue;
      // A Taiwan index Yahoo Finance does not know may be Yahoo 奇摩股市's alone; the error stays until it is priced.
      // A TW-only row keeps nothing of an earlier Yahoo Finance quote; a Yahoo 奇摩股市 overlay already held stays,
      // as the symbol's own quote.
      if (config.on[yahootw.id]) {
        this.twOnly.add(symbol);
        delete this.linePeriods[symbol];
        delete this.quotes[symbol];
        this.setEntry(this.overlayErrors, symbol, yahootw.id, undefined);
      } else if (config.yahootwPending) {
        // Not found is true but not the whole story: consent to the current statement is what holds it back.
        this.errors[symbol] = this.unpricedReason(symbol, config);
      }
    }
    if (routes) this.wakeResolved(before);
  }

  /**
   * Notes what one answer saw of each Taiwan market, once per market (noteTrade). The trade is:
   * - the decoder's `newestTrade` when it gives one (Yahoo 奇摩股市's newest real-time trade per market, whatever its
   *   day, so an answer of yesterday's prices still counts as an answer);
   * - else the newest trade among the answer's priced Taiwan rows, real time as the row that set it is. A quote not
   *   timed by a trade, or a symbol MIS flags as in a call auction, counts as a row without a trade.
   * Run once the rows are in, so an index reads its market by the exchange this answer gave.
   */
  observe(provider, result, now) {
    const trades = {};
    const realtime = REALTIME_SOURCES.has(provider.id);
    if (result.newestTrade) {
      for (const [market, time] of Object.entries(result.newestTrade)) trades[market] = { time, realtime };
    } else {
      const rows = [
        ...Object.entries(result.quotes).map(([symbol, quote]) => [
          symbol,
          timedByTrade(quote) ? (quote.tradeTime ?? quote.timestamp) : null,
          isRealtime(quote),
        ]),
        ...Object.keys(result.auction ?? {}).map((symbol) => [symbol, null, realtime]),
      ];
      for (const [symbol, time, rowRealtime] of rows) {
        if (this.marketFor(symbol) !== "tw") continue;
        const market = twMarket(symbol);
        const newest = trades[market]?.time ?? null;
        const later = Number.isFinite(time) && (newest === null || time > newest);
        // Real time as the row that set the newest trade is (the first row until one does).
        if (later || !trades[market]) trades[market] = { time: later ? time : null, realtime: rowRealtime };
      }
    }
    for (const [market, { time, realtime }] of Object.entries(trades))
      this.noteTrade(market, time, { source: provider.id, realtime }, now);
  }

  /** Each overlay source's symbols, in OVERLAYS order: what `wakeResolved` compares. */
  overlaySymbols() {
    return this.symbolLists(OVERLAYS).map((symbols) => symbols.join(","));
  }

  /**
   * A base answer that named an index's exchange can hand the index to an overlay source. Each source whose symbols
   * changed since `before` runs a round now, not after its idle wait; one in a round adds a round after it. Never
   * restart(): that would drop the rounds in flight, this base one too.
   */
  wakeResolved(before) {
    const after = this.overlaySymbols();
    OVERLAYS.forEach((provider, i) => {
      if (before[i] === after[i]) return;
      const state = this.sources[provider.id];
      state.dirty = true;
      wake(state);
    });
  }

  // Sets one provider's entry in a per-symbol record; undefined clears it, and a symbol left empty goes.
  setEntry(record, symbol, id, value) {
    if (value !== undefined) {
      (record[symbol] ??= {})[id] = value;
      return;
    }
    if (!record[symbol]) return;
    delete record[symbol][id];
    if (!Object.keys(record[symbol]).length) delete record[symbol];
  }

  // The quote requests after `index`, not sent this round.
  failRest(provider, requests, index, error) {
    for (const later of requests.slice(index + 1)) {
      if (later.kind !== "quote") continue;
      for (const symbol of later.symbols) this.fail(provider, symbol, error);
    }
  }

  // A symbol whose request was not answered. A base quote stays, marked cached, and so does a sole-source symbol's
  // quote, which has no base; an overlay goes.
  fail(provider, symbol, error) {
    if (provider === yahootw) delete this.ytwAuctionBooks[symbol];
    if (!provider.overlay || this.soleSource(symbol) === provider) {
      this.errors[symbol] = error;
      return;
    }
    this.forgetOverlay(provider, symbol, error);
  }

  // Drops `provider`'s overlay for `symbol`, with MIS's `noLevels` mark, and sets its error to `error` (undefined
  // clears it).
  forgetOverlay(provider, symbol, error) {
    this.dropOverlay(provider, symbol);
    if (provider === mis) delete this.noLevels[symbol];
    this.setEntry(this.overlayErrors, symbol, provider.id, error);
  }

  // An overlay's line goes with its price, so a line is never drawn with a later price it did not end at. MIS's
  // auction flag goes with MIS's price.
  dropOverlay(provider, symbol) {
    this.setEntry(this.overlays, symbol, provider.id, undefined);
    if (this.lines[provider.id]) delete this.lines[provider.id][symbol];
    if (provider === mis) this.dropAuction(symbol);
  }

  dropAuction(symbol) {
    delete this.auctionAt[symbol];
    delete this.auctionBooks[symbol];
  }

  /** One quote request; when one unknown symbol fails a whole batch, ask symbol by symbol. */
  async quote(provider, request, io, current, config) {
    const batch = await this.ask(provider, request, io, current);
    if (!batch || request.symbols.length < 2 || !request.symbols.every((symbol) => batch.errors[symbol]?.invalidSymbol))
      return batch;
    const merged = { quotes: {}, errors: {} };
    for (const symbol of request.symbols) {
      const single = provider.requests([symbol], config).find((r) => r.kind === "quote");
      const result = await this.ask(provider, single, io, current);
      if (!result) return null;
      Object.assign(merged.quotes, result.quotes);
      Object.assign(merged.errors, result.errors);
    }
    return merged;
  }

  /**
   * Asks for a symbol's line, at most once per `linesMs`, while the symbol has a quote from this provider. Returns
   * the request's error for the symbol, if any. An overlay provider's answer without a line drops the line it held,
   * and so does a frozen line, which would be drawn as live with only its tail moving. Frozen is judged as the line
   * arrives, not at each price. A sole-source symbol's known periods are never dropped.
   */
  async line(provider, state, request, io, current) {
    const [symbol] = request.symbols;
    const now = this.host.now();
    if (!this.lineDue(provider, state, symbol, now)) return null;
    state.linesAt[symbol] = now;
    const result = await this.ask(provider, request, io, current);
    const periods = result && current() && this.soleSource(symbol) === provider && result.periods?.[symbol];
    if (periods) this.linePeriods[symbol] = periods;
    const line = result?.lines?.[symbol];
    const kept = result && current() && this.priced(provider, symbol);
    const frozen = kept && provider.overlay && line && this.lineFrozen(provider, symbol, line, kept.tradeTime, now);
    if (kept && provider.overlay && line && !frozen) (this.lines[provider.id] ??= {})[symbol] = line;
    else if (kept && provider.overlay) delete this.lines[provider.id]?.[symbol];
    else if (kept && line) {
      const quote = this.quotes[symbol];
      quote.series = line.series;
      if (line.times) quote.times = line.times;
      else delete quote.times;
    }
    return result?.errors?.[symbol] ?? null;
  }

  /**
   * Whether an overlay line arriving at `now` has stopped: its last traded minute ends over LINE_LAG_MS before a
   * trade it must already hold.
   * - A trade counts once settled: its minute has ended and LINE_LAG_MS has passed. Until one has, the line stays,
   *   so a quiet line is never dropped for a trade it cannot hold yet. A line first asked after the close finds
   *   the price's last trade already settled, so it is judged on its first arrival.
   * - The trades seen at recent arrivals are kept (LINE_TRADES at most). The line is judged against the newest settled
   *   one, capped at its regular session's end: a stock's 14:30 fixed-price trade is never in its line.
   * With lines 2 min apart, a line frozen from its first arrival was dropped at its third, and one that stopped
   * mid-session 8 to 10 min after it stopped. A frozen line stays dropped, also through a dropped price.
   */
  lineFrozen(provider, symbol, line, tradeTime, now) {
    const trades = ((this.lineTrades[provider.id] ??= {})[symbol] ??= []);
    if (Number.isFinite(tradeTime) && !(trades[trades.length - 1] >= tradeTime)) trades.push(tradeTime);
    let settled = trades.length - 1;
    while (settled >= 0 && trades[settled] + MINUTE_MS + LINE_LAG_MS > now) settled--;
    // The newest settled trade goes first; older ones never count again.
    if (settled > 0) trades.splice(0, settled);
    // Lines asked closer together than usual: the oldest unsettled trades go, never the settled one.
    if (trades.length > LINE_TRADES) trades.splice(settled < 0 ? 0 : 1, trades.length - LINE_TRADES);
    if (settled < 0) return false;
    const reference = Math.min(trades[0], this.sessionEnd(provider, symbol, line));
    return line.lastAt + MINUTE_MS < reference - LINE_LAG_MS;
  }

  /**
   * When the regular session of a line's trading day ends: the answer's own `endAt`, else the known periods' end when
   * they are of that day, else never. A sole-source symbol's periods come from its last line answer.
   */
  sessionEnd(provider, symbol, line) {
    if (Number.isFinite(line.endAt)) return line.endAt;
    const known = this.soleSource(symbol) === provider ? this.linePeriods[symbol] : this.quotes[symbol]?.periods;
    const end = known?.regular?.[1];
    return Number.isFinite(end) && tradingDay(symbol, end - 1) === line.day ? end : Infinity;
  }

  async get(request) {
    const response = await this.host.fetch(request.url, request.headers);
    // `url`: where the answer came from after any redirect.
    return { status: response.status, ok: response.ok, url: response.url, text: await response.text() };
  }

  // The answer to `request` (get), or TIMED_OUT when REQUEST_TIMEOUT_MS passes first: Herdr's fetch has no timeout.
  getWithin(request, io) {
    const timeout = io.sleep(REQUEST_TIMEOUT_MS).then(() => TIMED_OUT);
    return Promise.race([this.get(request), timeout]);
  }

  /**
   * One request, decoded; null once the round is stale. A request that does not answer within REQUEST_TIMEOUT_MS gets
   * `request.timeout`, and its late answer is dropped. A network failure or a decoder bug becomes the provider's
   * `unreachable` error for each of its symbols.
   */
  async ask(provider, request, io, current) {
    try {
      const response = await this.getWithin(request, io);
      if (!current()) return null;
      if (response === TIMED_OUT) {
        throw new QuoteError("request.timeout", { source: provider.id, seconds: REQUEST_TIMEOUT_MS / 1000 });
      }
      return provider.decode(request, response, this.host.now());
    } catch (error) {
      if (!current()) return null;
      const failure = error instanceof QuoteError ? error : new QuoteError(`${provider.id}.unreachable`);
      return { quotes: {}, errors: Object.fromEntries(request.symbols.map((symbol) => [symbol, failure])) };
    }
  }
}
