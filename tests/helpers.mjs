// Test helpers shared by the watchlist and scheduler tests: canned responses, and a fake host
// with a virtual clock, a scripted network and a shared store.

export const ok = (body) => ({ status: 200, ok: true, text: JSON.stringify(body) });
export const chart = (meta) => ok({ chart: { result: [{ meta }], error: null } });

export function fakeHost(respond) {
  const host = {
    store: { version: 1, symbols: [], paused: false }, clock: 0, sleeps: [], requests: [],
    load: () => host.store,
    // The saved settings (shared state in Herdr); nothing saved yet.
    prefs: undefined,
    settings: () => host.prefs,
    save: (p) => { host.store = JSON.parse(JSON.stringify(p)); },
    now: () => host.clock,
    sleep: (ms) => new Promise((resolve) => host.sleeps.push({ at: host.clock + ms, resolve })),
    fetch: async (url) => { host.requests.push(url); const r = respond(url); return { ...r, text: async () => r.text }; },
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
