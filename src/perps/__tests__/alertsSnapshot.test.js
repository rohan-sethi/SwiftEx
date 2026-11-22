// Liquidation alerts: Aster account data -> alerts-server snapshot (field names as seen live on
// 2026-11-22: account.assets[].crossWalletBalance, account.positions[].maintMargin,
// positionRisk[].marginType "cross"/"isolated").
import { buildSnapshot, snapshotSignature, assetsNeedingPrice, MAX_POSITIONS, DEFAULT_DISCOUNT } from "../alerts/snapshot";

const risk = (symbol, positionAmt, markPrice, extra = {}) => ({
  symbol,
  positionAmt,
  entryPrice: "100",
  markPrice,
  marginType: "cross",
  isolatedWallet: "0",
  positionSide: "BOTH",
  ...extra,
});
const accPos = (symbol, maintMargin, extra = {}) => ({ symbol, maintMargin, positionSide: "BOTH", isolated: false, isolatedWallet: "0", ...extra });

describe("buildSnapshot", () => {
  test("cross position: maint margin from the account, prices as strings", () => {
    const { account } = buildSnapshot({
      account: {
        assets: [{ asset: "USDT", crossWalletBalance: "12.30000000" }],
        positions: [accPos("BTCUSDT", "3.2"), accPos("ETHUSDT", "0")],
      },
      positionRisk: [risk("BTCUSDT", "-0.010", "64000.5", { entryPrice: "65000" }), risk("ETHUSDT", "0.000", "3000")],
      multiAssets: false,
    });
    expect(account.assets).toEqual([{ asset: "USDT", crossWalletBalance: "12.30000000", price: "1", discount: "1" }]);
    expect(account.positions).toEqual([
      { symbol: "BTCUSDT", positionAmt: "-0.010", entryPrice: "65000", markPrice: "64000.5", maintMargin: "3.2", marginType: "cross" },
    ]);
  });

  test("isolated position carries isolatedWallet", () => {
    const { account } = buildSnapshot({
      account: { assets: [], positions: [accPos("SOLUSDT", "0.4", { isolated: true, isolatedWallet: "5.1" })] },
      positionRisk: [risk("SOLUSDT", "1", "150", { marginType: "isolated", isolatedWallet: "5.1" })],
    });
    expect(account.positions[0]).toMatchObject({ marginType: "isolated", isolatedWallet: "5.1", maintMargin: "0.4" });
  });

  test("isolated from the account flag when positionRisk has no marginType", () => {
    const { account } = buildSnapshot({
      account: { positions: [accPos("SOLUSDT", "0.4", { isolated: true, isolatedWallet: "2" })] },
      positionRisk: [risk("SOLUSDT", "1", "150", { marginType: undefined, isolatedWallet: undefined })],
    });
    expect(account.positions[0]).toMatchObject({ marginType: "isolated", isolatedWallet: "2" });
  });

  test("multi-asset collateral: stables at 1, BNB with Aster price + haircut, missing haircut -> conservative default", () => {
    const { account, info } = buildSnapshot({
      account: {
        assets: [
          { asset: "USDT", crossWalletBalance: "-1.5" },
          { asset: "USDC", crossWalletBalance: "1.00000000" },
          { asset: "BNB", crossWalletBalance: "0.01" },
          { asset: "ASTER", crossWalletBalance: "10" },
          { asset: "ETH", crossWalletBalance: "0.1" },
          { asset: "USD1", crossWalletBalance: "0" },
        ],
        positions: [],
      },
      positionRisk: [],
      multiAssets: true,
      prices: { BNB: { price: "561.29", discount: "0.95" }, ASTER: { price: "0.5" } },
    });
    expect(account.assets).toEqual([
      { asset: "USDT", crossWalletBalance: "-1.5", price: "1", discount: "1" },
      { asset: "USDC", crossWalletBalance: "1.00000000", price: "1", discount: "1" },
      { asset: "BNB", crossWalletBalance: "0.01", price: "561.29", discount: "0.95" },
      { asset: "ASTER", crossWalletBalance: "10", price: "0.5", discount: DEFAULT_DISCOUNT },
    ]);
    expect(info.skippedAssets).toEqual(["ETH"]); // no price -> left out (alerts can only come earlier)
  });

  test("single-asset (or unknown) mode: only USDT/USD1 count as margin", () => {
    const account = { assets: [{ asset: "USDT", crossWalletBalance: "3" }, { asset: "USDC", crossWalletBalance: "1" }, { asset: "BNB", crossWalletBalance: "1" }] };
    expect(buildSnapshot({ account, positionRisk: [], multiAssets: false }).account.assets.map((a) => a.asset)).toEqual(["USDT"]);
    expect(buildSnapshot({ account, positionRisk: [], multiAssets: null }).account.assets.map((a) => a.asset)).toEqual(["USDT"]);
  });

  test("zero-size positions are filtered", () => {
    const { account } = buildSnapshot({
      account: { positions: [] },
      positionRisk: [risk("A", "0", "1"), risk("B", "0.0", "1"), risk("C", "", "1"), risk("D", "2", "1")],
    });
    expect(account.positions.map((p) => p.symbol)).toEqual(["D"]);
  });

  test("more than 10 positions: keeps the 10 largest by notional", () => {
    const positionRisk = [];
    for (let i = 1; i <= 12; i++) positionRisk.push(risk(`S${i}USDT`, i % 2 ? `${i}` : `-${i}`, "10"));
    const { account, info } = buildSnapshot({ account: { positions: [] }, positionRisk });
    expect(account.positions).toHaveLength(MAX_POSITIONS);
    expect(account.positions[0].symbol).toBe("S12USDT"); // short of 12 * 10 = 120 notional
    expect(account.positions.map((p) => p.symbol)).not.toContain("S1USDT");
    expect(account.positions.map((p) => p.symbol)).not.toContain("S2USDT");
    expect(info.droppedPositions).toBe(2);
  });

  test("missing maint margin is reported, never throws on junk", () => {
    const { account, info } = buildSnapshot({ account: { positions: [] }, positionRisk: [risk("XUSDT", "1", "5")] });
    expect(account.positions[0].maintMargin).toBe("0");
    expect(info.missingMaint).toEqual(["XUSDT"]);
    expect(buildSnapshot({}).account).toEqual({ assets: [], positions: [], muted: [] });
    expect(buildSnapshot({ account: null, positionRisk: null }).account).toEqual({ assets: [], positions: [], muted: [] });
  });

  test("signature ignores mark price / maint margin, changes when a position closes", () => {
    const base = { account: { assets: [{ asset: "USDT", crossWalletBalance: "5" }], positions: [accPos("BTCUSDT", "1")] } };
    const a = buildSnapshot({ ...base, positionRisk: [risk("BTCUSDT", "1", "100")] }).account;
    const b = buildSnapshot({ ...base, positionRisk: [risk("BTCUSDT", "1", "101")] }).account;
    const closed = buildSnapshot({ ...base, positionRisk: [risk("BTCUSDT", "0", "101")] }).account;
    expect(snapshotSignature("0xAb", a)).toBe(snapshotSignature("0xab", b));
    expect(snapshotSignature("0xab", a)).not.toBe(snapshotSignature("0xab", closed));
  });

  test("assetsNeedingPrice lists non-stables with a balance", () => {
    expect(assetsNeedingPrice({ assets: [{ asset: "USDT", crossWalletBalance: "1" }, { asset: "BNB", crossWalletBalance: "0.1" }, { asset: "ETH", crossWalletBalance: "0" }] })).toEqual(["BNB"]);
  });
});
