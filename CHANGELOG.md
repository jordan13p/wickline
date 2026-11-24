# Changelog

All notable changes to Wickline. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/). Each version is dated by its tagged commit.

## [Unreleased]

### Fixed

- Before the open, a Taiwan index only Yahoo TW Stock prices, such as `^TWOII`, shows its previous close, closed on
  the previous trading day, instead of waiting until 09:00 when Wickline starts or the index is added then.
- A seven-digit size in the detail's best five no longer wraps onto two lines and pushes the rows below it down.

## [0.9.0] - 2026-11-20

### Added

- Hover the detail dialog's chart to read the nearest point's date, time, price and change on a card beside it.
- The detail's chart writes the date of its first point under its left end.

### Changed

- Development: Biome formatting and linting, contributing notes; no change in behavior.

## [0.8.0] - 2026-11-19

### Added

- A Taiwan quote's detail opens in two columns with its activity: previous volume, turnover, last trade's size,
  volume at bid and at ask, and the best five bid and ask levels with their totals.
- Every quote's detail shows its volume (none for an index, nor for Yahoo Finance's crypto, whose volume is in
  dollars).
- Yahoo TW Stock's opening-auction book shows as the trial match, and market orders, such as those queued at a locked
  limit, show in the book.

### Changed

- An open detail stays current from its row, which hands it each newer quote.

### Fixed

- An earlier day's Yahoo TW Stock book is never shown as the auction's.

## [0.7.0] - 2026-11-18

### Added

- Taiwan's call auctions read `Call auction` (試撮中), and an auction's book is never shown as a price.

### Changed

- A chart's line is drawn only as far as its trading day has run.
- The detail shows its chart box only when there is something to draw.

## [0.6.1] - 2026-11-12

### Changed

- An open detail stays current without fetching, and redraws only when its reading can change.
- Each row's date turns at its own midnight, and a live row shows no date.

### Fixed

- A cached price never shows as live, and a cached chart beside a live price says so.
- On a listed Taiwan holiday, a future's `No trading` mark now lasts until 05:00 the next morning, through the night
  session the holiday cancels.
- On a quiet futures day, `No trades today` ends at 15:10 even when no answer for the night session has arrived.

## [0.6.0] - 2026-11-11

### Added

- TWSE's holiday schedule (from `openapi.twse.com.tw`): a listed Taiwan holiday reads `No trading` (休市), and a
  Taiwan weekday without trades reads `No trades today` without calling it closed.
- The detail shows each instrument's trading hours in your local time.

### Changed

- A row changes state (open, lunch break, closed) at the moment its session starts or ends, not at the next refresh.
- A Taiwan or US quote whose trading periods have not arrived yet is read by its exchange's regular hours until they do.
- Currencies read closed only over their weekend, not by their daily period.

## [0.5.0] - 2026-11-11

### Added

- Taiwan futures such as `WTX&`, priced by Yahoo TW Stock alone and read by TAIFEX's day and night sessions.
- Taiwan indexes Yahoo Finance lacks, such as `^TWOII`, are priced through Yahoo TW Stock.
- Lunch breaks and closed currency weekends are shown.

### Changed

- The Yahoo TW Stock statement now lists what is asked for each exchange (TWSE, TPEx, TAIFEX), so anyone who
  consented before is asked once more.
- Each Taiwan consent shows its key points first.

### Fixed

- Corrected the VIX and US venue delays; a cached Yahoo quote, or one still at yesterday's close, never reads Live.

## [0.4.0] - 2026-11-09

### Added

- Yahoo TW Stock (Yahoo 奇摩股市) as an opt-in real-time Taiwan source, with its intraday line.
- A Taiwan price at its limit-up or limit-down is lit, and a Taiwan stock's detail shows its limits.
- Undo for 10 seconds after removing a symbol.

### Changed

- Settings are a sidebar of market pages, and the Taiwan statements are shown in full.
- A sidebar row shows the change amount and an area line; live rows are labeled by state.

## [0.3.1] - 2026-11-06

### Fixed

- A Taiwan stock locked at its limit keeps its real-time TWSE MIS price at that limit, instead of Yahoo's delayed one.

## [0.3.0] - 2026-11-06

### Added

- Filter the list by market; each copy keeps its own filter across restarts.
- Rows animate when added, removed and dropped, and a new symbol goes to the top of the list.
- A docked Wickline moves to its own tab and back.

### Changed

- The refresh icon turns until the round ends, and a docked copy that is not shown sends no requests.

## [0.2.0] - 2026-11-06

### Added

- Herdr's side-panel card when docked with `card: true`.

### Changed

- Each sidebar row has its name on a line of its own.

### Fixed

- A TWSE MIS row keeps its name when it has no price.

## [0.1.0] - 2026-11-05

### Added

- Stock, index, currency and futures quotes from Yahoo Finance and crypto from Binance Spot, each source refreshing on
  its own, every row saying how fresh its price is.
- Opt-in sources: TWSE MIS for Taiwan, after your consent, and Finnhub for US stocks, with your own key, sent only to
  `finnhub.io`.
- A band, sidebar or table layout chosen by the pane's size; drag to reorder; move between a pane and its own tab;
  open with `ctrl-alt-b`.
- A settings dialog, five interface languages, and red-up or green-up colors.

[Unreleased]: https://github.com/jordan13p/wickline/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/jordan13p/wickline/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jordan13p/wickline/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jordan13p/wickline/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jordan13p/wickline/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jordan13p/wickline/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jordan13p/wickline/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jordan13p/wickline/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jordan13p/wickline/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jordan13p/wickline/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jordan13p/wickline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jordan13p/wickline/releases/tag/v0.1.0
