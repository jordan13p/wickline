// The person's settings: interface language, gain/loss colors, whether the
// language prompt was dismissed, and where each source lives. No Herdr imports,
// so tests run it under Node.
import { LANGUAGES } from "./i18n.js";
import { MIS_CONSENT_VERSION, MIS_URL } from "./providers/mis.js";

// Herdr's shared state (persisted), so every copy uses the same settings.
export const SETTINGS_KEY = "bellwether.settings.v1";
// The Finnhub key's name in `data/bellwether/secrets.json`; the key is never put in shared state.
export const SECRET_KEY_FINNHUB = "finnhub.key";
export const DEFAULT_BINANCE_URL = "https://data-api.binance.vision";
const COLORS = ["auto", "red-up", "green-up"];

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
  return {
    version: 1,
    language: LANGUAGES.includes(saved.language) ? saved.language : "en",
    colors: COLORS.includes(saved.colors) ? saved.colors : "auto",
    languagePromptDismissed: saved.languagePromptDismissed === true,
    // A URL is kept as written, even a bad one, so the dialog can name the problem.
    sources: {
      tw: { provider: tw.provider === "mis" ? "mis" : "yahoo", misUrl: readUrl(tw.misUrl, MIS_URL), misAck: readAck(tw.misAck) },
      crypto: { binanceUrl: readUrl(crypto.binanceUrl, DEFAULT_BINANCE_URL) },
    },
  };
}

/** MIS is on only when chosen and consented to for the current statement. */
export function misEnabled(settings) {
  return settings.sources.tw.provider === "mis" && settings.sources.tw.misAck?.version === MIS_CONSENT_VERSION;
}

/** MIS is chosen but its consent is missing or for an older statement: Taiwan uses Yahoo until it is given again. */
export function misReconfirm(settings) {
  return settings.sources.tw.provider === "mis" && !misEnabled(settings);
}

// Field path -> error code; an https address, optionally with a path, and no userinfo, query or fragment.
// A field is checked only while it is shown: the MIS address only with MIS chosen.
const URL_FIELDS = [
  ["sources.tw.misUrl", (s) => (s.sources.tw?.provider === "mis" ? s.sources.tw.misUrl : null)],
  ["sources.crypto.binanceUrl", (s) => s.sources.crypto.binanceUrl],
];
// The host has at least one letter or digit and no `@` (a password in the address would be sent as is).
const HTTPS_ADDRESS = /^https:\/\/[^\s/?#@]*[a-z0-9][^\s/?#@]*(\/[^\s?#]*)?$/i;

/** What stops a save: `{}` is valid. The text for each code is in i18n.js. */
export function validateSettings(settings) {
  const errors = {};
  for (const [path, get] of URL_FIELDS) {
    const value = get(settings);
    if (value === null) continue;
    const url = value.trim();
    if (!/^https:\/\//i.test(url)) errors[path] = "url.notHttps";
    else if (!HTTPS_ADDRESS.test(url)) errors[path] = "url.invalid";
  }
  // MIS cannot be saved without ticking the consent box.
  if (settings.sources.tw && misReconfirm(settings)) errors["sources.tw.misAck"] = "mis.consentNeeded";
  return errors;
}

/**
 * What a save writes: keys this build does not know are kept (a newer copy may have added them),
 * known ones are read as usual, then `change` applies.
 */
export function mergeSettings(raw, change) {
  const old = isPlainObject(raw) ? raw : {};
  const known = readSettings(raw);
  return { ...old, ...known, ...change, sources: mergeSources(old.sources, known.sources, change?.sources) };
}

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
