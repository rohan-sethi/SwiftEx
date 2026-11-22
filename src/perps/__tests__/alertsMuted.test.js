// Liquidation alerts settings: muted keys in the snapshot, margin ratios for the sheet, and the
// syncer's master switch / mute pruning.
import { buildSnapshot, marginRatios, muteKeyOf, CROSS_KEY } from "../alerts/snapshot";
import { createAlertsSyncer } from "../alerts/syncer";

const USER = "0x6Ad7A4C1F113F65aF139831D7D78EAAc6b9a4eA0";
const risk = (symbol, positionAmt, extra = {}) => ({
  symbol,
  positionAmt,
  entryPrice: "100",
  markPrice: "100",
  marginType: "cross",
  isolatedWallet: "0",
  positionSide: "BOTH",
  ...extra,
});
const iso = (symbol, amt, wallet = "5") => risk(symbol, amt, { marginType: "isolated", isolatedWallet: wallet });
const acc = (positions = [], assets = [{ asset: "USDT", crossWalletBalance: "10" }]) => ({
  assets,
  positions: positions.map((p) => ({ symbol: p.symbol, positionSide: "BOTH", maintMargin: p.mm || "0.5", isolatedWallet: p.isolatedWallet })),
});

describe("muted keys", () => {
  test("key per position: cross / iso:SYMBOL:LONG|SHORT", () => {
    expect(muteKeyOf({ marginType: "cross", symbol: "BTCUSDT", positionAmt: "1" })).toBe(CROSS_KEY);
    expect(muteKeyOf({ marginType: "isolated", symbol: "XRPUSDT", positionAmt: "10" })).toBe("iso:XRPUSDT:LONG");
    expect(muteKeyOf({ marginType: "isolated", symbol: "XRPUSDT", positionAmt: "-10" })).toBe("iso:XRPUSDT:SHORT");
    expect(muteKeyOf({ marginType: "isolated", symbol: "XRPUSDT", positionAmt: "10" }, "SHORT")).toBe("iso:XRPUSDT:SHORT");
  });

  test("only keys of open positions are sent; closed ones are dropped from what is kept", () => {
    const positionRisk = [risk("BTCUSDT", "0.01"), iso("XRPUSDT", "10"), iso("SOLUSDT", "0")];
    const { account, info } = buildSnapshot({
      account: acc(positionRisk),
      positionRisk,
      muted: ["cross", "iso:XRPUSDT:LONG", "iso:SOLUSDT:LONG", "iso:XRPUSDT:SHORT", "junk", 5, "cross"],
    });
    expect(account.muted).toEqual(["cross", "iso:XRPUSDT:LONG"]);
    expect(info.keepMuted).toEqual(["cross", "iso:XRPUSDT:LONG"]);
  });

  test("cross key is dropped when no cross position is open; always an array", () => {
    const positionRisk = [iso("XRPUSDT", "-10")];
    const { account, info } = buildSnapshot({ account: acc(positionRisk), positionRisk, muted: ["cross"] });
    expect(account.muted).toEqual([]);
    expect(info.keepMuted).toEqual([]);
    expect(buildSnapshot({}).account.muted).toEqual([]);
  });

  test("never more than 11 keys sent", () => {
    const positionRisk = [risk("BTCUSDT", "1")];
    for (let i = 0; i < 12; i++) positionRisk.push(iso(`S${i}USDT`, `${i + 1}`));
    const muted = ["cross", ...positionRisk.slice(1).map((p) => `iso:${p.symbol}:LONG`)];
    const { account } = buildSnapshot({ account: acc(positionRisk), positionRisk, muted });
    expect(account.positions).toHaveLength(10);
    expect(account.muted.length).toBeLessThanOrEqual(11);
    account.muted.forEach((k) => expect(k === "cross" || account.positions.some((p) => k === `iso:${p.symbol}:LONG`)).toBe(true));
  });
});

describe("marginRatios", () => {
  test("cross: maint / (collateral × discount + uPnL); isolated: maint / (wallet + uPnL)", () => {
    const positionRisk = [
      risk("BTCUSDT", "0.01", { entryPrice: "100", markPrice: "90" }), // uPnL -0.1
      risk("ETHUSDT", "-1", { entryPrice: "10", markPrice: "11" }), // uPnL -1
      iso("XRPUSDT", "10", "2"),
    ];
    const account = acc(
      [{ symbol: "BTCUSDT", mm: "1" }, { symbol: "ETHUSDT", mm: "0.9" }, { symbol: "XRPUSDT", mm: "1.5" }],
      [{ asset: "USDT", crossWalletBalance: "5" }, { asset: "USDC", crossWalletBalance: "1" }]
    );
    const { account: snap } = buildSnapshot({ account, positionRisk, multiAssets: true });
    const r = marginRatios(snap);
    expect(r.cross.symbols).toEqual(["ETHUSDT", "BTCUSDT"]);
    expect(r.cross.ratio).toBeCloseTo(1.9 / (6 - 1.1), 6);
    expect(r.isolated).toEqual([{ key: "iso:XRPUSDT:LONG", symbol: "XRPUSDT", side: "LONG", ratio: 0.75 }]);
  });
  test("no positions -> empty; zero equity -> Infinity (shown as ≥100%)", () => {
    expect(marginRatios({ assets: [], positions: [] })).toEqual({ cross: null, isolated: [] });
    const positionRisk = [risk("BTCUSDT", "1")];
    const { account } = buildSnapshot({ account: acc(positionRisk, []), positionRisk });
    expect(marginRatios(account).cross.ratio).toBe(Infinity);
  });
});

describe("syncer: master switch + mute pruning", () => {
  const setup = (prefs) => {
    let p = { enabled: true, muted: [], ...prefs };
    const deps = {
      enabled: () => true,
      now: () => 1_000_000,
      platform: "android",
      getToken: jest.fn(async () => "tok-123456"),
      getAgent: jest.fn(async () => ({})),
      loadRaw: jest.fn(async () => {
        const positionRisk = [risk("BTCUSDT", "0.01")];
        return { account: acc(positionRisk), positionRisk };
      }),
      loadMode: jest.fn(async () => true),
      loadPrices: jest.fn(async () => ({})),
      post: jest.fn(async () => ({ status: 200 })),
      del: jest.fn(async () => ({ status: 200 })),
      saveWallet: jest.fn(async () => {}),
      loadWallet: jest.fn(async () => USER),
      log: jest.fn(),
      schedule: jest.fn(),
      getPrefs: jest.fn(async () => p),
      saveMuted: jest.fn(async (u, keys) => {
        p = { ...p, muted: keys };
      }),
    };
    return { s: createAlertsSyncer(deps), deps, setPrefs: (x) => (p = { ...p, ...x }) };
  };

  test("master Off: no uploads at all (even forced), DELETE removes the device", async () => {
    const { s, deps } = setup({ enabled: false });
    expect(await s.sync({ user: USER })).toMatchObject({ skipped: "off" });
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ skipped: "off" });
    expect(deps.loadRaw).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
    expect(await s.remove("alerts-off")).toEqual({ removed: true });
    expect(deps.del).toHaveBeenCalledWith({ fcmToken: "tok-123456" });
  });

  test("master back On: a forced upload goes out at once (no throttle)", async () => {
    const { s, deps, setPrefs } = setup({ enabled: true });
    await s.sync({ user: USER });
    setPrefs({ enabled: false });
    await s.remove();
    setPrefs({ enabled: true });
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ sent: true });
    expect(deps.post).toHaveBeenCalledTimes(2);
  });

  test("DELETE waits for a running upload (it can't re-create the row afterwards)", async () => {
    let release;
    const { s, deps } = setup();
    deps.post.mockImplementation(() => new Promise((r) => (release = () => r({ status: 200 }))));
    const up = s.sync({ user: USER });
    await new Promise((r) => setTimeout(r, 0));
    const rm = s.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.del).not.toHaveBeenCalled();
    release();
    await up;
    await rm;
    expect(deps.del).toHaveBeenCalledTimes(1);
  });

  test("muted keys are sent; keys of closed positions are forgotten", async () => {
    const { s, deps } = setup({ muted: ["cross", "iso:XRPUSDT:LONG"] });
    await s.sync({ user: USER, force: true });
    expect(deps.post.mock.calls[0][0].account.muted).toEqual(["cross"]);
    expect(deps.saveMuted).toHaveBeenCalledWith(USER, ["cross"]);
  });

  test("changing a switch changes the upload (not skipped as unchanged)", async () => {
    const { s, deps, setPrefs } = setup();
    await s.sync({ user: USER, force: true });
    setPrefs({ muted: ["cross"] });
    await s.sync({ user: USER, force: true });
    expect(deps.post.mock.calls[1][0].account.muted).toEqual(["cross"]);
  });
});
