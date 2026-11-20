// The open detail's quote, handed over through one shared key by the panel copy that opened it. The key holds the quote
// with its line's times packed (packTimes); the opening copy keeps it plain and the detail unpacks it on adoption. The
// decisions only: main.js reads and writes the key (its detailStore). No imports, so tests run it under Node.

export const DETAIL_KEY = "wickline.detail";

/**
 * A token no other copy, and no earlier run, makes: the time and a random draw, both in base 36. The detail gets it
 * in its props, so it adopts only what its own opening copy wrote.
 */
export const makeToken = (now, random) => `${now.toString(36)}-${Math.floor(random * 36 ** 8).toString(36)}`;

// A hand-over as written: `{ symbol, token, seq, quote }`. Anything else (`{}` once cleared, a malformed value from
// another version) is no one's.
function handedOver(stored) {
  return (
    stored !== null &&
    typeof stored === "object" &&
    typeof stored.symbol === "string" &&
    typeof stored.token === "string" &&
    Number.isInteger(stored.seq) &&
    stored.seq > 0 &&
    stored.quote !== null &&
    typeof stored.quote === "object" &&
    stored.quote.symbol === stored.symbol
  );
}

/**
 * What a hand-over compares: the whole quote, or, while the list is paused, all but its closure marks. A loop that
 * fetches nothing still runs a pass at each edge and at least every 120 s, where the row's quote is marked again at the
 * new time: a paused detail keeps the mark it holds until the mark's end (heldMarks), never a newer one at midnight.
 * Whatever else the row reads differently (a fallback as its overlay ages, a sole source's periods turning, a source
 * turned off) is handed while paused too. Both keys are built in the current mode, so a pause after a write never
 * hands a mark change.
 */
function contentKey(quote, paused) {
  if (!paused) return JSON.stringify(quote);
  const { closure: _closure, closureUntil: _until, ...rest } = quote;
  return JSON.stringify(rest);
}

// The packed form, only in the written key: whole seconds, the first time then each step.
export function packTimes(quote) {
  if (!("times" in quote)) return quote;
  const { times, ...rest } = quote;
  if (!Array.isArray(times) || !times.length || !times.every((time) => Number.isInteger(time) && time % 1000 === 0))
    return rest;
  return {
    ...rest,
    timesPacked: { t0: times[0] / 1000, d: times.slice(1).map((time, i) => (time - times[i]) / 1000) },
  };
}

/**
 * The adopted form: `times` in ms again, only from a packed value whose steps are whole seconds and that gives one time
 * per value of the line. A plain `times` in the key, or anything that cannot be aligned, leaves the quote without times.
 */
export function unpackTimes(quote) {
  const { timesPacked: packed, times: _times, ...rest } = quote;
  const { t0, d } = packed !== null && typeof packed === "object" ? packed : {};
  if (!Number.isInteger(t0) || !Array.isArray(d) || !d.every(Number.isInteger) || d.length + 1 !== rest.series?.length)
    return rest;
  const times = [t0 * 1000];
  let at = t0;
  for (const step of d) times.push((at += step) * 1000);
  return { ...rest, times };
}

/** The first write, before the dialog opens: `value` for the key, `mine` what the opening copy keeps of it (plain). */
export function startHandover(symbol, token, quote) {
  return { value: { symbol, token, seq: 1, quote: packTimes(quote) }, mine: { symbol, token, seq: 1, quote } };
}

/**
 * After a pass of the opening copy's loop: what to write (`write`, null for nothing) and what it keeps (`mine`), given
 * the key as read now (`stored`), what it keeps, its row's quote now (null: the symbol is no longer listed) and whether
 * the list is paused. Once the key holds anything but its own token (another detail, or `{}`), the copy drops its
 * token for good. A quote that reads as the last one written is not written again.
 */
export function nextWrite(stored, mine, quote, paused) {
  if (!mine || !handedOver(stored) || stored.token !== mine.token) return { write: null, mine: null };
  if (!quote || contentKey(mine.quote, paused) === contentKey(quote, paused)) return { write: null, mine };
  const next = { symbol: mine.symbol, token: mine.token, seq: mine.seq + 1 };
  return { write: { ...next, quote: packTimes(quote) }, mine: { ...next, quote } };
}

/**
 * The detail's read: `{ quote, seq }` (the quote unpacked) when the key holds its own token (`held`) with a newer `seq`,
 * else null.
 */
export function adopt(stored, held) {
  if (!held || !handedOver(stored) || stored.token !== held.token || stored.seq <= held.seq) return null;
  return { quote: unpackTimes(stored.quote), seq: stored.seq };
}

/** Whether the detail's close clears the key: only while it holds its own token, so a newer detail keeps its own. */
export function clearsOnClose(stored, token) {
  return typeof token === "string" && handedOver(stored) && stored.token === token;
}
