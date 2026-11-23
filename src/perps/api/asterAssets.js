// Chains + assets for Perps deposit / withdraw. Source of truth = Aster's live lists (cached 24h):
//   deposit/assets, withdraw/assets (www.asterdex.com bapi, public) and GET /fapi/v3/assetIndex
//   (public; bidBuffer = collateral haircut in Multi-Assets mode).
// Vaults are from Aster's docs ("deposit-withdrawal": chain / chainId / contract address).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { asterFetch } from "./asterPublic";
import { PERPS_NETWORK, perpsStoreKey } from "../network";

export const NATIVE_TOKEN = PERPS_NETWORK.nativeToken.toLowerCase(); // Aster's native placeholder

// Chains Perps deposits from / withdraws to (src/perps/network.js). Mainnet: BSC, Ethereum, Arbitrum.
export const PERPS_CHAINS = PERPS_NETWORK.chains;

// Default deposit / withdraw chain: BSC (56) on mainnet, BSC Testnet (97) on testnet.
export const DEFAULT_CHAIN_ID = PERPS_NETWORK.defaultChainId;
export const chainById = (id) => PERPS_CHAINS.find((c) => c.chainId === Number(id)) || PERPS_CHAINS[0];
export const txUrl = (chainId, hash) => `${chainById(chainId).explorer}/tx/${hash}`;

// Deposit picker: stablecoins + the chain's native coin (only if Aster lists them for that chain).
export const STABLES = ["USDT", "USDC", "USDCE", "USD1", "USDF"];
// Isolated margin / Single-Asset mode: only these count as margin.
export const SINGLE_ASSET_MARGIN = ["USDT", "USD1"];
export const displayName = (name) => (name === "USDCE" ? "USDC.e" : name);

const CACHE_KEY = perpsStoreKey("perps_asset_lists_v1");
const TTL = 24 * 60 * 60 * 1000;
const PARTIAL_TTL = 5 * 60 * 1000;
const fresh = (m) =>
  !!m && Array.isArray(m.withdraw) && m.withdraw.length > 0 && Date.now() - m.at < (m.partial ? PARTIAL_TTL : TTL);
const IDS = PERPS_CHAINS.map((c) => c.chainId).join(",");
const BAPI = PERPS_NETWORK.bapiBase;

let mem = null; // { at, deposit: [...], withdraw: [...], collateral: { ASSET: ratio } }
let inflight = null;

const slim = (a) => ({
  name: String(a.name),
  chainId: Number(a.chainId),
  contract: String(a.contractAddress || "").toLowerCase(),
  decimals: Number(a.decimals),
  isNative: !!a.isNative || String(a.contractAddress || "").toLowerCase() === NATIVE_TOKEN,
  minDeposit: a.minDeposit !== undefined && a.minDeposit !== null ? String(a.minDeposit) : "0",
});

const load = async () => {
  const [dep, wd, idx] = await Promise.all([
    asterFetch(`${BAPI}/deposit/assets?chainIds=${IDS}&networks=EVM&accountType=perp`, { timeoutMs: 15000 }),
    asterFetch(`${BAPI}/withdraw/assets?chainIds=${IDS}&networks=EVM&accountType=perp`, { timeoutMs: 15000 }),
    asterFetch("/fapi/v3/assetIndex", { timeoutMs: 15000 }),
  ]);
  if (dep.error || !Array.isArray(dep.data && dep.data.data)) throw new Error(dep.error || "No asset list");
  const collateral = {};
  (Array.isArray(idx.data) ? idx.data : []).forEach((r) => {
    const asset = String(r.symbol || "").replace(/USD$/, "");
    const buf = Number(r.bidBuffer);
    if (asset && Number.isFinite(buf)) collateral[asset] = Math.max(0, 1 - buf);
  });
  return {
    at: Date.now(),
    deposit: dep.data.data.filter((a) => a && a.network === "EVM").map(slim),
    withdraw:
      wd.data && Array.isArray(wd.data.data) && wd.data.data.length ? wd.data.data.map(slim) : (mem && mem.withdraw) || [],
    // A list that failed to load is retried after PARTIAL_TTL instead of being kept for a day.
    partial: !!(wd.error || idx.error || !(wd.data && Array.isArray(wd.data.data) && wd.data.data.length)),
    collateral: Object.keys(collateral).length ? collateral : (mem && mem.collateral) || {},
  };
};

// { deposit, withdraw, collateral, at } — memory, then AsyncStorage (≤24h), then network.
// A stale cache is still returned if the network fails.
export const getAssetLists = async ({ force = false } = {}) => {
  if (!force && fresh(mem)) return mem;
  if (!mem) {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (raw) mem = JSON.parse(raw);
    } catch (e) {
      mem = null;
    }
    if (!force && fresh(mem)) return mem;
  }
  if (!inflight) {
    inflight = load()
      .then((lists) => {
        mem = lists;
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(lists)).catch(() => {});
        return lists;
      })
      .catch((e) => {
        if (mem) return mem;
        throw e;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
};

export const depositAssetsFor = (lists, chainId) => {
  const list = lists.deposit.filter((a) => a.chainId === chainId && (a.isNative || STABLES.includes(a.name)));
  // native first, then stables in our order
  return list.sort((a, b) => (a.isNative ? -1 : b.isNative ? 1 : STABLES.indexOf(a.name) - STABLES.indexOf(b.name)));
};

// null = unknown (list missing): callers then trust Aster's user-withdraw-info chains.
export const withdrawChainsFor = (lists, asset) =>
  !lists || !lists.withdraw || lists.withdraw.length === 0
    ? null
    :
    PERPS_CHAINS.filter((c) => lists.withdraw.some((a) => a.chainId === c.chainId && a.name === asset));

// Collateral value in Multi-Assets mode, e.g. 0.95. USD stables ~1. null = unknown.
export const collateralRatio = (lists, asset) => {
  const key = asset === "USDCE" ? "USDCE" : asset;
  const r = lists && lists.collateral ? lists.collateral[key] : undefined;
  return typeof r === "number" ? r : null;
};
