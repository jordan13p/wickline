// The watchlist and its refresh loops, one per provider. Herdr's APIs come in through `host`
// and each loop's `io`, so tests drive it under Node with a fake clock and network.
import { QuoteError, STARTER_SYMBOLS, normalizeSymbol } from "./quotes.js";
import { sessionOf } from "./freshness.js";
import { marketOf } from "./markets.js";
import { binance } from "./providers/binance.js";
import { readSettings } from "./settings.js";
import { yahoo } from "./providers/yahoo.js";

// The watchlist lives in Herdr's shared state (persisted), so every copy sees one list.
export const WATCHLIST_KEY = "bellwether.watchlist.v1";
// Herdr's fetch cannot be aborted: a request that has not answered by then counts as failed.
export const REQUEST_TIMEOUT_MS = 10_000;
// Started in this order, so their first requests go out in this order too.
const PROVIDERS = [binance, yahoo];
// A provider refreshes at the pace of its busiest symbol; a pair's "24h" counts as open.
const SESSION_RANK = { open: 3, "24h": 3, unknown: 2, pre: 1, post: 1, closed: 0 };
// Errors about the source itself, not one symbol: shown as the source's problem.
const SOURCE_FAILURE = /\.(unreachable|timeout|rateLimited|region|http|unreadable)$/;
const TIMED_OUT = {};

const notice = (code, params = {}) => ({ code, params });
const coded = (error) => notice(error.code, error.params);

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
 *   now(): number
 * }
 * Each loop gets its own io: { sleep(ms): Promise<void>, changed(): void } (redraw).
 */
export class Watchlist {
  constructor(host) {
    this.host = host;
    this.preferences = readPreferences(host.load());
    this.configKey = JSON.stringify(this.config());
    this.quotes = {};
    // By symbol: `{ code, params }` for the view to translate.
    this.errors = {};
    this.revision = 0;
    this.stopped = false;
    // Per provider: its backoff, its current problem, its round and its own wake-up.
    this.sources = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, {
      retryAt: 0, failures: 0, disabled: false, problem: null,
      loading: false, manual: false, dirty: true, wake: null,
      lastRequestAt: -Infinity, linesAt: {}, configKey: null,
    }]));
  }

  /** What the providers are given: the saved addresses. */
  config() {
    return { binanceUrl: readSettings(this.host.settings()).sources.crypto.binanceUrl };
  }

  providerIds() {
    return PROVIDERS.map((provider) => provider.id);
  }

  get loading() {
    return Object.values(this.sources).some((state) => state.loading);
  }

  /** One entry per provider that has a problem now (rate limited, unreachable, timed out, refused). */
  problems() {
    return PROVIDERS.filter((provider) => this.sources[provider.id].problem)
      .map((provider) => ({ provider: provider.id, ...this.sources[provider.id].problem }));
  }

  // Edits are synchronous (the store is Herdr's shared state) and return a short notice,
  // `{ code, params }`, for the view to translate.
  edit(change) {
    const preferences = readPreferences(this.host.load());
    const message = change(preferences);
    this.host.save(preferences);
    this.adopt(preferences);
    this.restart();
    return message;
  }

  add(input) {
    const symbol = normalizeSymbol(input);
    return this.edit((p) => {
      if (p.symbols.includes(symbol)) return notice("notice.duplicate", { symbol });
      p.symbols.push(symbol);
      return notice("notice.added", { symbol });
    });
  }

  remove(symbol) {
    return this.edit((p) => {
      if (!p.symbols.includes(symbol)) return notice("notice.notListed", { symbol });
      p.symbols = p.symbols.filter((s) => s !== symbol);
      return notice("notice.removed", { symbol });
    });
  }

  pause(paused) {
    return this.edit((p) => {
      p.paused = paused;
      return notice(paused ? "notice.paused" : "notice.resumed");
    });
  }

  /** One round of every source now, also while paused; a source's cooldown still holds. */
  refreshNow() {
    for (const state of Object.values(this.sources)) state.manual = true;
    this.poke();
  }

  stop() {
    this.stopped = true;
    this.revision++;
    this.poke();
  }

  poke() {
    for (const state of Object.values(this.sources)) {
      const wake = state.wake;
      state.wake = null;
      wake?.();
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
  }

  symbolsFor(provider) {
    return this.preferences.symbols.filter((symbol) => provider.markets.includes(marketOf(symbol)));
  }

  /** The busiest session among `symbols`: open > unknown (no quote yet) > pre/post > closed. */
  sessionFor(symbols, now) {
    let best = "closed";
    for (const symbol of symbols) {
      const quote = this.quotes[symbol];
      const session = quote ? sessionOf(quote, now) : "unknown";
      if (SESSION_RANK[session] > SESSION_RANK[best]) best = session === "24h" ? "open" : session;
    }
    return symbols.length ? best : "unknown";
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
      const wait = Math.max(provider.intervalMs(this.sessionFor(symbols, now)), state.retryAt - now);
      await new Promise((resolve) => {
        state.wake = resolve;
        if (!idle) io.sleep(wait).then(resolve);
      });
      state.wake = null;
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
    const requests = provider.requests(symbols, config);
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
        const result = await this.quote(provider, request, io, current, config);
        if (!result) return;
        const failures = Object.values(result.errors);
        const limited = failures.find((error) => error.retryAfterMs !== undefined);
        if (!problem) problem = failures.find((error) => SOURCE_FAILURE.test(error.code)) ?? null;
        this.apply(provider, result);
        if (limited) {
          // Back off this provider only: at least a minute, doubling up to 15 minutes.
          state.failures++;
          const backoff = Math.min(900_000, 60_000 * 2 ** Math.min(state.failures - 1, 4));
          state.retryAt = this.host.now() + Math.max(backoff, limited.retryAfterMs);
          state.problem = coded(limited);
          for (const later of requests.slice(index + 1)) {
            if (later.kind !== "quote") continue;
            for (const symbol of later.symbols) this.errors[symbol] = notice("request.deferred", { source: provider.id });
          }
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

  apply(provider, result) {
    for (const [symbol, quote] of Object.entries(result.quotes)) {
      // A source with its own line requests keeps the last line until a new one arrives.
      if (provider.linesMs) quote.series = this.quotes[symbol]?.series ?? [];
      this.quotes[symbol] = quote;
      delete this.errors[symbol];
    }
    for (const [symbol, error] of Object.entries(result.errors)) this.errors[symbol] = coded(error);
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
