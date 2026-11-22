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
      return { row, notional: mul(absOf(p.positionAmt), row.markPrice) };
    })
    .sort((a, b) => (gt(a.notional, b.notional) ? -1 : gt(b.notional, a.notional) ? 1 : 0));
  return {
    positions: rows.slice(0, MAX_POSITIONS).map((r) => r.row),
    dropped: Math.max(0, rows.length - MAX_POSITIONS),
    missingMaint,
  };
};

// -> { account: { assets, positions }, info: { skippedAssets, droppedPositions, missingMaint } }
export const buildSnapshot = ({ account, positionRisk, multiAssets = null, prices = null } = {}) => {
  const a = mapAssets(account, multiAssets, prices);
  const p = mapPositions(account, positionRisk);
  return {
    account: { assets: a.assets, positions: p.positions },
    info: { skippedAssets: a.skipped, droppedPositions: p.dropped, missingMaint: p.missingMaint },
  };
};

// What decides "nothing changed since the last upload" (prices / maint margin move all the time and
// are refreshed by the periodic re-send instead).
export const snapshotSignature = (wallet, account) =>
  JSON.stringify([
    String(wallet || "").toLowerCase(),
    account.assets.map((x) => [x.asset, x.crossWalletBalance]),
    account.positions.map((x) => [x.symbol, x.positionAmt, x.entryPrice, x.marginType, x.isolatedWallet || ""]),
  ]);

// Non-stable assets with a balance (they need a USD price from assetIndex).
export const assetsNeedingPrice = (account) =>
  (account && Array.isArray(account.assets) ? account.assets : [])
    .filter((a) => a && a.asset && !STABLES.includes(String(a.asset)) && nonZero(a.crossWalletBalance))
    .map((a) => String(a.asset));
