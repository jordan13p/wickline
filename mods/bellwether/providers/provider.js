// The shape every provider shares: JSDoc types only, nothing runs from here. No Herdr imports.

/**
 * The shape every provider shares.
 * @typedef {{ url: string, headers: Record<string, string>, symbols: string[], kind: "quote"|"line" }} ProviderRequest
 * @typedef {{ status: number, ok: boolean, text: string }} ProviderResponse
 * @typedef {object} Quote  What decodeYahoo / decodeBinance return, with `source` naming the provider.
 * @typedef {{ quotes: Record<string, Quote>, errors: Record<string, QuoteError>, lines?: Record<string, number[]> }} ProviderResult
 * @typedef {{
 *   id: "yahoo"|"binance"|"mis"|"finnhub",
 *   markets: string[],
 *   overlay?: boolean,
 *   manualRefresh?: boolean,
 *   cap?(config: object): number,
 *   spacingMs(count: number, intervalMs: number): number,
 *   intervalMs(session: string): number,
 *   linesMs?: number,
 *   requests(symbols: string[], config: object): ProviderRequest[],
 *   decode(request: ProviderRequest, response: ProviderResponse, now: number): ProviderResult,
 * }} Provider
 * `markets` are the markets (markets.js) whose symbols it quotes. `spacingMs` is the gap between
 * this provider's quote requests in one round. `intervalMs` is the wait between rounds, given the
 * busiest session among its symbols ("open" while unknown). A provider with `kind: "line"`
 * requests asks each line again only once `linesMs` has passed. An `overlay` provider (TWSE MIS) is
 * off until the person turns it on, and lays its prices over the base quote instead of replacing it.
 * `cap` limits it to that many of its symbols, in list order; `manualRefresh: false` keeps Refresh
 * from starting an extra round (a request budget). `decode` does not throw
 * for an HTTP or body problem: the request's symbols each get that error instead.
 */

export {};
