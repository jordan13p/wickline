// The watchlist and its refresh loops, one per provider. Herdr's APIs come in through `host`
// and each loop's `io`, so tests drive it under Node with a fake clock and network.
import { QuoteError, STARTER_SYMBOLS, normalizeSymbol } from "./quotes.js";
import { LIVE_MAX_AGE_MS, sessionOf } from "./freshness.js";
import { marketOf } from "./markets.js";
import { binance } from "./providers/binance.js";
import { finnhub, finnhubCap } from "./providers/finnhub.js";
import { mis } from "./providers/mis.js";
import { SECRET_KEY_FINNHUB, finnhubChosen, misEnabled, misReconfirm, readSettings } from "./settings.js";
import { yahoo } from "./providers/yahoo.js";

// The watchlist lives in Herdr's shared state (persisted), so every copy sees one list.
export const WATCHLIST_KEY = "bellwether.watchlist.v1";
// Herdr's fetch cannot be aborted: a request that has not answered by then counts as failed.
export const REQUEST_TIMEOUT_MS = 10_000;
// Started in this order, so their first requests go out in this order too.
const PROVIDERS = [binance, mis, finnhub, yahoo];
// Overlay sources the person turns on in Settings: whether each is on now (given this watchlist, which
// holds the key read from the secrets file), what its card and status line say while it is chosen but
// cannot run, and, for a source that can refuse the key, the settings whose change lets it try again.
const SWITCHES = {
  mis: { on: misEnabled, notice: (settings) => (misReconfirm(settings) ? "mis.reconfirm" : null) },
  finnhub: {
    on: (settings, w) => finnhubChosen(settings) && Boolean(w.finnhubKey),
    // Only once this copy has read the key file for the saved keyRev.
    notice: (settings, w) => {
      if (!finnhubChosen(settings) || w.keyRev !== settings.keyRev) return null;
      if (w.keyUnreadable) return "finnhub.secretUnreadable";
      return w.finnhubKey ? null : "finnhub.noKey";
    },
    retryOn: (settings) => JSON.stringify([settings.sources.us, settings.keyRev]),
  },
};
// A provider refreshes at the pace of its busiest symbol; a pair's "24h" counts as open.
const SESSION_RANK = { open: 3, "24h": 3, unknown: 2, pre: 1, post: 1, closed: 0 };
// Errors about the source itself, not one symbol: shown as the source's problem.
const SOURCE_FAILURE = /\.(unreachable|timeout|rateLimited|region|http|unreadable)$/;
// The source is down or hung: the rest of the round would only wait out more timeouts.
const SOURCE_DOWN = /\.(unreachable|timeout)$/;
const TIMED_OUT = {};

const notice = (code, params = {}) => ({ code, params });
const coded = (error) => notice(error.code, error.params);

// Ends a loop's wait now.
function wake(state) {
  const resolve = state.wake;
  state.wake = null;
  resolve?.();
}

/**
 * A real-time overlay's fields over the Yahoo base quote. The line, the trading periods, the
 * currency and the name stay the base's (the overlay's name is kept as `localName`), and
 * `chartSource` names where the line came from. Works with no base yet.
 */
export function mergeOverlay(base, overlay) {
  if (!overlay) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) if (value !== null && value !== undefined) merged[key] = value;
  const previousClose = merged.previousClose ?? null;
  return {
    ...merged,
    previousClose,
    changePercent: previousClose > 0 ? (overlay.price - previousClose) / previousClose * 100 : null,
    name: base?.name ?? null,
    localName: overlay.name ?? null,
    currency: base?.currency ?? null,
    delaySeconds: 0,
    chartDelaySeconds: base?.delaySeconds ?? null,
    series: base?.series ?? [],
    periods: base?.periods ?? null,
    chartSource: base?.source ?? null,
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
 * }
 * Each loop gets its own io: { sleep(ms): Promise<void>, changed(): void } (redraw).
 */
export class Watchlist {
  constructor(host) {
    this.host = host;
    // The Finnhub key as read from the secrets file for keyRev `keyRev` (null: not read yet). Only in
    // memory: never in the config, the shared state or an error.
    this.finnhubKey = null;
    this.keyRev = null;
    this.keyUnreadable = false;
    this.preferences = readPreferences(host.load());
    this.configKey = JSON.stringify(this.config());
    // By symbol: the base quote (Yahoo for stocks, Binance for pairs) and a real-time overlay over it.
    this.quotes = {};
    this.overlays = {};
    // By symbol: the last name an overlay gave (MIS's Chinese name), kept while that source fails.
    this.localNames = {};
    // By symbol: `{ code, params }` for the view to translate; an overlay's own errors apart, since
    // its symbol still has the base quote.
    this.errors = {};
    this.overlayErrors = {};
    this.revision = 0;
    this.stopped = false;
    // Per provider: its backoff, its current problem, its round and its own wake-up.
    this.sources = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, {
      retryAt: 0, failures: 0, disabled: false, problem: null,
      loading: false, manual: false, dirty: true, wake: null,
      lastRequestAt: -Infinity, linesAt: {}, configKey: null, disabledFor: null,
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
      on: Object.fromEntries(Object.entries(SWITCHES).map(([id, { on }]) => [id, on(settings, this)])),
    };
  }

  /** Reads the Finnhub key again when Finnhub is chosen and keyRev changed; a broken file is no key. */
  async loadKey(settings) {
    if (!finnhubChosen(settings) || this.keyRev === settings.keyRev) return;
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

  /** The US symbols Finnhub prices: the first `finnhubCap(budget)` in list order. */
  finnhubSymbols() {
    return this.symbolsFor(finnhub);
  }

  /** A listed US symbol left on Yahoo because Finnhub's budget is used up by the ones before it. */
  overCap(symbol) {
    const config = this.config();
    return config.on.finnhub && marketOf(symbol) === "us" && this.preferences.symbols.includes(symbol)
      && !this.symbolsFor(finnhub, config).includes(symbol);
  }

  /** What a row shows: the base quote with its overlay, if any. */
  shown(symbol) {
    const quote = mergeOverlay(this.quotes[symbol], this.overlays[symbol]);
    const localName = this.localNames[symbol];
    return quote && localName && !quote.localName ? { ...quote, localName } : quote;
  }

  providerIds() {
    return PROVIDERS.map((provider) => provider.id);
  }

  get loading() {
    return Object.values(this.sources).some((state) => state.loading);
  }

  /**
   * One entry per provider that has a problem now (rate limited, unreachable, timed out, refused),
   * or that is chosen but cannot run (consent to confirm again).
   */
  problems() {
    const settings = readSettings(this.host.settings());
    return PROVIDERS.flatMap((provider) => {
      const code = SWITCHES[provider.id]?.notice(settings, this);
      const problem = code ? notice(code) : this.sources[provider.id].problem;
      return problem ? [{ provider: provider.id, ...problem }] : [];
    });
  }

  // Edits are synchronous (the store is Herdr's shared state) and return a short notice,
  // `{ code, params }`, for the view to translate. A change that returns null changed nothing: no save.
  edit(change) {
    const preferences = readPreferences(this.host.load());
    const message = change(preferences);
    if (message === null) return null;
    this.host.save(preferences);
    this.adopt(preferences);
    this.restart();
    return message;
  }

  add(input) {
    const symbol = normalizeSymbol(input);
    const message = this.edit((p) => {
      if (p.symbols.includes(symbol)) return notice("notice.duplicate", { symbol });
      p.symbols.push(symbol);
      return notice("notice.added", { symbol });
    });
    if (message.code !== "notice.added" || !this.overCap(symbol)) return message;
    return notice("notice.overCap", { symbol, cap: finnhubCap(this.config().budgetPerMinute) });
  }

  remove(symbol) {
    return this.edit((p) => {
      if (!p.symbols.includes(symbol)) return notice("notice.notListed", { symbol });
      p.symbols = p.symbols.filter((s) => s !== symbol);
      return notice("notice.removed", { symbol });
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
   * a request budget (Finnhub) keeps its own pace.
   */
  refreshNow() {
    for (const provider of PROVIDERS) {
      if (provider.manualRefresh === false) continue;
      const state = this.sources[provider.id];
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
    this.configKey = configKey;
    this.adopt(preferences);
    this.restart();
    return true;
  }

  adopt(preferences) {
    this.preferences = preferences;
    const keep = new Set(preferences.symbols);
    for (const record of [this.quotes, this.errors]) {
      for (const key of Object.keys(record)) if (!keep.has(key)) delete record[key];
    }
    // An overlay goes as soon as its source no longer covers the symbol (removed, or turned off).
    const config = this.config();
    const covered = new Set(PROVIDERS.filter((provider) => provider.overlay).flatMap((provider) => this.symbolsFor(provider, config)));
    for (const record of [this.overlays, this.overlayErrors, this.localNames]) {
      for (const key of Object.keys(record)) if (!covered.has(key)) delete record[key];
    }
  }

  /** The listed symbols a provider quotes, up to its cap; none for an overlay source that is off. */
  symbolsFor(provider, config = this.config()) {
    if (provider.overlay && !config.on[provider.id]) return [];
    const symbols = this.preferences.symbols.filter((symbol) => provider.markets.includes(marketOf(symbol)));
    return provider.cap ? symbols.slice(0, Math.max(0, provider.cap(config))) : symbols;
  }

  /** The busiest session among `symbols`: open > unknown (no quote yet) > pre/post > closed. */
  sessionFor(symbols, now) {
    let best = "closed";
    for (const symbol of symbols) {
      const quote = this.shown(symbol);
      const session = quote ? sessionOf(quote, now) : "unknown";
      if (SESSION_RANK[session] > SESSION_RANK[best]) best = session === "24h" ? "open" : session;
    }
    return symbols.length ? best : "unknown";
  }

  /** How long until the newest of `symbols`' quotes is older than LIVE_MAX_AGE_MS (at most that). */
  staleInMs(symbols, now) {
    let wait = LIVE_MAX_AGE_MS;
    for (const symbol of symbols) {
      const quote = this.shown(symbol);
      const left = quote ? quote.timestamp + LIVE_MAX_AGE_MS + 1 - now : 0;
      if (left > 0 && left < wait) wait = left;
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
      const symbols = this.symbolsFor(provider);
      if (!symbols.length) state.problem = null;
      const { paused } = this.preferences;
      if (symbols.length && !state.disabled && (manual || !paused)) await this.round(provider, state, symbols, io);
      if (this.stopped) return;
      io.changed();
      if (state.manual || state.dirty) continue;
      const idle = paused || !symbols.length || state.disabled;
      const now = this.host.now();
      const due = now + (idle ? 0 : Math.max(provider.intervalMs(this.sessionFor(symbols, now)), state.retryAt - now));
      await this.rest(state, symbols, due, io);
    }
  }

  /**
   * Sleeps until `due` (an idle loop: until a live price turns stale), or until poked. A long wait,
   * such as a rate-limit cooldown, is cut where a live price turns stale: that wake only redraws.
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
    // Only the requests carry the key.
    const asked = { ...config, finnhubKey: this.finnhubKey };
    const requests = provider.requests(symbols, asked);
    const quoteCount = requests.filter((request) => request.kind === "quote").length;
    const spacing = provider.spacingMs(quoteCount, provider.intervalMs(this.sessionFor(symbols, this.host.now())));
    let problem = null;
    state.loading = true;
    io.changed();
    try {
      for (const [index, request] of requests.entries()) {
        if (!current()) return;
        if (request.kind === "line") { await this.line(provider, state, request, io, current); continue; }
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
          // Back off this provider only: at least a minute, doubling up to 15 minutes.
          state.failures++;
          const backoff = Math.min(900_000, 60_000 * 2 ** Math.min(state.failures - 1, 4));
          state.retryAt = this.host.now() + Math.max(backoff, limited.retryAfterMs);
          state.problem = coded(limited);
          this.failRest(provider, requests, index, notice("request.deferred", { source: provider.id }));
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
      if (!current()) return;
      state.failures = 0;
      state.retryAt = 0;
      state.problem = problem && coded(problem);
    } finally {
      state.loading = false;
    }
  }

  apply(provider, request, result) {
    if (provider.overlay) {
      // Only this answer's prices are laid over the base: a symbol without one shows the base at once.
      for (const symbol of request.symbols) {
        const overlay = result.quotes[symbol];
        if (overlay) {
          this.overlays[symbol] = overlay;
          if (overlay.name) this.localNames[symbol] = overlay.name;
          delete this.overlayErrors[symbol];
          continue;
        }
        delete this.overlays[symbol];
        if (result.errors[symbol]) this.overlayErrors[symbol] = coded(result.errors[symbol]);
        else delete this.overlayErrors[symbol];
      }
      return;
    }
    for (const [symbol, quote] of Object.entries(result.quotes)) {
      // A source with its own line requests keeps the last line until a new one arrives.
      if (provider.linesMs) quote.series = this.quotes[symbol]?.series ?? [];
      this.quotes[symbol] = quote;
      delete this.errors[symbol];
    }
    for (const [symbol, error] of Object.entries(result.errors)) this.errors[symbol] = coded(error);
  }

  // The quote requests after `index`, not sent this round.
  failRest(provider, requests, index, error) {
    for (const later of requests.slice(index + 1)) {
      if (later.kind !== "quote") continue;
      for (const symbol of later.symbols) this.fail(provider, symbol, error);
    }
  }

  // A symbol whose request was not answered: a base quote stays, marked cached; an overlay goes.
  fail(provider, symbol, error) {
    if (!provider.overlay) { this.errors[symbol] = error; return; }
    delete this.overlays[symbol];
    this.overlayErrors[symbol] = error;
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

  /** A symbol's line, at most once per `linesMs`; a failure only leaves the line as it was. */
  async line(provider, state, request, io, current) {
    const [symbol] = request.symbols;
    const now = this.host.now();
    if (!this.quotes[symbol] || now - (state.linesAt[symbol] ?? -Infinity) < provider.linesMs) return;
    state.linesAt[symbol] = now;
    const series = (await this.ask(provider, request, io, current))?.lines?.[symbol];
    if (series && current() && this.quotes[symbol]) this.quotes[symbol].series = series;
  }

  async get(request) {
    const response = await this.host.fetch(request.url, request.headers);
    return { status: response.status, ok: response.ok, text: await response.text() };
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
