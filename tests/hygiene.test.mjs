// node --test tests/  (what ships in the mod, and how it credits its origin)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MESSAGES_EN } from "../mods/bellwether/quotes.js";
import { STRINGS } from "../mods/bellwether/i18n.js";
import { Watchlist } from "../mods/bellwether/watchlist.js";
import { SECRET_KEY_FINNHUB } from "../mods/bellwether/settings.js";

const MOD = new URL("../mods/bellwether/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
// mis.twse.com.tw only once the person turns TWSE MIS on and consents; finnhub.io only with Finnhub
// chosen and a key saved.
const ALLOWED_HOSTS = ["query1.finance.yahoo.com", "data-api.binance.vision", "mis.twse.com.tw", "finnhub.io"];
// Herdr writes these into the mod folder; they are git-ignored.
const GENERATED = ["jsconfig.json", "gpui-kit.d.ts"];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (GENERATED.includes(entry.name)) return [];
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? files(url) : [url];
  });
}
const read = (url) => readFileSync(url, "utf8");

test("no Pulse branding, programs or hc in the mod", () => {
  for (const file of files(MOD)) {
    const text = read(file);
    assert.doesNotMatch(text, /pulse|pulseticker/i, file.pathname);
    assert.doesNotMatch(text, /\bexec\(/, file.pathname);
    assert.doesNotMatch(text, /\bhc\(/, file.pathname);
  }
});

// The grep above misses an aliased import (`exec as run`); the import list does not.
function herdrImports(source) {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']herdr["']/g)]
    .flatMap(([, list]) => list.split(","))
    .map((name) => name.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);
}

const jsFiles = () => files(MOD).filter((url) => url.pathname.endsWith(".js"));
const relativeName = (url) => url.pathname.slice(MOD.pathname.length);

test("no module imports program runners from herdr", () => {
  const importers = jsFiles().filter((file) => herdrImports(read(file)).length > 0);
  assert.ok(importers.length > 0, "no herdr import found");
  for (const file of importers) {
    for (const banned of ["exec", "hc"]) assert.ok(!herdrImports(read(file)).includes(banned), `${banned} in ${relativeName(file)}`);
  }
  assert.deepEqual(herdrImports('import {\n  theme,\n  exec as run } from "herdr";'), ["theme", "exec"]);
});

// Every module specifier, whether it is imported with a list, a namespace or a default.
function importSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map(([, specifier]) => specifier);
}

// The layer rule: the core imports only other modules of the mod, so `node --test` can load it; main.js
// is the shell that talks to Herdr, and anything under ui/ may add the view libraries.
const VIEW_LIBRARIES = ["gpui-kit", "gpui-base", "herdr"];
test("core modules import only relative modules; ui/ adds the view libraries", () => {
  let core = 0;
  for (const file of jsFiles()) {
    const name = relativeName(file);
    if (name === "main.js") continue;
    const allowed = name.startsWith("ui/") ? VIEW_LIBRARIES : [];
    if (allowed.length === 0) core += 1;
    for (const specifier of importSpecifiers(read(file))) {
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../") || allowed.includes(specifier), `${specifier} in ${name}`);
    }
  }
  assert.ok(core > 0, "no core module found");
  assert.deepEqual(importSpecifiers('import { a } from "./a.js";\nimport fs from "fs/promises";\nimport "gpui-kit";'), ["./a.js", "fs/promises", "gpui-kit"]);
});

// "none": installing never docks Bellwether into the person's layout; the open key or pane.split opens it.
test("mod.json docks Bellwether nowhere", () => {
  assert.deepEqual(JSON.parse(read(new URL("mod.json", MOD))), { place: "none", title: "Bellwether" });
});

test("keys.json binds only the open key", () => {
  assert.deepEqual(JSON.parse(read(new URL("keys.json", ROOT))), {
    global: { "ctrl-alt-b": { command: "pane.split", args: { direction: "right", mod: "bellwether" } } },
  });
});

test("the repo root is the listing folder", () => {
  const names = readdirSync(ROOT);
  for (const name of ["mods", "RECIPE.md", "preview.png", "README.md", "README.zh-TW.md", "LICENSE", "keys.json", "assets", "tests"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes("layouts"), "no layouts/");
  for (const name of ["logo-light.svg", "logo-dark.svg"]) assert.match(read(new URL(`assets/${name}`, ROOT)), /viewBox="0 0 24 24"/, name);
});

test("icon is single-colour", () => {
  const svg = read(new URL("icon.svg", MOD));
  assert.match(svg, /stroke="currentColor"/);
  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(fills.length > 0);
  for (const fill of fills) assert.ok(fill === "none" || fill === "currentColor", fill);
});

test("header and row icons are single-colour and drawn on a 24 px grid", () => {
  const dir = new URL("icons/", MOD);
  const names = readdirSync(dir).filter((name) => name.endsWith(".svg")).sort();
  for (const name of ["close", "grip", "mark-center", "mark-sides", "pause", "play", "refresh", "restore", "settings", "zoom"]) {
    assert.ok(names.includes(`${name}.svg`), name);
  }
  for (const name of names) {
    const svg = read(new URL(name, dir));
    assert.match(svg, /viewBox="0 0 24 24"/, name);
    assert.match(svg, /currentColor/, name);
    for (const [, attr, value] of svg.matchAll(/(fill|stroke)="([^"]*)"/g)) {
      assert.ok(value === "none" || value === "currentColor", `${name} ${attr}=${value}`);
    }
  }
});

test("licence keeps both notices", () => {
  const licence = read(new URL("LICENSE", ROOT));
  assert.match(licence, /Copyright \(c\) 2026 fatwang2/);
  assert.match(licence, /Copyright \(c\) 2026 jordan13p/);
});

test("only allowed hosts", () => {
  for (const file of files(MOD).filter((url) => url.pathname.endsWith(".js"))) {
    for (const [, host] of read(file).matchAll(/https?:\/\/([^/\s"'`?:]+)/g)) {
      assert.ok(ALLOWED_HOSTS.includes(host), `${host} in ${file.pathname}`);
    }
  }
});

// QuoteError shows a code it does not know as text, so every code used must have English text.
test("every error code has English text", () => {
  const errors = new Set();
  const notices = new Set();
  for (const file of files(MOD).filter((url) => url.pathname.endsWith(".js"))) {
    const text = read(file);
    for (const [, code] of text.matchAll(/new QuoteError\(\s*"([^"]+)"/g)) errors.add(code);
    // Codes handed to the view as `{ code, params }`, e.g. a deferred refresh.
    for (const [, code] of text.matchAll(/"((?:symbol|yahoo|binance|mis|finnhub|request|notice|budget)\.[A-Za-z]+)"/g)) notices.add(code);
  }
  // The key's name in the secrets file, not a text.
  notices.delete(SECRET_KEY_FINNHUB);
  // Built from the provider id: `${provider.id}.unreachable`.
  for (const id of new Watchlist({ load: () => undefined, settings: () => undefined }).providerIds()) errors.add(`${id}.unreachable`);
  assert.ok(errors.size > 0);
  for (const code of errors) assert.ok(code in MESSAGES_EN, code);
  for (const code of notices) assert.ok(code in STRINGS.en, code);
});

test("READMEs link to each other", () => {
  assert.match(read(new URL("README.md", ROOT)), /README\.zh-TW\.md/);
  assert.match(read(new URL("README.zh-TW.md", ROOT)), /README\.md/);
});

test("READMEs carry the same sections", () => {
  const headings = (name) => read(new URL(name, ROOT)).match(/^## .+$/gm) ?? [];
  assert.ok(headings("README.md").length >= 10);
  assert.equal(headings("README.zh-TW.md").length, headings("README.md").length);
});

test("README and RECIPE show the preview and say how to open Bellwether", () => {
  for (const name of ["README.md", "README.zh-TW.md", "RECIPE.md"]) {
    const text = read(new URL(name, ROOT));
    assert.match(text, /preview\.png/, name);
    assert.ok(text.includes("ctrl-alt-b"), `open key in ${name}`);
    assert.ok(text.includes("herdr-app do pane.split --direction right --mod bellwether"), `manual open in ${name}`);
  }
});

// The settings tab's disclaimer block and the READMEs carry the same sentences.
test("the READMEs and RECIPE carry the settings tab's disclaimer", () => {
  const keys = ["disclaimer.data", "disclaimer.advice", "disclaimer.sources", "disclaimer.direct", "disclaimer.key"];
  for (const [name, lang] of [["README.md", "en"], ["README.zh-TW.md", "zh-TW"]]) {
    const text = read(new URL(name, ROOT));
    for (const key of keys) assert.ok(text.includes(STRINGS[lang][key]), `${key} in ${name}`);
  }
  // RECIPE paraphrases the rest of the disclaimer, but quotes the key sentence and names no string ids.
  const recipe = read(new URL("RECIPE.md", ROOT));
  assert.ok(recipe.includes(STRINGS.en["disclaimer.key"]), "disclaimer.key in RECIPE.md");
  assert.doesNotMatch(recipe, /`disclaimer\.[a-z]+`/, "string ids in RECIPE.md");
  assert.ok(read(new URL("main.js", MOD)).includes('"disclaimer.key"'), "the tab shows disclaimer.key");
});

test("the disclosure names every host and the key file in all four places", () => {
  const docs = ["README.md", "README.zh-TW.md", "RECIPE.md"].map((name) => [name, read(new URL(name, ROOT))]);
  for (const lang of Object.keys(STRINGS)) {
    const privacy = ["privacy.hosts", "privacy.storage", "privacy.finnhub"].map((key) => STRINGS[lang][key]).join(" ");
    docs.push([`${lang} privacy`, privacy]);
  }
  for (const [name, text] of docs) {
    for (const host of ALLOWED_HOSTS) assert.ok(text.includes(host), `${host} in ${name}`);
    assert.ok(text.includes("data/bellwether/secrets.json"), `key file in ${name}`);
    // The default cap, behind the budget and the two-copies warning.
    assert.ok(text.includes("15"), `cap in ${name}`);
  }
});
