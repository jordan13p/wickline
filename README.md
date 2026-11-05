English | [繁體中文](README.zh-TW.md)

# Bellwether

A stock and crypto watchlist for Herdr. It docks beside your agents, shows each ticker's price, signed change and today's line, and opens a ticker's day on a click. Dock it as a short strip and it becomes a one-line quote band. Quotes come from Yahoo Finance and Binance (plus TWSE MIS for Taiwan and Finnhub for US stocks, only if you turn them on) and are for reference only.

## Layout

Bellwether picks its layout from its size. Beside a terminal (below 720 px wide) it is a sidebar: each row shows the ticker over its freshness and name, then the line and the price over the change, with the numbers right-aligned so they line up. From 720 px, for example in its own tab, it is a table with one row per ticker and the columns Symbol, Name, Status, Today, Price, Change, Change %, High, Low and Prev close; the column labels stay put while the list scrolls, the table is at most 1280 px wide, and narrower tables drop Prev close first, then Low, High, Change, Today and Name (Symbol, Status, Price and Change % always stay). Docked as a strip under 72 px tall, it is a one-line band.

The header's icons are refresh, pause or resume, settings and, when Bellwether is a pane, **open in its own tab**: it opens a `Bellwether` tab with the table and closes the pane, so only one copy keeps fetching. In that tab the same spot reads **back beside the terminal**: it puts Bellwether back to the right of a pane in the tab it came from and closes its own tab. Every icon has a tooltip in your language. The status line is plain text: whether auto-refresh is on, when quotes were last updated, and `Refreshing quotes…` only while a refresh you asked for runs. The middle candle of the logo takes your theme's accent color.

## How fresh are quotes?

Each source refreshes on its own, so a slow one never holds up another: Yahoo Finance every 60 seconds, Binance tickers every 15 seconds and each pair's 24-hour line every 60 seconds, TWSE MIS (only if you turn it on, see Settings) every 10 seconds while the Taiwan market is open and every 60 seconds otherwise, and Finnhub (only if you choose it and save your own key) 15 seconds after its previous round ends while the US market is open and 60 seconds otherwise. Finnhub gets one request per symbol, spread over about 15 seconds and at least a second apart, so each symbol refreshes about every 30 seconds and one copy uses about half its per-minute budget, and prices only as many US symbols as its per-minute budget allows: the budget divided by 4, so 15 symbols at the default 60 requests per minute (one copy then sends about 30 a minute); the rest stay on Yahoo and their rows say they are over the Finnhub limit. The Refresh button never sends extra Finnhub requests. A request that has not answered within 10 seconds counts as failed and is retried at the next interval. A rate-limited source waits at least 60 seconds, doubling up to 15 minutes, while the others carry on. The status line under the header names every source that has a problem right now.

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

## Reordering

Hover a row and a six-dot handle appears at its left (and `×` at its right). Press it, drag to where the row should go and release: a thin accent line shows the spot, and the row you are moving looks lifted. Moving the pointer out of the list cancels the drag and changes nothing. The order is saved with your watchlist, so every copy shows it at once and it survives a restart. It also decides which US symbols use Finnhub's request budget (the first ones in the list).

## Languages and colors

The interface is in English, 繁體中文, 简体中文, 日本語 or 한국어. Until you answer it, a line above the add field reads `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`: pick a language to switch, or press `×` (or add a ticker) to stay in English. The line does not come back. The language is your choice only; it never follows the markets you watch or your system language. By default, gains show red and losses green in the four Asian languages, and green-up in English.

## Settings

The settings icon (a gear) in the panel header opens a dialog with three tabs; nothing changes until you press Save, and Cancel or Esc drops your edits.

- **Data sources**: Yahoo Finance for stocks and indexes (delayed, nothing to set) and Binance Spot for crypto pairs. The United States card switches US stocks between Yahoo (the default) and Finnhub, which needs your own API key (a free-plan key is enough and recommended). Choosing Finnhub shows a masked key field with a Show/Hide button, the Finnhub URL, the requests per minute (a whole number of at least 4, default 60) and how many US symbols that covers. Save stays disabled without a key. The key is stored in plaintext on this computer (see below). The Taiwan card switches Taiwan stocks between Yahoo (the default) and TWSE MIS, the Taiwan Stock Exchange's unofficial market-information feed. Choosing TWSE MIS shows its URL, a responsibility statement (the Traditional Chinese text prevails) and a consent box; Save stays disabled until you tick it. Your consent is stored with the statement's version: when the statement changes, Taiwan stocks go back to Yahoo and the card and status line ask you to confirm again. Binance may be unavailable in some regions, such as the United States (crypto rows then say so); the Binance URL can be changed to another address that serves the same API. It must start with `https://`, otherwise Save stays disabled.
- **Display**: the interface language (it changes only the interface text, not the quotes), the gain/loss color (automatic by language, red-up or green-up), which applies to the whole list whatever the market, and a button that opens Herdr's own appearance settings. Bellwether has no light/dark setting of its own.
- **Disclaimer & privacy**: the full disclaimer, the sources and what their quotes mean (Yahoo Finance: regular-session quotes, exchange delays vary; Binance Spot: crypto pairs with a 24-hour change), the hosts and the storage. The one-line disclaimer in the panel footer opens this tab.

## Network and storage

Bellwether sends read-only requests to `query1.finance.yahoo.com` and `data-api.binance.vision`, plus the Binance URL if you set another one in Settings, and runs no programs. Only after you choose TWSE MIS on the Taiwan card and tick its consent box does it also contact `mis.twse.com.tw` (unofficial; or the MIS URL you set), for the Taiwan symbols on your list. Only after you choose Finnhub on the United States card and save a key does it also contact `finnhub.io` (or the Finnhub URL you set), for the first US symbols on your list; the key travels in a request header, never in the address. It keeps your watchlist in Herdr's shared state under `bellwether.watchlist.v1` and your settings (language, colors, whether the language line was answered, the US and Taiwan sources, the Finnhub, MIS and Binance URLs, the Finnhub budget, the version of the MIS statement you consented to, and a counter that tells every copy to read the Finnhub key again) under `bellwether.settings.v1`. A Finnhub key you save is kept in plaintext in `data/bellwether/secrets.json` in Herdr's folder on this computer (`~/.config/herdr-app`), never in Herdr's shared state; anyone who can read your files can read it, so use a free-plan key. It reads and writes no other files.

## Credits

Bellwether is a modified version of the Herdr mod in [fatwang2/Pulse](https://github.com/fatwang2/Pulse) (MIT). It is not affiliated with or endorsed by Pulse.
