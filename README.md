English | [繁體中文](README.zh-TW.md)

# Bellwether

A stock and crypto watchlist for Herdr. It docks beside your agents, shows each ticker's price, signed change and today's line, and opens a ticker's day on a click. Dock it as a short strip and it becomes a one-line quote band. Quotes come from Yahoo Finance and Binance and are for reference only.

## Languages and colors

The interface is in English, 繁體中文, 简体中文, 日本語 or 한국어. Until you answer it, a line above the add field reads `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`: pick a language to switch, or press `×` (or add a ticker) to stay in English. The line does not come back. The language is your choice only; it never follows the markets you watch or your system language. By default, gains show red and losses green in the four Asian languages, and green-up in English.

## Settings

The Settings button in the panel header opens a dialog with four tabs; nothing changes until you press Save, and Cancel or Esc drops your edits.

- **Data sources**: Yahoo Finance for stocks and indexes (delayed, nothing to set) and Binance Spot for crypto pairs. Binance may be unavailable in some regions, such as the United States; the Binance URL can be changed to another address that serves the same API. It must start with `https://`, otherwise Save stays disabled.
- **Display**: the gain/loss color (automatic by language, red-up or green-up), which applies to the whole list whatever the market, and a button that opens Herdr's own appearance settings. Bellwether has no light/dark setting of its own.
- **Language**: the interface language.
- **Disclaimer & privacy**: the full disclaimer, the hosts and the storage. The disclaimer line in the panel footer opens this tab.

## Network and storage

Bellwether sends read-only requests to `query1.finance.yahoo.com` and `data-api.binance.vision`, plus the Binance URL if you set another one in Settings, and runs no programs. It keeps your watchlist in Herdr's shared state under `bellwether.watchlist.v1` and your settings (language, colors, whether the language line was answered, the Binance URL) under `bellwether.settings.v1`. It reads and writes no other files.

## Credits

Bellwether is a modified version of the Herdr mod in [fatwang2/Pulse](https://github.com/fatwang2/Pulse) (MIT). It is not affiliated with or endorsed by Pulse.
