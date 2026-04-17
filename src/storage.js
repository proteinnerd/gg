// Storage layer.
// Personal data (profile, lastread, squads on this device) -> localStorage.
// Shared data (squads, schedules, chat, polls, clicker) -> Vercel KV via /api/kv.

async function kvGet(key) {
  const res = await fetch(`/api/kv?key=${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage get failed: ${res.status}`);
  return res.json();
}

async function kvSet(key, value) {
  const res = await fetch("/api/kv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`storage set failed: ${res.status}`);
  return res.json();
}

async function kvDelete(key) {
  const res = await fetch(`/api/kv?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`storage delete failed: ${res.status}`);
  return res.json();
}

async function kvList(prefix) {
  const res = await fetch(`/api/kv?prefix=${encodeURIComponent(prefix || "")}&list=1`);
  if (!res.ok) throw new Error(`storage list failed: ${res.status}`);
  return res.json();
}

function localGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : { key, value: v };
  } catch { return null; }
}

function localSet(key, value) {
  try { localStorage.setItem(key, value); return { key, value }; }
  catch { return null; }
}

function localDelete(key) {
  try { localStorage.removeItem(key); return { key, deleted: true }; }
  catch { return null; }
}

function localList(prefix) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!prefix || k.startsWith(prefix)) keys.push(k);
    }
    return { keys, prefix };
  } catch { return { keys: [], prefix }; }
}

const storage = {
  async get(key, shared = false) { return shared ? kvGet(key) : localGet(key); },
  async set(key, value, shared = false) { return shared ? kvSet(key, value) : localSet(key, value); },
  async delete(key, shared = false) { return shared ? kvDelete(key) : localDelete(key); },
  async list(prefix, shared = false) { return shared ? kvList(prefix) : localList(prefix); },
};

if (typeof window !== "undefined") {
  window.storage = storage;
}

export default storage;
