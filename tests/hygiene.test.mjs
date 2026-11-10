// node --test tests/  (what ships in the mod, and how it credits its origin)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MESSAGES_EN } from "../mods/wickline/quotes.js";
import { STRINGS } from "../mods/wickline/i18n.js";
import { Watchlist } from "../mods/wickline/watchlist.js";
import { SECRET_KEY_FINNHUB } from "../mods/wickline/settings.js";

const MOD = new URL("../mods/wickline/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
// mis.twse.com.tw only once the person turns TWSE MIS on and consents; finnhub.io only with Finnhub
// chosen and a key saved.
const ALLOWED_HOSTS = ["query1.finance.yahoo.com", "data-api.binance.vision", "mis.twse.com.tw", "tw.stock.yahoo.com", "finnhub.io"];
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

// Herdr's globals reach no module but main.js either: `fetch` (the core gets it as `host.fetch`), also
// aliased or through `window` / `self` (also destructured), `localStorage`, and `globalThis`, through which a module could
// find anything else. `fetch:` as an object key and `fetchedAt` are not the global.
const HERDR_GLOBALS = /(?<![.\w$])(?:fetch\b(?!\s*:)|localStorage\b|globalThis\b)|\b(?:window|self)\s*\.\s*fetch\b|\}\s*=\s*(?:window|self)\b/;
// The source without comments, which may name these; a `//` after `:` or a quote is a URL, not a comment.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// The source with each string's text left out, quote-aware: '…' and "…" become empty, a template keeps only
// its `${…}` expressions, which are code. (No module writes a quote inside a regex literal.)
function withoutStrings(source) {
  let out = "";
  // One entry per `${…}` being read: how many `{` deep inside it.
  const open = [];
  let i = 0;
  // Template text from `i` to its closing backtick, or to the next `${`, which opens an expression.
  const templateText = () => {
    while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) i += source[i] === "\\" ? 2 : 1;
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
      out += c + c;
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
  assert.deepEqual([...main.matchAll(/\bexec\s*\(.*?\]\)/g)].map(([call]) => call), ['exec("chmod", ["600", path])']);
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
    const commands = [...source.matchAll(/(?<![.\w$])host\.run\("([^"]*)"/g)].map(([, id]) => id);
    assert.equal(commands.length, runs, "every run in moves.js is host.run with its command named");
    assert.deepEqual([...new Set(commands)].sort(), [...MOVE_COMMANDS].sort());
  }
});

// The settings dialog learns only that a key is saved and its ending: the full-key loader is wired to the
// panel's watchlist alone, and the dialog's loader goes through loadSecretEnding.
test("the settings dialog never loads the full key", () => {
  const main = code(read(new URL("main.js", MOD)));
  assert.deepEqual([...main.matchAll(/\bloadSecret\b.*$/gm)].map(([line]) => line.trim()),
    ["loadSecret = (name) => secrets.loadSecret(fs, secretsDir(), name);", "loadSecret,"]);
  assert.match(main, /const loadSecretEnding = \(name\) => secrets\.loadSecretEnding\(fs, secretsDir\(\), name\);/);
  const reader = main.match(/async readKeyEnding\(\) \{[\s\S]*?\n  \}/);
  assert.ok(reader, "readKeyEnding found");
  assert.match(reader[0], /\bloadSecretEnding\(SECRET_KEY_FINNHUB\)/);
  assert.doesNotMatch(reader[0], /\bloadSecret\b|secrets\./);
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

// herdr.dev/mods drops a repo whose recipe exceeds about 64 KiB; keep headroom below it.
test("RECIPE.md stays under the gallery's size limit", () => {
  assert.ok(statSync(new URL("RECIPE.md", ROOT)).size <= 60_000, "RECIPE.md over 60,000 bytes");
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

// The prevailing Traditional Chinese statements, word for word as the Taiwan card shows them.
test("README.zh-TW.md quotes both Taiwan statements", () => {
  const readme = read(new URL("README.zh-TW.md", ROOT));
  for (const key of ["mis.statement", "yahootw.statement"]) assert.ok(readme.includes(STRINGS["zh-TW"][key]), key);
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
test("the disclosure names the chmod, the fixed Finnhub host and how to revoke the key", () => {
  const docs = [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["RECIPE.md", "en"]].map(([name, lang]) => [name, lang, read(new URL(name, ROOT))]);
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
    } else {
      assert.ok(text.includes("chmod 600"), `chmod 600 in ${name}`);
    }
    assert.match(text, revoke[lang], `revoke in ${name}`);
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
  const dialog = code(read(new URL("ui/settings-dialog.js", MOD)));
  assert.equal(dialog.match(/overflow_y_scrollbar\(/g).length, 1);
  assert.match(dialog, /id\("bw-settings-pane"\)[^;]*overflow_y_scrollbar\(/);
});

// overflow_y_scrollbar paints its bar along the list's right edge, over the column where each row's remove ×
// sits. The list scrolls on its own, and a separate bar sits in a lane of its own beside that column: the list
// keeps the lane clear of rows, and every region keeps the same right inset, so all of them end on one edge.
test("the list's scrollbar has its own lane", () => {
  const panel = code(read(new URL("ui/panel.js", MOD)));
  const list = panel.slice(panel.indexOf("function list("), panel.indexOf("function footer("));
  assert.match(list, /id\("bw-list"\)[^;]*overflow_y_scroll\(/);
  assert.doesNotMatch(list, /overflow_y_scrollbar\(/);
  assert.match(list, /id\("bw-list"\)[^;]*\.pr\(SCROLL_LANE\)/);
  assert.match(panel, /Scrollbar\.vertical\("bw-list"\)[^;]*\.right\(0\)/);
  assert.match(panel, /Scrollbar\.vertical\("bw-list"\)[^;]*\.w\(SCROLL_LANE\)/);
  assert.doesNotMatch(panel, /\.mode\(/);
  assert.match(panel, /id\(`bw-remove-\$\{symbol\}`\)[^;]*\.w\(REMOVE_W\)/);
  // `inset` pads every region; the only other gutter is the empty-list text's, inside the list, ending at the ×.
  assert.equal(panel.match(/pr\(RIGHT_INSET\)/g).length, 1);
  assert.equal(panel.match(/pl\(GUTTER\)/g).length, 2);
  assert.doesNotMatch(panel, /px\(GUTTER\)|pr\(GUTTER\)|right\(GUTTER\)/);
  assert.doesNotMatch(panel, /\.p[xr]\(20\)/);
});

test("the sidebar list keeps its gap and hairline outside the scroll", () => {
  const panel = code(read(new URL("ui/panel.js", MOD)));
  const list = panel.slice(panel.indexOf("function list("), panel.indexOf("function footer("));
  const box = list.slice(list.indexOf('id("bw-list")'), list.indexOf(".children(rows)"));
  // The gap no longer scrolls away with the rows.
  assert.doesNotMatch(box, /\.pt\(/);
  assert.match(list, /\.pt\(top\)/);
  // A 1 px border hairline, only for a list with a gap (the sidebar), inset like the footer's, above the scrolling box.
  assert.match(list, /top > 0[^;]*map\(inset\)[^;]*border_t\(1\)[^;]*border_color\(t\.border\)/);
  const tree = list.slice(list.indexOf("return v_flex"));
  assert.ok(tree.indexOf("border_t(1)") > 0 && tree.indexOf("border_t(1)") < tree.indexOf("scrolling"));
  // The empty-list text stays inside the scrolling box, so it sits below the hairline.
  assert.match(box, /list\.empty/);
  assert.match(panel, /list\(view, t, rows, 8\)/);
  assert.match(panel, /list\(view, t, rows\)\)/);
});

// The notice ends with its own full stop (。 in Chinese and Japanese), so a separator before Undo would sit
// right after it; the link follows the text with only the gap between them.
test("Undo follows the notice with no separator", () => {
  const panel = read(new URL("ui/panel.js", MOD));
  const messages = panel.slice(panel.indexOf("function messages("), panel.indexOf("function problemLines("));
  assert.match(messages, /link\(t, "bw-undo"/);
  assert.doesNotMatch(messages, /"·"/);
});

// 亮燈 as Taiwan's quote boards draw it: a solid block in the limit's color with the panel's background as
// ink, so it stands apart from the 16% chart fill beside it. Static: nothing here animates on its own.
test("a lit price is a solid block that never animates", () => {
  const parts = code(read(new URL("ui/parts.js", MOD)));
  const box = parts.slice(parts.indexOf("export function priceBox("), parts.indexOf("export function link("));
  assert.match(box, /\.bg\(mark\.color\)/);
  assert.match(box, /mark\.ink/);
  assert.doesNotMatch(box, /opacity|transition|loop\(|frames\(|tint/);
});

test("a collapsed sidebar row is one line with its notes", () => {
  const panel = code(read(new URL("ui/panel.js", MOD)));
  const row = panel.slice(panel.indexOf("function sidebarRow("), panel.indexOf("function tableCell("));
  assert.match(row, /collapsedRow\(row\)/);
  // The body is chosen once and framed by one call, so a fading (ghost) row collapses exactly as a live one
  // does: the choice never looks at `ghost`, and a removed failed row fades from its short height.
  assert.equal(row.split("ghostFrame(").length - 1, 1);
  assert.equal(row.split("rowFrame(").length - 1, 1);
  assert.doesNotMatch(row, /!ghost\s*&&\s*collapsedRow|collapsedRow[^;]*!ghost/);
  assert.ok(row.indexOf("collapsedRow(row)") < row.indexOf("ghost ? ghostFrame("));
});

test("the detail's stats are numbers without the currency", () => {
  const detail = code(read(new URL("ui/detail-dialog.js", MOD)));
  assert.doesNotMatch(detail, /formatBandPrice/);
  assert.match(detail, /number\(q, price\)/);
});
