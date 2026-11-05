// Test helpers shared by the watchlist and scheduler tests: canned responses, and a fake host
// with a virtual clock, a scripted network and a shared store.

export const ok = (body) => ({ status: 200, ok: true, text: JSON.stringify(body) });
export const chart = (meta) => ok({ chart: { result: [{ meta }], error: null } });

export function fakeHost(respond) {
  const host = {
    store: { version: 1, symbols: [], paused: false }, clock: 0, sleeps: [], requests: [], headers: [],
    load: () => host.store,
    // The saved settings (shared state in Herdr); nothing saved yet.
    prefs: undefined,
    settings: () => host.prefs,
    save: (p) => { host.store = JSON.parse(JSON.stringify(p)); },
    now: () => host.clock,
    sleep: (ms) => new Promise((resolve) => host.sleeps.push({ at: host.clock + ms, resolve })),
    fetch: async (url, headers) => {
      host.requests.push(url);
      host.headers.push(headers);
      const r = await respond(url);
      return { ...r, text: async () => r.text };
    },
    // The secrets file (main.js reads it from Herdr's data folder): `secret` by name, or a broken file.
    secrets: {}, secretsBroken: false, secretReads: 0,
    loadSecret: async (name) => {
      host.secretReads++;
      if (host.secretsBroken) throw new SyntaxError("broken");
      return host.secrets[name] ?? null;
    },
    changed: () => {},
  };
  return host;
}

// Advance the clock to the next sleeper and let the loop run.
export async function tick(host) {
  await new Promise((r) => setImmediate(r));
  host.sleeps.sort((a, b) => a.at - b.at);
  const next = host.sleeps.shift();
  if (!next) return false;
  host.clock = Math.max(host.clock, next.at);
  next.resolve();
  await new Promise((r) => setImmediate(r));
  return true;
}

// Every source's loop, as main.js starts them.
export function start(w, host) {
  return w.providerIds().map((id) => w.runProvider(id, { sleep: host.sleep, changed: host.changed }));
}

export async function stop(w, host, runs) {
  w.stop();
  for (let i = 0; i < 50 && host.sleeps.length; i++) await tick(host);
  await Promise.all(runs);
}

// Runs every sleeper due by `until` (virtual ms), in time order.
export async function advance(host, until) {
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setImmediate(r));
    host.sleeps.sort((a, b) => a.at - b.at);
    if (!host.sleeps.length || host.sleeps[0].at > until) break;
    await tick(host);
  }
  host.clock = Math.max(host.clock, until);
  await new Promise((r) => setImmediate(r));
}
