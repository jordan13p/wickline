// The watchlist and its refresh loop. Herdr's APIs come in through `host`,
// so tests drive it under Node with a fake clock and network.
import { QuoteError, STARTER_SYMBOLS, isCryptoPair, normalizeSymbol } from "./quotes.js";
import { binance } from "./providers/binance.js";
import { yahoo } from "./providers/yahoo.js";

// The watchlist lives in Herdr's shared state (persisted), so every copy sees one list.
export const WATCHLIST_KEY = "bellwether.watchlist.v1";
export const INTERVAL_MS = 60_000;

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
 *   fetch(url, headers): Promise<{ status, ok, text() }>  // GET with the request's headers; hosts in providers/
 *   now(): number, sleep(ms): Promise<void>
 *   changed(): void                                    // redraw, from the loop only
 * }
 */
export class Watchlist {
  constructor(host, intervalMs = INTERVAL_MS) {
    this.host = host;
    this.intervalMs = intervalMs;
    this.preferences = readPreferences(host.load());
    this.quotes = {};
    this.errors = {};
    this.message = "";
    this.loading = false;
    this.retryAt = 0;
    this.rateFailures = 0;
    this.revision = 0;
    this.stopped = false;
    this.manual = false;
    this.dirty = true;
    this.lastYahooAt = -Infinity;
    this.wake = null;
  }

  // Edits are synchronous (the store is Herdr's shared state) and return a short notice.
  edit(change) {
    const preferences = readPreferences(this.host.load());
    const message = change(preferences);
    this.host.save(preferences);
    this.adopt(preferences);
    this.revision++;
    this.dirty = true;
    this.poke();
    return message;
  }

  add(input) {
    const symbol = normalizeSymbol(input);
    return this.edit((p) => {
      if (p.symbols.includes(symbol)) return `${symbol} is already on your watchlist.`;
      p.symbols.push(symbol);
      return `Added ${symbol}.`;
    });
  }

  remove(symbol) {
    return this.edit((p) => {
      if (!p.symbols.includes(symbol)) return `${symbol} is not on your watchlist.`;
      p.symbols = p.symbols.filter((s) => s !== symbol);
      return `Removed ${symbol}.`;
    });
  }

  pause(paused) {
    return this.edit((p) => {
      p.paused = paused;
      return paused ? "Automatic refresh paused." : "Automatic refresh resumed.";
    });
  }

  /** One round now, also while paused; a Yahoo cooldown still holds for stocks. */
  refreshNow() {
    this.manual = true;
    this.poke();
  }

  stop() {
    this.stopped = true;
    this.revision++;
    this.poke();
  }

  poke() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Picks up another copy's edit of the shared list at once (the main view calls it on render). */
  sync() {
    const preferences = readPreferences(this.host.load());
    if (JSON.stringify(preferences) === JSON.stringify(this.preferences)) return false;
    this.adopt(preferences);
    this.revision++;
    this.dirty = true;
    this.poke();
    return true;
  }

  adopt(preferences) {
    this.preferences = preferences;
    const keep = new Set(preferences.symbols);
    for (const record of [this.quotes, this.errors]) {
      for (const key of Object.keys(record)) if (!keep.has(key)) delete record[key];
    }
  }

  /** Runs until stop(). Each round starts the interval after the previous one ends. */
  async run() {
    while (!this.stopped) {
      const manual = this.manual;
      this.manual = false;
      this.dirty = false;
      // Another copy may have edited the shared list.
      this.adopt(readPreferences(this.host.load()));
      const due = manual || (!this.preferences.paused && this.preferences.symbols.length > 0);
      if (due) await this.round(manual);
      if (this.stopped) return;
      this.host.changed();
      if (this.manual || this.dirty) continue;
      const idle = this.preferences.paused || !this.preferences.symbols.length;
      await new Promise((resolve) => {
        this.wake = resolve;
        if (!idle) this.host.sleep(this.intervalMs).then(resolve);
      });
      this.wake = null;
    }
  }

  async round(manual) {
    const revision = this.revision;
    const current = () => !this.stopped && revision === this.revision;
    const symbols = this.preferences.symbols;
    this.loading = true;
    this.message = "";
    this.host.changed();
    try {
      // Each quote batch comes with the line requests for its pairs.
      const crypto = binance.requests(symbols.filter(isCryptoPair), {});
      for (let i = 0; i < crypto.length && current();) {
        const quote = crypto[i++];
        const lines = [];
        while (i < crypto.length && crypto[i].kind === "line") lines.push(crypto[i++]);
        await this.crypto(quote, lines, current);
      }
      const requests = yahoo.requests(symbols.filter((s) => !isCryptoPair(s)), {});
      if (!requests.length || !current()) return;
      if (this.host.now() < this.retryAt) {
        // Pairs keep their cadence through a Yahoo cooldown; stocks wait it out.
        this.message = `Yahoo rate limited requests. Retry after ${Math.ceil((this.retryAt - this.host.now()) / 1000)}s.`;
        return;
      }
      const spacing = yahoo.spacingMs(requests.length, this.intervalMs);
      for (const [index, request] of requests.entries()) {
        const wait = spacing - (this.host.now() - this.lastYahooAt);
        if (wait > 0) await this.host.sleep(wait);
        if (!current()) return;
        this.lastYahooAt = this.host.now();
        const [symbol] = request.symbols;
        const result = await this.ask(yahoo, request, current, "yahoo.unreachable");
        if (!result) return;
        const error = result.errors[symbol];
        if (!error) {
          this.quotes[symbol] = result.quotes[symbol];
          delete this.errors[symbol];
        } else {
          this.errors[symbol] = error.message;
          if (error.retryAfterMs !== undefined) {
            this.rateFailures++;
            const backoff = Math.min(900_000, 60_000 * 2 ** Math.min(this.rateFailures - 1, 4));
            this.retryAt = this.host.now() + Math.max(backoff, error.retryAfterMs);
            this.message = "Yahoo rate limited requests. Automatic retries are delayed.";
            const deferred = new QuoteError("yahoo.deferred").message;
            for (const later of requests.slice(index + 1)) this.errors[later.symbols[0]] = deferred;
            return;
          }
        }
        this.host.changed();
      }
      if (current()) { this.rateFailures = 0; this.retryAt = 0; }
    } finally {
      this.loading = false;
    }
  }

  async get(request) {
    const response = await this.host.fetch(request.url, request.headers);
    return { status: response.status, ok: response.ok, text: await response.text() };
  }

  /**
   * One request, decoded; null once the round is stale. A network failure (or a decoder bug)
   * becomes the `unreachable` error for each of the request's symbols.
   */
  async ask(provider, request, current, unreachable) {
    try {
      const response = await this.get(request);
      if (!current()) return null;
      return provider.decode(request, response, this.host.now());
    } catch (error) {
      if (!current()) return null;
      const failure = error instanceof QuoteError ? error : new QuoteError(unreachable);
      return { quotes: {}, errors: Object.fromEntries(request.symbols.map((symbol) => [symbol, failure])) };
    }
  }

  /** One request per batch; an unknown pair fails the batch, so then ask pair by pair. */
  async crypto(quote, lines, current) {
    const pairs = quote.symbols;
    const apply = (result) => {
      for (const pair of Object.keys(result.quotes)) {
        // Keep the last line until a new one arrives.
        result.quotes[pair].series = this.quotes[pair]?.series ?? [];
        this.quotes[pair] = result.quotes[pair];
        delete this.errors[pair];
      }
      for (const pair of Object.keys(result.errors)) this.errors[pair] = result.errors[pair].message;
    };
    const batch = await this.ask(binance, quote, current, "binance.unreachable");
    if (!batch) return;
    if (pairs.length > 1 && pairs.every((pair) => batch.errors[pair]?.invalidSymbol)) {
      for (const pair of pairs) {
        if (!current()) return;
        const single = binance.requests([pair], {}).find((request) => request.kind === "quote");
        const result = await this.ask(binance, single, current, "binance.unreachable");
        if (result) apply(result);
      }
    } else apply(batch);
    if (!current()) return;
    this.host.changed();
    // The 24-hour line, one request a pair; a failure only leaves the line as it was.
    for (const request of lines) {
      const [pair] = request.symbols;
      if (!current()) return;
      if (!this.quotes[pair]) continue;
      try {
        const series = binance.decode(request, await this.get(request), this.host.now()).lines?.[pair];
        if (series && current() && this.quotes[pair]) this.quotes[pair].series = series;
      } catch { /* The quote itself is fine. */ }
    }
    if (current()) this.host.changed();
  }
}
