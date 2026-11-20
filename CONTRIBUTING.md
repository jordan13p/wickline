# Contributing to Wickline

Herdr is a desktop app for terminals and coding agents; its mods are listed at [herdr.dev/mods](https://herdr.dev/mods).

Wickline is a Herdr mod in plain JavaScript. Herdr runs it in QuickJS: no Node APIs, no `Intl`, no `setTimeout`
(timers come from Herdr's `cx.timer` and `cx.sleep`). Export each name on its own (`export function`,
`export const`): Herdr's loader rejects destructured exports. The mod has no dependencies; `package.json` is for
development only.

## Checks

With Node 26 and Herdr installed:

```sh
npm ci                                 # Biome, the formatter and linter
npm test                               # node --test tests/
npm run lint                           # biome ci
npm run format                         # format in place
herdr-app check "$PWD/mods/wickline"   # Herdr loads the mod
```

A change is done when all of them pass. CI runs lint, tests and a secret scan on every branch push and pull request (a
release tag is not checked again).

## Layers

- **Core**, every module but `main.js` and `ui/`, imports only the mod's own modules, so it runs under Node and the
  tests cover it.
- **`ui/`** builds elements from the view and the theme; it adds `gpui-kit` and `gpui-base`, nothing else.
- **`main.js`** alone talks to Herdr (storage, network, files, commands) and hands what core needs to it as a `host`
  object or as arguments.

`tests/hygiene.test.mjs` enforces these layers, and that no import cycle exists.

Wickline discloses every host it contacts, the one program it runs and everything it stores. A change that adds or
changes any of them also updates both READMEs, `RECIPE.md` and the settings dialog's Disclaimer & privacy tab, in the
same commit.

## Code map

All under `mods/wickline/`. Per-module build notes: [RECIPE-internals.md](RECIPE-internals.md#modules).

### Shell

- `main.js`: the one view and the only module that talks to Herdr; picks the panel or a dialog, runs each source's
  loop, handles input and commands.

### Moves, handover and the key file

Core modules (see Layers) that serve `main.js`; any Herdr call or file access they need comes in from it.

- `moves.js`, `panes.js`: moving the panel between a pane, its own tab and the dock, and telling when it has arrived.
- `handover.js`: hands the open detail dialog each newer quote of its row.
- `secrets.js`: reads, writes and removes the Finnhub key file.

### `ui/`

- `panel.js`: the band, sidebar and table, with the list, market filters and footer.
- `header.js`, `rows.js`: the header's pieces, and the rows both list layouts share.
- `parts.js`: stateless pieces (chart, price box, toggle, …).
- `detail-dialog.js`, `settings-dialog.js`: the two dialogs.

### Data and scheduling

- `watchlist.js`: the list, its edits, one loop per source, and what each row shows.
- `overlay.js`: which source's price a row shows and how it merges over the base quote.
- `providers/`: one file per source (requests and decoding); `provider.js` describes what a source declares.
- `quotes.js`: symbol rules, error codes, request headers and the cleaners for what a source sends.

### Time and markets

- `time.js`: fixed-offset clock arithmetic by hand.
- `markets.js`: a symbol's market and kind, each exchange's delay and hours.
- `calendar.js`: Taipei days, a future's trading day and TWSE's holiday list.
- `closures.js`: whether a row's market is closed for the day, listed or inferred.
- `freshness.js`: a quote's session and freshness, and the moments a row next reads differently.

### Presentation helpers

- `format.js`: numbers, dates, times and row labels, formatted by hand.
- `chart.js`: chart geometry and the crosshair.
- `detail.js`: the detail dialog's cells, times, sources and redraw timing.
- `filter.js`: the market filter and each copy's stored choice.
- `layout.js`: panel sizes and the table's columns.
- `motion.js`: row animation timings and a removed row's fading place.

### Settings and text

- `settings.js`: reading, checking and merging settings; source gates, consents and health.
- `i18n.js`, `i18n/`: `t()` and one string table per language (`en`, `zh-tw`, `zh-cn`, `ja`, `ko`).

Tests live in `tests/`: a `<module>.test.mjs` for most core modules, `hygiene.test.mjs` for the rules above and the
docs, and shared helpers in `helpers.mjs`.

## Commits

- Tag every commit `[STRUCT]` (no behavior change: move, rename, extract, format) or `[BEHAV]` (changes what
  Wickline does, with tests that show it). Never mix the two in one commit.
- Subject in the imperative; the body says why, how and what it changes.
- A `[BEHAV]` commit updates `RECIPE.md` (at most 57,000 bytes; a test checks) and the READMEs where they describe
  that behavior.
