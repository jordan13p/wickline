// node --test tests/  (the Finnhub key file, over an in-memory fs and a fake program runner)
import test from "node:test";
import assert from "node:assert/strict";
import { loadSecret, loadSecretEnding, removeSecret, saveSecret } from "../mods/bellwether/secrets.js";

const DIR = "home/data/bellwether";
const FILE = `${DIR}/secrets.json`;

// The calls secrets.js makes on Herdr's `fs/promises`; `files` maps a path to its text. `log` keeps their order.
function fakeFs(files = {}, log = []) {
  const fs = {
    files, dirs: [], writes: 0, log,
    exists: async (path) => path in fs.files,
    readFile: async (path) => fs.files[path],
    mkdir: async (path, options) => { fs.dirs.push([path, options]); },
    writeFile: async (path, text) => { fs.writes++; log.push(["write", path]); fs.files[path] = text; },
    unlink: async (path) => { log.push(["unlink", path]); delete fs.files[path]; },
  };
  return fs;
}

// Herdr's `process` module: `platform` and `run(command, args)`, answering with `answer` (or throwing it).
function fakeSystem(platform = "darwin", answer = { code: 0, stdout: "", stderr: "" }, log = []) {
  const system = {
    platform, runs: [], log,
    run: async (command, args) => {
      system.runs.push([command, args]);
      log.push(["run", command, ...args]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return system;
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

test("ending: the last four characters of a saved key, none of a short one, null without a key", async () => {
  const withKey = (key) => fakeFs({ [FILE]: JSON.stringify({ "finnhub.key": key }) });
  assert.equal(await loadSecretEnding(withKey("test-key-0123456789"), DIR, "finnhub.key"), "6789");
  assert.equal(await loadSecretEnding(withKey("  test-key-abcd  "), DIR, "finnhub.key"), "abcd");
  // Four of a short key would give most of it away.
  assert.equal(await loadSecretEnding(withKey("test-key"), DIR, "finnhub.key"), "");
  assert.equal(await loadSecretEnding(withKey("   "), DIR, "finnhub.key"), null);
  assert.equal(await loadSecretEnding(fakeFs(), DIR, "finnhub.key"), null);
  await assert.rejects(loadSecretEnding(fakeFs({ [FILE]: "{oops" }), DIR, "finnhub.key"));
});

test("save: makes the folder, writes indented JSON with a final newline and keeps the other keys", async () => {
  const fs = fakeFs();
  await saveSecret(fs, fakeSystem(), DIR, "finnhub.key", "abc");
  assert.deepEqual(fs.dirs, [[DIR, { recursive: true }]]);
  assert.equal(fs.files[FILE], '{\n  "finnhub.key": "abc"\n}\n');
  fs.files[FILE] = '{"other":"x","finnhub.key":"old"}';
  await saveSecret(fs, fakeSystem(), DIR, "finnhub.key", "new");
  assert.deepEqual(JSON.parse(fs.files[FILE]), { other: "x", "finnhub.key": "new" });
});

test("save: a file that cannot be read is replaced by one holding only this key", async () => {
  for (const text of ["{oops", "[1]"]) {
    const fs = fakeFs({ [FILE]: text });
    await saveSecret(fs, fakeSystem(), DIR, "finnhub.key", "abc");
    assert.deepEqual(JSON.parse(fs.files[FILE]), { "finnhub.key": "abc" }, text);
  }
});

test("save: on macOS and Linux the file is made owner-only right after it is written", async () => {
  for (const platform of ["darwin", "linux"]) {
    const log = [];
    const system = fakeSystem(platform, undefined, log);
    assert.equal(await saveSecret(fakeFs({}, log), system, DIR, "finnhub.key", "test-key"), true, platform);
    assert.deepEqual(system.runs, [["chmod", ["600", FILE]]], platform);
    assert.deepEqual(log, [["write", FILE], ["run", "chmod", "600", FILE]], platform);
  }
});

test("save: elsewhere no program runs", async () => {
  for (const platform of ["win32", "freebsd", ""]) {
    const system = fakeSystem(platform);
    assert.equal(await saveSecret(fakeFs(), system, DIR, "finnhub.key", "test-key"), true, String(platform));
    assert.deepEqual(system.runs, [], String(platform));
  }
});

test("save: a chmod that fails or cannot start still keeps the key, and says so", async () => {
  for (const answer of [{ code: 1, stdout: "", stderr: "denied" }, new Error("not found")]) {
    const fs = fakeFs();
    assert.equal(await saveSecret(fs, fakeSystem("darwin", answer), DIR, "finnhub.key", "test-key"), false);
    assert.equal(await loadSecret(fs, DIR, "finnhub.key"), "test-key");
  }
});

test("remove: the last key deletes the file, and nothing happens when there is no file", async () => {
  const fs = fakeFs({ [FILE]: '{"finnhub.key":"test-key"}' });
  const system = fakeSystem();
  assert.equal(await removeSecret(fs, system, DIR, "finnhub.key"), true);
  assert.equal(FILE in fs.files, false);
  assert.equal(fs.writes, 0);
  assert.deepEqual(system.runs, []);
  const empty = fakeFs();
  await removeSecret(empty, system, DIR, "finnhub.key");
  assert.equal(empty.writes, 0);
  assert.deepEqual(empty.log, []);
  assert.deepEqual(empty.dirs, []);
});

test("remove: other keys stay, written again and made owner-only", async () => {
  const fs = fakeFs({ [FILE]: '{"other":"x","finnhub.key":"test-key"}' });
  const system = fakeSystem("linux");
  assert.equal(await removeSecret(fs, system, DIR, "finnhub.key"), true);
  assert.equal(fs.files[FILE], '{\n  "other": "x"\n}\n');
  assert.deepEqual(system.runs, [["chmod", ["600", FILE]]]);
  assert.equal(await removeSecret(fakeFs({ [FILE]: '{"other":"x"}' }), fakeSystem("darwin", new Error("x")), DIR, "finnhub.key"), false);
});

test("remove: an unreadable file rejects and is left as it is", async () => {
  const fs = fakeFs({ [FILE]: "{oops" });
  await assert.rejects(removeSecret(fs, fakeSystem(), DIR, "finnhub.key"));
  assert.equal(fs.files[FILE], "{oops");
  assert.deepEqual(fs.log, []);
});
