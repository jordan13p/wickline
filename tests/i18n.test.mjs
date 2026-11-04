// node --test tests/  (i18n.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, LANGUAGE_LABELS, STRINGS, t } from "../mods/bellwether/i18n.js";
import { MESSAGES_EN } from "../mods/bellwether/quotes.js";

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
  assert.ok(tw["footer.sources"].includes("一般交易時段"));
  assert.ok(tw["detail.sourceStock"].includes("一般交易時段"));
  assert.equal(tw["button.refresh"], "重新整理");

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
