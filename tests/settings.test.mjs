// node --test tests/  (settings.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_KEY_FINNHUB, SETTINGS_KEY, keyChange, mergeSettings, misEnabled, misReconfirm, readSettings, upIsRed, validateSettings } from "../mods/bellwether/settings.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "../mods/bellwether/providers/mis.js";
import { FINNHUB_URL } from "../mods/bellwether/providers/finnhub.js";
import { STRINGS } from "../mods/bellwether/i18n.js";

const BINANCE = "https://data-api.binance.vision";
const DEFAULTS = {
  version: 1, language: "en", colors: "auto", languagePromptDismissed: false, keyRev: 0,
  sources: {
    us: { provider: "yahoo", finnhubUrl: FINNHUB_URL, budgetPerMinute: 60 },
    tw: { provider: "yahoo", misUrl: MIS_URL, misAck: null },
    crypto: { binanceUrl: BINANCE },
  },
};

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
    { us: DEFAULTS.sources.us, tw: DEFAULTS.sources.tw, crypto: { binanceUrl: "https://b.test", later: 1 }, future: { x: 2 } });
  // A change without sources leaves them as they were.
  assert.deepEqual(mergeSettings(raw, { language: "ja" }).sources,
    { us: DEFAULTS.sources.us, tw: DEFAULTS.sources.tw, crypto: { binanceUrl: "https://a.test", later: 1 }, future: { x: 2 } });
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

test("a save stores URLs without surrounding spaces", () => {
  const change = { sources: { tw: { provider: "mis", misUrl: ` ${MIS_URL}\t`, misAck: { version: MIS_CONSENT_VERSION } },
    crypto: { binanceUrl: "  https://mirror.test/x " } } };
  const saved = mergeSettings(undefined, change);
  assert.equal(saved.sources.tw.misUrl, MIS_URL);
  assert.equal(saved.sources.crypto.binanceUrl, "https://mirror.test/x");
  // Spaces inside an address are kept, so the dialog still refuses it.
  const inner = mergeSettings(undefined, { sources: { crypto: { binanceUrl: " https://a b.test " } } });
  assert.equal(inner.sources.crypto.binanceUrl, "https://a b.test");
  assert.deepEqual(validateSettings(readSettings(inner)), { "sources.crypto.binanceUrl": "url.invalid" });
});

const us = (fields) => readSettings({ version: 1, sources: { us: fields } });

test("budget validation", () => {
  assert.deepEqual(validateSettings(us({ provider: "finnhub", budgetPerMinute: 3 })), { "sources.us.budgetPerMinute": "budget.tooSmall" });
  assert.equal(us({ budgetPerMinute: "60" }).sources.us.budgetPerMinute, 60);
  assert.equal(us({ budgetPerMinute: "30" }).sources.us.budgetPerMinute, 60);
  assert.equal(us({ budgetPerMinute: 30 }).sources.us.budgetPerMinute, 30);
  for (const bad of [4.5, null, -8, {}]) assert.equal(us({ budgetPerMinute: bad }).sources.us.budgetPerMinute, 60, String(bad));
  assert.deepEqual(validateSettings(us({ provider: "finnhub", budgetPerMinute: 4 })), {});
  // A draft holds what is typed until it is a whole number.
  for (const typed of ["", "12a", "4.5", 0]) {
    const draft = us({ provider: "finnhub" });
    draft.sources.us.budgetPerMinute = typed;
    assert.deepEqual(validateSettings(draft), { "sources.us.budgetPerMinute": "budget.tooSmall" }, String(typed));
  }
  // Hidden while Yahoo is chosen: never blocks a save.
  assert.deepEqual(validateSettings(us({ provider: "yahoo", budgetPerMinute: 3 })), {});
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["budget.tooSmall"], lang);
});

test("reads the US source and the key revision", () => {
  assert.equal(us({ provider: "bogus" }).sources.us.provider, "yahoo");
  assert.equal(us({ provider: "finnhub" }).sources.us.provider, "finnhub");
  assert.equal(us({ finnhubUrl: "https://mirror.test/fh" }).sources.us.finnhubUrl, "https://mirror.test/fh");
  assert.equal(readSettings({ keyRev: 3 }).keyRev, 3);
  for (const bad of ["3", -1, 1.5, null]) assert.equal(readSettings({ keyRev: bad }).keyRev, 0, String(bad));
});

test("Finnhub needs an https address and a key to save", () => {
  assert.deepEqual(validateSettings(us({ provider: "finnhub", finnhubUrl: "http://x.test" })), { "sources.us.finnhubUrl": "url.notHttps" });
  assert.deepEqual(validateSettings(us({ provider: "yahoo", finnhubUrl: "http://x.test" })), {});
  // The key is checked only when the dialog passes what is typed.
  assert.deepEqual(validateSettings(us({ provider: "finnhub" }), { finnhubKey: " " }), { "sources.us.key": "finnhub.keyNeeded" });
  assert.deepEqual(validateSettings(us({ provider: "finnhub" }), { finnhubKey: "test-key" }), {});
  assert.deepEqual(validateSettings(us({ provider: "yahoo" }), { finnhubKey: "" }), {});
  const saved = mergeSettings(undefined, { sources: { us: { provider: "finnhub", finnhubUrl: ` ${FINNHUB_URL} ` } } });
  assert.equal(saved.sources.us.finnhubUrl, FINNHUB_URL);
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["finnhub.keyNeeded"], lang);
});

test("what a save does with the key", () => {
  // Finnhub chosen: a new key is written; the same one is not written again.
  assert.equal(keyChange({ provider: "finnhub", typed: "new-key", saved: "old-key" }), "write");
  assert.equal(keyChange({ provider: "finnhub", typed: "new-key", saved: null }), "write");
  assert.equal(keyChange({ provider: "finnhub", typed: "old-key", saved: "old-key" }), null);
  // Yahoo chosen with the field cleared: the saved key is removed.
  assert.equal(keyChange({ provider: "yahoo", typed: "", saved: "old-key" }), "remove");
  // Yahoo alone keeps the key, also with another key typed; nothing to remove without a saved key.
  assert.equal(keyChange({ provider: "yahoo", typed: "old-key", saved: "old-key" }), null);
  assert.equal(keyChange({ provider: "yahoo", typed: "new-key", saved: "old-key" }), null);
  assert.equal(keyChange({ provider: "yahoo", typed: "", saved: null }), null);
});
