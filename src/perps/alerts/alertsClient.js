// Perps liquidation alerts: every call to the alerts server lives here.
// Server: PERPS_ALERTS_URL (public, no login; a device = its FCM token).
//   POST   /v1/snapshot  full list of open positions (replaces the previous one)
//   DELETE /v1/device    stop alerts for this device
// Plain fetch with a 10 s timeout (not proxyRequest/apiHelper). Nothing here throws to callers.
// Logs never contain keys, signatures or auth tokens; the FCM token only as its last 6 chars.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import messaging from "@react-native-firebase/messaging";
import notifee, { AndroidImportance } from "@notifee/react-native";
import { PERPS_ALERTS_URL, PERPS_ENABLED } from "../config";
import { fetchAccount, fetchPositions, fetchMultiAssetsMode } from "../api/asterTrade";
import { asterFetch } from "../api/asterPublic";
import { getUsableAgent } from "../hooks/usePerpsAgent";
import { logPerpsError } from "../utils/perpsLog";
import { createAlertsSyncer } from "./syncer";
import { buildSnapshot, marginRatios } from "./snapshot";
import { loadAlertPrefs, saveAlertsEnabled, saveMutedKeys } from "./prefs";

export { buildSnapshot };

export const PERPS_ALERTS_CHANNEL = "perps_alerts";
export { PERPS_ALERT_TYPE } from "./notificationRoute";
const TIMEOUT_MS = 10000;
const WALLET_KEY = "perpsAlerts:lastWallet";
const MODE_TTL_MS = 10 * 60 * 1000;
const PRICE_TTL_MS = 60 * 1000;
const NO_DEPOSIT_CODE = -5050;

const devLog = (...a) => {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.log("[perpsAlerts]", ...a);
};

const request = async (method, path, body) => {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error("timeout"));
      }, TIMEOUT_MS);
    });
    const res = await Promise.race([
      fetch(`${PERPS_ALERTS_URL}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      }),
      timeout,
    ]);
    let error = null;
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      error = data && (data.error || data.message) ? String(data.error || data.message).slice(0, 120) : `HTTP ${res.status}`;
    }
    return { status: res.status, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Account margin mode, cached (it changes only when the user switches it).
let modeCache = null; // { user, value, at }
const loadMode = async (agent, user) => {
  if (modeCache && modeCache.user === user && Date.now() - modeCache.at < MODE_TTL_MS) return modeCache.value;
  const res = await fetchMultiAssetsMode(agent, user);
  if (res.error || !res.data) return modeCache && modeCache.user === user ? modeCache.value : null;
  const value = res.data.multiAssetsMargin === true || res.data.multiAssetsMargin === "true";
  modeCache = { user, value, at: Date.now() };
  return value;
};

// USD price + collateral ratio for non-stable collateral, from Aster's public assetIndex.
let priceCache = null; // { at, map }
const loadPrices = async () => {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.map;
  const res = await asterFetch("/fapi/v3/assetIndex", { timeoutMs: TIMEOUT_MS });
  if (res.error || !Array.isArray(res.data)) return priceCache ? priceCache.map : null;
  const map = {};
  res.data.forEach((r) => {
    const asset = String(r.symbol || "").replace(/USD$/, "");
    const buf = Number(r.bidBuffer);
    if (!asset || !r.index) return;
    map[asset] = { price: String(r.index), discount: Number.isFinite(buf) ? String(Math.max(0, 1 - buf)) : undefined };
  });
  priceCache = { at: Date.now(), map };
  return map;
};

// Same reads as the Perps screen's account poller.
const loadRaw = async (agent, user) => {
  const [acc, pos] = await Promise.all([fetchAccount(agent, user), fetchPositions(agent, user)]);
  if (acc.agentInvalid || pos.agentInvalid) return null;
  if (acc.code === NO_DEPOSIT_CODE || pos.code === NO_DEPOSIT_CODE) return { noDeposit: true };
  if (acc.error || pos.error) return null;
  return { account: acc.data, positionRisk: pos.data };
};

const getToken = async () => {
  try {
    return (await messaging().getToken()) || null;
  } catch (e) {
    return null;
  }
};

const syncer = createAlertsSyncer({
  enabled: () => PERPS_ENABLED,
  now: () => Date.now(),
  platform: Platform.OS === "ios" ? "ios" : Platform.OS === "web" ? "web" : "android",
  getToken,
  getAgent: getUsableAgent,
  loadRaw,
  loadMode,
  loadPrices,
  post: (body) => request("POST", "/v1/snapshot", body),
  del: (body) => request("DELETE", "/v1/device", body),
  saveWallet: (w) => (w ? AsyncStorage.setItem(WALLET_KEY, w) : AsyncStorage.removeItem(WALLET_KEY)).catch(() => {}),
  loadWallet: () => AsyncStorage.getItem(WALLET_KEY).catch(() => null),
  log: (e) => logPerpsError(e),
  getPrefs: loadAlertPrefs,
  saveMuted: saveMutedKeys,
  schedule: (fn, ms) => setTimeout(fn, ms),
});

// Android channel for liquidation alerts (high importance). notifee's createChannel is idempotent.
let channelReady = null;
export const ensurePerpsAlertsChannel = () => {
  if (Platform.OS !== "android") return Promise.resolve(null);
  if (!channelReady) {
    channelReady = notifee
      .createChannel({
        id: PERPS_ALERTS_CHANNEL,
        name: "Perps liquidation alerts",
        importance: AndroidImportance.HIGH,
        sound: "default",
        vibration: true,
      })
      .catch((e) => {
        channelReady = null;
        logPerpsError({ step: "alerts:channel", msg: e && e.message });
        return null;
      });
  }
  return channelReady;
};

// Upload the current open positions. `raw` = { account, positionRisk } when the caller already has
// them (the Perps account poller); otherwise they are fetched with the stored trading key.
export const syncPerpsAlerts = async ({ reason = "sync", force = false, user, agent, raw } = {}) => {
  try {
    if (!PERPS_ENABLED || !user) return { sent: false, skipped: "disabled" };
    const r = await syncer.sync({ reason, force, user, agent, raw });
    if (r.sent) {
      ensurePerpsAlertsChannel();
      devLog(`snapshot sent (${reason}${force ? ", forced" : ""}): ${r.positions} position(s), token …${r.token6}`);
    } else if (r.skipped !== "throttle" && r.skipped !== "unchanged") {
      devLog(`snapshot skipped (${reason}): ${r.skipped}`);
    }
    return r;
  } catch (e) {
    return { sent: false, skipped: "error" };
  }
};

export const removePerpsAlertsDevice = async (reason) => {
  try {
    const r = await syncer.remove(reason);
    devLog(`device removed (${reason}): ${r.removed}`);
    return r;
  } catch (e) {
    return { removed: false };
  }
};

export const onWalletRemovedForAlerts = async (address) => {
  try {
    if (!PERPS_ENABLED) return { removed: false };
    return await syncer.onWalletRemoved(address);
  } catch (e) {
    return { removed: false };
  }
};

// ---- Settings sheet ----------------------------------------------------------------------

// Master switch (per wallet). Off: stop all uploads + DELETE this device. On: upload at once.
export const setPerpsAlertsEnabled = async (user, enabled) => {
  try {
    await saveAlertsEnabled(user, enabled);
    if (!enabled) return await removePerpsAlertsDevice("alerts-off");
    return await syncPerpsAlerts({ reason: "alerts-on", force: true, user });
  } catch (e) {
    logPerpsError({ step: "alerts:enable", msg: e && e.message });
    return null;
  }
};

// One switch in the list ('cross' / 'iso:SYMBOL:LONG|SHORT'). Uploads at once.
export const setPerpsAlertMuted = async (user, key, muted) => {
  try {
    const prefs = await loadAlertPrefs(user);
    const set = new Set(prefs.muted);
    if (muted) set.add(key);
    else set.delete(key);
    await saveMutedKeys(user, [...set]);
    return await syncPerpsAlerts({ reason: muted ? "mute" : "unmute", force: true, user });
  } catch (e) {
    logPerpsError({ step: "alerts:mute", msg: e && e.message });
    return null;
  }
};

// Rows for the sheet from data the Perps screen already polled ({ account, positionRisk }).
// Uses the margin mode / prices cached by the last upload: no new Aster calls.
export const alertsViewFrom = (raw) => {
  if (!raw || !raw.account || !Array.isArray(raw.positionRisk)) return { cross: null, isolated: [] };
  const multiAssets = modeCache ? modeCache.value : null;
  const snap = buildSnapshot({
    account: raw.account,
    positionRisk: raw.positionRisk,
    multiAssets,
    prices: priceCache ? priceCache.map : null,
  });
  return marginRatios(snap.account);
};
