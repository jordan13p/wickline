// The person's settings: interface language, gain/loss colors, and whether the
// language prompt was dismissed. No Herdr imports, so tests run it under Node.
import { LANGUAGES } from "./i18n.js";

// Herdr's shared state (persisted), so every copy uses the same settings.
export const SETTINGS_KEY = "bellwether.settings.v1";
const COLORS = ["auto", "red-up", "green-up"];

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Any object is read one field at a time; a field that is missing or unreadable gets its default. */
export function readSettings(value) {
  const saved = isPlainObject(value) ? value : {};
  return {
    version: 1,
    language: LANGUAGES.includes(saved.language) ? saved.language : "en",
    colors: COLORS.includes(saved.colors) ? saved.colors : "auto",
    languagePromptDismissed: saved.languagePromptDismissed === true,
  };
}

/**
 * What a save writes: keys this build does not know are kept (a newer copy may have added them),
 * known ones are read as usual, then `change` applies.
 */
export function mergeSettings(raw, change) {
  return { ...(isPlainObject(raw) ? raw : {}), ...readSettings(raw), ...change };
}

/** Gains in red (and losses in green): automatic means every language but English. */
export function upIsRed(settings) {
  if (settings.colors === "red-up") return true;
  if (settings.colors === "green-up") return false;
  return settings.language !== "en";
}
