// Liquidation alerts upload: throttle / force / unchanged re-send / 429 back-off / error swallowing.
import { createAlertsSyncer, THROTTLE_MS, RESEND_MS, BACKOFF_MS } from "../alerts/syncer";

const USER = "0x6Ad7A4C1F113F65aF139831D7D78EAAc6b9a4eA0";
const AGENT = { address: "0xagent" };
const rawWith = (amt) => ({
  account: { assets: [{ asset: "USDT", crossWalletBalance: "4.43" }], positions: [{ symbol: "BTCUSDT", maintMargin: "0.02", positionSide: "BOTH" }] },
  positionRisk: [{ symbol: "BTCUSDT", positionAmt: amt, entryPrice: "90000", markPrice: "90000", marginType: "cross", positionSide: "BOTH" }],
});

const setup = (over = {}) => {
  let t = 1_000_000;
  const scheduled = [];
  const deps = {
    enabled: () => true,
    now: () => t,
    platform: "android",
    getToken: jest.fn(async () => "fcm-token-abcdef"),
    getAgent: jest.fn(async () => AGENT),
    loadRaw: jest.fn(async () => rawWith("0.001")),
    loadMode: jest.fn(async () => true),
    loadPrices: jest.fn(async () => ({})),
    post: jest.fn(async () => ({ status: 200 })),
    del: jest.fn(async () => ({ status: 200 })),
    saveWallet: jest.fn(async () => {}),
    loadWallet: jest.fn(async () => USER),
    log: jest.fn(),
    schedule: jest.fn((fn, ms) => scheduled.push({ fn, ms })),
    ...over,
  };
  const s = createAlertsSyncer(deps);
  return { s, deps, scheduled, advance: (ms) => (t += ms) };
};

describe("alerts syncer", () => {
  test("sends a full snapshot with token, wallet, platform and time", async () => {
    const { s, deps } = setup();
    const r = await s.sync({ reason: "poll", user: USER });
    expect(r).toMatchObject({ sent: true, positions: 1, token6: "abcdef" });
    const body = deps.post.mock.calls[0][0];
    expect(body).toMatchObject({ fcmToken: "fcm-token-abcdef", wallet: USER, platform: "android", snapshotAt: 1_000_000 });
    expect(body.account.positions[0]).toMatchObject({ symbol: "BTCUSDT", positionAmt: "0.001", maintMargin: "0.02" });
    expect(deps.saveWallet).toHaveBeenCalledWith(USER);
  });

  test("throttle: a second sync within 15 s is skipped before any Aster call; force sends", async () => {
    const { s, deps, advance } = setup();
    await s.sync({ user: USER });
    advance(THROTTLE_MS - 1);
    expect(await s.sync({ user: USER })).toMatchObject({ sent: false, skipped: "throttle" });
    expect(deps.loadRaw).toHaveBeenCalledTimes(1);
    deps.loadRaw.mockImplementationOnce(async () => rawWith("0"));
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ sent: true, positions: 0 });
    expect(deps.post).toHaveBeenCalledTimes(2);
  });

  test("unchanged snapshot is not re-sent until 5 min; a closed position is sent at once", async () => {
    const { s, deps, advance } = setup();
    await s.sync({ user: USER });
    advance(THROTTLE_MS);
    expect(await s.sync({ user: USER })).toMatchObject({ skipped: "unchanged" });
    advance(RESEND_MS);
    expect(await s.sync({ user: USER })).toMatchObject({ sent: true });
    advance(THROTTLE_MS);
    deps.loadRaw.mockImplementationOnce(async () => rawWith("0"));
    expect(await s.sync({ user: USER })).toMatchObject({ sent: true, positions: 0 });
  });

  test("uses data the caller already has (no extra Aster reads)", async () => {
    const { s, deps } = setup();
    await s.sync({ user: USER, agent: AGENT, raw: rawWith("0.002") });
    expect(deps.loadRaw).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.post.mock.calls[0][0].account.positions[0].positionAmt).toBe("0.002");
  });

  test("no Perps account / no deposit / disabled / no token: nothing sent", async () => {
    expect(await setup({ getAgent: async () => null }).s.sync({ user: USER })).toMatchObject({ skipped: "no-perps" });
    expect(await setup({ loadRaw: async () => ({ noDeposit: true }) }).s.sync({ user: USER })).toMatchObject({ skipped: "no-data" });
    expect(await setup({ enabled: () => false }).s.sync({ user: USER })).toMatchObject({ skipped: "disabled" });
    const t = setup({ getToken: async () => null });
    expect(await t.s.sync({ user: USER })).toMatchObject({ skipped: "no-token" });
    expect(t.deps.post).not.toHaveBeenCalled();
  });

  test("429: backs off (doubling); a forced sync is retried after the back-off", async () => {
    const { s, deps, scheduled, advance } = setup({ post: jest.fn(async () => ({ status: 429 })) });
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ sent: false, skipped: "http-429" });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(BACKOFF_MS);
    advance(1000);
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ skipped: "backoff" });
    expect(deps.post).toHaveBeenCalledTimes(1);
    deps.post.mockImplementation(async () => ({ status: 200 }));
    advance(BACKOFF_MS);
    scheduled[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.post).toHaveBeenCalledTimes(2);
  });

  test("errors are swallowed and logged, never thrown", async () => {
    const boom = async () => {
      throw new Error("network down");
    };
    for (const over of [{ post: boom }, { loadRaw: boom }, { getToken: boom }, { getAgent: boom }, { loadMode: boom }]) {
      const { s, deps } = setup(over);
      await expect(s.sync({ user: USER })).resolves.toMatchObject({ sent: false, skipped: "error" });
      expect(deps.log).toHaveBeenCalled();
    }
    const bad = setup({ post: async () => ({ status: 400, error: "too many positions" }) });
    await expect(bad.s.sync({ user: USER })).resolves.toMatchObject({ skipped: "http-400" });
    const throwingLog = setup({ post: boom, log: () => { throw new Error("log broke"); } });
    await expect(throwingLog.s.sync({ user: USER })).resolves.toMatchObject({ sent: false });
    await expect(setup({ del: boom }).s.remove()).resolves.toMatchObject({ removed: false });
  });

  test("a forced sync while another upload runs is sent right after it", async () => {
    let release;
    const { s, deps } = setup({ loadRaw: jest.fn(() => new Promise((r) => (release = () => r(rawWith("0.001"))))) });
    const first = s.sync({ user: USER });
    expect(await s.sync({ user: USER, force: true })).toMatchObject({ skipped: "busy" });
    deps.loadRaw.mockImplementation(async () => rawWith("0"));
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(deps.post.mock.calls[1][0].account.positions).toHaveLength(0);
  });

  test("remove device / wallet removed", async () => {
    const { s, deps } = setup();
    expect(await s.remove()).toEqual({ removed: true });
    expect(deps.del).toHaveBeenCalledWith({ fcmToken: "fcm-token-abcdef" });
    expect(deps.saveWallet).toHaveBeenCalledWith(null);
    expect(await s.onWalletRemoved("0xsomeoneelse")).toMatchObject({ skipped: "other-wallet" });
    const r = await s.onWalletRemoved(USER.toLowerCase());
    expect(await r.removing).toEqual({ removed: true });
    expect(deps.del).toHaveBeenCalledTimes(2);
  });
});
