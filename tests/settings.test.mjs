// node --test tests/  (settings.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  SECRET_KEY_FINNHUB, SETTINGS_KEY, SETTINGS_MARKETS, consentCollapsed, consentGiven, currentHealth, finnhubKeyUsable, firstDraftError, keyChange, marketState, marketStatus,
  mergeSettings,
  misEnabled, misReconfirm, readSettings, settingsMarkets, upIsRed, validateSettings, yahootwEnabled, yahootwReconfirm,
} from "../mods/wickline/settings.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "../mods/wickline/providers/mis.js";
import { FINNHUB_URL } from "../mods/wickline/providers/finnhub.js";
import { YAHOOTW_CONSENT_VERSION } from "../mods/wickline/providers/yahootw.js";
import { STRINGS } from "../mods/wickline/i18n.js";

const BINANCE = "https://data-api.binance.vision";
const DEFAULTS = {
  version: 1, language: "en", colors: "auto", languagePromptDismissed: false, keyRev: 0,
  sources: {
    us: { provider: "yahoo", finnhubUrl: FINNHUB_URL, budgetPerMinute: 60 },
    tw: { provider: "yahoo", mis: false, yahootw: false, misUrl: MIS_URL, misAck: null, yahootwAck: null },
    crypto: { binanceUrl: BINANCE },
  },
};

test("reads settings defensively", () => {
  assert.equal(SETTINGS_KEY, "wickline.settings.v1");
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
  assert.equal(readSettings({ version: 1, sources: { tw: { provider: "bogus" } } }).sources.tw.mis, false);
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
  // A hidden address (MIS off) does not block a save.
  assert.deepEqual(validateSettings(tw({ mis: false, misUrl: "http://x.test" })), {});
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

test("an old MIS choice loads as the MIS switch", () => {
  const settings = tw({ provider: "mis", misAck: { version: MIS_CONSENT_VERSION } });
  assert.equal(settings.sources.tw.mis, true);
  assert.equal(settings.sources.tw.yahootw, false);
  assert.equal(misEnabled(settings), true);
});

test("a choice changed in 0.3.1 after a downgrade wins on upgrade", () => {
  // Every save writes both keys in step, so only 0.3.1 (which writes `provider` alone) leaves them apart.
  const ack = { version: MIS_CONSENT_VERSION };
  assert.equal(misEnabled(tw({ provider: "yahoo", mis: true, misAck: ack })), false);
  assert.equal(tw({ provider: "yahoo", mis: true }).sources.tw.provider, "yahoo");
  assert.equal(misEnabled(tw({ provider: "mis", mis: false, misAck: ack })), true);
  assert.equal(tw({ provider: "mis", mis: false }).sources.tw.provider, "mis");
  // Without the old key, the switch alone decides.
  assert.equal(tw({ mis: true }).sources.tw.mis, true);
  assert.equal(tw({ mis: "true" }).sources.tw.mis, false);
});

test("an outdated MIS consent still asks again", () => {
  assert.equal(misReconfirm(tw({ mis: true, misAck: { version: 1 } })), true);
});

test("Yahoo 奇摩股市 needs its own consent", () => {
  assert.equal(validateSettings(tw({ yahootw: true }))["sources.tw.yahootwAck"], "yahootw.consentNeeded");
  assert.deepEqual(validateSettings(tw({ yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION } })), {});
  // A MIS consent does not stand in for it.
  assert.equal(validateSettings(tw({ yahootw: true, misAck: { version: MIS_CONSENT_VERSION } }))["sources.tw.yahootwAck"], "yahootw.consentNeeded");
  assert.equal(yahootwEnabled(tw({ yahootw: true, misAck: { version: MIS_CONSENT_VERSION } })), false);
  // Consent alone does not turn it on.
  assert.equal(yahootwEnabled(tw({ yahootwAck: { version: YAHOOTW_CONSENT_VERSION } })), false);
  assert.equal(yahootwReconfirm(tw({ yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION - 1 } })), true);
  assert.equal(yahootwReconfirm(tw({ yahootw: false })), false);
  for (const yahootw of ["true", 1, null]) assert.equal(tw({ yahootw }).sources.tw.yahootw, false, String(yahootw));
  for (const lang of Object.keys(STRINGS)) {
    for (const code of ["yahootw.consentNeeded", "yahootw.statement", "yahootw.consent", "yahootw.reconfirm", "yahootw.prevails"]) {
      assert.ok(STRINGS[lang][code], `${lang} ${code}`);
    }
  }
});

test("consent versions are independent", () => {
  const settings = tw({ yahootw: true, yahootwAck: { version: 1 }, mis: true, misAck: { version: 1 } });
  assert.equal(yahootwEnabled(settings), true);
  assert.equal(misReconfirm(settings), true);
});

test("a fresh install has both Taiwan switches off", () => {
  const { tw: fresh } = readSettings(undefined).sources;
  assert.equal(fresh.mis, false);
  assert.equal(fresh.yahootw, false);
});

test("a save also writes the old provider key", () => {
  // 0.3.1 reads only `provider`: going back keeps the person's MIS choice.
  assert.equal(mergeSettings({}, { sources: { tw: { mis: true } } }).sources.tw.provider, "mis");
  assert.equal(mergeSettings({}, { sources: { tw: { mis: false } } }).sources.tw.provider, "yahoo");
  // A stale provider in the dialog's draft never wins over the switch.
  assert.equal(mergeSettings({}, { sources: { tw: { provider: "mis", mis: false } } }).sources.tw.provider, "yahoo");
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

test("the Finnhub address keeps the host finnhub.io; only its path can change", () => {
  const check = (finnhubUrl) => validateSettings(us({ provider: "finnhub", finnhubUrl }));
  for (const good of [FINNHUB_URL, "https://finnhub.io", "https://finnhub.io/", "https://FINNHUB.io/api/v2", " https://finnhub.io/api/v1 "]) {
    assert.deepEqual(check(good), {}, good);
  }
  for (const bad of ["https://evil.test", "https://finnhub.io.evil.test/api/v1", "https://evil.test/finnhub.io", "https://user@finnhub.io/api/v1",
    "https://finnhub.io:8443/api/v1", "https://finnhub.io./api/v1", "https://finnhub.io/api/v1?x=1", "https://finnhub.io/api/v1#x",
    "https://finnhub.io/api v1", "https://api.finnhub.io/v1"]) {
    assert.deepEqual(check(bad), { "sources.us.finnhubUrl": "url.finnhubHost" }, bad);
  }
  assert.deepEqual(check("http://finnhub.io/api/v1"), { "sources.us.finnhubUrl": "url.notHttps" });
  // Not checked while Yahoo is chosen, and kept as written so the dialog can name the problem.
  assert.deepEqual(validateSettings(us({ provider: "yahoo", finnhubUrl: "https://evil.test" })), {});
  assert.equal(us({ finnhubUrl: "https://evil.test" }).sources.us.finnhubUrl, "https://evil.test");
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["url.finnhubHost"], lang);
});

test("what a save does with the key", () => {
  // The dialog never holds the saved key: a typed key replaces it while Finnhub is chosen.
  assert.equal(keyChange({ provider: "finnhub", typed: "test-key-new", saved: true, removing: false }), "write");
  assert.equal(keyChange({ provider: "finnhub", typed: "test-key-new", saved: false, removing: false }), "write");
  assert.equal(keyChange({ provider: "finnhub", typed: "test-key-new", saved: true, removing: true }), "write");
  // An empty field keeps the saved key.
  assert.equal(keyChange({ provider: "finnhub", typed: "", saved: true, removing: false }), null);
  // Remove, then Save: the saved key goes, with either source chosen.
  assert.equal(keyChange({ provider: "yahoo", typed: "", saved: true, removing: true }), "remove");
  assert.equal(keyChange({ provider: "finnhub", typed: "", saved: true, removing: true }), "remove");
  // Yahoo alone keeps the key, also with a key left typed; nothing to remove without a saved key.
  assert.equal(keyChange({ provider: "yahoo", typed: "", saved: true, removing: false }), null);
  assert.equal(keyChange({ provider: "yahoo", typed: "test-key-new", saved: true, removing: false }), null);
  assert.equal(keyChange({ provider: "yahoo", typed: "", saved: false, removing: true }), null);
});

test("a typed key is trimmed, has no spaces inside and at most 128 characters", () => {
  const check = (finnhubKey, keySaved = false) => validateSettings(us({ provider: "finnhub" }), { finnhubKey, keySaved });
  assert.deepEqual(check("  test-key-0123  "), {});
  assert.deepEqual(check("t".repeat(128)), {});
  for (const bad of ["test key", "test-key\n2", "test\tkey", "t".repeat(129), "test\u0000key"]) {
    assert.deepEqual(check(bad), { "sources.us.key": "finnhub.keyInvalid" }, JSON.stringify(bad));
  }
  // An empty field is the saved key, if there is one (and it is not being removed).
  assert.deepEqual(check("", true), {});
  assert.deepEqual(check("", false), { "sources.us.key": "finnhub.keyNeeded" });
  assert.deepEqual(check("test key", true), { "sources.us.key": "finnhub.keyInvalid" });
  // Not checked while Yahoo is chosen: there is no field to type in.
  assert.deepEqual(validateSettings(us({ provider: "yahoo" }), { finnhubKey: "test key", keySaved: true }), {});
  for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang]["finnhub.keyInvalid"], lang);
});

test("the key texts say what lifts a stop, what Remove needs and that a chmod warning loses nothing", () => {
  // Any change to the US settings (or a new key) lifts finnhub.redirected, not only the source.
  assert.match(STRINGS.en["finnhub.redirected"], /US settings/);
  assert.match(STRINGS["zh-TW"]["finnhub.redirected"], /美股設定/);
  // Remove with Finnhub on blocks Save until a key is typed or Finnhub is turned off.
  assert.match(STRINGS.en["sources.us.keyRemoveHint"], /turn Finnhub off/);
  // The warning comes after both saves, so Cancel is safe.
  assert.match(STRINGS.en["finnhub.keyUnprotected"], /settings and the key are saved/);
  for (const lang of Object.keys(STRINGS)) {
    for (const key of ["sources.us.keyRemoveHint", "finnhub.keyUnprotected", "finnhub.redirected"]) assert.ok(STRINGS[lang][key], `${lang} ${key}`);
  }
});

test("marketState: Taiwan", () => {
  const delayed = { live: false, source: "yahoo" };
  const yahootwAck = { version: YAHOOTW_CONSENT_VERSION };
  const misAck = { version: MIS_CONSENT_VERSION };
  assert.deepEqual(marketState(readSettings(undefined), "tw"), delayed);
  assert.deepEqual(marketState(tw({ yahootw: true }), "tw"), delayed);
  assert.deepEqual(marketState(tw({ yahootw: true, yahootwAck }), "tw"), { live: true, source: "yahootw" });
  assert.deepEqual(marketState(tw({ mis: true, misAck }), "tw"), { live: true, source: "mis" });
  assert.deepEqual(marketState(tw({ yahootw: true, yahootwAck, mis: true, misAck }), "tw"), { live: true, source: "yahootw" });
  assert.deepEqual(marketState(tw({ mis: true, misAck: { version: MIS_CONSENT_VERSION - 1 } }), "tw"), delayed);
});

test("marketState: US", () => {
  assert.deepEqual(marketState(us({ provider: "finnhub" }), "us"), { live: false, source: "yahoo" });
  assert.deepEqual(marketState(us({ provider: "finnhub" }), "us", { keyAvailable: true }), { live: true, source: "finnhub" });
  assert.deepEqual(marketState(us({ provider: "yahoo" }), "us", { keyAvailable: true }), { live: false, source: "yahoo" });
});

test("marketState: crypto and other", () => {
  assert.deepEqual(marketState(readSettings(undefined), "crypto"), { live: true, source: "binance" });
  assert.deepEqual(marketState(readSettings(undefined), "other"), { live: false, source: "yahoo" });
});

test("finnhubKeyUsable", () => {
  const none = { typed: "", typedValid: true, saved: false, removing: false, health: [] };
  assert.equal(finnhubKeyUsable(none), false);
  // A typed key counts once well formed, whatever happens to the saved one.
  assert.equal(finnhubKeyUsable({ ...none, typed: "abc" }), true);
  assert.equal(finnhubKeyUsable({ ...none, typed: "abc", typedValid: false }), false);
  assert.equal(finnhubKeyUsable({ ...none, typed: "abc", saved: true, removing: true }), true);
  // ...and alone: a malformed typed key never falls back to the saved one.
  assert.equal(finnhubKeyUsable({ ...none, typed: "a b", typedValid: false, saved: true }), false);
  // A stop on the address refuses a typed key too; a stop on the key does not.
  const stopped = (code) => [{ provider: "finnhub", code, stopped: true }];
  for (const code of ["finnhub.redirected", "finnhub.badUrl"]) assert.equal(finnhubKeyUsable({ ...none, typed: "abc", health: stopped(code) }), false, code);
  assert.equal(finnhubKeyUsable({ ...none, typed: "abc", health: stopped("finnhub.invalidKey") }), true);
  // The saved key counts while it stays and Finnhub has not stopped on it.
  assert.equal(finnhubKeyUsable({ ...none, saved: true }), true);
  assert.equal(finnhubKeyUsable({ ...none, saved: true, removing: true }), false);
  // Stopped is what problems() says, whatever the code: no list of codes to keep in step.
  for (const code of ["finnhub.invalidKey", "finnhub.secretUnreadable", "finnhub.someNewStop"]) {
    assert.equal(finnhubKeyUsable({ ...none, saved: true, health: [{ provider: "finnhub", code, stopped: true }] }), false, code);
  }
  assert.equal(finnhubKeyUsable({ ...none, saved: true, health: [{ provider: "finnhub", code: "finnhub.invalidKey" }] }), true);
  assert.equal(finnhubKeyUsable({ ...none, saved: true, health: [{ provider: "finnhub", code: "finnhub.rateLimited" }] }), true);
  assert.equal(finnhubKeyUsable({ ...none, saved: true, health: [{ provider: "yahoo", code: "finnhub.invalidKey", stopped: true }] }), true);
});

// The settings dialog's status for a market: the saved settings, a draft copy of them, the panel's
// health when the dialog opened and the key fields as the dialog holds them.
const copy = (settings) => JSON.parse(JSON.stringify(settings));
const NO_KEY = { typed: "", typedValid: true, saved: false, removing: false };
const status = ({ saved, draft = copy(saved), health = [], market, key = NO_KEY }) => {
  const { live, source, problem } = marketStatus({ saved, draft, health, market, key });
  return { live, source, problem };
};

test("marketStatus: the source in use and whether it is failing", () => {
  const misOn = tw({ mis: true, misAck: { version: MIS_CONSENT_VERSION } });
  const off = readSettings(undefined);
  const failing = (provider) => [{ provider, code: `${provider}.unreachable` }];
  // The source kept from the saved settings and listed in health.
  assert.deepEqual(status({ saved: misOn, health: failing("mis"), market: "tw" }), { live: true, source: "mis", problem: true });
  assert.deepEqual(status({ saved: off, health: failing("yahoo"), market: "tw" }), { live: false, source: "yahoo", problem: true });
  // Another source failing is not this market's problem.
  assert.deepEqual(status({ saved: misOn, health: failing("yahoo"), market: "tw" }), { live: true, source: "mis", problem: false });
  assert.deepEqual(status({ saved: misOn, market: "tw" }), { live: true, source: "mis", problem: false });
  // A changed choice is not judged by the saved source's problem.
  assert.deepEqual(status({ saved: misOn, draft: off, health: failing("mis"), market: "tw" }), { live: false, source: "yahoo", problem: false });
  assert.deepEqual(status({ saved: off, draft: misOn, health: failing("mis"), market: "tw" }), { live: true, source: "mis", problem: false });
  // The saved key picks the US source; a failing Finnhub that has not stopped is still the one in use.
  const finnhub = us({ provider: "finnhub" });
  const savedKey = { ...NO_KEY, saved: true };
  assert.deepEqual(status({ saved: finnhub, health: failing("finnhub"), market: "us", key: savedKey }), { live: true, source: "finnhub", problem: true });
  assert.deepEqual(status({ saved: finnhub, health: failing("finnhub"), market: "us" }), { live: false, source: "yahoo", problem: false });
});

test("marketStatus: health counts only while its source's settings are as saved", () => {
  const finnhub = us({ provider: "finnhub" });
  const savedKey = { ...NO_KEY, saved: true };
  const stop = (code) => [{ provider: "finnhub", code, params: {}, stopped: true }];
  // A key typed over a refused one is judged by the choice alone: Save writes it and Finnhub tries it.
  assert.deepEqual(status({ saved: finnhub, health: stop("finnhub.invalidKey"), market: "us", key: { ...savedKey, typed: "new-key" } }),
    { live: true, source: "finnhub", problem: false });
  // So is a new Binance address after a region refusal: crypto has no fallback, so the choice says live.
  const crypto = readSettings(undefined);
  const moved = copy(crypto);
  moved.sources.crypto.binanceUrl = "https://example.com";
  const region = [{ provider: "binance", code: "binance.region", params: {} }];
  assert.deepEqual(status({ saved: crypto, draft: moved, health: region, market: "crypto" }), { live: true, source: "binance", problem: false });
  // And a new Finnhub path after a redirect: the saved key would be sent again after Save.
  const path = copy(finnhub);
  path.sources.us.finnhubUrl = "https://finnhub.io/api/v2";
  assert.deepEqual(status({ saved: finnhub, draft: path, health: stop("finnhub.redirected"), market: "us", key: savedKey }),
    { live: true, source: "finnhub", problem: false });
  // Remove pending is a change too: no key is left, so the market reads delayed, not failing.
  assert.deepEqual(status({ saved: finnhub, health: stop("finnhub.invalidKey"), market: "us", key: { ...savedKey, removing: true } }),
    { live: false, source: "yahoo", problem: false });
  // Unchanged, the old problem still shows.
  assert.deepEqual(status({ saved: crypto, health: region, market: "crypto" }), { live: true, source: "binance", problem: true });
  assert.deepEqual(status({ saved: finnhub, health: stop("finnhub.redirected"), market: "us", key: savedKey }),
    { live: false, source: "yahoo", problem: false });
  assert.deepEqual(status({ saved: finnhub, health: [{ provider: "finnhub", code: "finnhub.rateLimited", params: {} }], market: "us", key: savedKey }),
    { live: true, source: "finnhub", problem: true });
  // A Finnhub stop lifts only by what caused it: a budget edit keeps a refused key refused.
  const budget = copy(finnhub);
  budget.sources.us.budgetPerMinute = 30;
  for (const code of ["finnhub.invalidKey", "finnhub.noKey", "finnhub.secretUnreadable", "finnhub.redirected", "finnhub.badUrl"]) {
    assert.deepEqual(status({ saved: finnhub, draft: budget, health: stop(code), market: "us", key: savedKey }),
      { live: false, source: "yahoo", problem: false }, code);
  }
  // A new address does not lift a refused key; a key typed does not lift a refused address.
  assert.deepEqual(status({ saved: finnhub, draft: path, health: stop("finnhub.invalidKey"), market: "us", key: savedKey }),
    { live: false, source: "yahoo", problem: false });
  assert.deepEqual(currentHealth({ saved: finnhub, draft: copy(finnhub), health: stop("finnhub.badUrl"), keyEdited: true }), stop("finnhub.badUrl"));
  // Yahoo Finance reads no settings: no edit drops its problem, so a delayed market it serves reads Problem.
  const yahooDown = [{ provider: "yahoo", code: "yahoo.unreachable", params: {} }];
  assert.deepEqual(status({ saved: finnhub, draft: budget, health: yahooDown, market: "us" }), { live: false, source: "yahoo", problem: true });
  // A typed key decides alone: a malformed one is not saved, and the refused saved key is not used either.
  const badKey = { ...savedKey, typed: "bad key", typedValid: false };
  assert.deepEqual(status({ saved: finnhub, health: stop("finnhub.invalidKey"), market: "us", key: badKey }),
    { live: false, source: "yahoo", problem: false });
  // A refused address refuses every key, typed or saved: after Save the US uses Yahoo Finance.
  const typedKey = { ...savedKey, typed: "new-key" };
  assert.deepEqual(status({ saved: finnhub, health: stop("finnhub.redirected"), market: "us", key: typedKey }),
    { live: false, source: "yahoo", problem: false });
  assert.deepEqual(status({ saved: finnhub, draft: path, health: stop("finnhub.redirected"), market: "us", key: typedKey }),
    { live: true, source: "finnhub", problem: false });
  // A change on another market's page leaves this one's health in force.
  const elsewhere = copy(crypto);
  elsewhere.sources.tw.mis = true;
  assert.deepEqual(status({ saved: crypto, draft: elsewhere, health: region, market: "crypto" }), { live: true, source: "binance", problem: true });
});

test("marketStatus: a failing source hands the market to the next one switched on", () => {
  const both = tw({ yahootw: true, yahootwAck: { version: YAHOOTW_CONSENT_VERSION }, mis: true, misAck: { version: MIS_CONSENT_VERSION } });
  const down = (provider) => ({ provider, code: `${provider}.unreachable`, params: {} });
  // Yahoo 奇摩股市 unreachable, MIS healthy: the rows show MIS, and so does the status.
  assert.deepEqual(status({ saved: both, health: [down("yahootw")], market: "tw" }), { live: true, source: "mis", problem: false });
  // Every source switched on is failing: a problem, named after the first.
  assert.deepEqual(status({ saved: both, health: [down("mis"), down("yahootw")], market: "tw" }), { live: true, source: "yahootw", problem: true });
  // Yahoo Finance failing too changes nothing: the problem is the real-time sources'.
  assert.deepEqual(status({ saved: both, health: [down("yahootw"), down("mis"), down("yahoo")], market: "tw" }),
    { live: true, source: "yahootw", problem: true });
  // Health is kept per source: a new MIS address says nothing about Yahoo 奇摩股市, which still fails.
  const edited = copy(both);
  edited.sources.tw.misUrl = "https://example.com";
  assert.deepEqual(status({ saved: both, draft: edited, health: [down("yahootw")], market: "tw" }), { live: true, source: "mis", problem: false });
  // MIS failing too: its own edit drops its problem, so the choice says MIS.
  assert.deepEqual(status({ saved: both, draft: edited, health: [down("yahootw"), down("mis")], market: "tw" }), { live: true, source: "mis", problem: false });
  assert.deepEqual(currentHealth({ saved: both, draft: edited, health: [down("yahootw"), down("mis")], keyEdited: false }), [down("yahootw")]);
});

test("currentHealth: each source's problem holds while the settings it reads are as saved", () => {
  const saved = us({ provider: "finnhub" });
  const problem = (provider, code, extra = {}) => ({ provider, code, params: {}, ...extra });
  const health = [problem("finnhub", "finnhub.rateLimited"), problem("binance", "binance.region"), problem("yahoo", "yahoo.unreachable")];
  assert.deepEqual(currentHealth({ health, saved, draft: copy(saved), keyEdited: false }), health);
  // A switch turned on and off again is unchanged.
  const back = copy(saved);
  back.sources.tw.mis = true;
  back.sources.tw.mis = false;
  const tw = [problem("mis", "mis.unreachable"), problem("yahootw", "yahootw.unreachable")];
  assert.deepEqual(currentHealth({ health: tw, saved, draft: back, keyEdited: false }), tw);
  // A key typed or removed (also a key Save wrote, in a dialog left open): Finnhub's problem goes.
  assert.deepEqual(currentHealth({ health, saved, draft: copy(saved), keyEdited: true }), health.slice(1));
  // Only crypto changed: Finnhub keeps its problem; Yahoo Finance reads no settings, so its stays.
  const moved = copy(saved);
  moved.sources.crypto.binanceUrl = "https://example.com";
  assert.deepEqual(currentHealth({ health, saved, draft: moved, keyEdited: false }), [health[0], health[2]]);
  // A budget edit drops a rate limit, which the budget may cure.
  const budget = copy(saved);
  budget.sources.us.budgetPerMinute = 30;
  assert.deepEqual(currentHealth({ health, saved, draft: budget, keyEdited: false }), health.slice(1));
  // The MIS switch is MIS's own: Yahoo 奇摩股市 keeps its problem.
  const misOn = copy(saved);
  misOn.sources.tw.mis = true;
  assert.deepEqual(currentHealth({ health: tw, saved, draft: misOn, keyEdited: false }), [tw[1]]);
  const ticked = copy(saved);
  ticked.sources.tw.yahootwAck = { version: YAHOOTW_CONSENT_VERSION };
  assert.deepEqual(currentHealth({ health: tw, saved, draft: ticked, keyEdited: false }), [tw[0]]);
});

test("settingsMarkets follows the language", () => {
  assert.deepEqual(SETTINGS_MARKETS, ["us", "tw", "crypto", "other"]);
  assert.deepEqual(settingsMarkets("zh-TW"), ["tw", "us", "crypto", "other"]);
  for (const lang of ["en", "ja", "ko"]) assert.deepEqual(settingsMarkets(lang), ["us", "tw", "crypto", "other"], lang);
  assert.deepEqual(settingsMarkets("xx"), settingsMarkets("en"));
});

test("consentGiven", () => {
  for (const [source, ack, version] of [["yahootw", "yahootwAck", YAHOOTW_CONSENT_VERSION], ["mis", "misAck", MIS_CONSENT_VERSION]]) {
    assert.equal(consentGiven({ [ack]: { version } }, source), true, source);
    assert.equal(consentGiven({ [ack]: { version: version - 1 } }, source), false, source);
    assert.equal(consentGiven({ [ack]: null }, source), false, source);
    assert.equal(consentGiven({}, source), false, source);
  }
  assert.equal(consentGiven({ misAck: { version: MIS_CONSENT_VERSION } }, "yahootw"), false);
});

test("consentCollapsed", () => {
  const current = { yahootwAck: { version: YAHOOTW_CONSENT_VERSION }, misAck: { version: MIS_CONSENT_VERSION } };
  const old = { yahootwAck: { version: YAHOOTW_CONSENT_VERSION - 1 }, misAck: { version: MIS_CONSENT_VERSION - 1 } };
  for (const source of ["yahootw", "mis"]) {
    assert.equal(consentCollapsed(tw(current), tw(current), source), true, source);
    // Just ticked: the box stays under the pointer until it is saved.
    assert.equal(consentCollapsed(tw({}), tw(current), source), false, source);
    assert.equal(consentCollapsed(tw(current), tw({}), source), false, source);
    assert.equal(consentCollapsed(tw(old), tw(old), source), false, source);
  }
  const misOnly = tw({ misAck: current.misAck });
  assert.equal(consentCollapsed(misOnly, misOnly, "yahootw"), false);
  assert.equal(consentCollapsed(misOnly, misOnly, "mis"), true);
});

test("firstDraftError", () => {
  const order = ["tw", "us", "crypto", "other"];
  assert.equal(firstDraftError({}, order), null);
  const errors = { "sources.crypto.binanceUrl": "url.notHttps", "sources.us.budgetPerMinute": "budget.tooSmall" };
  assert.equal(firstDraftError(errors, order), "budget.tooSmall");
  assert.equal(firstDraftError(errors, ["crypto"]), "url.notHttps");
  assert.equal(firstDraftError(errors, ["tw"]), null);
});
