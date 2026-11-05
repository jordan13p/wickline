// The person's settings: interface language, gain/loss colors, whether the
// language prompt was dismissed, and where each source lives. No Herdr imports,
// so tests run it under Node.
import { LANGUAGES } from "./i18n.js";

// Herdr's shared state (persisted), so every copy uses the same settings.
export const SETTINGS_KEY = "bellwether.settings.v1";
// The Finnhub key is kept in Bellwether's own local storage under this name, never in shared state.
export const SECRET_KEY_FINNHUB = "finnhub.key";
export const DEFAULT_BINANCE_URL = "https://data-api.binance.vision";
const COLORS = ["auto", "red-up", "green-up"];

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const readUrl = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

/** Any object is read one field at a time; a field that is missing or unreadable gets its default. */
export function readSettings(value) {
  const saved = isPlainObject(value) ? value : {};
  const crypto = isPlainObject(saved.sources) && isPlainObject(saved.sources.crypto) ? saved.sources.crypto : {};
  return {
    version: 1,
    language: LANGUAGES.includes(saved.language) ? saved.language : "en",
    colors: COLORS.includes(saved.colors) ? saved.colors : "auto",
    languagePromptDismissed: saved.languagePromptDismissed === true,
    // A URL is kept as written, even a bad one, so the dialog can name the problem.
    sources: { crypto: { binanceUrl: readUrl(crypto.binanceUrl, DEFAULT_BINANCE_URL) } },
  };
}

// Field path -> error code; an https address, optionally with a path, and no query or fragment.
const URL_FIELDS = [["sources.crypto.binanceUrl", (s) => s.sources.crypto.binanceUrl]];
const HTTPS_ADDRESS = /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i;

/** What stops a save: `{}` is valid. The text for each code is in i18n.js. */
export function validateSettings(settings) {
  const errors = {};
  for (const [path, get] of URL_FIELDS) {
    const url = get(settings);
    if (!/^https:\/\//i.test(url)) errors[path] = "url.notHttps";
    else if (!HTTPS_ADDRESS.test(url)) errors[path] = "url.invalid";
  }
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
