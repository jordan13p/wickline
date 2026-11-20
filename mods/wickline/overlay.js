// Which source's price a row shows (pickOverlay) and how that price merges over the base quote (mergeOverlay).
// watchlist.js hands in each symbol's overlays and line.
import { taipeiDay } from "./calendar.js";
import { LIVE_MAX_AGE_MS, isRealtime } from "./freshness.js";
import { mis } from "./providers/mis.js";
import { withoutActivity } from "./quotes.js";

/**
 * The overlay a row shows, `{ id, overlay }`, from a symbol's overlays keyed by provider id. It is the first in
 * `order` that is still live, else the newest, a tie keeping the earlier id. Null with none, or when none is live and
 * the `base` quote is real time and no older than the newest: a stale overlay never hides a fresher real-time price.
 * While MIS flags the symbol as in a call auction (`flagged`), its held price is from before the auction, so it never
 * outranks another overlay of the same Taipei day, whatever their ages.
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
 * A real-time overlay's fields over the Yahoo base quote; works with no base yet. Name, currency and periods stay
 * the base's, and the overlay's name is kept as `localName`. The line is the overlay source's own same-day line,
 * ending at the shown price; without one, the base's. The `chart*` fields describe the quote the line came from, so
 * the line's state is judged by that quote. A base's cached line under another source's price is `chartCached`, so a
 * fresh overlay never reads as cached. The activity is the price source's, but an overlay without its own volume
 * keeps a live, uncached base's from the same period (Finnhub's price beside Yahoo Finance's live volume).
 */
export function mergeOverlay(base, overlay, line) {
  if (!overlay) return base;
  // The price is the base's own: a quote over itself.
  const ownPrice = base?.source === overlay.source;
  // The base's line and activity count only from the overlay's period: both times fall on the same side of the
  // start of the base's regular period.
  const start = base?.periods?.regular?.[0];
  const samePeriod = start === undefined || base.timestamp < start === overlay.timestamp < start;
  // A cached volume, or another period's, never stands beside a fresh price.
  const lendsActivity =
    ownPrice || ((overlay.volume ?? null) === null && Boolean(base) && isRealtime(base) && !base.cached && samePeriod);
  const merged = { ...(lendsActivity ? base : withoutActivity(base)) };
  for (const [key, value] of Object.entries(overlay)) if (value !== null && value !== undefined) merged[key] = value;
  const previousClose = merged.previousClose ?? null;
  // A copy hidden overnight may hold yesterday's line next to today's first price.
  const own = line?.series.length && line.day === overlay.day ? line.series : null;
  // The base's own line, never a quote's over itself.
  const fallback = ownPrice || !samePeriod ? null : base;
  // A quiet stock's last trade can be older than the line's last (carried) minute, so the appended point never goes
  // back. Whole seconds, like the line's own, so the hand-over can pack them.
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
