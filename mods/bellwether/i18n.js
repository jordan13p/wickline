// Every text the person reads, by language and key; `{name}` is filled from params.
// No Herdr imports, so tests run it under Node.
import { MESSAGES_EN, fill } from "./quotes.js";

export const STRINGS = {
  en: {
    ...MESSAGES_EN,
    "notice.added": "Added {symbol}.",
    "notice.duplicate": "{symbol} is already on your watchlist.",
    "notice.removed": "Removed {symbol}.",
    "notice.notListed": "{symbol} is not on your watchlist.",
    "notice.paused": "Automatic refresh paused.",
    "notice.resumed": "Automatic refresh resumed.",
    "error.save": "Could not save the watchlist.",
    "header.tickers.one": "{count} ticker",
    "header.tickers.other": "{count} tickers",
    "button.refresh": "Refresh",
    "button.pause": "Pause",
    "button.resume": "Resume",
    "status.paused": "Auto-refresh paused",
    "status.refreshing": "Refreshing quotes…",
    "status.every": "Auto-refresh every {seconds}s",
    "input.placeholder": "Add a ticker: AAPL, 0700.HK, BTC/USDT",
    "list.empty": "Your watchlist is empty. Add a ticker above.",
    "band.paused": "Paused",
    "band.unavailable": "unavailable",
    "band.cached": "cached",
    "band.empty": "Make the panel taller to add tickers.",
    "row.unavailable": "Unavailable",
    "row.notFetched": "Not fetched",
    "row.waiting": "Waiting…",
    "quote.asOf": "As of {date}",
    "quote.delay": "Delay {minutes}m",
    "quote.cached": "Cached quote · {reason}",
    "footer.disclaimer": "Quotes for reference only. Not investment advice.",
    "footer.sources": "Yahoo Finance · Regular-session quotes · Exchange delays vary",
    "footer.sourcesCrypto": "Yahoo Finance · Binance Spot · Stocks: regular session, exchange delays vary · Crypto: 24h change",
    "detail.open": "Open",
    "detail.high": "High",
    "detail.low": "Low",
    "detail.prevClose": "Prev close",
    "detail.open24h": "24h open",
    "detail.high24h": "24h high",
    "detail.low24h": "24h low",
    "detail.noLine": "No intraday line yet.",
    "detail.sourceStock": "Yahoo Finance · regular session",
    "detail.sourceCrypto": "Binance Spot · 24h",
    "session.open": "Market open",
    "session.pre": "Pre-market",
    "session.post": "After hours",
    "session.closed": "Market closed",
    "session.24h": "Trades 24h",
  },
};

/** The text for `key` in `lang`, else in English, else the key itself. */
export function t(lang, key, params = {}) {
  return fill(STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key, params);
}
