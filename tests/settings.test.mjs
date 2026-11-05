// node --test tests/  (settings.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_KEY_FINNHUB, SETTINGS_KEY, mergeSettings, readSettings, upIsRed, validateSettings } from "../mods/bellwether/settings.js";
import { STRINGS } from "../mods/bellwether/i18n.js";

const BINANCE = "https://data-api.binance.vision";
const DEFAULTS = { version: 1, language: "en", colors: "auto", languagePromptDismissed: false, sources: { crypto: { binanceUrl: BINANCE } } };

test("reads settings defensively", () => {
  assert.equal(SETTINGS_KEY, "bellwether.settings.v1");
  assert.deepEqual(readSettings(undefined), DEFAULTS);
  assert.deepEqual(readSettings(null), DEFAULTS);
  assert.deepEqual(readSettings("en"), DEFAULTS);
  assert.deepEqual(readSettings({ version: 1, language: "fr", colors: "pink", languagePromptDismissed: "yes" }), DEFAULTS);
  assert.deepEqual(readSettings({ language: "ja" }), { ...DEFAULTS, language: "ja" });
  assert.deepEqual(readSettings({ language: "ko", colors: "red-up", languagePromptDismissed: 1 }),
    { ...DEFAULTS, language: "ko", colors: "red-up" });
  assert.deepEqual(readSettings([]), DEFAULTS);
  assert.deepEqual(readSettings({ version: 1, language: "ko", colors: "green-up", languagePromptDismissed: true }),
    { ...DEFAULTS, language: "ko", colors: "green-up", languagePromptDismissed: true });
});

test("reads the sources field by field", () => {
  const url = (binanceUrl) => readSettings({ version: 1, sources: { crypto: { binanceUrl } } }).sources.crypto.binanceUrl;
  assert.equal(url("https://mirror.test"), "https://mirror.test");
  // Kept as written so the dialog can name the problem; only a non-string or blank value falls back.
  assert.equal(url("http://x.test"), "http://x.test");
  for (const bad of [42, null, {}, "", "  "]) assert.equal(url(bad), BINANCE, String(bad));
  for (const sources of [undefined, null, "x", [], { crypto: null }, { crypto: [] }]) {
    assert.deepEqual(readSettings({ sources }).sources, DEFAULTS.sources);
  }
});

test("validates URLs", () => {
  const check = (binanceUrl) => validateSettings(readSettings({ version: 1, sources: { crypto: { binanceUrl } } }));
  assert.deepEqual(check("http://x.test"), { "sources.crypto.binanceUrl": "url.notHttps" });
  assert.deepEqual(validateSettings(readSettings(undefined)), {});
  assert.deepEqual(check("https://mirror.test"), {});
  assert.deepEqual(check("https://mirror.test/proxy"), {});
  assert.deepEqual(check("HTTPS://mirror.test"), {});
  assert.deepEqual(check("https://mirror.test/x"), {});
  for (const bad of ["https://", "https:///x", "https://a b.test", "https://x.test?a=1", "https://x.test#top",
    "https://u:p@mirror.test", "https://user@mirror.test/x", "https://.", "https://:", "https://-.:/x"]) {
    assert.deepEqual(check(bad), { "sources.crypto.binanceUrl": "url.invalid" }, bad);
  }
  // Spaces around the address are ignored, as when it is read back.
  assert.deepEqual(validateSettings({ sources: { crypto: { binanceUrl: " https://mirror.test " } } }), {});
  assert.deepEqual(validateSettings({ sources: { crypto: { binanceUrl: "  " } } }), { "sources.crypto.binanceUrl": "url.notHttps" });
  // A draft that the person is still typing is validated as it is, not read again.
  assert.deepEqual(validateSettings({ sources: { crypto: { binanceUrl: "" } } }), { "sources.crypto.binanceUrl": "url.notHttps" });
  for (const lang of Object.keys(STRINGS)) {
    for (const code of ["url.notHttps", "url.invalid"]) assert.ok(STRINGS[lang][code], `${lang} ${code}`);
  }
});

test("the Finnhub key lives outside shared state", () => {
  assert.equal(SECRET_KEY_FINNHUB, "finnhub.key");
});

test("red-up by language", () => {
  assert.equal(upIsRed({ language: "zh-TW", colors: "auto" }), true);
  for (const language of ["zh-CN", "ja", "ko"]) assert.equal(upIsRed({ language, colors: "auto" }), true, language);
  assert.equal(upIsRed({ language: "en", colors: "auto" }), false);
  assert.equal(upIsRed({ language: "en", colors: "red-up" }), true);
  assert.equal(upIsRed({ language: "ko", colors: "green-up" }), false);
});

test("a save keeps keys this build does not know", () => {
  assert.deepEqual(mergeSettings({ version: 1, language: "fr", later: { x: 1 } }, { languagePromptDismissed: true }),
    { ...DEFAULTS, languagePromptDismissed: true, later: { x: 1 } });
  assert.deepEqual(mergeSettings(undefined, { language: "ja" }), { ...DEFAULTS, language: "ja" });
  assert.deepEqual(mergeSettings("junk", {}), DEFAULTS);
});

test("a save keeps sources keys this build does not know", () => {
  const raw = { version: 1, sources: { crypto: { binanceUrl: "https://a.test", later: 1 }, future: { x: 2 } } };
  const change = { sources: { crypto: { binanceUrl: "https://b.test" } } };
  assert.deepEqual(mergeSettings(raw, change).sources,
    { crypto: { binanceUrl: "https://b.test", later: 1 }, future: { x: 2 } });
  // A change without sources leaves them as they were.
  assert.deepEqual(mergeSettings(raw, { language: "ja" }).sources,
    { crypto: { binanceUrl: "https://a.test", later: 1 }, future: { x: 2 } });
});
