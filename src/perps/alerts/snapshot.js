// Pure mapping: Aster account data -> the alerts server's snapshot (no network, unit tested).
//
// Inputs are the responses the Perps module already fetches:
//   account      GET /fapi/v3/account       (assets[].crossWalletBalance, positions[].maintMargin)
//   positionRisk GET /fapi/v3/positionRisk  (positionAmt, entryPrice, markPrice, marginType, isolatedWallet)
//   multiAssets  GET /fapi/v3/multiAssetsMargin (true / false / null = unknown)
//   prices       { ASSET: { price, discount } } from the public /fapi/v3/assetIndex (non-stables)
import { isValid, toUnits, toPlain, mul, gt, sub } from "../utils/decimal";

export const MAX_POSITIONS = 10;
// Collateral haircut used when Aster's assetIndex gave none for a non-stable asset. Conservative
// (Aster's own BNB haircut was 0.95 on 2026-11-22).
export const DEFAULT_DISCOUNT = "0.9";
// Same lists as api/asterAssets.js (kept here so this file has no app imports).
const STABLES = ["USDT", "USDC", "USDCE", "USD1", "USDF"];
const SINGLE_ASSET_MARGIN = ["USDT", "USD1"];

const nonZero = (v) => isValid(v) && !toUnits(v).isZero();
const str = (v) => toPlain(String(v));
const absOf = (v) => (gt(v, "0") ? str(v) : sub("0", v));
const sideKey = (p) => `${p.symbol}|${p.positionSide || "BOTH"}`;

export const CROSS_KEY = "cross";
// Alert switch key of one position: 'cross' for every cross position, 'iso:SYMBOL:LONG|SHORT'
// for an isolated one (side from positionSide in hedge mode, else from the sign of positionAmt).
export const muteKeyOf = (row, positionSide) => {
  if (row.marginType !== "isolated") return CROSS_KEY;
  const ps = String(positionSide || "BOTH").toUpperCase();
  const side = ps === "LONG" || ps === "SHORT" ? ps : gt(row.positionAmt, "0") ? "LONG" : "SHORT";
  return `iso:${row.symbol}:${side}`;
};
export const MAX_MUTED = 11;

// Aster/Binance write "cross"/"isolated" (positionRisk) or "CROSSED"/"ISOLATED" (requests).
const marginTypeOf = (p, accPos) => {
  const t = String((p && p.marginType) || "").toLowerCase();
  if (t.startsWith("iso")) return "isolated";
  if (t.startsWith("cross")) return "cross";
  if (accPos && (accPos.isolated === true || accPos.isolated === "true")) return "isolated";
  return "cross";
};

const mapAssets = (account, multiAssets, prices) => {
  const list = account && Array.isArray(account.assets) ? account.assets : [];
  const out = [];
  const skipped = [];
  list.forEach((a) => {
    const asset = String((a && a.asset) || "");
    if (!asset || !nonZero(a.crossWalletBalance)) return;
    // Single-Asset mode (or unknown mode): only USDT/USD1 count as margin. Leaving the others out
    // can only make the server warn earlier, never later.
    if (multiAssets !== true && !SINGLE_ASSET_MARGIN.includes(asset)) return;
    const p = prices && prices[asset];
    if (STABLES.includes(asset)) {
      out.push({
        asset,
        crossWalletBalance: str(a.crossWalletBalance),
        price: p && isValid(p.price) ? str(p.price) : "1",
        discount: p && isValid(p.discount) ? str(p.discount) : "1",
      });
      return;
    }
    if (!p || !isValid(p.price) || !gt(p.price, "0")) {
      skipped.push(asset); // no USD price: left out (a positive balance only makes alerts earlier)
      return;
    }
    out.push({
      asset,
      crossWalletBalance: str(a.crossWalletBalance),
      price: str(p.price),
      discount: isValid(p.discount) ? str(p.discount) : DEFAULT_DISCOUNT,
    });
  });
  return { assets: out, skipped };
};

const mapPositions = (account, positionRisk) => {
  const accPositions = account && Array.isArray(account.positions) ? account.positions : [];
  const accBySide = new Map(accPositions.map((p) => [sideKey(p), p]));
  const risk = Array.isArray(positionRisk) ? positionRisk : [];
  const missingMaint = [];
  const rows = risk
    .filter((p) => p && p.symbol && nonZero(p.positionAmt))
    .map((p) => {
      const acc = accBySide.get(sideKey(p)) || null;
      const markPrice = isValid(p.markPrice) ? str(p.markPrice) : null;
      const entryPrice = isValid(p.entryPrice) ? str(p.entryPrice) : "0";
      const maint = acc && isValid(acc.maintMargin) ? acc.maintMargin : isValid(p.maintMargin) ? p.maintMargin : null;
      if (maint === null) missingMaint.push(p.symbol);
      const marginType = marginTypeOf(p, acc);
      const row = {
        symbol: String(p.symbol),
        positionAmt: str(p.positionAmt),
        entryPrice,
        markPrice: markPrice || entryPrice,
        maintMargin: maint === null ? "0" : str(maint),
        marginType,
      };
      if (marginType === "isolated") {
        const w = isValid(p.isolatedWallet) ? p.isolatedWallet : acc && isValid(acc.isolatedWallet) ? acc.isolatedWallet : "0";
        row.isolatedWallet = str(w);
      }
      return { row, key: muteKeyOf(row, p.positionSide), notional: mul(absOf(p.positionAmt), row.markPrice) };
    })
    .sort((a, b) => (gt(a.notional, b.notional) ? -1 : gt(b.notional, a.notional) ? 1 : 0));
  const kept = rows.slice(0, MAX_POSITIONS);
  return {
    positions: kept.map((r) => r.row),
    sentKeys: kept.map((r) => r.key),
    openKeys: rows.map((r) => r.key),
    dropped: Math.max(0, rows.length - MAX_POSITIONS),
    missingMaint,
  };
};

// muted: the wallet's saved switch keys. Only keys of currently open positions are kept:
//   account.muted  = saved ∩ positions sent (max 11), always present (may be empty)
//   info.keepMuted = saved ∩ all open positions -> what should stay saved (a closed position's
//                    key is dropped, so it starts unmuted when opened again)
// -> { account: { assets, positions, muted }, info: { skippedAssets, droppedPositions, missingMaint, keepMuted, openKeys } }
export const buildSnapshot = ({ account, positionRisk, multiAssets = null, prices = null, muted = [] } = {}) => {
  const a = mapAssets(account, multiAssets, prices);
  const p = mapPositions(account, positionRisk);
  const saved = [...new Set(Array.isArray(muted) ? muted.filter((k) => typeof k === "string") : [])];
  const open = new Set(p.openKeys);
  const sent = new Set(p.sentKeys);
  return {
    account: {
      assets: a.assets,
      positions: p.positions,
      muted: saved.filter((k) => sent.has(k)).slice(0, MAX_MUTED),
    },
    info: {
      skippedAssets: a.skipped,
      droppedPositions: p.dropped,
      missingMaint: p.missingMaint,
      keepMuted: saved.filter((k) => open.has(k)),
      openKeys: [...open],
    },
  };
};

// Margin ratios for the alerts sheet (display only, numbers), from a built snapshot account:
//   cross:    Σ maintMargin(cross) / (Σ balance × price × discount + Σ unrealized PnL(cross))
//   isolated: maintMargin / (isolatedWallet + unrealized PnL)
// 100% = liquidation. An equity of 0 or less counts as 100%+.
// -> { cross: { key, symbols, ratio } | null, isolated: [{ key, symbol, side, ratio }] }
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const upnl = (p) => n(p.positionAmt) * (n(p.markPrice) - n(p.entryPrice));
const ratioOf = (maint, equity) => (equity > 0 ? maint / equity : maint > 0 ? Infinity : 0);
export const marginRatios = (acct) => {
  const positions = (acct && acct.positions) || [];
  const cross = positions.filter((p) => p.marginType !== "isolated");
  const collateral = ((acct && acct.assets) || []).reduce(
    (s, x) => s + n(x.crossWalletBalance) * n(x.price) * (n(x.crossWalletBalance) > 0 ? n(x.discount) : 1),
    0
  );
  const crossRow = cross.length
    ? {
        key: CROSS_KEY,
        symbols: cross.map((p) => p.symbol),
        ratio: ratioOf(
          cross.reduce((s, p) => s + n(p.maintMargin), 0),
          collateral + cross.reduce((s, p) => s + upnl(p), 0)
        ),
      }
    : null;
  const isolated = positions
    .filter((p) => p.marginType === "isolated")
    .map((p) => {
      const key = muteKeyOf(p);
      return { key, symbol: p.symbol, side: key.endsWith(":LONG") ? "LONG" : "SHORT", ratio: ratioOf(n(p.maintMargin), n(p.isolatedWallet) + upnl(p)) };
    });
  return { cross: crossRow, isolated };
};

// What decides "nothing changed since the last upload" (prices / maint margin move all the time and
// are refreshed by the periodic re-send instead).
export const snapshotSignature = (wallet, account) =>
  JSON.stringify([
    String(wallet || "").toLowerCase(),
    account.assets.map((x) => [x.asset, x.crossWalletBalance]),
    account.positions.map((x) => [x.symbol, x.positionAmt, x.entryPrice, x.marginType, x.isolatedWallet || ""]),
    account.muted || [],
  ]);

// Non-stable assets with a balance (they need a USD price from assetIndex).
export const assetsNeedingPrice = (account) =>
  (account && Array.isArray(account.assets) ? account.assets : [])
    .filter((a) => a && a.asset && !STABLES.includes(String(a.asset)) && nonZero(a.crossWalletBalance))
    .map((a) => String(a.asset));
