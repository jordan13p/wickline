// The person's settings: interface language, gain/loss colors, whether the
// language prompt was dismissed, and where each source lives. No Herdr imports,
// so tests run it under Node.
import { LANGUAGES } from "./i18n.js";
import { BINANCE_URL } from "./providers/binance.js";
import { FINNHUB_URL, finnhubAddressOk } from "./providers/finnhub.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "./providers/mis.js";
import { YAHOOTW_CONSENT_VERSION } from "./providers/yahootw.js";

// Herdr's shared state (persisted), so every copy uses the same settings.
export const SETTINGS_KEY = "wickline.settings.v1";
// The Finnhub key's name in `data/wickline/secrets.json`; the key is never put in shared state.
export const SECRET_KEY_FINNHUB = "finnhub.key";
const COLORS = ["auto", "red-up", "green-up"];
// Finnhub's free plan allows 60 requests a minute; each US symbol takes four.
const DEFAULT_FINNHUB_BUDGET = 60;
const MIN_FINNHUB_BUDGET = 4;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const readUrl = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

const section = (sources, name) => (isPlainObject(sources) && isPlainObject(sources[name]) ? sources[name] : {});

// The consent the person gave, by the version of the text they read; anything else is none.
const readAck = (value) => (isPlainObject(value) && Number.isInteger(value.version) ? { version: value.version } : null);

/** Any object is read one field at a time; a field that is missing or unreadable gets its default. */
export function readSettings(value) {
  const saved = isPlainObject(value) ? value : {};
  const crypto = section(saved.sources, "crypto");
  const tw = section(saved.sources, "tw");
  const us = section(saved.sources, "us");
  // Before the two Taiwan switches, `provider: "mis"` chose MIS; a saved switch wins over it.
  const mis = typeof tw.mis === "boolean" ? tw.mis : tw.provider === "mis";
  return {
    version: 1,
    language: LANGUAGES.includes(saved.language) ? saved.language : "en",
    colors: COLORS.includes(saved.colors) ? saved.colors : "auto",
    languagePromptDismissed: saved.languagePromptDismissed === true,
    // Raised by each save of a new Finnhub key, so every copy reads the key file again.
    keyRev: Number.isInteger(saved.keyRev) && saved.keyRev >= 0 ? saved.keyRev : 0,
    // A URL or budget is kept as written, even a bad one, so the dialog can name the problem.
    sources: {
      us: {
        provider: us.provider === "finnhub" ? "finnhub" : "yahoo",
        finnhubUrl: readUrl(us.finnhubUrl, FINNHUB_URL),
        budgetPerMinute: Number.isInteger(us.budgetPerMinute) && us.budgetPerMinute > 0 ? us.budgetPerMinute : DEFAULT_FINNHUB_BUDGET,
      },
      tw: {
        // Only for going back to 0.3.1, which reads this key; this build reads `mis`.
        provider: mis ? "mis" : "yahoo",
        mis,
        yahootw: tw.yahootw === true,
        misUrl: readUrl(tw.misUrl, MIS_URL),
        misAck: readAck(tw.misAck),
        yahootwAck: readAck(tw.yahootwAck),
      },
      crypto: { binanceUrl: readUrl(crypto.binanceUrl, BINANCE_URL) },
    },
  };
}

/** Finnhub is chosen for US stocks; it runs only once a key is saved too. */
export function finnhubChosen(settings) {
  return settings.sources.us.provider === "finnhub";
}

/**
 * What Save does with the Finnhub key, given the US source chosen, the key field (trimmed), whether a
 * key is saved now and whether the person pressed Remove (the dialog never holds the saved key): "write"
 * a typed key while Finnhub is chosen, "remove" the saved key after Remove with nothing typed, else null.
 * An empty field keeps the saved key; choosing Yahoo alone keeps it too.
 */
export function keyChange({ provider, typed, saved, removing }) {
  if (provider === "finnhub" && typed !== "") return "write";
  return removing && saved ? "remove" : null;
}

/** MIS is on only when switched on and consented to for the current statement. */
export function misEnabled(settings) {
  return settings.sources.tw.mis === true && settings.sources.tw.misAck?.version === MIS_CONSENT_VERSION;
}

/** MIS is switched on but its consent is missing or for an older statement: Taiwan does not use it until it is given again. */
export function misReconfirm(settings) {
  return settings.sources.tw.mis === true && !misEnabled(settings);
}

/** Yahoo 奇摩股市 is on only when switched on and consented to for its own current statement. */
export function yahootwEnabled(settings) {
  return settings.sources.tw.yahootw === true && settings.sources.tw.yahootwAck?.version === YAHOOTW_CONSENT_VERSION;
}

/** Yahoo 奇摩股市 is switched on but its consent is missing or for an older statement. */
export function yahootwReconfirm(settings) {
  return settings.sources.tw.yahootw === true && !yahootwEnabled(settings);
}

// Field path -> error code; an https address, optionally with a path, and no userinfo, query or fragment.
// Finnhub's keeps the host finnhub.io (it is sent the key).
// A field is checked only while it is shown: the MIS address only with MIS on.
const URL_FIELDS = [
  ["sources.us.finnhubUrl", (s) => (s.sources.us?.provider === "finnhub" ? s.sources.us.finnhubUrl : null)],
  ["sources.tw.misUrl", (s) => (s.sources.tw?.mis === true ? s.sources.tw.misUrl : null)],
  ["sources.crypto.binanceUrl", (s) => s.sources.crypto.binanceUrl],
];
// The host has at least one letter or digit and no `@` (a password in the address would be sent as is).
const HTTPS_ADDRESS = /^https:\/\/[^\s/?#@]*[a-z0-9][^\s/?#@]*(\/[^\s?#]*)?$/i;

// A key as typed, trimmed: no spaces or control characters inside, and a loose length bound (a key in
// Finnhub's current shape is 20 characters; a longer future one still fits).
const KEY_MAX_LENGTH = 128;
const KEY_BAD_CHARACTER = /[\s\x00-\x1f\x7f]/;

/**
 * What stops a save: `{}` is valid. The text for each code is in i18n.js. `finnhubKey` is the key
 * typed in the dialog (it is never in the settings; without it the key is not checked) and `keySaved`
 * says a saved key stays after Save, so an empty field keeps it.
 */
export function validateSettings(settings, { finnhubKey, keySaved = false } = {}) {
  const errors = {};
  for (const [path, get] of URL_FIELDS) {
    const value = get(settings);
    if (value === null) continue;
    const url = value.trim();
    if (!/^https:\/\//i.test(url)) errors[path] = "url.notHttps";
    else if (path === "sources.us.finnhubUrl") { if (!finnhubAddressOk(url)) errors[path] = "url.finnhubHost"; }
    else if (!HTTPS_ADDRESS.test(url)) errors[path] = "url.invalid";
  }
  if (settings.sources.us?.provider === "finnhub") {
    const budget = settings.sources.us.budgetPerMinute;
    if (!Number.isInteger(budget) || budget < MIN_FINNHUB_BUDGET) errors["sources.us.budgetPerMinute"] = "budget.tooSmall";
    const key = typeof finnhubKey === "string" ? finnhubKey.trim() : null;
    if (key === "" && !keySaved) errors["sources.us.key"] = "finnhub.keyNeeded";
    else if (key && (KEY_BAD_CHARACTER.test(key) || key.length > KEY_MAX_LENGTH)) errors["sources.us.key"] = "finnhub.keyInvalid";
  }
  // Neither Taiwan source can be saved on without ticking its own consent box.
  if (settings.sources.tw && misReconfirm(settings)) errors["sources.tw.misAck"] = "mis.consentNeeded";
  if (settings.sources.tw && yahootwReconfirm(settings)) errors["sources.tw.yahootwAck"] = "yahootw.consentNeeded";
  return errors;
}

/**
 * What a save writes: keys this build does not know are kept (a newer copy may have added them),
 * known ones are read as usual, then `change` applies.
 */
export function mergeSettings(raw, change) {
  const old = isPlainObject(raw) ? raw : {};
  const known = readSettings(raw);
  const sources = mergeSources(old.sources, known.sources, change?.sources);
  // An address is stored without the spaces around it; spaces inside stay, for validation to refuse.
  for (const [name, key] of URL_KEYS) {
    if (typeof sources[name]?.[key] === "string") sources[name][key] = sources[name][key].trim();
  }
  // The old key follows the MIS switch, so a stale one in the dialog's draft never wins.
  sources.tw.provider = sources.tw.mis === true ? "mis" : "yahoo";
  return { ...old, ...known, ...change, sources };
}

// The address fields in `sources`, as [source, key].
const URL_KEYS = [["us", "finnhubUrl"], ["tw", "misUrl"], ["crypto", "binanceUrl"]];

// Each source keeps the keys a newer copy added to it, and whole sources this build lacks.
function mergeSources(old, known, change) {
  const parts = [old, known, change].map((part) => (isPlainObject(part) ? part : {}));
  const sources = {};
  for (const name of new Set(parts.flatMap(Object.keys))) {
    sources[name] = Object.assign({}, ...parts.map((part) => (isPlainObject(part[name]) ? part[name] : {})));
  }
  return sources;
}

/** Gains in red (and losses in green): automatic means every language but English. */
export function upIsRed(settings) {
  if (settings.colors === "red-up") return true;
  if (settings.colors === "green-up") return false;
  return settings.language !== "en";
}
