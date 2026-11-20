// node --test tests/  (what ships in the mod, and how it credits its origin)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MESSAGES_EN } from "../mods/wickline/quotes.js";
import { STRINGS } from "../mods/wickline/i18n.js";
import { Watchlist } from "../mods/wickline/watchlist.js";
import { SECRET_KEY_FINNHUB } from "../mods/wickline/settings.js";
import { CROSSHAIR_CARD_PX } from "../mods/wickline/format.js";

const MOD = new URL("../mods/wickline/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
// mis.twse.com.tw only once the person turns TWSE MIS on and consents; finnhub.io only with Finnhub
// chosen and a key saved.
// openapi.twse.com.tw: TWSE's holiday schedule, while the list holds a Taiwan symbol.
const ALLOWED_HOSTS = ["query1.finance.yahoo.com", "data-api.binance.vision", "mis.twse.com.tw", "tw.stock.yahoo.com", "finnhub.io",
  "openapi.twse.com.tw"];
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
    // main.js's one exec is pinned by "the only program is chmod 600 on the key file".
    if (!file.pathname.endsWith("/wickline/main.js")) assert.doesNotMatch(text, /\bexec\(/, file.pathname);
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

test("no module imports program runners from herdr, but main.js its one exec", () => {
  const importers = jsFiles().filter((file) => herdrImports(read(file)).length > 0);
  assert.ok(importers.length > 0, "no herdr import found");
  for (const file of importers) {
    const banned = relativeName(file) === "main.js" ? ["hc"] : ["exec", "hc"];
    for (const name of banned) assert.ok(!herdrImports(read(file)).includes(name), `${name} in ${relativeName(file)}`);
  }
  assert.deepEqual(herdrImports('import {\n  theme,\n  exec as run } from "herdr";'), ["theme", "exec"]);
});

// Every module specifier, whether it is imported with a list, a namespace, a default or `import("…")`.
function importSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map(([, specifier]) => specifier);
}

// The layer rule. The core imports only other modules of the mod, so `node --test` can load it. ui/ adds
// the two view libraries and nothing from Herdr: whatever it does to storage, the network, files, panes or
// commands goes through a method of the view in main.js, so what an installing agent must disclose is all
// in main.js and the core. main.js is the shell that talks to Herdr.
const UI_LIBRARIES = ["gpui-kit", "gpui-base"];
test("core modules import only relative modules; ui/ adds the view libraries", () => {
  let core = 0;
  let ui = 0;
  for (const file of jsFiles()) {
    const name = relativeName(file);
    if (name === "main.js") continue;
    const allowed = name.startsWith("ui/") ? UI_LIBRARIES : [];
    if (allowed.length === 0) core += 1;
    else ui += 1;
    for (const specifier of importSpecifiers(read(file))) {
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../") || allowed.includes(specifier), `${specifier} in ${name}`);
      // main.js is the shell: importing it would bring Herdr in by a relative path.
      assert.doesNotMatch(specifier, /(^|\/)main\.js$/, `${specifier} in ${name}`);
    }
  }
  assert.ok(core > 0, "no core module found");
  assert.ok(ui > 0, "no ui module found");
  assert.deepEqual(importSpecifiers('import { a } from "./a.js";\nimport fs from "fs/promises";\nimport "gpui-kit";\nawait import ( "herdr" );\nawait import(`herdr`);'),
    ["./a.js", "fs/promises", "gpui-kit", "herdr", "herdr"]);
});

// A split keeps the modules a tree: a cycle would make one module's top level run before another it needs is ready.
test("no import cycle among the mod's modules", () => {
  const graph = new Map(jsFiles().map((file) => [file.href, importSpecifiers(read(file))
    .filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"))
    .map((specifier) => new URL(specifier, file).href)]));
  const name = (href) => relativeName(new URL(href));
  const done = new Set();
  const path = [];
  const visit = (href) => {
    const at = path.indexOf(href);
    if (at >= 0) assert.fail(`import cycle: ${[...path.slice(at), href].map(name).join(" → ")}`);
    if (done.has(href) || !graph.has(href)) return;
    path.push(href);
    for (const next of graph.get(href)) visit(next);
    path.pop();
    done.add(href);
  };
  for (const href of graph.keys()) visit(href);
});

// Herdr's globals reach no module but main.js either: `fetch` (the core gets it as `host.fetch`), also
// aliased or through `window` / `self` (also destructured), `localStorage`, and `globalThis`, through which a module could
// find anything else. `fetch:` as an object key and `fetchedAt` are not the global.
const HERDR_GLOBALS = /(?<![.\w$])(?:fetch\b(?!\s*:)|localStorage\b|globalThis\b)|\b(?:window|self)\s*\.\s*fetch\b|\}\s*=\s*(?:window|self)\b/;
// The source without comments, which may name these; a `//` after `:` or a quote is a URL, not a comment.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// The source with each string's text blanked, quote-aware: the text of '…', "…" and a template turns to spaces
// (a line break stays one), so every index still points at the same code; a template keeps its `${…}`
// expressions, which are code. (No module writes a quote inside a regex literal.)
function withoutStrings(source) {
  let out = "";
  const blank = (from, to) => source.slice(from, Math.min(to, source.length)).replace(/[^\n]/g, " ");
  // One entry per `${…}` being read: how many `{` deep inside it.
  const open = [];
  let i = 0;
  // Template text from `i` to its closing backtick, or to the next `${`, which opens an expression.
  const templateText = () => {
    const from = i;
    while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) i += source[i] === "\\" ? 2 : 1;
    out += blank(from, i);
    if (source[i] === "`") {
      out += "`";
      i += 1;
    } else if (i < source.length) {
      out += "${";
      i += 2;
      open.push(0);
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out += c + blank(i + 1, j) + (source[j] === c ? c : "");
      i = source[j] === c ? j + 1 : j;
    } else if (c === "`") {
      out += "`";
      i += 1;
      templateText();
    } else if (c === "}" && open.length && open[open.length - 1] === 0) {
      open.pop();
      out += "}";
      i += 1;
      templateText();
    } else {
      if (open.length && c === "{") open[open.length - 1] += 1;
      if (open.length && c === "}") open[open.length - 1] -= 1;
      out += c;
      i += 1;
    }
  }
  return out;
}
// What the globals scan reads: the code without its strings, which may name a global (the text table's
// storage disclosure names `localStorage`) without using it.
const scanned = (source) => withoutStrings(code(source));

// Hygiene pins: the checks on the code's own text find what they guard by shape, so a move between files, a
// renamed local or a formatter's line breaks leave them standing, and each still fails when its decision breaks.

// The code with no whitespace and no trailing comma before `)`, `]` or `}`: for shape patterns, written without
// spaces. Identifier counts and words that must be absent are checked on code(), where `const intro` keeps its space.
const flat = (text) => code(text).replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
// The index of the bracket that closes the one at `at`, counted on code whose strings are blanked; -1 if none.
function closing(blanked, at) {
  const open = blanked[at];
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let i = at; i < blanked.length; i += 1) {
    if (blanked[i] === open) depth += 1;
    else if (blanked[i] === close && --depth === 0) return i;
  }
  return -1;
}
// A function or method by name, from its head to its closing brace, as code(). A call never counts: its `)` is not
// followed by `{`. Throws unless exactly one declaration has the name, so a pin never reads an empty slice.
function body(source, name) {
  const text = code(source);
  const blanked = withoutStrings(text);
  const head = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`, "gm");
  const hits = [];
  for (const match of blanked.matchAll(head)) {
    const params = closing(blanked, match.index + match[0].length - 1);
    if (params < 0) continue;
    const brace = blanked.slice(params + 1).search(/\S/) + params + 1;
    if (blanked[brace] === "{") hits.push({ start: match.index, brace });
  }
  if (hits.length !== 1) throw new Error(`body: ${hits.length} declarations of ${name}`);
  return text.slice(hits[0].start, closing(blanked, hits[0].brace) + 1);
}
// From `anchor` through the braces that follow it, as code(). Throws unless `anchor` occurs exactly once.
function block(source, anchor) {
  const text = code(source);
  const count = text.split(anchor).length - 1;
  if (count !== 1) throw new Error(`block: ${count} occurrences of ${anchor}`);
  const at = text.indexOf(anchor);
  const blanked = withoutStrings(text);
  return text.slice(at, closing(blanked, blanked.indexOf("{", at + anchor.length)) + 1);
}
const uiFiles = () => jsFiles().filter((url) => relativeName(url).startsWith("ui/"));
// The panel and whatever it splits into: every ui/ module but the two dialogs and the parts they share with it.
const NOT_PANEL = ["ui/detail-dialog.js", "ui/settings-dialog.js", "ui/parts.js"];
const uiCode = () => uiFiles().map((url) => code(read(url))).join("\n");
const panelCode = () => uiFiles().filter((url) => !NOT_PANEL.includes(relativeName(url))).map((url) => code(read(url))).join("\n");

// The pins read code(), so a comment opener inside a string (`"/*"`) would erase code up to the next `*/`, and the
// pins would pass on what is left. Every function and method head in a module must survive the stripper.
const HEAD = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*)?(\w+)\s*\([^()]*\)\s*\{/gm;
const NOT_HEADS = ["if", "for", "while", "switch", "catch", "function", "return"];
test("the comment stripper keeps every declared function and method", () => {
  const heads = (text) => [...text.matchAll(HEAD)].map(([, name]) => name).filter((name) => !NOT_HEADS.includes(name));
  for (const file of jsFiles()) {
    const source = read(file);
    const kept = heads(code(source));
    const lost = heads(source).filter((name) => {
      const at = kept.indexOf(name);
      if (at >= 0) kept.splice(at, 1);
      return at < 0;
    });
    assert.deepEqual(lost, [], relativeName(file));
  }
});

test("only main.js wires Herdr's storage, network and files", () => {
  for (const file of jsFiles()) {
    const name = relativeName(file);
    if (name !== "main.js") assert.doesNotMatch(scanned(read(file)), HERDR_GLOBALS, name);
  }
  const main = read(new URL("main.js", MOD));
  for (const api of ["shared", "setShared", "appHome", "run", "openOverlay", "closeOverlay"]) {
    assert.ok(herdrImports(main).includes(api), `main.js imports ${api}`);
  }
  assert.ok(importSpecifiers(main).includes("fs/promises"), "main.js imports fs/promises");
  assert.match(code(main), /(?<![.\w])fetch\s*\(/, "main.js calls fetch");
  assert.doesNotMatch(scanned("this.host.fetch(url); // fetch(url)\n/* localStorage */"), HERDR_GLOBALS);
  assert.doesNotMatch(scanned("const host = { fetch: (url) => url }; quote.fetchedAt; window.paint_path(p)"), HERDR_GLOBALS);
  assert.doesNotMatch(scanned('const text = "kept in localStorage";'), HERDR_GLOBALS);
  assert.match(scanned('const u = "https://x"; globalThis'), HERDR_GLOBALS);
  assert.doesNotMatch(scanned("const t = `kept in ${'localStorage'} and \\` fetch(u)`;"), HERDR_GLOBALS);
  for (const source of [
    "const get = fetch;", "window.fetch(url)", "self . fetch(url)", "const { fetch: get } = window;", 'const s = "a"; localStorage.getItem("k")',
    // A quote of the other kind inside a string, or inside a template, hides nothing after it.
    "const q = '\"'; localStorage.x; const r = '\"';", "const s = `a\"`; fetch(u); const t = \"x\";",
    // A template's expressions are code, also nested.
    "const u = `${host}/${fetch(u)}`;", "const v = `a${`b${globalThis}`}c`;", "const w = `${{ a: 1 }.a}`; localStorage.x;",
  ]) {
    assert.match(scanned(source), HERDR_GLOBALS, source);
  }
});

// The one program Wickline runs: `chmod 600` on its key file, through Herdr's `exec`, called once in
// main.js and handed to secrets.js as `chmod(path)`. No module imports `process` (or `child_process`) or
// reaches the global of that name; `exec` appears in main.js only in its import and that one call.
const PROCESS_GLOBAL = /(?<![.\w$])process\b/;
// The Herdr commands the moves between a pane, a tab and a docked block run (`host.run` is Herdr's `run`,
// handed in by main.js): commands, not programs.
const MOVE_COMMANDS = ["tab.new", "tab.select", "pane.split", "pane.close", "layout.hide", "layout.show", "layout.select"];
test("the only program is chmod 600 on the key file", () => {
  for (const file of jsFiles()) {
    const name = relativeName(file);
    for (const banned of ["process", "child_process"]) assert.ok(!importSpecifiers(read(file)).includes(banned), `${banned} imported in ${name}`);
    assert.doesNotMatch(withoutStrings(code(read(file))), PROCESS_GLOBAL, name);
  }
  const main = code(read(new URL("main.js", MOD)));
  assert.ok(herdrImports(main).includes("exec"), "main.js imports exec");
  assert.doesNotMatch(main, /\bexec\s+as\b/, "exec imported under another name");
  assert.equal([...main.matchAll(/\bexec\b/g)].length, 2, "exec imported and called once");
  assert.equal([...flat(main).matchAll(/exec\("chmod",\["600",\w+\]\)/g)].length, 1, 'exec("chmod", ["600", path])');
  // Besides main.js, only moves.js runs anything, and only those commands, each named as it is run.
  for (const file of jsFiles().filter((url) => relativeName(url) !== "main.js")) {
    const name = relativeName(file);
    const source = code(read(file));
    assert.doesNotMatch(source, /\bexec\b/, name);
    const runs = [...source.matchAll(/\.run\s*\(/g)].length;
    if (name !== "moves.js") {
      assert.equal(runs, 0, `.run( in ${name}`);
      continue;
    }
    const commands = [...source.matchAll(/(?<![.\w$])host\.run\(\s*"([^"]*)"/g)].map(([, id]) => id);
    assert.equal(commands.length, runs, "every run in moves.js is host.run with its command named");
    assert.deepEqual([...new Set(commands)].sort(), [...MOVE_COMMANDS].sort());
  }
});

// The settings dialog learns only that a key is saved and its ending: the full-key loader is wired to the
// panel's watchlist alone, and the dialog's loader goes through loadSecretEnding.
test("the settings dialog never loads the full key", () => {
  const main = code(read(new URL("main.js", MOD)));
  // Two uses: its definition, and the panel's Watchlist.
  const uses = [...main.matchAll(/(?<![.\w$])loadSecret\b/g)].map(({ index }) => index);
  assert.equal(uses.length, 2, "loadSecret defined and used once");
  assert.equal(uses[0], main.search(/(?<=\bconst\s+)loadSecret\s*=/), "the first is the definition");
  assert.match(flat(main), /constloadSecret=\((\w+)\)=>secrets\.loadSecret\(fs,secretsDir\(\),\1\)/);
  const watch = block(main, "new Watchlist(");
  const watchAt = main.indexOf(watch);
  assert.ok(uses[1] > watchAt && uses[1] < watchAt + watch.length, "the other is the panel's Watchlist");
  assert.match(flat(main), /constloadSecretEnding=\((\w+)\)=>secrets\.loadSecretEnding\(fs,secretsDir\(\),\1\)/);
  const reader = body(main, "readKeyEnding");
  assert.match(reader, /\bloadSecretEnding\(\s*SECRET_KEY_FINNHUB\s*\)/);
  assert.doesNotMatch(reader, /\bloadSecret\b|secrets\./);
  for (const name of ["ui/settings-dialog.js", "settings.js"]) assert.doesNotMatch(code(read(new URL(name, MOD))), /\bloadSecret|secrets\./, name);
});

// Every module is a .js file: an .mjs, .cjs or .ts one would escape the scans above.
test("the mod holds only .js modules, its mod.json and SVG icons", () => {
  for (const file of files(MOD)) assert.match(relativeName(file), /\.(js|json|svg)$/, relativeName(file));
});

// "none": installing never docks Wickline into the person's layout; the open key or pane.split opens it.
test("mod.json docks Wickline nowhere", () => {
  assert.deepEqual(JSON.parse(read(new URL("mod.json", MOD))), { place: "none", title: "Wickline" });
});

test("keys.json binds only the open key", () => {
  assert.deepEqual(JSON.parse(read(new URL("keys.json", ROOT))), {
    global: { "ctrl-alt-b": { command: "pane.split", args: { direction: "right", mod: "wickline" } } },
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
    for (const [, code] of text.matchAll(/"((?:symbol|yahoo|yahootw|binance|mis|finnhub|request|notice|budget)\.[A-Za-z]+)"/g)) notices.add(code);
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

test("README and RECIPE show the preview and say how to open Wickline", () => {
  for (const name of ["README.md", "README.zh-TW.md", "RECIPE.md"]) {
    const text = read(new URL(name, ROOT));
    assert.match(text, /preview\.png/, name);
    assert.ok(text.includes("ctrl-alt-b"), `open key in ${name}`);
    assert.ok(text.includes("herdr-app do pane.split --direction right --mod wickline"), `manual open in ${name}`);
  }
});

// herdr.dev/mods drops a repo whose recipe exceeds about 64 KiB; 57,000 keeps a margin below it.
test("RECIPE.md stays under the gallery's size limit", () => {
  assert.ok(statSync(new URL("RECIPE.md", ROOT)).size <= 57_000, "RECIPE.md over 57,000 bytes");
});

// Field-level build details live beside the recipe, so the gallery's copy stays under its limit.
const COMPANIONS = { "RECIPE-internals.md": "# Wickline — internals", "RECIPE-sources.md": "# Wickline — sources" };
test("each RECIPE companion stays short", () => {
  for (const name of Object.keys(COMPANIONS)) assert.ok(statSync(new URL(name, ROOT)).size <= 30_000, `${name} over 30,000 bytes`);
});

test("RECIPE.md links to each companion, which exists", () => {
  for (const [name, heading] of Object.entries(COMPANIONS)) {
    assert.match(read(new URL("RECIPE.md", ROOT)), new RegExp(`\\]\\(${name.replace(".", "\\.")}[)#]`));
    assert.ok(statSync(new URL(name, ROOT)).isFile(), `${name} missing`);
    assert.match(read(new URL(name, ROOT)), new RegExp(`^${heading}$`, "m"));
  }
  assert.match(read(new URL("RECIPE-internals.md", ROOT)), /\]\(RECIPE-sources\.md[)#]/);
});

// Only ASCII anchors are checked (a `#yahoo-奇摩股市` anchor is skipped): companion headings stay ASCII ("Yahoo TW Stock").
test("every link into a RECIPE companion lands on one of its headings", () => {
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  for (const doc of ["RECIPE.md", ...Object.keys(COMPANIONS), "README.md", "README.zh-TW.md"]) {
    for (const [, target, anchor] of read(new URL(doc, ROOT)).matchAll(/\]\((RECIPE-[a-z]+\.md)#([a-z0-9-]+)\)/g)) {
      const slugs = [...read(new URL(target, ROOT)).matchAll(/^#+ (.+)$/gm)].map(([, h]) => slug(h));
      assert.ok(slugs.includes(anchor), `${doc} → ${target}#${anchor}`);
    }
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
  assert.ok(read(new URL("ui/settings-dialog.js", MOD)).includes('"disclaimer.key"'), "the tab shows disclaimer.key");
});

// The prevailing Traditional Chinese statements, word for word as the Taiwan card shows them: one quote,
// its paragraphs in order, each on a `> ` line of its own and parted by a bare `>`.
test("README.zh-TW.md quotes both Taiwan statements", () => {
  const readme = read(new URL("README.zh-TW.md", ROOT));
  for (const key of ["mis.statement", "yahootw.statement"]) {
    const quote = STRINGS["zh-TW"][key].split("\n\n").map((paragraph) => `> ${paragraph}`).join("\n>\n");
    assert.ok(readme.includes(quote), key);
  }
});

// Key points first: until consented, a source shows its summary and a link that opens the full statement
// in place; the box stays below, reachable without opening it.
test("the consent shows key points first and the full statement on request", () => {
  const parts = flat(body(read(new URL("ui/settings-dialog.js", MOD)), "consentParts"));
  assert.match(parts, /view\.tx\(`\$\{source\}\.summary`\)/);
  assert.match(parts, /"settings\.hideFullStatement":"settings\.fullStatement"/);
  assert.ok(parts.indexOf(".summary`") < parts.indexOf('"settings.fullStatement"'), "key points before the link");
  // Each key point its own row (its text hangs past the bullet), and the link discloses like Advanced.
  assert.match(parts, /\.summary`\)\.split\("\\n"\)/);
  assert.match(parts, /open\?"⌄":"›"/);
  // Not yet consented: only the full statement waits for the link; the box follows it either way.
  assert.match(parts, /open\?statement:null,\.\.\.box\]/);
});

test("the disclosure names every host and the key file in all four places", () => {
  const docs = ["README.md", "README.zh-TW.md", "RECIPE.md"].map((name) => [name, read(new URL(name, ROOT))]);
  for (const lang of Object.keys(STRINGS)) {
    const privacy = ["privacy.hosts", "privacy.storage", "privacy.finnhub"].map((key) => STRINGS[lang][key]).join(" ");
    docs.push([`${lang} privacy`, privacy]);
  }
  for (const [name, text] of docs) {
    for (const host of ALLOWED_HOSTS) assert.ok(text.includes(host), `${host} in ${name}`);
    assert.ok(text.includes("data/wickline/secrets.json"), `key file in ${name}`);
    // The default cap, behind the budget and the two-copies warning.
    assert.ok(text.includes("15"), `cap in ${name}`);
  }
});

// The Yahoo 奇摩股市 host is named with what it is asked for, in every place the disclosure lives.
test("the disclosure says Yahoo 奇摩股市 is asked for futures too", () => {
  const future = { en: /futures/, "zh-TW": /期貨/, "zh-CN": /期货/, ja: /先物/, ko: /선물/ };
  const places = [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["RECIPE.md", "en"]]
    .map(([name, lang]) => [name, lang, read(new URL(name, ROOT)).split("\n")]);
  // Sentences end with 。, or with a period and a space (the host names keep their own dots).
  for (const lang of Object.keys(STRINGS)) places.push([`${lang} privacy.hosts`, lang, STRINGS[lang]["privacy.hosts"].split(/(?<=。)|(?<=\.)\s+/)]);
  for (const [name, lang, parts] of places) {
    const naming = parts.filter((part) => part.includes("tw.stock.yahoo.com"));
    assert.ok(naming.some((part) => future[lang].test(part)), name);
  }
});

// What every disclosure says beside the holiday schedule's host: while the list holds a Taiwan symbol, by GET,
// once a day per open copy and hourly after a failure, with no key, nothing stored.
const SCHEDULE_WORDS = {
  en: [/once a day per open copy/, /retried hourly after a failure/, /Taiwan symbol/, /no key/, /nothing (from it )?(is )?stored/],
  "zh-TW": [/每個開啟的 copy 每天/, /失敗後每小時重試/, /台灣商品/, /不需金鑰/, /不儲存/],
  "zh-CN": [/每个打开的副本每天/, /失败后每小时重试/, /台湾商品/, /无需密钥/, /不保存/],
  ja: [/開いているコピーごとに 1 日 1 回/, /失敗した場合は 1 時間ごとに再試行/, /台湾の銘柄/, /キーは不要/, /何も保存しません/],
  ko: [/열려 있는 사본마다 하루 한 번/, /실패하면 1시간마다 다시 시도/, /대만 종목/, /키는 필요 없/, /저장하지 않습니다/],
};
test("the schedule's host is named with what is asked", () => {
  const places = [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["RECIPE.md", "en"]]
    .map(([name, lang]) => [name, lang, read(new URL(name, ROOT)).split("\n")]);
  for (const lang of Object.keys(STRINGS)) places.push([`${lang} privacy.hosts`, lang, STRINGS[lang]["privacy.hosts"].split(/(?<=。)|(?<=\.)\s+/)]);
  for (const [name, lang, parts] of places) {
    const naming = parts.filter((part) => part.includes("openapi.twse.com.tw"));
    assert.ok(naming.some((part) => /GET/.test(part) && SCHEDULE_WORDS[lang].every((word) => word.test(part))), name);
  }
});

const ATTRIBUTION = "臺灣證券交易所 有價證券集中交易市場開（休）市日期（每年最新版）；此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。https://data.gov.tw/license";
test("the holiday schedule is credited with its licence in both READMEs, RECIPE and the tab", () => {
  for (const [name, lang] of [["README.md", "en"], ["README.zh-TW.md", "zh-TW"]]) {
    const text = read(new URL(name, ROOT));
    assert.ok(text.includes(STRINGS[lang]["disclaimer.sourcesHolidays"]), name);
    assert.ok(text.includes(ATTRIBUTION), name);
  }
  assert.ok(STRINGS["zh-TW"]["disclaimer.sourcesHolidays"].startsWith("休市日資料來源：臺灣證券交易所 OpenAPI"));
  assert.ok(STRINGS["zh-TW"]["disclaimer.sourcesHolidays"].includes("政府資料開放授權條款－第1版"));
  const recipe = read(new URL("RECIPE.md", ROOT));
  assert.ok(recipe.includes("Holiday data: Taiwan Stock Exchange OpenAPI"), "credit in RECIPE.md");
  assert.match(recipe, /Open Government Data License/);
  assert.ok(read(new URL("ui/settings-dialog.js", MOD)).includes('"disclaimer.sourcesHolidays"'));
});

// The one program, the owner-only key file, the fixed Finnhub host and the real revoke, in all four places.
// README and RECIPE name `chmod 600` for technical readers; the app says the same fact in plain words.
const OWNER_ONLY = {
  en: /only your account can read it/, "zh-TW": /只有你的帳號能讀取/, "zh-CN": /只有你的账户能读取/,
  ja: /あなたのアカウントだけが読める/, ko: /내 계정만 읽을 수 있/,
};
const NOTHING_ELSE = {
  en: /No other programs run/, "zh-TW": /不執行其他任何程式/, "zh-CN": /不运行其他任何程序/,
  ja: /それ以外のプログラムは実行しません/, ko: /그 밖의 프로그램은 실행하지 않습니다/,
};
// The companions hold build details, not the disclosure: they are only checked for what they must never claim.
test("the disclosure names the chmod, the fixed Finnhub host and how to revoke the key", () => {
  const docs = [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["RECIPE.md", "en"], ...Object.keys(COMPANIONS).map((name) => [name, "en"])].map(([name, lang]) => [name, lang, read(new URL(name, ROOT))]);
  for (const lang of Object.keys(STRINGS)) {
    docs.push([`${lang} privacy`, lang, ["privacy.hosts", "privacy.programs", "privacy.storage"].map((key) => STRINGS[lang][key]).join(" ")]);
  }
  const revoke = { en: /regenerat/i, "zh-TW": /重新產生/, "zh-CN": /重新生成/, ja: /再発行/, ko: /재발급/ };
  const settable = { en: /Finnhub address you set/i, "zh-TW": /你設定的 Finnhub 網址/, "zh-CN": /你设置的 Finnhub 网址/ };
  for (const [name, lang, text] of docs) {
    if (name.endsWith(" privacy")) {
      // The same fact as chmod 600, without the jargon: the key file, after saving, readable by your account only.
      const programs = STRINGS[lang]["privacy.programs"];
      assert.doesNotMatch(programs, /chmod/, `no jargon in ${name}`);
      assert.match(programs, OWNER_ONLY[lang], `owner-only in ${name}`);
      assert.match(programs, /macOS/, `macOS in ${name}`);
      assert.match(programs, /Linux/, `Linux in ${name}`);
      assert.match(programs, NOTHING_ELSE[lang], `nothing else runs in ${name}`);
    } else if (!(name in COMPANIONS)) {
      assert.ok(text.includes("chmod 600"), `chmod 600 in ${name}`);
    }
    if (!(name in COMPANIONS)) assert.match(text, revoke[lang], `revoke in ${name}`);
    if (settable[lang]) assert.doesNotMatch(text, settable[lang], `a settable Finnhub host in ${name}`);
    assert.doesNotMatch(text, /Programs: none|No programs|(?<!除此之外)不執行任何程式|不執行程式|(?<!除此之外)不运行任何程序/, `"no programs" in ${name}`);
  }
});

// The product is Wickline; the old working name must not linger anywhere a person or an installing agent reads.
test("no tracked file names the old working name", () => {
  const root = new URL("../", import.meta.url);
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const old = ["bell", "wether"].join("");
  for (const name of tracked) {
    if (name.endsWith(".png")) continue;
    assert.doesNotMatch(read(new URL(name, root)), new RegExp(old, "i"), name);
  }
});

// gpui reads a bare number as a multiplier of the text size, not pixels: a line height is always a length string.
test("line heights are given in pixels", () => {
  for (const file of jsFiles()) assert.doesNotMatch(code(read(file)), /\.line_height\(\s*[\d.]/, relativeName(file));
});

// A scroll box inside the scrolling page clipped the statements and let them run past its edge: the page
// alone scrolls, and every text wraps to the page width.
test("the settings dialog scrolls only its page", () => {
  assert.equal(uiCode().match(/overflow_y_scrollbar\(/g).length, 1);
  assert.match(flat(uiCode()), /id\("bw-settings-pane"\)[^;]*overflow_y_scrollbar\(/);
});

// overflow_y_scrollbar paints its bar along the list's right edge, over the column where each row's remove ×
// sits. The list scrolls on its own, and a separate bar sits in a lane of its own beside that column: the list
// keeps the lane clear of rows, and every region keeps the same right inset, so all of them end on one edge.
test("the list's scrollbar has its own lane", () => {
  const panel = panelCode();
  const list = flat(body(panel, "list"));
  assert.match(list, /id\("bw-list"\)[^;]*overflow_y_scroll\(/);
  assert.doesNotMatch(list, /overflow_y_scrollbar\(/);
  assert.match(list, /id\("bw-list"\)[^;]*\.pr\(SCROLL_LANE\)/);
  assert.match(flat(panel), /Scrollbar\.vertical\("bw-list"\)[^;]*\.right\(0\)/);
  assert.match(flat(panel), /Scrollbar\.vertical\("bw-list"\)[^;]*\.w\(SCROLL_LANE\)/);
  assert.doesNotMatch(panel, /\.mode\s*\(/);
  assert.match(flat(panel), /id\(`bw-remove-\$\{symbol\}`\)[^;]*\.w\(REMOVE_W\)/);
  // `inset` pads every region; the only other gutter is the empty-list text's, inside the list, ending at the ×.
  const ui = uiCode();
  assert.equal(ui.match(/pr\(\s*RIGHT_INSET\s*\)/g).length, 1);
  assert.equal(ui.match(/pl\(\s*GUTTER\s*\)/g).length, 2);
  assert.doesNotMatch(ui, /(?:px|pr|right)\(\s*GUTTER\s*\)/);
  assert.doesNotMatch(ui, /\.p[xr]\(\s*20\s*\)/);
});

test("the sidebar list keeps its gap and hairline outside the scroll", () => {
  const panel = panelCode();
  const list = flat(body(panel, "list"));
  for (const anchor of ['id("bw-list")', ".children(rows)", "returnv_flex"]) assert.ok(list.includes(anchor), anchor);
  const box = list.slice(list.indexOf('id("bw-list")'), list.indexOf(".children(rows)"));
  // The gap no longer scrolls away with the rows.
  assert.doesNotMatch(box, /\.pt\(/);
  const tree = list.slice(list.indexOf("returnv_flex"));
  assert.ok(tree.includes(".when("), ".when(");
  assert.match(tree.slice(0, tree.indexOf(".when(")), /\.pt\(top\)/);
  // A 1 px border hairline, only for a list with a gap (the sidebar), inset like the footer's, above the scrolling box.
  assert.match(list, /top>0[^;]*map\(inset\)[^;]*border_t\(1\)[^;]*border_color\(t\.border\)/);
  assert.ok(tree.indexOf("border_t(1)") > 0 && tree.indexOf("border_t(1)") < tree.indexOf("scrolling"));
  // The bar is the scrolling box's next sibling, in the relative box that holds both.
  assert.match(tree, /\.relative\(\)[^;]*\.child\(scrolling\)\.child\(Scrollbar\.vertical\("bw-list"\)/);
  // The empty-list text stays inside the scrolling box, so it sits below the hairline.
  assert.match(box, /list\.empty/);
  assert.match(flat(panel), /list\(\w+,\w+,\w+,8\)/);
  assert.match(flat(panel), /list\(\w+,\w+,\w+\)\)/);
});

// The notice ends with its own full stop (。 in Chinese and Japanese), so a separator before Undo would sit
// right after it; the link follows the text with only the gap between them.
test("Undo follows the notice with no separator", () => {
  const messages = body(panelCode(), "messages");
  assert.match(flat(messages), /link\(\w+,"bw-undo"/);
  assert.doesNotMatch(messages, /"·"/);
});

// 亮燈 as Taiwan's quote boards draw it: a solid block in the limit's color with the panel's background as
// ink, so it stands apart from the 16% chart fill beside it. Static: nothing here animates on its own.
test("a lit price is a solid block that never animates", () => {
  const box = body(uiCode(), "priceBox");
  assert.ok(flat(box).includes(".bg(mark.color)"), ".bg(mark.color)");
  assert.ok(flat(box).includes("mark.ink"), "mark.ink");
  assert.doesNotMatch(box, /opacity|transition|loop\(|frames\(|tint/);
});

test("a collapsed sidebar row is one line with its notes", () => {
  const source = body(panelCode(), "sidebarRow");
  const row = flat(source);
  assert.ok(row.includes("collapsedRow(row)"), "collapsedRow(row)");
  // The body is chosen once and framed by one call, so a fading (ghost) row collapses exactly as a live one
  // does: the choice never looks at `ghost`, and a removed failed row fades from its short height.
  assert.equal(source.match(/\bghostFrame\s*\(/g)?.length, 1);
  assert.equal(source.match(/\browFrame\s*\(/g)?.length, 1);
  assert.doesNotMatch(row, /!ghost&&collapsedRow|collapsedRow[^;]*!ghost/);
  assert.ok(row.indexOf("collapsedRow(row)") < row.indexOf("ghost?ghostFrame("));
});

test("the detail's stats are numbers without the currency", () => {
  assert.match(flat(read(new URL("ui/detail-dialog.js", MOD))), /\bnumber\(\w+,price\)/);
});

test("the detail names a future's day or night session", () => {
  assert.match(flat(read(new URL("ui/detail-dialog.js", MOD))), /view\.tx\(`session\.\$\{sessionName\(/);
});

test("the detail's session times sit between the source lines and the times", () => {
  const detail = flat(read(new URL("ui/detail-dialog.js", MOD)));
  assert.match(detail, /\[\.\.\.source,\.\.\.\(hours\.length\?\[hours\]:\[\]\),times\]/);
  assert.match(detail, /sessionTimesParts\(sessionTimes\(\w+,\w+\),view\.lang,\w+\)/);
});

test("rows keep their own look: only the detail dims together", () => {
  const panel = panelCode();
  assert.match(panel, /\bpriceInk\(/);
  assert.doesNotMatch(panel, /detailDimmed/);
  const detail = code(read(new URL("ui/detail-dialog.js", MOD)));
  assert.match(detail, /detailDimmed\(/);
});

test("no module names session.unknown, and the detail's header shows no word for an unknown session", () => {
  for (const file of jsFiles()) assert.ok(!code(read(file)).includes("session.unknown"), relativeName(file));
  assert.ok(flat(read(new URL("ui/detail-dialog.js", MOD))).includes('!=="unknown"'));
});

test("the pause key acts as the button does", () => {
  const main = flat(read(new URL("main.js", MOD)));
  assert.match(main, /command==="pause"\)this\.act\(\w+,\(\)=>this\.togglePause\(\)\)/);
  assert.doesNotMatch(main, /command==="pause"\)this\.togglePause\(\)/);
});

test("render settles a choice a pending index held", () => {
  const main = read(new URL("main.js", MOD));
  assert.ok(flat(main).includes("this.filterHeld=heldFilter("), "this.filterHeld = heldFilter(");
  const render = flat(body(main, "render"));
  // After the sync, so another copy's quotes count; with nothing pending, so the choice cannot stay held.
  assert.ok(render.includes("this.watch.sync()"), "this.watch.sync()");
  assert.ok(render.indexOf("this.watch.sync()") < render.indexOf("this.filterHeld"), "settles after watch.sync()");
  assert.match(render, /if\(this\.filterHeld[\s\S]*?filterAfterRemove\([^;]*\(\)=>false\)/);
});

test("the settings dialog reads Yahoo's delay and real-time pace from the exchange table", () => {
  const delay = flat(body(read(new URL("ui/settings-dialog.js", MOD)), "delayText"));
  assert.match(delay, /exchangeRule\(TYPICAL_EXCHANGE\[\w+\]/);
  assert.match(delay, /realtime[^;]*"settings\.liveEveryMinute"/);
  assert.doesNotMatch(uiCode(), /TAIWAN_YAHOO_DELAY_S/);
});

// A lunch break is a session: no dot, like closed or pre-market.
test("only a price that may not be current draws a ring", () => {
  assert.equal(flat(uiCode()).split('=["unconfirmed","stalled","delayed"]').length - 1, 1);
});

test("the US page says what Finnhub adds", () => {
  const us = flat(body(read(new URL("ui/settings-dialog.js", MOD)), "usPage"));
  assert.match(us, /details\(note\(\w+,view\.tx\("sources\.us\.faster"\)\)/);
});

test("the docs call Yahoo's US prices real time, and name lunch, FX and futures", () => {
  for (const name of ["README.md", "RECIPE.md"]) {
    const doc = read(new URL(name, ROOT));
    assert.doesNotMatch(doc, /United States \| Yahoo Finance \(delayed\)|Real time for up to|showing Yahoo|real-time limit/, name);
    for (const word of ["Lunch", "22:00 UTC", "indicative"]) assert.ok(doc.includes(word), `${name} ${word}`);
  }
  const zh = read(new URL("README.zh-TW.md", ROOT));
  assert.doesNotMatch(zh, /美股 \| Yahoo Finance（延遲）/);
  for (const word of ["午休", "22:00 UTC", "參考報價"]) assert.ok(zh.includes(word), word);
});

test("the row's stale date is judged by the quote's own day", () => {
  assert.match(flat(panelCode()), /rowDate\(quote,\w+,now,view\.lang\)/);
});

test("the status line shows the no-trades notes after the problems", () => {
  assert.ok(flat(panelCode()).includes("[...view.watch.problems(),...view.watch.notes()]"));
});

// One render reads every row's quote at its one `now`, so each Taiwan market's closure is worked out once
// (Watchlist#closureAt) and every row reads the same one.
test("a render reads every row's quote at its one now", () => {
  const main = read(new URL("main.js", MOD));
  const rowSource = flat(body(main, "rowSource"));
  assert.ok(rowSource.startsWith("rowSource(symbol,now){"), rowSource.slice(0, 40));
  assert.doesNotMatch(rowSource, /Date\.now\(\)/);
  assert.doesNotMatch(panelCode(), /\.shown\(\s*symbol\s*\)|rowSource\(\s*symbol\s*\)/);
});

// The first write is a boundary like handOver's: a failed one opens the detail on its quote, with no token (the
// detail then keeps the quote it opened with), never blocks it.
test("a failed first write never keeps the detail from opening", () => {
  const open = flat(body(read(new URL("main.js", MOD)), "openDetail"));
  const guarded = open.match(/try\{detailStore\.write\(value\);[^}]*\}catch\{([^}]*)\}/);
  assert.ok(guarded, "the write is guarded");
  assert.match(guarded[1], /token=null/);
  assert.ok(open.indexOf("openOverlay(") > open.indexOf(guarded[0]) + guarded[0].length, "the dialog opens after the guard");
  assert.ok(open.includes("props:{detail,token,wide}"), "props: { detail, token, wide }");
});

// The detail copy only reads what its row hands it (handover.js): no request, no list of its own.
test("the detail copy sends no request and owns no Watchlist", () => {
  const branch = flat(block(read(new URL("main.js", MOD)), "if (given.detail)"));
  assert.ok(branch.includes("this.held="), "the detail branch");
  for (const word of ["newWatchlist", "fetch", "runProvider"]) assert.ok(!branch.includes(word), word);
});

test("only detailStore touches wickline.detail, and the hand-over decides in one synchronous step", () => {
  const source = read(new URL("main.js", MOD));
  const main = code(source);
  assert.ok(!withoutStrings(main).includes("wickline.detail") && !/["'`]wickline\.detail["'`]/.test(main), "the key by its constant only");
  const store = block(source, "const detailStore =");
  assert.ok(flat(store).includes("read:()=>shared(DETAIL_KEY)"), "read: () => shared(DETAIL_KEY)");
  assert.match(flat(store), /write:\((\w+)\)=>setShared\(DETAIL_KEY,\1\)/);
  const uses = [...main.matchAll(/DETAIL_KEY/g)].map((m) => m.index);
  const importAt = main.search(/import\s*\{[^}]*\bDETAIL_KEY\b[^}]*\}\s*from\s*"\.\/handover\.js"/);
  const storeAt = main.indexOf(store);
  for (const at of uses) {
    const inImport = importAt >= 0 && at > importAt && at < main.indexOf(";", importAt);
    const inStore = at > storeAt && at < storeAt + store.length;
    assert.ok(inImport || inStore, `DETAIL_KEY at ${at}`);
  }
  const handOver = body(source, "handOver");
  assert.ok(flat(handOver).includes("nextWrite(detailStore.read(),this.handover,"), "nextWrite(detailStore.read(), this.handover, …");
  assert.doesNotMatch(handOver, /\bawait\b/);
  const open = flat(body(source, "openDetail"));
  assert.ok(open.indexOf("detailStore.write(") >= 0 && open.indexOf("detailStore.write(") < open.indexOf("openOverlay("), "written before the dialog opens");
  assert.match(flat(main), /changed:\(\)=>\{this\.handOver\(\);cx\.notify\(\);?\}/);
  assert.ok(flat(body(source, "close")).includes("clearsOnClose(detailStore.read(),this.held"), "clearsOnClose(detailStore.read(), this.held");
  const render = flat(body(source, "render"));
  assert.ok(render.includes("if(this.detail)") && render.includes("detailView("), "the detail's render");
  const branch = render.slice(render.indexOf("if(this.detail)"), render.indexOf("detailView(") + 1);
  assert.match(branch, /this\.adoptDetail\(\)/);
});

// What the disclosure says of the open detail's key, per language.
const DETAIL_KEY_WORDS = {
  en: [/wickline\.detail/, /saved to disk/, /copy that opened it/, /cleared when it closes/, /next detail opens/, /no request of its own/],
  "zh-TW": [/wickline\.detail/, /寫入磁碟/, /開啟它的那個/, /關閉時清除/, /下次開啟詳細資料/, /不會自行發出任何請求/],
  "zh-CN": [/wickline\.detail/, /写入磁盘/, /打开它的那个/, /关闭时清除/, /下次打开详情/, /不会自行发出任何请求/],
  ja: [/wickline\.detail/, /ディスクに保存/, /開いたコピー/, /閉じると消去/, /次に詳細を開く/, /独自のリクエストは送りません/],
  ko: [/wickline\.detail/, /디스크에 저장/, /연 사본/, /닫으면 지웁니다/, /다음에 상세를 열/, /자체 요청은 보내지 않습니다/],
};
const STORAGE_NAMES = ["wickline.watchlist.v1", "wickline.settings.v1", "wickline.dockTab", "wickline.detail", "data/wickline/secrets.json",
  "localStorage"];
test("Storage named", () => {
  const places = ["README.md", "README.zh-TW.md", "RECIPE.md"].map((name) => [name, read(new URL(name, ROOT))]);
  for (const lang of Object.keys(STRINGS)) places.push([`${lang} privacy.storage`, STRINGS[lang]["privacy.storage"]]);
  for (const [name, text] of places) for (const key of STORAGE_NAMES) assert.ok(text.includes(key), `${key} in ${name}`);
});

test("The detail's key", () => {
  // A doc says it all on one line naming the key; the app's storage text, anywhere in it.
  const places = [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["RECIPE.md", "en"]]
    .map(([name, lang]) => [name, lang, read(new URL(name, ROOT)).split("\n").filter((line) => line.includes("wickline.detail"))]);
  for (const lang of Object.keys(STRINGS)) places.push([`${lang} privacy.storage`, lang, [STRINGS[lang]["privacy.storage"]]]);
  for (const [name, lang, parts] of places) {
    assert.ok(parts.some((part) => DETAIL_KEY_WORDS[lang].every((word) => word.test(part))), name);
  }
});

test("only the detail's chart follows the pointer", () => {
  assert.doesNotMatch(panelCode(), /crosshair/);
  const parts = read(new URL("ui/parts.js", MOD));
  assert.equal(code(parts).match(/on_mouse_move/g)?.length, 1);
  assert.match(flat(parts), /\.when\(Boolean\(crosshair\)[\s\S]*?on_mouse_move/);
  const detail = flat(read(new URL("ui/detail-dialog.js", MOD)));
  assert.match(detail, /crosshair:\w+\?crosshairOption\(/);
  assert.ok(detail.includes("bw-detail-chart"), "bw-detail-chart");
});
test("the crosshair's label dims with the detail and with a cached line", () => {
  assert.match(flat(read(new URL("ui/detail-dialog.js", MOD))), /dimmed\|\|Boolean\(\w+\.chartCached\)/);
});
test("the crosshair's card stays opaque: only its text dims", () => {
  const layers = body(uiCode(), "crosshairLayers");
  const plate = layers.match(/const\s+card\s*=[\s\S]*?\.bg\(\s*t\.background\s*\)[\s\S]*?\.child\(/)?.[0];
  assert.ok(plate);
  assert.doesNotMatch(plate, /opacity/);
  assert.ok(flat(layers).includes(".opacity(mark.opacity)"), ".opacity(mark.opacity)");
  assert.ok(flat(layers).includes("mark.level"), "mark.level");
  assert.doesNotMatch(layers, / · /);
});
test("the crosshair card's lines carry fixed line heights that sum to the height crosshairLevel assumes", () => {
  const layers = flat(body(uiCode(), "crosshairLayers"));
  assert.ok(layers.includes('div().opacity(mark.opacity).line_height("14px")'), "the time's 14 px line");
  assert.ok(layers.includes('h_flex().opacity(mark.opacity).line_height("16px")'), "the price's 16 px line");
  assert.ok(layers.includes(".gap(2).px(6).py(4)"), "the card's gap and padding");
  // 14 + 2 (gap) + 16 + 4 + 4 (py) = crosshairLevel's CROSSHAIR_CARD_PX
  assert.equal(CROSSHAIR_CARD_PX, 14 + 2 + 16 + 4 + 4);
});
test("the chart's date stands below the detail's chart, never over its line", () => {
  const params = uiCode().match(/function\s+chart\s*\(([^)]*)\)/);
  assert.ok(params, "chart found");
  assert.doesNotMatch(params[1], /\bdate\b/);
  const detail = flat(read(new URL("ui/detail-dialog.js", MOD)));
  assert.match(detail, /lineDate\(\w+,view\.lang\)/);
  // The date line wraps the chart from outside, and the chart's own options never see the date.
  assert.match(detail, /\w+!==null&&dated\(chart\(/);
  assert.match(detail, /child\(box\)\.child\(div\(\)[^;]*child\(lineDay\)/);
  const options = detail.match(/dated\(chart\(\w+,\w+,\w+,\{[\s\S]*?\}\)\)/)?.[0] ?? "";
  assert.ok(options);
  assert.doesNotMatch(options, /lineDay|lineDate/);
});
