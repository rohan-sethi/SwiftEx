// Perps network switch (src/perps/network.js).
// 1) MAINNET values are pinned here exactly as they were hard-coded before: any change fails.
// 2) TESTNET has every value, and a TESTNET build points every module at the testnet.
// 3) Liquidation alerts are fully off on testnet (no uploads, no DELETE, no prompt).

const MAINNET_EXPECTED = {
  name: "MAINNET",
  isTestnet: false,
  restBase: "https://fapi.asterdex.com",
  wsUrl: "wss://fstream.asterdex.com/stream?streams=",
  bapiBase: "https://www.asterdex.com/bapi/futures/v1/public/future/aster",
  logoUrl: "https://www.asterdex.com/bapi/futures/v1/public/future/asset/ae/all-asset-logo",
  nativeToken: "0xfdAE1bA7C826aBDc4c99903c8056f82a1A04a615",
  chains: [
    {
      chainId: 56,
      key: "BNB",
      name: "BNB Chain",
      asterName: "BSC",
      native: "BNB",
      vault: "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974",
      explorer: "https://bscscan.com",
      explorerName: "BscScan",
    },
    {
      chainId: 1,
      key: "ETH",
      name: "Ethereum",
      asterName: "ETH",
      native: "ETH",
      vault: "0x604DD02d620633Ae427888d41bfd15e38483736E",
      explorer: "https://etherscan.io",
      explorerName: "Etherscan",
      gasNote: "Ethereum network fees can be a few dollars.",
    },
    {
      chainId: 42161,
      key: "ARB",
      name: "Arbitrum",
      asterName: "Arbitrum",
      native: "ETH",
      vault: "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5",
      explorer: "https://arbiscan.io",
      explorerName: "Arbiscan",
    },
  ],
  defaultChainId: 56,
  usdt: { chainId: 56, key: "BNB", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  approveSignatureChainId: 56,
  agentSigningChainId: 1666,
  withdrawAsterChain: "Mainnet",
  withdrawChainNames: { 1: "ETH", 56: "BSC", 42161: "Arbitrum" },
  depositSendEnabled: true,
  withdrawEnabled: true,
  alertsEnabled: true,
  zeroAddress: "0x0000000000000000000000000000000000000000",
};

// Modules that need native code: stubbed for every environment below.
const stubNative = () => {
  jest.doMock("@react-native-async-storage/async-storage", () => ({
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  }));
  jest.doMock("@react-native-firebase/messaging", () => () => ({ getToken: jest.fn(async () => "tok-123456") }));
  jest.doMock("@notifee/react-native", () => ({
    __esModule: true,
    default: { createChannel: jest.fn(async () => "perps_alerts"), getNotificationSettings: jest.fn(async () => ({ authorizationStatus: 0 })) },
    AndroidImportance: { HIGH: 4 },
    AuthorizationStatus: { AUTHORIZED: 1, PROVISIONAL: 2 },
  }));
  jest.doMock("../hooks/usePerpsAgent", () => ({ getUsableAgent: jest.fn(async () => ({ address: "0xagent" })) }));
  jest.doMock("../api/asterTrade", () => ({
    fetchAccount: jest.fn(async () => ({ data: { assets: [], positions: [] } })),
    fetchPositions: jest.fn(async () => ({ data: [] })),
    fetchMultiAssetsMode: jest.fn(async () => ({ data: { multiAssetsMargin: false } })),
  }));
  jest.doMock("../utils/modalSafe", () => ({ showInfo: jest.fn() }));
  // The app's EVM signer stack (native modules): any call would be a failure here.
  jest.doMock("../../utilities/TokenUtils", () => ({ CHAINS: {} }));
  jest.doMock("../../utilities/evmTxManager", () => ({
    fustionEvmTxManager: jest.fn(async () => {
      throw new Error("must not sign");
    }),
  }));
  jest.doMock("../api/asterWithdrawSigner", () => ({
    signAsterWithdrawRequest: jest.fn(async () => {
      throw new Error("must not sign");
    }),
    isAsterWithdrawSigningAvailable: () => true,
  }));
};

// Load a module as a fresh build for `env` ('MAINNET' | 'TESTNET').
const loadFor = (env, path) => {
  jest.resetModules();
  jest.doMock("../../Dashboard/constants", () => ({ ENVIRONMENT: env }));
  stubNative();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path);
};

afterEach(() => {
  jest.dontMock("../../Dashboard/constants");
  delete global.fetch;
});

describe("mainnet values (must never change)", () => {
  test("every mainnet value is exactly as before", () => {
    const { PERPS_NETWORK, PERPS_NETWORKS } = loadFor("MAINNET", "../network");
    expect(PERPS_NETWORK).toBe(PERPS_NETWORKS.MAINNET);
    expect(JSON.parse(JSON.stringify(PERPS_NETWORK))).toEqual(MAINNET_EXPECTED);
  });

  test("modules read the mainnet values", () => {
    expect(loadFor("MAINNET", "../api/asterPublic").ASTER_REST_BASE).toBe("https://fapi.asterdex.com");
    const assets = loadFor("MAINNET", "../api/asterAssets");
    expect(assets.NATIVE_TOKEN).toBe("0xfdae1ba7c826abdc4c99903c8056f82a1a04a615");
    expect(assets.PERPS_CHAINS.map((c) => c.chainId)).toEqual([56, 1, 42161]);
    expect(assets.DEFAULT_CHAIN_ID).toBe(56);
    expect(assets.chainById(999).chainId).toBe(56);
    expect(assets.txUrl(56, "0xabc")).toBe("https://bscscan.com/tx/0xabc");
    const funds = loadFor("MAINNET", "../api/asterFunds");
    expect(funds.ASTER_VAULT_BSC).toBe("0x128463A60784c4D3f46c23Af3f65Ed859Ba87974");
    expect(funds.USDT_BSC).toBe("0x55d398326f99059fF775485246999027B3197955");
    expect(funds.USDT_DECIMALS).toBe(18);
    expect(funds.NATIVE_TOKEN_ADDRESS).toBe("0xfdAE1bA7C826aBDc4c99903c8056f82a1A04a615");
  });

  test("storage keys are unchanged on mainnet; perps + alerts on", () => {
    const { perpsStoreKey } = loadFor("MAINNET", "../network");
    expect(perpsStoreKey("perps_markets_cache")).toBe("perps_markets_cache");
    const cfg = loadFor("MAINNET", "../config");
    expect(cfg.PERPS_ENABLED).toBe(true);
    expect(cfg.PERPS_ALERTS_ENABLED).toBe(true);
  });

  test("mainnet asset lists are read from www.asterdex.com for chains 56,1,42161", async () => {
    const { getAssetLists } = loadFor("MAINNET", "../api/asterAssets");
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "{}" };
    });
    await getAssetLists().catch(() => null);
    expect(urls.some((u) => u.startsWith("https://www.asterdex.com/bapi/futures/v1/public/future/aster/deposit/assets?chainIds=56,1,42161&"))).toBe(true);
  });
});

describe("testnet values", () => {
  test("every testnet value is present", () => {
    const { PERPS_NETWORK } = loadFor("TESTNET", "../network");
    expect(PERPS_NETWORK.isTestnet).toBe(true);
    expect(PERPS_NETWORK.restBase).toBe("https://fapi.asterdex-testnet.com");
    expect(PERPS_NETWORK.wsUrl).toBe("wss://fstream.asterdex-testnet.com/stream?streams=");
    expect(PERPS_NETWORK.bapiBase).toBe("https://www.asterdex-testnet.com/bapi/futures/v1/public/future/aster");
    expect(PERPS_NETWORK.chains).toHaveLength(1);
    expect(PERPS_NETWORK.chains[0]).toMatchObject({
      chainId: 97,
      vault: "0x62904590b575ea1C3F4aC411EB6A5A3140d6956e",
      explorer: "https://testnet.bscscan.com",
    });
    expect(PERPS_NETWORK.chains[0].rpcUrls.length).toBeGreaterThan(0);
    expect(PERPS_NETWORK.defaultChainId).toBe(97);
    expect(PERPS_NETWORK.usdt).toMatchObject({ chainId: 97, address: "0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7", decimals: 18 });
    expect(PERPS_NETWORK.agentSigningChainId).toBe(714);
    expect(PERPS_NETWORK.approveSignatureChainId).toBe(56);
    expect(PERPS_NETWORK.withdrawAsterChain).toBe("Testnet");
    expect(PERPS_NETWORK.alertsEnabled).toBe(false);
    // Every key the mainnet object has exists on testnet too.
    Object.keys(MAINNET_EXPECTED).forEach((k) => expect(PERPS_NETWORK[k]).not.toBeUndefined());
  });

  test("a TESTNET build points every module at the testnet; storage keys are separate", () => {
    expect(loadFor("TESTNET", "../api/asterPublic").ASTER_REST_BASE).toBe("https://fapi.asterdex-testnet.com");
    const assets = loadFor("TESTNET", "../api/asterAssets");
    expect(assets.PERPS_CHAINS.map((c) => c.chainId)).toEqual([97]);
    expect(assets.chainById(56).chainId).toBe(97);
    expect(assets.txUrl(97, "0xabc")).toBe("https://testnet.bscscan.com/tx/0xabc");
    const funds = loadFor("TESTNET", "../api/asterFunds");
    expect(funds.ASTER_VAULT_BSC).toBe("0x62904590b575ea1C3F4aC411EB6A5A3140d6956e");
    expect(funds.USDT_BSC).toBe("0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7");
    const { perpsStoreKey } = loadFor("TESTNET", "../network");
    expect(perpsStoreKey("perps_markets_cache")).toBe("perps_markets_cache_testnet");
    const cfg = loadFor("TESTNET", "../config");
    expect(cfg.PERPS_ENABLED).toBe(true);
  });

  test("testnet: deposit send and withdraw are refused before anything is signed", async () => {
    const funds = loadFor("TESTNET", "../api/asterFunds");
    expect(await funds.verifyDepositPlan("0x1", { chainId: 97, chainKey: "PERPS_BSC_TESTNET" })).toMatch(/Testnet deposits/);
    const r = await funds.executeChainDeposit("0x1", { chainId: 97, chainKey: "PERPS_BSC_TESTNET", needsApprove: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Testnet deposits/);
    await expect(funds.withdrawWithMainWallet("0x1", "1", "0.1", { asset: "USDT", chainId: 97 })).rejects.toThrow(/Testnet withdrawals/);
  });
});

describe("liquidation alerts are off on testnet", () => {
  test("no uploads, no DELETE, no permission prompt", async () => {
    const cfg = loadFor("TESTNET", "../config");
    expect(cfg.PERPS_ALERTS_ENABLED).toBe(false);
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = loadFor("TESTNET", "../alerts/alertsClient");
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const user = "0x6Ad7A4C1F113F65aF139831D7D78EAAc6b9a4eA0";
    expect(await client.syncPerpsAlerts({ reason: "poll", force: true, user })).toMatchObject({ sent: false, skipped: "disabled" });
    expect(await client.removePerpsAlertsDevice("perps-reset")).toEqual({ removed: false });
    expect(await client.onWalletRemovedForAlerts(user)).toEqual({ removed: false });
    await client.setPerpsAlertsEnabled(user, false);
    await client.setPerpsAlertsEnabled(user, true);
    await client.setPerpsAlertMuted(user, "cross", true);
    expect(global.fetch).not.toHaveBeenCalled();

    const prompt = loadFor("TESTNET", "../alerts/notificationPrompt");
    const { showInfo } = require("../utils/modalSafe");
    await prompt.maybeAskForAlertsPermission();
    expect(showInfo).not.toHaveBeenCalled();
  });

  test("mainnet: alerts still upload", async () => {
    const client = loadFor("MAINNET", "../alerts/alertsClient");
    const calls = [];
    global.fetch = jest.fn(async (url, opts) => {
      calls.push({ url: String(url), method: opts && opts.method });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    });
    const user = "0x6Ad7A4C1F113F65aF139831D7D78EAAc6b9a4eA0";
    const raw = { account: { assets: [], positions: [] }, positionRisk: [] };
    await client.syncPerpsAlerts({ reason: "poll", force: true, user, agent: { address: "0xagent" }, raw });
    expect(calls.some((c) => c.method === "POST" && c.url === "https://alerts.swiftexchange.io/v1/snapshot")).toBe(true);
  });
});
