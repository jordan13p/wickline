// node --test tests/  (settings.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_KEY_FINNHUB, SETTINGS_KEY, mergeSettings, misEnabled, misReconfirm, readSettings, upIsRed, validateSettings } from "../mods/bellwether/settings.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "../mods/bellwether/providers/mis.js";
import { STRINGS } from "../mods/bellwether/i18n.js";

const BINANCE = "https://data-api.binance.vision";
const DEFAULTS = { version: 1, language: "en", colors: "auto", languagePromptDismissed: false, sources: { tw: { provider: "yahoo", misUrl: MIS_URL, misAck: null }, crypto: { binanceUrl: BINANCE } } };

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
    { tw: DEFAULTS.sources.tw, crypto: { binanceUrl: "https://b.test", later: 1 }, future: { x: 2 } });
  // A change without sources leaves them as they were.
  assert.deepEqual(mergeSettings(raw, { language: "ja" }).sources,
    { tw: DEFAULTS.sources.tw, crypto: { binanceUrl: "https://a.test", later: 1 }, future: { x: 2 } });
});

const tw = (fields) => readSettings({ version: 1, sources: { tw: fields } });

test("consent gates MIS", () => {
  assert.equal(misEnabled(tw({ provider: "mis", misAck: null })), false);
  assert.equal(misEnabled(tw({ provider: "mis", misAck: { version: 0 } })), false);
  assert.equal(misEnabled(tw({ provider: "mis", misAck: { version: MIS_CONSENT_VERSION } })), true);
  // Consent alone does not turn it on.
  assert.equal(misEnabled(tw({ provider: "yahoo", misAck: { version: MIS_CONSENT_VERSION } })), false);
  assert.equal(readSettings({ version: 1, sources: { tw: { provider: "bogus" } } }).sources.tw.provider, "yahoo");
  for (const misAck of [{}, { version: "1" }, [], 1, { version: 1.5 }]) assert.equal(tw({ misAck }).sources.tw.misAck, null, JSON.stringify(misAck));
  assert.deepEqual(tw({ misAck: { version: 1, extra: true } }).sources.tw.misAck, { version: 1 });
  // An older consent asks again; Yahoo or a current consent does not.
  assert.equal(misReconfirm(tw({ provider: "mis", misAck: { version: 0 } })), true);
  assert.equal(misReconfirm(tw({ provider: "mis", misAck: null })), true);
  assert.equal(misReconfirm(tw({ provider: "mis", misAck: { version: MIS_CONSENT_VERSION } })), false);
  assert.equal(misReconfirm(tw({ provider: "yahoo", misAck: { version: 0 } })), false);
});

test("MIS needs consent and an https address to save", () => {
  const ack = { version: MIS_CONSENT_VERSION };
  assert.deepEqual(validateSettings(tw({ provider: "mis", misAck: null })), { "sources.tw.misAck": "mis.consentNeeded" });
  assert.deepEqual(validateSettings(tw({ provider: "mis", misAck: ack })), {});
  assert.deepEqual(validateSettings(tw({ provider: "mis", misAck: ack, misUrl: "http://x.test" })), { "sources.tw.misUrl": "url.notHttps" });
  // A hidden address (Yahoo chosen) does not block a save.
  assert.deepEqual(validateSettings(tw({ provider: "yahoo", misUrl: "http://x.test" })), {});
  assert.equal(tw({ misUrl: "https://mirror.test/mis" }).sources.tw.misUrl, "https://mirror.test/mis");
  for (const lang of Object.keys(STRINGS)) {
    for (const code of ["mis.consentNeeded", "mis.statement", "mis.consent", "mis.reconfirm"]) assert.ok(STRINGS[lang][code], `${lang} ${code}`);
  }
});
