// Which source's price a row shows (pickOverlay) and how that price merges over the base quote (mergeOverlay). Pure:
// watchlist.js hands in each symbol's overlays and line, so tests run it under Node.
import { taipeiDay } from "./calendar.js";
import { LIVE_MAX_AGE_MS, isRealtime } from "./freshness.js";
import { mis } from "./providers/mis.js";
import { withoutActivity } from "./quotes.js";

/**
 * The overlay a row shows, among a symbol's overlays keyed by provider id: the first of `order` that is
 * still live (at most LIVE_MAX_AGE_MS old: the moment msUntilStale wakes an idle loop for, in any session),
 * else the newest, a tie keeping the earlier id. Null with none, or when none is live and the `base` quote is
 * real time (isRealtime) and no older than the newest: a stale overlay never hides a fresher real-time price.
 * While MIS flags the symbol as in a call auction (`flagged`), its held price never outranks another overlay of its
 * own Taipei day, whatever their ages: it is from before the auction.
 */
export function pickOverlay(byProvider, order, now, base = null, flagged = false) {
  const held = flagged ? byProvider[mis.id] : null;
  const heldDay = held ? taipeiDay(held.timestamp) : null;
  const misYields =
    Boolean(held) &&
    order.some((id) => id !== mis.id && byProvider[id] && taipeiDay(byProvider[id].timestamp) === heldDay);
  let newest = null;
  for (const id of order) {
    const overlay = byProvider[id];
    if (!overlay || (misYields && id === mis.id)) continue;
    if (now - overlay.timestamp <= LIVE_MAX_AGE_MS) return { id, overlay };
    if (!newest || overlay.timestamp > newest.overlay.timestamp) newest = { id, overlay };
  }
  return newest && base && isRealtime(base) && base.timestamp >= newest.overlay.timestamp ? null : newest;
}

/**
 * A real-time overlay's fields over the Yahoo base quote. The trading periods, the currency and the
 * name stay the base's (the overlay's name is kept as `localName`); so does the line, unless the
 * overlay's source gave its own (`line`, `{ day, series, times }`) on the overlay's trading day (`overlay.day`):
 * then that line, ending at the shown price. That price's time is its trade time (else the quote's) in whole
 * seconds, never before the line's last point; an own line without a time per value gives no times, and the base's
 * times go with the base's line only. `chartSource` names where the line came from, and
 * `chartTimestamp` and `chartFetchedAt` keep that quote's times, so the line's state is judged by its own
 * quote. Works with no base yet. A quote over itself (a symbol's sole source, base and overlay from one source)
 * has no line but the overlay's own: without one, no line and no `chartSource`. `cached` is the shown price's
 * (the base's, kept only when the price is the base's own); the base's flag on a line shown under another
 * source's price is `chartCached`, so a fresh overlay never reads as cached for the base's failed fetch, and only
 * when that line has points: an empty one shows no chart to call cached. The base's line under an overlay price from
 * another trading period (yesterday's line under today's first price) is no line: none, no `chartSource`, no
 * `chartCached`. The activity (quotes.js ACTIVITY_FIELDS) is the price source's: an overlay over another source's base
 * starts from the base without its own, except that an overlay with no volume of its own keeps a real-time base's
 * (Finnhub's price beside Yahoo Finance's live volume) when that base is not cached and is from the overlay's period;
 * a delayed base never lends any.
 */
export function mergeOverlay(base, overlay, line) {
  if (!overlay) return base;
  // The price is the base's own: a quote over itself.
  const ownPrice = base?.source === overlay.source;
  // The base's line and activity come only from the overlay's period: both times before, or both at or after, the
  // start of the base's regular period (epoch ms, no time zone needed).
  const start = base?.periods?.regular?.[0];
  const samePeriod = start === undefined || base.timestamp < start === overlay.timestamp < start;
  // A kept (cached) or another period's volume never stands beside a fresh price.
  const lendsActivity =
    ownPrice || ((overlay.volume ?? null) === null && Boolean(base) && isRealtime(base) && !base.cached && samePeriod);
  const merged = { ...(lendsActivity ? base : withoutActivity(base)) };
  for (const [key, value] of Object.entries(overlay)) if (value !== null && value !== undefined) merged[key] = value;
  const previousClose = merged.previousClose ?? null;
  // A copy hidden overnight may hold yesterday's line next to today's first price.
  const own = line?.series.length && line.day === overlay.day ? line.series : null;
  // The base's own line, never a quote's over itself.
  const fallback = ownPrice || !samePeriod ? null : base;
  // A quiet stock's last trade can be older than the line's last (carried) minute: the appended point never goes back.
  // Whole seconds, as the line's own, so the hand-over can pack them.
  const timed = own && Array.isArray(line.times) && line.times.length === line.series.length;
  const appendedAt = timed && Math.max(overlay.tradeTime ?? overlay.timestamp, line.times.at(-1));
  const times = timed ? [...line.times, Math.floor(appendedAt / 1000) * 1000] : own ? undefined : fallback?.times;
  const { cached, times: _times, ...price } = merged;
  return {
    ...price,
    ...(ownPrice && cached ? { cached } : {}),
    ...(!own && fallback?.cached && fallback.series?.length ? { chartCached: true } : {}),
    previousClose,
    changePercent: previousClose > 0 ? ((overlay.price - previousClose) / previousClose) * 100 : null,
    name: base?.name ?? null,
    localName: overlay.name ?? null,
    // A price is never paired with another answer's limits.
    limitUp: overlay.limitUp ?? null,
    limitDown: overlay.limitDown ?? null,
    currency: base?.currency ?? null,
    series: own ? [...own, overlay.price] : (fallback?.series ?? []),
    ...(times && { times }),
    periods: base?.periods ?? null,
    chartSource: own ? overlay.source : (fallback?.source ?? null),
    chartTimestamp: own ? overlay.timestamp : (fallback?.timestamp ?? null),
    chartFetchedAt: own ? overlay.fetchedAt : (fallback?.fetchedAt ?? null),
  };
}
