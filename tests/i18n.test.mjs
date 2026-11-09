// node --test tests/  (i18n.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, LANGUAGE_LABELS, STRINGS, t } from "../mods/wickline/i18n.js";
import { MESSAGES_EN } from "../mods/wickline/quotes.js";

const tokens = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test("five languages with their own names", () => {
  assert.deepEqual(LANGUAGES, ["en", "zh-TW", "zh-CN", "ja", "ko"]);
  assert.deepEqual(LANGUAGE_LABELS, { en: "English", "zh-TW": "繁中", "zh-CN": "简中", ja: "日本語", ko: "한국어" });
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LANGUAGES].sort());
});

test("every language has every key", () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const code of Object.keys(MESSAGES_EN)) assert.ok(keys.includes(code), code);
  for (const lang of LANGUAGES) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);
});

test("placeholders match", () => {
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries(STRINGS.en)) {
      assert.deepEqual(tokens(STRINGS[lang][key]), tokens(text), `${lang} ${key}`);
    }
  }
});

test("every text is filled in and other languages are translated", () => {
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries(STRINGS[lang])) assert.ok(text.trim().length > 0, `${lang} ${key}`);
  }
  for (const lang of LANGUAGES.slice(1)) assert.notEqual(STRINGS[lang]["notice.added"], STRINGS.en["notice.added"], lang);
});

test("a failed settings save has its own text", () => {
  assert.equal(t("en", "error.saveSettings"), "Could not save the settings.");
  assert.notEqual(t("en", "error.saveSettings"), t("en", "error.save"));
});

test("falls back to English", () => {
  assert.equal(t("ja", "no.such"), "no.such");
  assert.equal(t("xx", "notice.added", { symbol: "AAPL" }), "Added AAPL.");
  assert.equal(t("zh-TW", "notice.added", { symbol: "AAPL" }).includes("AAPL"), true);
});

test("reviewed terms", () => {
  const tw = STRINGS["zh-TW"];
  // 開盤中 ("market open") is correct; only 盤中 as "intraday" was wrong.
  for (const [key, text] of Object.entries(tw)) assert.ok(!text.replaceAll("開盤中", "").includes("盤中"), `zh-TW ${key}`);
  assert.ok(tw["disclaimer.sourcesStocks"].includes("一般交易時段"));
  assert.ok(tw["detail.sourceStock"].includes("一般交易時段"));
  assert.equal(tw["button.refresh"], "重新整理");
  // The Finnhub key is 「API 金鑰」 throughout, never "key".
  for (const [key, text] of Object.entries(tw)) assert.ok(!/key/i.test(text), `zh-TW ${key}`);
  for (const key of ["sources.us.keyNote", "finnhub.noKey", "error.saveKey", "settings.ownKey"]) {
    assert.ok(tw[key].includes("API 金鑰"), `zh-TW ${key}`);
  }

  const ko = STRINGS.ko;
  for (const [key, text] of Object.entries(ko)) assert.ok(!text.includes("관심 목록"), `ko ${key}`);
  for (const key of Object.keys(STRINGS.en)) {
    if (/watchlist/i.test(STRINGS.en[key])) assert.ok(ko[key].includes("관심종목"), `ko ${key}`);
  }
  for (const [key, text] of Object.entries(ko)) assert.ok(!text.includes("티커"), `ko ${key}`);
  assert.deepEqual([ko["session.pre"], ko["session.open"], ko["session.post"]], ["프리마켓", "장중", "애프터마켓"]);

  const ja = STRINGS.ja;
  assert.ok(ja["input.placeholder"].includes("銘柄コード"));
  for (const [key, text] of Object.entries(ja)) assert.ok(!text.includes("ティッカー"), `ja ${key}`);

  assert.equal(STRINGS["zh-CN"]["row.unavailable"], "暂无数据");
  assert.equal(STRINGS["zh-CN"]["band.unavailable"], "暂无数据");

  for (const lang of ["zh-TW", "zh-CN", "ja", "ko"]) {
    for (const [key, text] of Object.entries(STRINGS[lang])) assert.ok(!text.includes("24h"), `${lang} ${key}`);
  }
});

test("icon tooltips, table labels and the source legend", () => {
  const keys = ["button.ownTab", "button.backBeside", "button.remove", "status.updated", "table.symbol", "table.name",
    "table.state", "table.line", "table.price", "table.change", "table.changePct",
    "disclaimer.sourcesTitle", "disclaimer.sourcesStocks", "disclaimer.sourcesCrypto"];
  for (const key of keys) assert.ok(key in STRINGS.en, key);
  assert.equal(t("zh-TW", "button.ownTab"), "在自己的分頁開啟");
  assert.equal(t("zh-TW", "button.backBeside"), "回到側邊");
  assert.equal(t("zh-TW", "button.settings"), "設定");
  assert.equal(t("en", "status.updated", { time: "14:05" }), "Updated 14:05");
  // The legend lives in the Disclaimer & privacy tab now; the footer is one line.
  for (const lang of LANGUAGES) {
    assert.ok(!("footer.sources" in STRINGS[lang]) && !("footer.sourcesCrypto" in STRINGS[lang]), lang);
  }
});

test("the language choice lives in the Display tab", () => {
  for (const lang of LANGUAGES) {
    assert.ok(!("settings.tab.language" in STRINGS[lang]), lang);
    assert.ok(STRINGS[lang]["display.language"] && STRINGS[lang]["display.languageHint"], lang);
  }
  assert.equal(t("zh-TW", "display.languageHint"), "只改變介面文字，不影響報價。");
});

const ONLY_FILTER = { en: /nothing else is kept there/, "zh-TW": /只存這一項/, "zh-CN": /只存这一项/, ja: /これだけ/, ko: /이것만/ };
test("the storage disclosure names every key and the per-copy filter in all five languages", () => {
  for (const lang of LANGUAGES) {
    const text = STRINGS[lang]["privacy.storage"];
    for (const name of ["wickline.watchlist.v1", "wickline.settings.v1", "wickline.dockTab", "wickline.filter", "localStorage"]) {
      assert.ok(text.includes(name), `${lang} ${name}`);
    }
    // The filter is the only thing kept in localStorage.
    assert.match(text, ONLY_FILTER[lang], `${lang} only the filter`);
  }
});

test("every market has a label in all five languages", () => {
  for (const lang of LANGUAGES) {
    for (const id of ["us", "tw", "hk", "cn", "jp", "kr", "crypto", "other"]) assert.ok(STRINGS[lang][`market.${id}`], `${lang} market.${id}`);
    assert.ok(STRINGS[lang]["filter.all"], `${lang} filter.all`);
  }
  assert.equal(t("zh-TW", "market.tw"), "台股");
});

// Code points from U+1100 up (Hangul, kana, CJK) are drawn two columns wide.
const width = (text) => [...text].reduce((sum, char) => sum + (char.codePointAt(0) >= 0x1100 ? 2 : 1), 0);

test("the live label is never wider than Binance Spot", () => {
  for (const lang of LANGUAGES) assert.ok(width(STRINGS[lang]["freshness.live"]) <= width("Binance Spot"), lang);
});

test("the settings pages say Delayed, capitalized, with or without the minutes", () => {
  assert.equal(t("en", "settings.delayed"), "Delayed");
  assert.equal(t("en", "settings.delayedMinutes", { minutes: 20 }), "Delayed 20 min");
  assert.equal(t("zh-TW", "settings.delayedMinutes", { minutes: 20 }), "延遲 20 分鐘");
});
