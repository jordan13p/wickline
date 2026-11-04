// The person's settings: interface language, gain/loss colors, and whether the
// language prompt was dismissed. No Herdr imports, so tests run it under Node.
import { LANGUAGES } from "./i18n.js";

// Herdr's shared state (persisted), so every copy uses the same settings.
export const SETTINGS_KEY = "bellwether.settings.v1";
const COLORS = ["auto", "red-up", "green-up"];

/** Anything unreadable falls back to its default, one field at a time. */
export function readSettings(value) {
  const saved = value !== null && typeof value === "object" && value.version === 1 ? value : {};
  return {
    version: 1,
    language: LANGUAGES.includes(saved.language) ? saved.language : "en",
    colors: COLORS.includes(saved.colors) ? saved.colors : "auto",
    languagePromptDismissed: saved.languagePromptDismissed === true,
  };
}

/** Gains in red (and losses in green): automatic means every language but English. */
export function upIsRed(settings) {
  if (settings.colors === "red-up") return true;
  if (settings.colors === "green-up") return false;
  return settings.language !== "en";
}
