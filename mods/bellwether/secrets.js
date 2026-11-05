// The Finnhub key, in plaintext, in Bellwether's folder under Herdr's data folder: localStorage is per
// copy, so the dialog could not hand it to the panel there, and shared state is no place for a key.
// The caller passes in Herdr's `fs/promises` and the folder, so tests run this under Node.
// No Herdr imports.
const FILE = "secrets.json";
const file = (dir) => `${dir}/${FILE}`;

// `{}` when there is no file yet; rejects when the file cannot be read or is not a JSON object.
async function readSecrets(fs, dir) {
  if (!(await fs.exists(file(dir)))) return {};
  const value = JSON.parse(await fs.readFile(file(dir), "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value;
}

export async function loadSecret(fs, dir, name) {
  const value = (await readSecrets(fs, dir))[name];
  return typeof value === "string" ? value : null;
}

// A file that cannot be read is replaced by one holding only this key.
export async function saveSecret(fs, dir, name, value) {
  let secrets = {};
  try { secrets = await readSecrets(fs, dir); } catch { /* Replaced below. */ }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file(dir), `${JSON.stringify({ ...secrets, [name]: value }, null, 2)}\n`);
}

// The file is written again without this key; an unreadable file rejects, so nothing is taken as removed.
export async function removeSecret(fs, dir, name) {
  if (!(await fs.exists(file(dir)))) return;
  const { [name]: _removed, ...rest } = await readSecrets(fs, dir);
  await fs.writeFile(file(dir), `${JSON.stringify(rest, null, 2)}\n`);
}
