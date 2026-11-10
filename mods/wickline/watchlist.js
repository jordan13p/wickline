// The watchlist and its refresh loops, one per provider. Herdr's APIs come in through `host`
// and each loop's `io`, so tests drive it under Node with a fake clock and network.
import { QuoteError, STARTER_SYMBOLS, normalizeSymbol } from "./quotes.js";
import { LIVE_MAX_AGE_MS, isRealtime, msUntilStale, sessionOf } from "./freshness.js";
import { isTaiwanForm, kindOf, marketOf, resolvedMarket } from "./markets.js";
import { binance } from "./providers/binance.js";
import { finnhub, finnhubAddressOk, finnhubCap } from "./providers/finnhub.js";
import { mis } from "./providers/mis.js";
import {
  SECRET_KEY_FINNHUB, finnhubChosen, misEnabled, misReconfirm, readSettings, yahootwEnabled, yahootwReconfirm,
} from "./settings.js";
import { yahoo } from "./providers/yahoo.js";
import { ownPeriods, yahootw } from "./providers/yahootw.js";

// The watchlist lives in Herdr's shared state (persisted), so every copy sees one list.
export const WATCHLIST_KEY = "wickline.watchlist.v1";
// Herdr's fetch cannot be aborted: a request that has not answered by then counts as failed.
export const REQUEST_TIMEOUT_MS = 10_000;
// Started in this order, so their first requests go out in this order too. The order also sets the
// overlay sources' priority.
const PROVIDERS = [binance, yahootw, mis, finnhub, yahoo];
// The overlay sources in priority order (Yahoo 奇摩股市, then TWSE MIS): with several live ones for a
// symbol, the first wins.
const OVERLAYS = PROVIDERS.filter((provider) => provider.overlay);
const OVERLAY_ORDER = OVERLAYS.map((provider) => provider.id);
// Overlay sources the person turns on in Settings: whether each is on now (given this watchlist, which
// holds the key read from the secrets file), what its settings row and status line say while it is chosen but
// cannot run, and, for a source that can refuse the key, the settings whose change lets it try again.
const SWITCHES = {
  yahootw: { on: yahootwEnabled, notice: (settings) => (yahootwReconfirm(settings) ? "yahootw.reconfirm" : null) },
  mis: { on: misEnabled, notice: (settings) => (misReconfirm(settings) ? "mis.reconfirm" : null) },
  finnhub: {
    // The address is checked again here: shared state may hold one the dialog never accepted.
    on: (settings, w) => finnhubChosen(settings) && finnhubAddressOk(settings.sources.us.finnhubUrl) && Boolean(w.finnhubKey),
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
// A provider refreshes at the pace of its busiest symbol; a pair's "24h" counts as open, and a lunch break
// ranks below a session not yet known but above pre/post.
const SESSION_RANK = { open: 4, "24h": 4, unknown: 3, lunch: 2, pre: 1, post: 1, closed: 0 };
// Errors about the source itself, not one symbol: shown as the source's problem.
const SOURCE_FAILURE = /\.(unreachable|timeout|rateLimited|region|http|unreadable)$/;
// The source is down or hung: the rest of the round would only wait out more timeouts.
const SOURCE_DOWN = /\.(unreachable|timeout)$/;
const TIMED_OUT = {};
// A minute's length, and how far a line's last minute may end before its price's own last trade.
const MINUTE_MS = 60_000;
const LINE_LAG_MS = 120_000;

const notice = (code, params = {}) => ({ code, params });
const coded = (error) => notice(error.code, error.params);

// Ends a loop's wait now.
function wake(state) {
  const resolve = state.wake;
  state.wake = null;
  resolve?.();
}

/**
 * The overlay a row shows, among a symbol's overlays keyed by provider id: the first of `order` that is
 * still live (at most LIVE_MAX_AGE_MS old: the moment msUntilStale wakes an idle loop for, in any session),
 * else the newest, a tie keeping the earlier id. Null with none, or when none is live and the `base` quote is
 * real time (isRealtime) and no older than the newest: a stale overlay never hides a fresher real-time price.
 */
export function pickOverlay(byProvider, order, now, base = null) {
  let newest = null;
  for (const id of order) {
    const overlay = byProvider[id];
    if (!overlay) continue;
    if (now - overlay.timestamp <= LIVE_MAX_AGE_MS) return { id, overlay };
    if (!newest || overlay.timestamp > newest.overlay.timestamp) newest = { id, overlay };
  }
  return newest && base && isRealtime(base) && base.timestamp >= newest.overlay.timestamp ? null : newest;
}

/**
 * A real-time overlay's fields over the Yahoo base quote. The trading periods, the currency and the
 * name stay the base's (the overlay's name is kept as `localName`); so does the line, unless the
 * overlay's source gave its own (`line`, `{ day, series }`) on the overlay's Taipei day (`overlay.day`):
 * then that line, ending at the shown price. `chartSource` names where the line came from, and
 * `chartTimestamp` and `chartFetchedAt` keep that quote's times, so the line's state is judged by its own
 * quote. Works with no base yet. A quote over itself (a symbol's sole source, base and overlay from one source)
 * has no line but the overlay's own: without one, no line and no `chartSource`.
 */
export function mergeOverlay(base, overlay, line) {
  if (!overlay) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) if (value !== null && value !== undefined) merged[key] = value;
  const previousClose = merged.previousClose ?? null;
  // A copy hidden overnight may hold yesterday's line next to today's first price.
  const own = line?.series.length && line.day === overlay.day ? line.series : null;
  // The base's own line, never a quote's over itself.
  const fallback = base?.source === overlay.source ? null : base;
  return {
    ...merged,
    previousClose,
    changePercent: previousClose > 0 ? (overlay.price - previousClose) / previousClose * 100 : null,
    name: base?.name ?? null,
    localName: overlay.name ?? null,
    // A price is never paired with another answer's limits.
    limitUp: overlay.limitUp ?? null,
    limitDown: overlay.limitDown ?? null,
    currency: base?.currency ?? null,
    series: own ? [...own, overlay.price] : fallback?.series ?? [],
    periods: base?.periods ?? null,
    chartSource: own ? overlay.source : fallback?.source ?? null,
    chartTimestamp: own ? overlay.timestamp : fallback?.timestamp ?? null,
    chartFetchedAt: own ? overlay.fetchedAt : fallback?.fetchedAt ?? null,
  };
}

export function readPreferences(value) {
  // Nothing saved yet: a starter list, until the first edit saves the person's own.
  if (value === undefined || value === null) return { version: 1, symbols: [...STARTER_SYMBOLS], paused: false };
  const saved = typeof value === "object" ? value : null;
  const symbols = [];
  if (saved?.version === 1 && Array.isArray(saved.symbols)) {
    for (const raw of saved.symbols) {
      if (typeof raw !== "string") continue;
      try {
        const symbol = normalizeSymbol(raw);
        if (!symbols.includes(symbol)) symbols.push(symbol);
      } catch { /* Skip one bad entry, not the whole list. */ }
    }
  }
  return { version: 1, symbols, paused: saved?.version === 1 && saved.paused === true };
}

/**
 * host: {
 *   load(): unknown, save(preferences): void          // the saved watchlist
 *   settings(): unknown                                // the saved settings (read only)
 *   fetch(url, headers): Promise<{ status, ok, text() }>  // GET with the request's headers; hosts in providers/
 *   loadSecret(name): Promise<string|null>             // the secrets file's value (null: no file or no key);
 *                                                      // rejects when the file cannot be read
 *   now(): number
 *   shown?(): boolean                                  // this copy is on screen (default: yes); a docked
 *                                                      // copy that is not sends nothing
 * }
 * Each loop gets its own io: { sleep(ms): Promise<void>, changed(): void } (redraw).
 */
export class Watchlist {
  constructor(host) {
    this.host = host;
    // This copy is on screen; a host without shown() always is.
    this.isShown = () => host.shown?.() ?? true;
    // The Finnhub key as read from the secrets file for keyRev `keyRev` (null: not read yet). Only in
    // memory: never in the config, the shared state or an error.
    this.finnhubKey = null;
    this.keyRev = null;
    this.keyUnreadable = false;
    this.preferences = readPreferences(host.load());
    this.configKey = JSON.stringify(this.config());
    // By symbol: the base quote (Yahoo for stocks, Binance for pairs), and the real-time overlays over it,
    // one per overlay source (by provider id). A symbol with a sole source (soleSource) has no base quote: its
    // price stays in that source's overlay slot.
    this.quotes = {};
    this.overlays = {};
    // By provider id, then symbol: an overlay source's own line, `{ day, series }` (`day`: its Taipei
    // day), kept only while that source's price for the symbol is.
    this.lines = {};
    // By symbol: the last name an overlay gave (its Chinese name), kept while that source fails.
    this.localNames = {};
    // By symbol: `{ code, params }` for the view to translate; an overlay's own errors apart (by
    // provider id), since its symbol still has the base quote.
    this.errors = {};
    this.overlayErrors = {};
    // TW-only symbols: a ^TW… index Yahoo Finance answered not found, which Yahoo 奇摩股市 then prices alone
    // while it is on (soleSource). Only in memory, so each start learns them again with one Yahoo Finance request.
    this.twOnly = new Set();
    // By symbol: the trading periods the last line answer gave a symbol priced by its sole source alone, which
    // has no base quote to give them (see ownPeriods).
    this.linePeriods = {};
    this.revision = 0;
    this.stopped = false;
    // Per provider: its backoff, its current problem, its round and its own wake-up. `lineFailures`, by
    // symbol: the source failure of that symbol's last line request, for a provider with `linesPerRound`.
    // `noLive`: while the market is open, why an overlay source that answers prices nothing.
    this.sources = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, {
      retryAt: 0, failures: 0, disabled: false, problem: null, noLive: null,
      loading: false, manual: false, refreshing: false, dirty: true, wake: null,
      lastRequestAt: -Infinity, missed: false, linesAt: {}, lineFailures: {}, configKey: null, disabledFor: null,
    }]));
  }

  /**
   * What the providers are given: the saved addresses and budget, and which overlay sources are on.
   * The key is added only to the requests of a round, so it never reaches `configKey`.
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
    };
  }

  /**
   * Reads the Finnhub key again when Finnhub is chosen and keyRev changed; a broken file is no key.
   * With Finnhub not chosen no key is held, so a key removed from the file leaves memory too; choosing
   * Finnhub again reads the file again.
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

  /** A listed US stock left on Yahoo because Finnhub's budget is used up by the ones before it. */
  overCap(symbol) {
    const config = this.config();
    return config.on.finnhub && this.serves(finnhub, symbol, config) && this.preferences.symbols.includes(symbol)
      && !this.symbolsFor(finnhub, config).includes(symbol);
  }

  /**
   * The exchange a symbol's quote reports (Yahoo's exchangeName), else its Yahoo 奇摩股市 overlay's (a symbol
   * with a sole source has no base quote: its own quote is in that overlay slot), or null: see resolvedMarket.
   */
  exchangeOf(symbol) {
    return this.quotes[symbol]?.exchange ?? this.overlays[symbol]?.[yahootw.id]?.exchange ?? null;
  }

  /** A symbol's market: an index's from the exchange its quote reports (see exchangeOf, resolvedMarket). */
  marketFor(symbol) {
    return resolvedMarket(symbol, this.exchangeOf(symbol));
  }

  /**
   * An index still waiting for its first quote: no quote, overlay or error yet, so its market is unknown. One
   * priced without an exchange, or one that failed, is not waiting.
   */
  pendingIndex(symbol) {
    return kindOf(symbol) === "index" && !this.quotes[symbol] && !this.overlays[symbol] && !this.errors[symbol];
  }

  /**
   * What a row shows: its base quote (baseQuote) with its overlay, if any. A symbol with a sole source shows
   * its own quote over itself: the name, currency and periods are its own, and the line only its own.
   */
  shown(symbol, now = this.host.now()) {
    const pick = this.pick(symbol, now);
    const quote = mergeOverlay(this.baseQuote(symbol, now), pick?.overlay, pick && this.lines[pick.id]?.[symbol]);
    const localName = this.localNames[symbol];
    return quote && localName && !quote.localName ? { ...quote, localName } : quote;
  }

  /**
   * The source that prices `symbol` alone (Yahoo 奇摩股市 for a TW-only symbol while it is on), else null.
   * `config` is read only for a TW-only symbol, since this is asked for every row.
   */
  soleSource(symbol, config) {
    if (!this.twOnly.has(symbol)) return null;
    return (config ?? this.config()).on[yahootw.id] ? yahootw : null;
  }

  /**
   * What a row is built on. With a sole source: that source's own quote, read by the trading periods ownPeriods
   * gives it. Otherwise the base quote. Either one, kept through a failure or a missing row, is marked `cached`,
   * so freshness ages it to now, never by its last good fetch.
   */
  baseQuote(symbol, now = this.host.now()) {
    const sole = this.soleSource(symbol);
    if (sole) {
      const own = this.overlays[symbol]?.[sole.id];
      const quote = own && { ...own, periods: ownPeriods(own, this.linePeriods[symbol] ?? null, now) };
      return quote && this.errors[symbol] ? { ...quote, cached: true } : quote;
    }
    const quote = this.quotes[symbol];
    return quote && this.errors[symbol] ? { ...quote, cached: true } : quote;
  }

  pick(symbol, now) {
    return pickOverlay(this.overlays[symbol] ?? {}, OVERLAY_ORDER, now, this.quotes[symbol]);
  }

  /**
   * Why a symbol has no live overlay: the first overlay source's error, in priority order; null while a
   * live one shows. A stale one shown still gets the reason a source before it has none. A symbol's sole
   * source never writes one: with no base to fall back to, its row's own error says why.
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

  /** A round the person asked for (Refresh) is running; automatic rounds do not count. */
  get refreshing() {
    return Object.values(this.sources).some((state) => state.loading && state.refreshing);
  }

  /**
   * One entry per provider that has a problem now (rate limited, unreachable, timed out, refused),
   * or that is chosen but cannot run (consent to confirm again). `stopped: true` marks a source that
   * makes no request until its settings change (a notice, or a refusal that disabled it), so the
   * settings dialog reads that from here instead of from a list of codes.
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

  // Edits are synchronous (the store is Herdr's shared state) and return a short notice,
  // `{ code, params }`, for the view to translate. A change that returns null changed nothing: no save.
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
    // The symbol went to the top, so a US stock Finnhub priced before may have lost its place under the
    // cap. With Finnhub off, or a symbol Finnhub does not price, both lists are the same.
    const kept = new Set(this.symbolsFor(finnhub, config));
    const pushed = this.symbolsFor(finnhub, config, before).find((s) => !kept.has(s));
    return pushed ? notice("notice.overCapPushed", { symbol, pushed, cap }) : message;
  }

  // A removal's notice carries `undo`, the symbol and its place in the list as saved before it, for
  // `restore`; any later notice replaces it, which ends the Undo.
  remove(symbol) {
    return this.edit((p) => {
      const index = p.symbols.indexOf(symbol);
      if (index < 0) return notice("notice.notListed", { symbol });
      p.symbols.splice(index, 1);
      return { ...notice("notice.removed", { symbol }), undo: { symbol, index } };
    });
  }

  // Puts a removed symbol back at `index` (splice puts it at the end when the list has grown shorter since). Null, and
  // nothing saved, when it is listed again already (another copy added it).
  restore(symbol, index) {
    return this.edit((p) => {
      if (p.symbols.includes(symbol)) return null;
      p.symbols.splice(index, 0, symbol);
      return notice("notice.restored", { symbol });
    });
  }

  /**
   * Moves `symbol` before `beforeSymbol` (null: to the end), judged against the list as saved now,
   * so a drop in a copy that has not synced yet still lands beside the symbol it was dropped on.
   * Null, and nothing saved, when either symbol is gone or the order would stay.
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
   * One round of every source now, also while paused; a source's cooldown still holds. A source on
   * a request budget (Finnhub) keeps its own pace. A source already in a round joins it (the round
   * counts as asked for) instead of queuing another, so a second click costs no extra request.
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
   * Starts the round a hidden copy skipped, at once, in each source that skipped one (the main view
   * calls it on render, which is when a hidden docked copy is shown again). A source that missed
   * nothing keeps its own pace, so a render never starts a round by itself. A copy still judged hidden
   * wakes nothing: it can render anyway (a second card block, a stack with no active child), and each
   * wake would mark the round missed again and redraw, in a loop.
   */
  wakeMissed() {
    // Most renders find nothing missed: then shown(), which reads the layout for a docked copy, is not asked.
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

  /**
   * Picks up another copy's edit of the shared list, or a saved source address, at once
   * (the main view calls it on render).
   */
  sync() {
    const preferences = readPreferences(this.host.load());
    const configKey = JSON.stringify(this.config());
    if (JSON.stringify(preferences) === JSON.stringify(this.preferences) && configKey === this.configKey) return false;
    const configChanged = configKey !== this.configKey;
    this.configKey = configKey;
    this.adoptAndRestart(preferences, configChanged);
    return true;
  }

  /** What the loops act on: whether paused, and the symbols each provider quotes (order does not matter). */
  loopKey() {
    return JSON.stringify([this.preferences.paused, this.symbolLists(PROVIDERS).map((symbols) => [...symbols].sort())]);
  }

  /** The symbols each of `providers` quotes (see symbolsFor), in that order. */
  symbolLists(providers) {
    const config = this.config();
    return providers.map((provider) => this.symbolsFor(provider, config));
  }

  /**
   * Takes `preferences` as the list and starts new rounds only when something the loops act on
   * changed (or `restart`): a pure reorder leaves the rounds in flight alone.
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
    // Yahoo 奇摩股市 off: every TW-only symbol goes back to Yahoo Finance, so turning it on again starts over.
    // Until Yahoo Finance answers again (paused, or backing off), the row says what it last said: not found.
    if (!config.on[yahootw.id]) {
      for (const symbol of this.twOnly) if (keep.has(symbol)) this.errors[symbol] = notice("yahoo.notFound");
      this.twOnly.clear();
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
      for (const symbol of [this.overlays, this.overlayErrors, this.lines[provider.id] ?? {}].flatMap(Object.keys)) {
        if (symbols.has(symbol)) continue;
        this.dropOverlay(provider, symbol);
        this.setEntry(this.overlayErrors, symbol, provider.id, undefined);
      }
    }
    for (const symbol of Object.keys(this.localNames)) if (!covered.has(symbol)) delete this.localNames[symbol];
  }

  /**
   * Whether `provider` prices `symbol`: it declares the symbol's market (an index's from its quote's exchange,
   * see resolvedMarket) and its kind. A symbol with a sole source (in `config`) is priced by that source alone,
   * whatever its market reads.
   */
  serves(provider, symbol, config) {
    const sole = this.soleSource(symbol, config);
    if (sole) return provider === sole;
    const kind = kindOf(symbol);
    // Only an index's market needs its quote's exchange.
    return provider.kinds.includes(kind) && provider.markets.includes(kind === "index" ? this.marketFor(symbol) : marketOf(symbol));
  }

  /**
   * The listed symbols (or those of `list`) a provider quotes, up to its cap; none for an overlay source
   * that is off.
   */
  symbolsFor(provider, config = this.config(), list = this.preferences.symbols) {
    if (provider.overlay && !config.on[provider.id]) return [];
    const symbols = list.filter((symbol) => this.serves(provider, symbol, config));
    return provider.cap ? symbols.slice(0, Math.max(0, provider.cap(config))) : symbols;
  }

  /**
   * The busiest session among `symbols`: open > unknown (no quote yet) > lunch > pre/post > closed. Read from the
   * base quotes (baseQuote: an overlay keeps the base's trading periods). A symbol with a sole source and
   * nothing to show (no source knows it) counts as closed, so it is never polled every 10 s.
   */
  sessionFor(symbols, now) {
    let best = "closed";
    for (const symbol of symbols) {
      const quote = this.baseQuote(symbol, now);
      const session = quote ? sessionOf(quote, now) : this.soleSource(symbol) ? "closed" : "unknown";
      if (SESSION_RANK[session] > SESSION_RANK[best]) best = session === "24h" ? "open" : session;
    }
    return symbols.length ? best : "unknown";
  }

  /**
   * How long until the first of `symbols`' shown quotes turns stale, each at its own moment (msUntilStale);
   * at most LIVE_MAX_AGE_MS, also when none ever does. A quote that cannot turn stale in its session is
   * skipped: inside a lunch window its age stands still, also after a half day's close, and the cap wakes the
   * loop for the reopening or for the trading hours a delayed quote has not been given yet.
   */
  staleInMs(symbols, now) {
    let wait = LIVE_MAX_AGE_MS;
    for (const symbol of symbols) {
      const quote = this.shown(symbol, now);
      const left = quote ? msUntilStale(quote, sessionOf(quote, now), now) : null;
      if (left !== null && left > 0 && left < wait) wait = left;
    }
    return wait;
  }

  /**
   * One provider's loop, until stop(). Each round starts the provider's interval after the
   * previous one ends (or when its cooldown ends, if later); an edit starts one at once.
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
        // Another copy may have edited the shared list.
        this.adopt(readPreferences(this.host.load()));
        this.configKey = JSON.stringify(this.config());
        symbols = this.symbolsFor(provider);
        if (!symbols.length) {
          state.problem = null;
          state.lineFailures = {};
          state.noLive = null;
        }
        // A hidden copy never renders (so nothing else tells it), but its loops run: it asks here. A round
        // it skips is marked missed, and it waits as idle until wakeMissed() on the render that shows
        // the copy again.
        hidden = !this.isShown();
        const due = symbols.length && !state.disabled && (manual || !this.preferences.paused);
        state.missed = hidden && Boolean(due);
        if (due && !hidden) {
          state.refreshing = manual;
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
      const due = now + (idle ? 0 : Math.max(provider.intervalMs(this.sessionFor(symbols, now)), state.retryAt - now));
      await this.rest(state, symbols, due, io);
    }
  }

  /**
   * Sleeps until `due` (an idle loop: until a shown price turns stale), or until poked. A long wait,
   * such as a rate-limit cooldown, is cut where a shown price turns stale: that wake only redraws.
   */
  async rest(state, symbols, due, io) {
    for (;;) {
      const now = this.host.now();
      const stale = this.staleInMs(symbols, now);
      const wait = due > now ? Math.min(due - now, stale) : stale;
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
    // A cooldown holds, also for Refresh.
    if (this.host.now() < state.retryAt) return;
    const config = this.config();
    const configKey = JSON.stringify(config);
    // A new address asks every line again.
    if (state.configKey !== configKey) { state.configKey = configKey; state.linesAt = {}; }
    // Only Finnhub's requests carry the key; no other source is ever handed it. The symbols Yahoo 奇摩股市 prices
    // alone go to its requests only, never to config(): a change there would make sync() restart every round.
    const asked = provider === finnhub ? { ...config, finnhubKey: this.finnhubKey }
      : provider === yahootw ? { ...config, twOnly: symbols.filter((s) => this.soleSource(s, config) === yahootw) } : config;
    const requests = provider.requests(symbols, asked);
    const quoteCount = requests.filter((request) => request.kind === "quote").length;
    const spacing = provider.spacingMs(quoteCount, provider.intervalMs(this.sessionFor(symbols, this.host.now())));
    let problem = null;
    let live = false;
    let noLive = null;
    // A provider with `linesPerRound` lists its lines after its prices: this loop sends the prices, and
    // the due lines are picked once they are in. Any other provider's requests go out as listed.
    const listed = provider.linesPerRound ? quoteCount : requests.length;
    state.loading = true;
    io.changed();
    try {
      for (let index = 0; index < listed; index++) {
        if (!current()) return;
        const request = requests[index];
        if (request.kind === "line") {
          const failed = await this.line(provider, state, request, io, current);
          if (this.endsRound(provider, failed)) { this.endOnLine(provider, state, requests, index, failed); return; }
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
        if (this.endsRound(provider, failed)) { this.endOnLine(provider, state, requests, requests.indexOf(request), failed); return; }
        if (!current()) return;
        // A failure of the source itself (an HTTP error, an unreadable answer) shows, as a price's would.
        // A line is asked only every `linesMs`, so it stays shown through the rounds between, until
        // that symbol's next line comes in; otherwise a line that always fails would blink.
        if (failed && SOURCE_FAILURE.test(failed.code)) state.lineFailures[request.symbols[0]] = failed;
        else delete state.lineFailures[request.symbols[0]];
      }
      if (!current()) return;
      // A symbol no longer priced by this source (removed, or its price gone) is not asked for a line
      // again, so its failure goes.
      for (const symbol of Object.keys(state.lineFailures)) if (!this.priced(provider, symbol)) delete state.lineFailures[symbol];
      // An answer that prices nothing live while the market is open is shown, or the person sees only
      // delayed rows with no word why; it stays until an answer prices a row again.
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

  /**
   * The line requests a round sends of `requests`: those that are due (lineDue), longest-waiting first
   * (never asked counts as longest), at most `linesPerRound`.
   */
  dueLines(provider, state, requests) {
    const now = this.host.now();
    const askedAt = (request) => state.linesAt[request.symbols[0]] ?? 0;
    return requests
      .filter((request) => request.kind === "line" && this.lineDue(provider, state, request.symbols[0], now))
      .sort((a, b) => askedAt(a) - askedAt(b))
      .slice(0, provider.linesPerRound);
  }

  /**
   * A symbol's line is due: the symbol has this provider's price and its line waited `linesMs`. After the
   * close, a line already held for its price's day is the whole day: it is not asked again.
   */
  lineDue(provider, state, symbol, now) {
    const priced = this.priced(provider, symbol);
    if (!priced) return false;
    const session = this.sessionFor([symbol], now);
    const line = this.lines[provider.id]?.[symbol];
    if ((session === "closed" || session === "post") && line && line.day === priced.day) return false;
    return now - (state.linesAt[symbol] ?? -Infinity) >= provider.linesMs(session);
  }

  // What a line is drawn beside: this provider's overlay (for a symbol it prices alone, its own quote), or the base quote.
  priced(provider, symbol) {
    return provider.overlay ? this.overlays[symbol]?.[provider.id] : this.quotes[symbol];
  }

  // A line's error ends the round when the source rate limited it or, for a provider with
  // `linesPerRound` (its lines come after all its prices), when it is down or hung, so the next price
  // round is not held up by more line timeouts.
  endsRound(provider, error) {
    if (!error) return false;
    return error.retryAfterMs !== undefined || (Boolean(provider.linesPerRound) && SOURCE_DOWN.test(error.code));
  }

  // A line that ends the round. Rate limited: the source backs off. Down or hung: its prices are in, so
  // a backoff ends as after a clean round, and the round ends with the problem shown.
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

  // Back off this provider only: at least a minute, doubling up to 15 minutes; the rest of the
  // round's quote requests are deferred. A rate-limited line of an overlay source defers all its
  // prices, sent or not, so its rows fall to the next source (one it prices alone keeps its price, cached).
  backOff(provider, state, requests, index, limited) {
    state.failures++;
    const backoff = Math.min(900_000, 60_000 * 2 ** Math.min(state.failures - 1, 4));
    state.retryAt = this.host.now() + Math.max(backoff, limited.retryAfterMs);
    state.problem = coded(limited);
    const from = provider.overlay && requests[index].kind === "line" ? -1 : index;
    this.failRest(provider, requests, from, notice("request.deferred", { source: provider.id }));
  }

  apply(provider, request, result) {
    if (provider.overlay) {
      // A name can come without a price (before the open): remember it all the same.
      for (const symbol of request.symbols) if (result.names?.[symbol]) this.localNames[symbol] = result.names[symbol];
      // Only this answer's prices are laid over the base: a symbol without one shows the base at once.
      for (const symbol of request.symbols) {
        const overlay = result.quotes[symbol];
        const error = result.errors[symbol] ? coded(result.errors[symbol]) : undefined;
        if (this.soleSource(symbol) === provider) {
          // A symbol this source prices alone has no base, so it keeps its last price and line, as a base quote
          // does, and its own row says why: nothing once its source prices or names it, else a failure as itself,
          // never as not found, else not found (by this source once it priced it, so the kept price reads cached).
          const priced = this.overlays[symbol]?.[provider.id];
          if (overlay) this.setEntry(this.overlays, symbol, provider.id, overlay);
          if (overlay || result.names?.[symbol]) delete this.errors[symbol];
          else this.errors[symbol] = error ?? notice(priced ? "yahootw.notFound" : "yahoo.notFound");
          continue;
        }
        if (overlay) this.setEntry(this.overlays, symbol, provider.id, overlay);
        else this.dropOverlay(provider, symbol);
        this.setEntry(this.overlayErrors, symbol, provider.id, overlay ? undefined : error);
      }
      return;
    }
    // Only an index's exchange, or its TW-only mark, can hand a symbol to another source.
    const routes = request.symbols.some((symbol) => kindOf(symbol) === "index");
    const before = routes ? this.overlaySymbols() : null;
    for (const [symbol, quote] of Object.entries(result.quotes)) {
      // A source with its own line requests keeps the last line until a new one arrives.
      if (provider.linesMs) quote.series = this.quotes[symbol]?.series ?? [];
      this.quotes[symbol] = quote;
      delete this.errors[symbol];
    }
    const yahootwOn = this.config().on[yahootw.id];
    for (const [symbol, error] of Object.entries(result.errors)) {
      this.errors[symbol] = coded(error);
      // A Taiwan index Yahoo Finance does not know may be Yahoo 奇摩股市's alone; the error stays until it is priced.
      // A TW-only row keeps nothing of a quote Yahoo Finance gave before; a Yahoo 奇摩股市 overlay already held
      // stays, as the symbol's own quote.
      if (error.code === "yahoo.notFound" && isTaiwanForm(symbol) && yahootwOn) {
        this.twOnly.add(symbol);
        delete this.linePeriods[symbol];
        delete this.quotes[symbol];
        this.setEntry(this.overlayErrors, symbol, yahootw.id, undefined);
      }
    }
    if (routes) this.wakeResolved(before);
  }

  /** Each overlay source's symbols, in OVERLAYS order: what `wakeResolved` compares. */
  overlaySymbols() {
    return this.symbolLists(OVERLAYS).map((symbols) => symbols.join(","));
  }

  /**
   * A base answer that named an index's exchange can hand the index to an overlay source (`before`:
   * overlaySymbols() from before the answer): each source whose symbols changed rounds again now, not after its
   * idle wait; one in a round adds a round after it. Never restart(): that would drop the rounds in flight,
   * this base one too.
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

  // Sets one provider's entry in a per-symbol record (undefined clears it), dropping a symbol left empty.
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

  // A symbol whose request was not answered: a base quote stays, marked cached, and so does the quote of a symbol
  // this source prices alone, which has no base; an overlay goes.
  fail(provider, symbol, error) {
    if (!provider.overlay || this.soleSource(symbol) === provider) { this.errors[symbol] = error; return; }
    this.dropOverlay(provider, symbol);
    this.setEntry(this.overlayErrors, symbol, provider.id, error);
  }

  // An overlay's line goes with its price, so a line is never drawn with a later price it did not end at.
  dropOverlay(provider, symbol) {
    this.setEntry(this.overlays, symbol, provider.id, undefined);
    if (this.lines[provider.id]) delete this.lines[provider.id][symbol];
  }

  /** One quote request; when one unknown symbol fails a whole batch, ask symbol by symbol. */
  async quote(provider, request, io, current, config) {
    const batch = await this.ask(provider, request, io, current);
    if (!batch || request.symbols.length < 2 || !request.symbols.every((symbol) => batch.errors[symbol]?.invalidSymbol)) return batch;
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
   * A symbol's line, at most once per `linesMs`, while the symbol has a quote from this provider. A
   * base provider writes the base quote's line and a failure leaves it as it was; an overlay provider
   * keeps its own line beside its price, and an answer without one (a failure, or no point from today)
   * drops it. So does a line whose last minute ends well before its price's own last trade: a frozen
   * answer (such as a cached one from earlier in the day) would be drawn as live with only its tail
   * moving. A quiet stock's line ends at its last trade, so it stays. Checked as the line arrives, not
   * at each price: a busy stock trades on while its line waits up to `linesMs` for the next request.
   * A symbol this source prices alone keeps the answer's trading periods, line or not; known ones are never
   * dropped. Returns the request's error for the symbol, if any (endsRound says what it does to the round).
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
    const frozen = kept && provider.overlay && line && line.lastAt + MINUTE_MS < kept.tradeTime - LINE_LAG_MS;
    if (kept && provider.overlay && line && !frozen) (this.lines[provider.id] ??= {})[symbol] = line;
    else if (kept && provider.overlay) delete this.lines[provider.id]?.[symbol];
    else if (kept && line) this.quotes[symbol].series = line;
    return result?.errors?.[symbol] ?? null;
  }

  async get(request) {
    const response = await this.host.fetch(request.url, request.headers);
    // `url`: where the answer came from after any redirect.
    return { status: response.status, ok: response.ok, url: response.url, text: await response.text() };
  }

  /**
   * One request, decoded; null once the round is stale. A request that does not answer within
   * REQUEST_TIMEOUT_MS gets `request.timeout` and its late answer is dropped; a network failure
   * (or a decoder bug) becomes the provider's `unreachable` error, for each of its symbols.
   */
  async ask(provider, request, io, current) {
    const timeout = io.sleep(REQUEST_TIMEOUT_MS).then(() => TIMED_OUT);
    try {
      const response = await Promise.race([this.get(request), timeout]);
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
