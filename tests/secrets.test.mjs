// node --test tests/  (the Finnhub key file, over an in-memory fs)
import test from "node:test";
import assert from "node:assert/strict";
import { loadSecret, removeSecret, saveSecret } from "../mods/bellwether/secrets.js";

const DIR = "home/data/bellwether";
const FILE = `${DIR}/secrets.json`;

// The four calls secrets.js makes on Herdr's `fs/promises`; `files` maps a path to its text.
function fakeFs(files = {}) {
  const fs = {
    files, dirs: [], writes: 0,
    exists: async (path) => path in fs.files,
    readFile: async (path) => fs.files[path],
    mkdir: async (path, options) => { fs.dirs.push([path, options]); },
    writeFile: async (path, text) => { fs.writes++; fs.files[path] = text; },
  };
  return fs;
}

test("load: no file is no key, a string is the key, any other value is no key", async () => {
  assert.equal(await loadSecret(fakeFs(), DIR, "finnhub.key"), null);
  assert.equal(await loadSecret(fakeFs({ [FILE]: '{"finnhub.key":"abc"}' }), DIR, "finnhub.key"), "abc");
  assert.equal(await loadSecret(fakeFs({ [FILE]: '{"other":"x"}' }), DIR, "finnhub.key"), null);
  assert.equal(await loadSecret(fakeFs({ [FILE]: '{"finnhub.key":42}' }), DIR, "finnhub.key"), null);
});

test("load: a file that is not a JSON object rejects", async () => {
  for (const text of ["{oops", "[]", "null", "7", '"text"']) {
    await assert.rejects(loadSecret(fakeFs({ [FILE]: text }), DIR, "finnhub.key"), text);
  }
});

test("save: makes the folder, writes indented JSON with a final newline and keeps the other keys", async () => {
  const fs = fakeFs();
  await saveSecret(fs, DIR, "finnhub.key", "abc");
  assert.deepEqual(fs.dirs, [[DIR, { recursive: true }]]);
  assert.equal(fs.files[FILE], '{\n  "finnhub.key": "abc"\n}\n');
  fs.files[FILE] = '{"other":"x","finnhub.key":"old"}';
  await saveSecret(fs, DIR, "finnhub.key", "new");
  assert.deepEqual(JSON.parse(fs.files[FILE]), { other: "x", "finnhub.key": "new" });
});

test("save: a file that cannot be read is replaced by one holding only this key", async () => {
  for (const text of ["{oops", "[1]"]) {
    const fs = fakeFs({ [FILE]: text });
    await saveSecret(fs, DIR, "finnhub.key", "abc");
    assert.deepEqual(JSON.parse(fs.files[FILE]), { "finnhub.key": "abc" }, text);
  }
});

test("remove: drops the key, keeps the others, and writes nothing when there is no file", async () => {
  const fs = fakeFs({ [FILE]: '{"other":"x","finnhub.key":"abc"}' });
  await removeSecret(fs, DIR, "finnhub.key");
  assert.equal(fs.files[FILE], '{\n  "other": "x"\n}\n');
  const empty = fakeFs();
  await removeSecret(empty, DIR, "finnhub.key");
  assert.equal(empty.writes, 0);
  assert.deepEqual(empty.dirs, []);
});

test("remove: an unreadable file rejects and is left as it is", async () => {
  const fs = fakeFs({ [FILE]: "{oops" });
  await assert.rejects(removeSecret(fs, DIR, "finnhub.key"));
  assert.equal(fs.files[FILE], "{oops");
  assert.equal(fs.writes, 0);
});
