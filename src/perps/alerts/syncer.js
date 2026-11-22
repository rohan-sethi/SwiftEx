// Upload logic for liquidation alerts, with every side effect injected (unit tested with fakes).
// Never throws to callers: every failure is logged and reported as { sent: false, skipped }.
import { buildSnapshot, snapshotSignature, assetsNeedingPrice } from "./snapshot";

export const THROTTLE_MS = 15 * 1000; // non-forced uploads: at most one per 15 s
export const RESEND_MS = 5 * 60 * 1000; // an unchanged snapshot is still re-sent after 5 min
export const BACKOFF_MS = 60 * 1000; // first wait after a 429 (doubles, max 10 min)
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

// deps:
//   enabled()                     -> boolean (PERPS_ENABLED)
//   now()                         -> ms
//   getToken()                    -> FCM token | null
//   platform                      -> 'android' | 'ios' | 'web'
//   getAgent(user)                -> stored Perps agent | null (no agent = no Perps account set up)
//   loadRaw(agent, user)          -> { account, positionRisk, noDeposit } | null
//   loadMode(agent, user)         -> true | false | null
//   loadPrices(assets)            -> { ASSET: { price, discount } } | null
//   post(body) / del(body)        -> { status }   (throws on network errors)
//   saveWallet(wallet|null), loadWallet()  -> last wallet uploaded from this device
//   log({ step, status, msg })
//   schedule(fn, ms)              -> retry a forced upload later (after a 429 / while busy)
export const createAlertsSyncer = (deps) => {
  let lastSentAt = 0;
  let lastSig = null;
  let backoffUntil = 0;
  let backoffMs = BACKOFF_MS;
  let inflight = null;
  let pendingForce = null; // { reason, user, agent } waiting for the current upload / backoff
  let retryArmed = false;

  const safeLog = (e) => {
    try {
      deps.log(e);
    } catch (err) {
      // never let logging break a caller
    }
  };

  const armRetry = (ms) => {
    if (retryArmed || !deps.schedule) return;
    retryArmed = true;
    deps.schedule(() => {
      retryArmed = false;
      const p = pendingForce;
      pendingForce = null;
      if (p) sync({ ...p, force: true });
    }, Math.max(1000, ms));
  };

  const run = async ({ reason, force, user, agent, raw }) => {
    if (!deps.enabled() || !user) return { sent: false, skipped: "disabled" };
    const t0 = deps.now();
    if (t0 < backoffUntil) {
      if (force) {
        pendingForce = { reason, user, agent: agent || null };
        armRetry(backoffUntil - t0);
      }
      return { sent: false, skipped: "backoff" };
    }
    if (!force && t0 - lastSentAt < THROTTLE_MS) return { sent: false, skipped: "throttle" };

    const a = agent || (await deps.getAgent(user));
    if (!a) return { sent: false, skipped: "no-perps" };
    const data = raw || (await deps.loadRaw(a, user));
    if (!data || data.noDeposit || !data.account || !Array.isArray(data.positionRisk)) {
      return { sent: false, skipped: "no-data" };
    }
    const multiAssets = await deps.loadMode(a, user);
    const needPrice = multiAssets === true ? assetsNeedingPrice(data.account) : [];
    const prices = needPrice.length ? await deps.loadPrices(needPrice) : null;
    const snap = buildSnapshot({ account: data.account, positionRisk: data.positionRisk, multiAssets, prices });
    const sig = snapshotSignature(user, snap.account);
    const t1 = deps.now();
    if (!force && sig === lastSig && t1 - lastSentAt < RESEND_MS) return { sent: false, skipped: "unchanged" };

    const token = await deps.getToken();
    if (!token) return { sent: false, skipped: "no-token" };
    const res = await deps.post({
      fcmToken: token,
      wallet: user,
      platform: deps.platform,
      snapshotAt: t1,
      account: snap.account,
    });
    const status = res && res.status;
    if (status >= 200 && status < 300) {
      lastSentAt = deps.now();
      lastSig = sig;
      backoffMs = BACKOFF_MS;
      await deps.saveWallet(user);
      if (snap.info.missingMaint.length || snap.info.skippedAssets.length || snap.info.droppedPositions) {
        safeLog({
          step: "alerts:partial",
          msg: `noMaint=${snap.info.missingMaint.join(",")} noPrice=${snap.info.skippedAssets.join(",")} dropped=${snap.info.droppedPositions}`,
        });
      }
      return { sent: true, reason, positions: snap.account.positions.length, token6: String(token).slice(-6) };
    }
    if (status === 429) {
      backoffUntil = deps.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      if (force) {
        pendingForce = { reason, user, agent: a };
        armRetry(backoffUntil - deps.now());
      }
    }
    safeLog({ step: "alerts:snapshot", status, msg: (res && res.error) || `reason=${reason}` });
    return { sent: false, skipped: `http-${status}` };
  };

  const sync = (opts = {}) => {
    const o = { reason: "sync", force: false, ...opts };
    if (inflight) {
      if (o.force) {
        pendingForce = { reason: o.reason, user: o.user, agent: o.agent || null };
        inflight.then(() => {
          const p = pendingForce;
          pendingForce = null;
          if (p) sync({ ...p, force: true });
        });
      }
      return Promise.resolve({ sent: false, skipped: "busy" });
    }
    inflight = run(o)
      .catch((e) => {
        safeLog({ step: "alerts:snapshot:exception", msg: e && e.message });
        return { sent: false, skipped: "error" };
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  // Stop alerts for this device. Never throws.
  const remove = async (reason = "remove") => {
    try {
      const token = await deps.getToken();
      if (!token) return { removed: false, skipped: "no-token" };
      const res = await deps.del({ fcmToken: token });
      const ok = res && res.status >= 200 && res.status < 300;
      if (ok) {
        lastSig = null;
        lastSentAt = 0;
        await deps.saveWallet(null);
      } else safeLog({ step: "alerts:remove", status: res && res.status, msg: reason });
      return { removed: !!ok };
    } catch (e) {
      safeLog({ step: "alerts:remove:exception", msg: e && e.message });
      return { removed: false, skipped: "error" };
    }
  };

  // A wallet was deleted from the app: stop alerts if this device last uploaded for it.
  // Resolves once the stored wallet was read (fast); the DELETE itself runs on in the background
  // so the caller can go on (e.g. clear AsyncStorage) without waiting for the network.
  const onWalletRemoved = async (address) => {
    try {
      const last = await deps.loadWallet();
      if (!last || !address || String(last).toLowerCase() !== String(address).toLowerCase()) {
        return { removed: false, skipped: "other-wallet" };
      }
      return { removing: remove("wallet-removed") };
    } catch (e) {
      safeLog({ step: "alerts:wallet-removed:exception", msg: e && e.message });
      return { removed: false, skipped: "error" };
    }
  };

  return { sync, remove, onWalletRemoved };
};
