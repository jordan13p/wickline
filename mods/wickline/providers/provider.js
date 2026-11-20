// What every provider shares: the JSDoc types, the two helpers their decoders use at the boundary, and the retry wait.
import { QuoteError } from "../quotes.js";

/**
 * The shape every provider shares.
 * @typedef {{ url: string, headers: Record<string, string>, symbols: string[], kind: "quote"|"line" }} ProviderRequest
 * @typedef {{ status: number, ok: boolean, text: string }} ProviderResponse
 * @typedef {object} Quote  What decodeYahoo / decodeBinance return, with `source` naming the provider.
 * @typedef {{
 *   quotes: Record<string, Quote>,
 *   errors: Record<string, QuoteError>,
 *   lines?: Record<string, { day?: number, series: number[], times?: number[] }>,
 *   names?: Record<string, string>,
 * }} ProviderResult
 * @typedef {{
 *   id: "yahoo"|"binance"|"mis"|"yahootw"|"finnhub",
 *   markets: string[],
 *   kinds: string[],
 *   overlay?: boolean,
 *   manualRefresh?: boolean,
 *   cap?(config: object): number,
 *   spacingMs(count: number, intervalMs: number): number,
 *   intervalMs(session: string): number,
 *   linesMs?(session: string): number,
 *   linesPerRound?: number,
 *   requests(symbols: string[], config: object): ProviderRequest[],
 *   decode(request: ProviderRequest, response: ProviderResponse, now: number): ProviderResult,
 * }} Provider
 * - `markets`: the markets whose symbols it quotes.
 * - `spacingMs`: the gap between its quote requests in one round.
 * - `intervalMs`: the wait between rounds, given the busiest session among its symbols.
 * - `linesMs`: a line is asked again only once this has passed.
 * - `linesPerRound`: its line requests follow all its quote requests, and a round sends at most that many due ones,
 *   longest-waiting first.
 * - `overlay`: off until the user turns it on; lays its prices over the base quote. Its line, if any, is
 *   `{ day, series, times }`, drawn only with a price of the same trading day.
 * - `cap`: how many of its symbols it quotes, in list order.
 * - `manualRefresh: false`: Refresh starts no extra round, as it spends a request budget.
 * - `decode`: does not throw for an HTTP or body problem; the request's symbols each get that error instead.
 */

// Herdr's fetch gives no headers, so no Retry-After: a rate-limited provider waits at least a minute.
export const RATE_LIMIT_RETRY_MS = 60_000;

/** `JSON.parse` for an answer's body; a body that is not JSON is the provider's `*.unreadable` error. */
export function parseJson(text, unreadableCode) {
  try {
    return JSON.parse(text);
  } catch {
    throw new QuoteError(unreadableCode);
  }
}

/** A decoder's last step: a QuoteError becomes that error on each requested symbol; anything else is a bug. */
export function failEach(symbols, error) {
  if (!(error instanceof QuoteError)) throw error;
  return { quotes: {}, errors: Object.fromEntries(symbols.map((symbol) => [symbol, error])) };
}
