// Every text the person reads, by language and key; `{name}` is filled from params.
// The language is the person's choice only: never the markets watched, never the system's.
// The tables are in `i18n/`, one per language. No Herdr imports, so tests run it under Node.
import { fill } from "./quotes.js";
import { EN } from "./i18n/en.js";
import { JA } from "./i18n/ja.js";
import { KO } from "./i18n/ko.js";
import { ZH_CN } from "./i18n/zh-cn.js";
import { ZH_TW } from "./i18n/zh-tw.js";

export const LANGUAGES = ["en", "zh-TW", "zh-CN", "ja", "ko"];
// Each language in its own script, as the prompt and settings show it.
export const LANGUAGE_LABELS = { en: "English", "zh-TW": "繁中", "zh-CN": "简中", ja: "日本語", ko: "한국어" };

export const STRINGS = { en: EN, "zh-TW": ZH_TW, "zh-CN": ZH_CN, ja: JA, ko: KO };

/** The text for `key` in `lang`, else in English, else the key itself. */
export function t(lang, key, params = {}) {
  return fill(STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key, params);
}
