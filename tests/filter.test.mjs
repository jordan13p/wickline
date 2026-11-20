// node --test tests/  (filter.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  FILTER_MIN_MARKETS,
  FILTER_MIN_SYMBOLS,
  FILTER_STORAGE_KEY,
  dropBefore,
  filterAfterAdd,
  heldFilter,
  inFilter,
  marketFilters,
  nextOf,
  openFilter,
  readFilter,
  visibleSymbols,
} from "../mods/wickline/filter.js";
import { marketOf } from "../mods/wickline/markets.js";
import { TWELVE } from "./helpers.mjs";

// filterAfterRemove's `pending`: no index waits for its first quote, or every index does.
const none = () => false;
const waiting = (symbol) => symbol.startsWith("^");

test("no filters below 8 symbols or 2 markets", () => {
  assert.deepEqual(marketFilters(["AAPL", "2330.TW", "BTC/USDT", "NVDA"], marketOf), []);
  assert.deepEqual(marketFilters(["AAPL", "NVDA", "MSFT", "AMZN", "GOOG", "META", "TSLA", "NFLX"], marketOf), []);
  assert.equal(FILTER_MIN_SYMBOLS, 8);
  assert.equal(FILTER_MIN_MARKETS, 2);
});

test("filters list All, then the markets in the language's order, and the counts add up", () => {
  const filters = marketFilters(TWELVE, marketOf, "zh-TW");
  assert.deepEqual(filters, [
    { id: "all", count: 12 },
    { id: "tw", count: 5 },
    { id: "us", count: 4 },
    { id: "crypto", count: 3 },
  ]);
  assert.equal(
    filters.slice(1).reduce((sum, { count }) => sum + count, 0),
    filters[0].count,
  );
});

test("the order is fixed by the interface language, whatever comes first in the list", () => {
  const ids = (symbols, lang) => marketFilters(symbols, marketOf, lang).map(({ id }) => id);
  // A US symbol first: Chinese still leads with Taiwan, English with the US.
  const usFirst = ["AAPL", ...TWELVE.filter((symbol) => symbol !== "AAPL")];
  assert.deepEqual(ids(usFirst, "zh-TW"), ["all", "tw", "us", "crypto"]);
  assert.deepEqual(ids(usFirst, "zh-CN"), ["all", "tw", "us", "crypto"]);
  assert.deepEqual(ids(usFirst, "en"), ["all", "us", "tw", "crypto"]);
  // Japan and Korea lead with their own market.
  const wide = [...TWELVE, "7203.T", "005930.KS", "0700.HK", "600519.SS", "^GSPC"];
  assert.deepEqual(ids(wide, "en"), ["all", "us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "zh-TW"), ["all", "tw", "us", "hk", "cn", "jp", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "ja"), ["all", "jp", "us", "tw", "hk", "cn", "kr", "crypto", "other"]);
  assert.deepEqual(ids(wide, "ko"), ["all", "kr", "us", "tw", "hk", "cn", "jp", "crypto", "other"]);
  // Only markets on the list appear.
  assert.deepEqual(ids(TWELVE, "ja"), ["all", "us", "tw", "crypto"]);
  assert.deepEqual(ids(TWELVE, "ko"), ["all", "us", "tw", "crypto"]);
});

test("adding or dragging symbols never reorders the filters", () => {
  const ids = (symbols) => marketFilters(symbols, marketOf, "en").map(({ id }) => id);
  const before = ids(TWELVE);
  assert.deepEqual(ids(["00878.TW", ...TWELVE]), before);
  assert.deepEqual(ids([...TWELVE].reverse()), before);
});

test("a market shows its own symbols in list order", () => {
  assert.deepEqual(visibleSymbols(TWELVE, "tw", marketOf), ["2330.TW", "0050.TW", "00632R.TW", "2317.TW", "2454.TW"]);
  assert.deepEqual(visibleSymbols(TWELVE, "crypto", marketOf), ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
});

test("All, an unknown filter and an absent market show everything", () => {
  for (const filter of ["all", "kr", "nonsense"])
    assert.deepEqual(visibleSymbols(TWELVE, filter, marketOf), TWELVE, filter);
});

test("a drop in the visible list maps to a place in the full list", () => {
  const full = ["2330.TW", "AAPL", "0050.TW", "NVDA"];
  const visible = ["2330.TW", "0050.TW"];
  assert.equal(dropBefore(full, visible, "2330.TW"), "2330.TW");
  assert.equal(dropBefore(full, visible, "0050.TW"), "0050.TW");
  // After the last visible row: in front of that row's successor in the full list.
  assert.equal(dropBefore(full, visible, null), "NVDA");
  // The last visible row is also the last overall.
  assert.equal(dropBefore(["AAPL", "2330.TW"], ["2330.TW"], null), null);
  // No filter: the full list is the visible one.
  assert.equal(dropBefore(full, full, null), null);
});

test("the symbol after another in a list, or null", () => {
  assert.equal(nextOf(["A", "B", "C"], "A"), "B");
  assert.equal(nextOf(["A", "B", "C"], "C"), null);
  assert.equal(nextOf([], "A"), null);
});

test("the chosen filter is the stored one only while it is offered", () => {
  const chosen = (symbols, filter) => readFilter(symbols, filter, marketOf).chosen;
  assert.equal(chosen(TWELVE, "tw"), "tw");
  assert.equal(chosen(TWELVE, "kr"), "all");
  assert.equal(chosen(TWELVE, "all"), "all");
  // Below the thresholds there is no filter row, so a stored choice must not hide rows.
  assert.equal(chosen(["2330.TW", "AAPL"], "tw"), "all");
  // Whatever the interface language orders the filters by.
  assert.equal(readFilter(TWELVE, "tw", marketOf, "ja").chosen, "tw");
});

test("one read of the filter gives the row, the choice and the rows it shows", () => {
  assert.deepEqual(readFilter(TWELVE, "tw", marketOf, "zh-TW"), {
    filters: marketFilters(TWELVE, marketOf, "zh-TW"),
    chosen: "tw",
    shown: visibleSymbols(TWELVE, "tw", marketOf),
  });
  assert.deepEqual(readFilter(TWELVE, "kr", marketOf, "en"), {
    filters: marketFilters(TWELVE, marketOf, "en"),
    chosen: "all",
    shown: TWELVE,
  });
  assert.deepEqual(readFilter(["2330.TW", "AAPL"], "tw", marketOf), {
    filters: [],
    chosen: "all",
    shown: ["2330.TW", "AAPL"],
  });
});

test("a symbol is in its own market's filter and in All", () => {
  assert.equal(inFilter("2330.TW", "tw", marketOf), true);
  assert.equal(inFilter("AAPL", "tw", marketOf), false);
  assert.equal(inFilter("AAPL", "all", marketOf), true);
});

test("an add keeps the filter unless it would hide the symbol", () => {
  // The symbol is already on the list passed in (the list after the add).
  assert.equal(filterAfterAdd(TWELVE, "tw", "2330.TW", marketOf), "tw");
  assert.equal(filterAfterAdd(TWELVE, "tw", "AAPL", marketOf), "all");
  assert.equal(filterAfterAdd(TWELVE, "all", "AAPL", marketOf), "all");
  // A stored choice the row does not offer reads as All, which hides nothing.
  assert.equal(filterAfterAdd(TWELVE, "kr", "AAPL", marketOf), "kr");
  assert.equal(filterAfterAdd(["AAPL", "2330.TW"], "tw", "AAPL", marketOf), "tw");
});

test("a choice is held only while a pending index alone keeps it", () => {
  // No Taiwan symbol left, ^GSPC waiting: kept, but only for the index.
  const list = ["^GSPC", ...TWELVE.filter((s) => !s.endsWith(".TW"))];
  assert.equal(heldFilter(list, "tw", marketOf, waiting), true);
  // A Taiwan symbol keeps it on its own.
  assert.equal(heldFilter(["^GSPC", ...TWELVE], "tw", marketOf, waiting), false);
  // All is never held.
  assert.equal(heldFilter(list, "all", marketOf, waiting), false);
  // Nothing pending: the remove returned it to All already.
  assert.equal(heldFilter(list, "tw", marketOf, none), false);
});

// A copy's own storage as localStorage gives it, recording each write; `broken` throws on every use.
function fakeStorage(stored = {}, broken = false) {
  const storage = { items: { ...stored }, writes: [] };
  storage.getItem = (key) => {
    if (broken) throw new Error("broken");
    return storage.items[key] ?? null;
  };
  storage.setItem = (key, value) => {
    if (broken) throw new Error("broken");
    storage.writes.push([key, value]);
    storage.items[key] = value;
  };
  return storage;
}

test("a copy opens on its stored filter, else the one it was opened with, else All", () => {
  assert.equal(FILTER_STORAGE_KEY, "wickline.filter");
  // A stored choice wins over the props Herdr keeps with the tab.
  assert.equal(openFilter(fakeStorage({ "wickline.filter": "us" }), "tw"), "us");
  assert.equal(openFilter(fakeStorage(), "tw"), "tw");
  assert.equal(openFilter(fakeStorage(), undefined), "all");
  assert.equal(openFilter(fakeStorage(), 3), "all");
  // Storage that cannot be read: as nothing stored.
  assert.equal(openFilter(fakeStorage({}, true), "tw"), "tw");
});

test("opening a copy writes nothing: only a choice the person makes there is stored", () => {
  // The props are saved with the tab, so they seed the copy on every start until a choice is stored;
  // writing them would leave a storage file behind for each moved copy.
  for (const [stored, prop] of [
    [{}, "tw"],
    [{}, undefined],
    [{ "wickline.filter": "us" }, "tw"],
  ]) {
    const storage = fakeStorage(stored);
    openFilter(storage, prop);
    assert.deepEqual(storage.writes, [], JSON.stringify([stored, prop]));
  }
});
