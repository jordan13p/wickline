// node --test tests/  (settings.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_KEY, mergeSettings, readSettings, upIsRed } from "../mods/bellwether/settings.js";

const DEFAULTS = { version: 1, language: "en", colors: "auto", languagePromptDismissed: false };

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
    { version: 1, language: "ko", colors: "green-up", languagePromptDismissed: true });
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
    { version: 1, language: "en", colors: "auto", languagePromptDismissed: true, later: { x: 1 } });
  assert.deepEqual(mergeSettings(undefined, { language: "ja" }), { ...DEFAULTS, language: "ja" });
  assert.deepEqual(mergeSettings("junk", {}), DEFAULTS);
});
