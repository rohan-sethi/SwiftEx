// Liquidation-alert settings per wallet (AsyncStorage): master switch + muted positions.
//   perpsAlerts:enabled:<wallet>  "0" = off (default on)
//   perpsAlerts:muted:<wallet>    JSON array of 'cross' / 'iso:SYMBOL:LONG|SHORT'
import AsyncStorage from "@react-native-async-storage/async-storage";

const key = (kind, wallet) => `perpsAlerts:${kind}:${String(wallet || "").toLowerCase()}`;
const listeners = new Set();
const cache = new Map(); // wallet(lower) -> { enabled, muted }

const parseMuted = (raw) => {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
};

const emit = (wallet, prefs) => listeners.forEach((fn) => fn(String(wallet).toLowerCase(), prefs));

export const loadAlertPrefs = async (wallet) => {
  const w = String(wallet || "").toLowerCase();
  if (!w) return { enabled: true, muted: [] };
  if (cache.has(w)) return cache.get(w);
  const [enabled, muted] = await Promise.all([
    AsyncStorage.getItem(key("enabled", w)).catch(() => null),
    AsyncStorage.getItem(key("muted", w)).catch(() => null),
  ]);
  const prefs = { enabled: enabled !== "0", muted: parseMuted(muted) };
  cache.set(w, prefs);
  return prefs;
};

const update = async (wallet, patch) => {
  const w = String(wallet || "").toLowerCase();
  if (!w) return null;
  const prev = await loadAlertPrefs(w);
  const next = { ...prev, ...patch };
  cache.set(w, next);
  emit(w, next);
  await Promise.all([
    AsyncStorage.setItem(key("enabled", w), next.enabled ? "1" : "0").catch(() => {}),
    AsyncStorage.setItem(key("muted", w), JSON.stringify(next.muted)).catch(() => {}),
  ]);
  return next;
};

export const saveAlertsEnabled = (wallet, enabled) => update(wallet, { enabled: !!enabled });
export const saveMutedKeys = (wallet, muted) => update(wallet, { muted: [...new Set(muted)] });

export const onAlertPrefsChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Tests only.
export const __resetAlertPrefsCache = () => cache.clear();
