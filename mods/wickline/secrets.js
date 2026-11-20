// The Finnhub key, in plaintext, in Wickline's folder under Herdr's data folder.
// Not in localStorage: it is per copy, so the dialog could not hand the key to the panel.
// Not in shared state: that is no place for a key.
// The caller passes Herdr's `fs/promises`, the folder and a `system` with `platform()` ("macos", "linux" or
// "windows") and `chmod(path)` (main.js's one chmod 600), so tests run this under Node.
const FILE = "secrets.json";
const file = (dir) => `${dir}/${FILE}`;
// Herdr's `fs.writeFile` takes no mode and leaves the file readable by other accounts.
// Windows keeps a user's own folder private already.
const OWNER_ONLY_PLATFORMS = ["macos", "linux"];
// The dialog shows a saved key's last four characters only when they are a small part of it.
const ENDING = 4;
const ENDING_MIN_LENGTH = 12;

// `{}` when there is no file yet; rejects when the file cannot be read or is not a JSON object.
async function readSecrets(fs, dir) {
  if (!(await fs.exists(file(dir)))) return {};
  const value = JSON.parse(await fs.readFile(file(dir), "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value;
}

// Writes the file, then runs `chmod 600` on macOS and Linux: the only program Wickline runs.
// Resolves false when chmod failed or could not start (the file is written all the same), else true.
async function writeSecrets(fs, system, dir, secrets) {
  await fs.writeFile(file(dir), `${JSON.stringify(secrets, null, 2)}\n`);
  if (!OWNER_ONLY_PLATFORMS.includes(system.platform())) return true;
  try {
    return (await system.chmod(file(dir))).code === 0;
  } catch {
    return false;
  }
}

/** The saved value of key `name`, or null. */
export async function loadSecret(fs, dir, name) {
  const value = (await readSecrets(fs, dir))[name];
  return typeof value === "string" ? value : null;
}

/** What the dialog may show of a saved key: null without one, its last four characters, or "" for a short key. */
export async function loadSecretEnding(fs, dir, name) {
  const value = (await loadSecret(fs, dir, name))?.trim();
  if (!value) return null;
  return value.length >= ENDING_MIN_LENGTH ? value.slice(-ENDING) : "";
}

/** Saves key `name`. A file that cannot be read is replaced by one holding only this key. Resolves as writeSecrets. */
export async function saveSecret(fs, system, dir, name, value) {
  let secrets = {};
  try {
    secrets = await readSecrets(fs, dir);
  } catch {
    /* Replaced below. */
  }
  await fs.mkdir(dir, { recursive: true });
  return writeSecrets(fs, system, dir, { ...secrets, [name]: value });
}

/**
 * Removes key `name`, and the file once no key is left. An unreadable file rejects, so nothing is taken as removed.
 * Resolves as writeSecrets (true when the file was deleted).
 */
export async function removeSecret(fs, system, dir, name) {
  if (!(await fs.exists(file(dir)))) return true;
  const { [name]: _removed, ...rest } = await readSecrets(fs, dir);
  if (Object.keys(rest).length === 0) {
    await fs.unlink(file(dir));
    return true;
  }
  return writeSecrets(fs, system, dir, rest);
}
