// The person's settings: interface language, gain/loss colors, whether the
// language prompt was dismissed, and where each source lives. No Herdr imports,
// so tests run it under Node.
import { LANGUAGES } from "./i18n.js";
import { marketOrder } from "./markets.js";
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
  // Before the two Taiwan switches, `provider: "mis"` chose MIS. Every save writes `provider` in step with
  // `mis`, so the two differ only after 0.3.1 (which writes `provider` alone) changed it: `provider` wins.
  const mis = typeof tw.provider === "string" ? tw.provider === "mis" : tw.mis === true;
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
        // For going back to 0.3.1, which reads only this key; it follows `mis`.
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

/**
 * A key Finnhub would use after Save: one typed (trimmed) and well formed (`typedValid`), or the saved
 * one while it stays (no Remove) and `health` (each source's current problem) has not stopped Finnhub.
 */
export function finnhubKeyUsable({ typed, typedValid, saved, removing, health }) {
  return (typed !== "" && typedValid)
    || (saved && !removing && !health.some((p) => p.provider === "finnhub" && p.stopped));
}

// Each Taiwan source's consent, as [key in sources.tw, current version].
export const CONSENTS = { yahootw: ["yahootwAck", YAHOOTW_CONSENT_VERSION], mis: ["misAck", MIS_CONSENT_VERSION] };

/** `tw` (a `sources.tw`) holds consent to `source`'s current statement; an older version is none. */
export function consentGiven(tw, source) {
  const [ack, version] = CONSENTS[source];
  return tw[ack]?.version === version;
}

/** MIS is on only when switched on and consented to for the current statement. */
export function misEnabled(settings) {
  return settings.sources.tw.mis === true && consentGiven(settings.sources.tw, "mis");
}

/** MIS is switched on but its consent is missing or for an older statement: Taiwan does not use it until it is given again. */
export function misReconfirm(settings) {
  return settings.sources.tw.mis === true && !misEnabled(settings);
}

/** Yahoo 奇摩股市 is on only when switched on and consented to for its own current statement. */
export function yahootwEnabled(settings) {
  return settings.sources.tw.yahootw === true && consentGiven(settings.sources.tw, "yahootw");
}

/** Yahoo 奇摩股市 is switched on but its consent is missing or for an older statement. */
export function yahootwReconfirm(settings) {
  return settings.sources.tw.yahootw === true && !yahootwEnabled(settings);
}

// The markets with a page of their own in the settings dialog; Hong Kong, China, Japan and Korea share "other".
// Each id is also the `sources.<id>.` prefix of its fields' error paths, which firstDraftError relies on.
export const SETTINGS_MARKETS = ["us", "tw", "crypto", "other"];

/** The settings dialog's market pages, in the order the filter row uses for `lang`. */
export function settingsMarkets(lang) {
  return marketOrder(lang).filter((id) => SETTINGS_MARKETS.includes(id));
}

// The real-time sources `settings` switches on (and consents to) for `market`, in priority order.
function realtimeSources(settings, market, keyAvailable) {
  if (market === "crypto") return ["binance"];
  if (market === "tw") return [yahootwEnabled(settings) && "yahootw", misEnabled(settings) && "mis"].filter(Boolean);
  return market === "us" && finnhubChosen(settings) && keyAvailable ? ["finnhub"] : [];
}

/**
 * The source a market would use with `settings`, and whether it is real time: the first real-time source
 * switched on (and consented to) that is not `failing` (provider ids), as the panel's rows pick it; the
 * first one when all of them are; Yahoo Finance when none is on. `keyAvailable`: a Finnhub key would be
 * there after Save (the key is never in the settings).
 */
export function marketState(settings, market, { keyAvailable = false, failing = [] } = {}) {
  const sources = realtimeSources(settings, market, keyAvailable);
  if (!sources.length) return { live: false, source: "yahoo" };
  return { live: true, source: sources.find((source) => !failing.includes(source)) ?? sources[0] };
}

/**
 * The health the dialog was given still describes `market`: its section of the draft equals the saved
 * one, and for the US the key is as saved too (`keyEdited`: a key typed or Remove pressed). Once the
 * person changes anything there, the dialog cannot know the result before Save.
 */
export function marketUnchanged({ saved, draft, market, keyEdited }) {
  if (market === "us" && keyEdited) return false;
  return JSON.stringify(saved.sources[market]) === JSON.stringify(draft.sources[market]);
}

/**
 * A market's status in the settings dialog: what it would use after Save (marketState over `draft`)
 * and `problem`, every source it could use failing, so it never reads live while it does not work.
 * `health` (each source's problem when the dialog opened) counts only while the market is unchanged; a
 * changed market is judged by the choice alone. `key`: the Finnhub key fields finnhubKeyUsable takes,
 * less `health`.
 */
export function marketStatus({ saved, draft, health, market, key }) {
  const unchanged = marketUnchanged({ saved, draft, market, keyEdited: key.typed !== "" || key.removing });
  const counted = unchanged ? health : [];
  const failing = counted.map((entry) => entry.provider);
  const state = marketState(draft, market, { keyAvailable: finnhubKeyUsable({ ...key, health: counted }), failing });
  return { ...state, problem: failing.includes(state.source) };
}

// The market page whose settings each source reads; Yahoo Finance takes none.
const SOURCE_MARKETS = { finnhub: "us", yahootw: "tw", mis: "tw", binance: "crypto" };

/**
 * What a dialog left open after Save (the key file could not be made owner-only) keeps of `health`: a
 * source whose market changed in that save has not run with its new settings yet, so its old problem
 * goes. `saved`: the settings before Save; `draft`: what was saved; `keyChanged`: Save wrote or removed
 * the key.
 */
export function healthAfterSave({ health, saved, draft, keyChanged }) {
  return health.filter((entry) => {
    const market = SOURCE_MARKETS[entry.provider];
    return !market || marketUnchanged({ saved, draft, market, keyEdited: keyChanged });
  });
}

/**
 * A source's statement folds away once consent to its current version is both saved and still in the
 * draft: a box just ticked stays where the pointer is until Save.
 */
export function consentCollapsed(saved, draft, source) {
  return consentGiven(saved.sources.tw, source) && consentGiven(draft.sources.tw, source);
}

/** The code of the first of `errors` (validateSettings) on a page of `markets`, taken in that order; null when none. */
export function firstDraftError(errors, markets) {
  for (const market of markets) {
    const path = Object.keys(errors).find((key) => key.startsWith(`sources.${market}.`));
    if (path) return errors[path];
  }
  return null;
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
