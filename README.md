English | [繁體中文](README.zh-TW.md)

# Bellwether

A stock and crypto watchlist for Herdr. It docks beside your agents, shows each ticker's price, signed change and today's line, and opens a ticker's day on a click. Dock it as a short strip and it becomes a one-line quote band. Quotes come from Yahoo Finance and Binance (plus TWSE MIS for Taiwan and Finnhub for US stocks, only if you turn them on) and are for reference only.

## How fresh are quotes?

Each source refreshes on its own, so a slow one never holds up another: Yahoo Finance every 60 seconds, Binance tickers every 15 seconds and each pair's 24-hour line every 60 seconds, TWSE MIS (only if you turn it on, see Settings) every 10 seconds while the Taiwan market is open and every 60 seconds otherwise, and Finnhub (only if you choose it and save your own key) every 15 seconds while the US market is open and every 60 seconds otherwise. Finnhub gets one request per symbol, spread over that time and at least a second apart, and prices only as many US symbols as its per-minute budget allows: the budget divided by 4, so 15 symbols at the default 60 requests per minute; the rest stay on Yahoo and their rows say they are over the Finnhub limit. The Refresh button never sends extra Finnhub requests. A request that has not answered within 10 seconds counts as failed and is retried at the next interval. A rate-limited source waits at least 60 seconds, doubling up to 15 minutes, while the others carry on. The status line under the header names every source that has a problem right now.

Every row shows a dot and a label:

| Dot | Label | Meaning |
|---|---|---|
| filled | `Binance Spot`, `TWSE MIS`, `Finnhub` | real-time price, market trading, quote at most 120 seconds old |
| hollow | source name | real-time price, but the market session is not known yet |
| hollow | `quote stopped at 13:05` | real-time source, market trading, but the quote is older than 120 seconds |
| hollow | `delayed 15 min`, `Yahoo · delayed` | Yahoo Finance: minutes when Yahoo reports them (Taiwan is always 20 minutes), otherwise just "delayed" |
| none | `Market closed · Oct 31 16:00` | the market is closed; the date shows when it is not today |
| none | `Pre-market`, `After hours` | outside the regular session; the price is the regular session's |

A Yahoo price is never shown as live. With TWSE MIS on, a Taiwan row takes its price from MIS and keeps Yahoo's line; if MIS fails, or its price falls outside the stock's daily price limits, the row falls back to Yahoo's delayed quote at once and says why (`Showing Yahoo · …`). Finnhub works the same way for US rows. If Finnhub refuses your key (HTTP 401 or 403), Bellwether stops asking Finnhub, says the key is invalid and shows Yahoo until you save a new key or change the US source settings. The detail dialog gives the quote time and the fetch time to the second. Keep one copy of Bellwether shown: each shown copy (even a hidden one) runs its own loops, so a second copy doubles the requests. With Finnhub that means two copies use up its per-minute limit twice as fast, and it answers with rate limits.

## Languages and colors

The interface is in English, 繁體中文, 简体中文, 日本語 or 한국어. Until you answer it, a line above the add field reads `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`: pick a language to switch, or press `×` (or add a ticker) to stay in English. The line does not come back. The language is your choice only; it never follows the markets you watch or your system language. By default, gains show red and losses green in the four Asian languages, and green-up in English.

## Settings

The Settings button in the panel header opens a dialog with four tabs; nothing changes until you press Save, and Cancel or Esc drops your edits.

- **Data sources**: Yahoo Finance for stocks and indexes (delayed, nothing to set) and Binance Spot for crypto pairs. The United States card switches US stocks between Yahoo (the default) and Finnhub, which needs your own API key (a free-plan key is enough and recommended). Choosing Finnhub shows a masked key field with a Show/Hide button, the Finnhub URL, the requests per minute (a whole number of at least 4, default 60) and how many US symbols that covers. Save stays disabled without a key. The key is stored in plaintext on this computer (see below). The Taiwan card switches Taiwan stocks between Yahoo (the default) and TWSE MIS, the Taiwan Stock Exchange's unofficial market-information feed. Choosing TWSE MIS shows its URL, a responsibility statement (the Traditional Chinese text prevails) and a consent box; Save stays disabled until you tick it. Your consent is stored with the statement's version: when the statement changes, Taiwan stocks go back to Yahoo and the card and status line ask you to confirm again. Binance may be unavailable in some regions, such as the United States (crypto rows then say so); the Binance URL can be changed to another address that serves the same API. It must start with `https://`, otherwise Save stays disabled.
- **Display**: the gain/loss color (automatic by language, red-up or green-up), which applies to the whole list whatever the market, and a button that opens Herdr's own appearance settings. Bellwether has no light/dark setting of its own.
- **Language**: the interface language.
- **Disclaimer & privacy**: the full disclaimer, the hosts and the storage. The disclaimer line in the panel footer opens this tab.

## Network and storage

Bellwether sends read-only requests to `query1.finance.yahoo.com` and `data-api.binance.vision`, plus the Binance URL if you set another one in Settings, and runs no programs. Only after you choose TWSE MIS on the Taiwan card and tick its consent box does it also contact `mis.twse.com.tw` (unofficial; or the MIS URL you set), for the Taiwan symbols on your list. Only after you choose Finnhub on the United States card and save a key does it also contact `finnhub.io` (or the Finnhub URL you set), for the first US symbols on your list; the key travels in a request header, never in the address. It keeps your watchlist in Herdr's shared state under `bellwether.watchlist.v1` and your settings (language, colors, whether the language line was answered, the US and Taiwan sources, the Finnhub, MIS and Binance URLs, the Finnhub budget, the version of the MIS statement you consented to, and a counter that tells every copy to read the Finnhub key again) under `bellwether.settings.v1`. A Finnhub key you save is kept in plaintext in `data/bellwether/secrets.json` in Herdr's folder on this computer (`~/.config/herdr-app`), never in Herdr's shared state; anyone who can read your files can read it, so use a free-plan key. It reads and writes no other files.

## Credits

Bellwether is a modified version of the Herdr mod in [fatwang2/Pulse](https://github.com/fatwang2/Pulse) (MIT). It is not affiliated with or endorsed by Pulse.
