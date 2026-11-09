// What every provider shares: the JSDoc types, and the two helpers their decoders use at the boundary.
// No Herdr imports, so tests run it under Node.
import { QuoteError } from "../quotes.js";

/**
 * The shape every provider shares.
 * @typedef {{ url: string, headers: Record<string, string>, symbols: string[], kind: "quote"|"line" }} ProviderRequest
 * @typedef {{ status: number, ok: boolean, text: string }} ProviderResponse
 * @typedef {object} Quote  What decodeYahoo / decodeBinance return, with `source` naming the provider.
 * @typedef {{ quotes: Record<string, Quote>, errors: Record<string, QuoteError>, lines?: Record<string, number[]>, names?: Record<string, string> }} ProviderResult
 * @typedef {{
 *   id: "yahoo"|"binance"|"mis"|"finnhub",
 *   markets: string[],
 *   overlay?: boolean,
 *   manualRefresh?: boolean,
 *   cap?(config: object): number,
 *   spacingMs(count: number, intervalMs: number): number,
 *   intervalMs(session: string): number,
 *   linesMs?(session: string): number,
 *   requests(symbols: string[], config: object): ProviderRequest[],
 *   decode(request: ProviderRequest, response: ProviderResponse, now: number): ProviderResult,
 * }} Provider
 * `markets` are the markets (markets.js) whose symbols it quotes. `spacingMs` is the gap between
 * this provider's quote requests in one round. `intervalMs` is the wait between rounds, given the
 * busiest session among its symbols ("open" while unknown). A provider with `kind: "line"`
 * requests asks each line again only once `linesMs(session)` has passed. An `overlay` provider (TWSE MIS) is
 * off until the person turns it on, and lays its prices over the base quote instead of replacing it.
 * `cap` limits it to that many of its symbols, in list order; `manualRefresh: false` keeps Refresh
 * from starting an extra round (a request budget). `decode` does not throw
 * for an HTTP or body problem: the request's symbols each get that error instead.
 */

/** `JSON.parse` for an answer's body; a body that is not JSON is the provider's `*.unreadable` error. */
export function parseJson(text, unreadableCode) {
  try { return JSON.parse(text); } catch { throw new QuoteError(unreadableCode); }
}

/** A decoder's last step: a QuoteError becomes that error on each requested symbol; anything else is a bug. */
export function failEach(symbols, error) {
  if (!(error instanceof QuoteError)) throw error;
  return { quotes: {}, errors: Object.fromEntries(symbols.map((symbol) => [symbol, error])) };
}
