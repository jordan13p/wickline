// node --test tests/  (what ships in the mod, and how it credits its origin)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const MOD = new URL("../mods/bellwether/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
const ALLOWED_HOSTS = ["query1.finance.yahoo.com", "data-api.binance.vision"];
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

test("main.js imports no program runners from herdr", () => {
  const names = herdrImports(read(new URL("main.js", MOD)));
  assert.ok(names.length > 0, "no herdr import found");
  for (const banned of ["exec", "hc"]) assert.ok(!names.includes(banned), banned);
  assert.deepEqual(herdrImports('import {\n  theme,\n  exec as run } from "herdr";'), ["theme", "exec"]);
});

test("mod.json places Bellwether", () => {
  assert.deepEqual(JSON.parse(read(new URL("mod.json", MOD))), { place: "right", size: 320, title: "Bellwether" });
});

test("icon is single-colour", () => {
  const svg = read(new URL("icon.svg", MOD));
  assert.match(svg, /stroke="currentColor"/);
  const fills = [...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(fills.length > 0);
  for (const fill of fills) assert.ok(fill === "none" || fill === "currentColor", fill);
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

test("READMEs link to each other", () => {
  assert.match(read(new URL("README.md", ROOT)), /README\.zh-TW\.md/);
  assert.match(read(new URL("README.zh-TW.md", ROOT)), /README\.md/);
});
