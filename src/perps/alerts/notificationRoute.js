// Liquidation-alert taps. The FCM / notifee handlers only RECORD the tap here; the Home tab
// navigator (usePerpsAlertsBridge, mounted after the PIN unlock) opens Perps when it can.
// No app imports, so index.js and the FCM handlers can use it safely.
export const PERPS_ALERT_TYPE = "perps_liquidation";

let pending = null; // { symbol, at }
const listeners = new Set();
const PENDING_TTL_MS = 10 * 60 * 1000;

export const isPerpsAlert = (data) => !!data && data.type === PERPS_ALERT_TYPE;

// Returns true when the message was a liquidation alert (and is now pending).
export const notePerpsAlertOpened = (remoteMessage) => {
  const data = remoteMessage && remoteMessage.data;
  if (!isPerpsAlert(data)) return false;
  pending = { symbol: typeof data.symbol === "string" ? data.symbol : null, at: Date.now() };
  listeners.forEach((fn) => fn(pending));
  return true;
};

export const takePendingPerpsOpen = () => {
  const p = pending && Date.now() - pending.at <= PENDING_TTL_MS ? pending : null;
  pending = null;
  return p;
};

export const onPerpsOpenRequest = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
