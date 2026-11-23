// Every Aster network value Perps uses, in one place. Chosen by the app's ENVIRONMENT, like CCTP:
//   ENVIRONMENT === 'TESTNET' -> Aster testnet, anything else -> Aster mainnet.
// MAINNET must stay exactly as it was before this file existed (src/perps/__tests__/perpsNetwork.test.js
// pins every value; a change there fails the test).
import { ENVIRONMENT } from "../Dashboard/constants";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ MAINNET (values as before)
const MAINNET = Object.freeze({
  name: "MAINNET",
  isTestnet: false,
  restBase: "https://fapi.asterdex.com",
  wsUrl: "wss://fstream.asterdex.com/stream?streams=",
  bapiBase: "https://www.asterdex.com/bapi/futures/v1/public/future/aster",
  logoUrl: "https://www.asterdex.com/bapi/futures/v1/public/future/asset/ae/all-asset-logo",
  // Aster's native-coin placeholder in deposit lists / depositFor (same on both networks).
  nativeToken: "0xfdAE1bA7C826aBDc4c99903c8056f82a1A04a615",
  // key = the app's CHAINS key (src/utilities/TokenUtils.js) used by the existing EVM signer.
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
  // Legacy USDT-on-BSC deposit helpers in asterFunds.js.
  usdt: { chainId: 56, key: "BNB", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  // EIP-712 chain ids.
  approveSignatureChainId: 56, // registerAndApproveAgent: domain.chainId = signatureChainId (EVM)
  agentSigningChainId: 1666, // v3 requests signed by the agent / main wallet (Message{msg})
  // Withdraw (Action typed data): domain.chainId = destination chain; "aster chain" field.
  withdrawAsterChain: "Mainnet",
  withdrawChainNames: { 1: "ETH", 56: "BSC", 42161: "Arbitrum" },
  // Feature switches.
  depositSendEnabled: true,
  withdrawEnabled: true,
  alertsEnabled: true,
  zeroAddress: ZERO_ADDRESS,
});

// ------------------------------------------------------------------ TESTNET
// Sources (checked 2026-11-23):
// - REST / WS: Aster docs "aster-finance-futures-api-testnet.md" (github.com/asterdex/api-docs):
//   base https://fapi.asterdex-testnet.com, streams wss://fstream.asterdex-testnet.com/stream (live: OK).
// - bapi: www.asterdex-testnet.com/bapi/futures/v1/public/future/aster/{deposit,withdraw}/assets
//   list USDT 0x7037bf05…2bf7 (18 dec) + ASTER on chain 97, USDT on 11155111 (not on 56/421614).
// - Vault on BSC Testnet: GET www.asterdex-testnet.com/bapi/futures/v1/public/future/web3/ae/
//   deposit-address?chainId=97 -> 0x62904590b575ea1C3F4aC411EB6A5A3140d6956e (the same endpoint on
//   www.asterdex.com returns the known mainnet vault 0x1284…7974 for chainId=56). It is an ERC1967
//   proxy whose implementation has depositFor(address,address,uint256,uint256) (checked on-chain).
// - Agent-signed v3 requests: testnet docs sign Message{msg} with domain chainId 714 (mainnet docs: 1666).
// - registerAndApproveAgent: signatureChainId 56 for EVM addresses (same text in the testnet docs).
// - Withdraw Action "aster chain": Aster's testnet web app sends `Testnet` (isTestnet ? Testnet : Mainnet).
// - Logos: the testnet bapi has no asset-logo endpoint (405), so the public mainnet list is used.
const TESTNET = Object.freeze({
  name: "TESTNET",
  isTestnet: true,
  restBase: "https://fapi.asterdex-testnet.com",
  wsUrl: "wss://fstream.asterdex-testnet.com/stream?streams=",
  bapiBase: "https://www.asterdex-testnet.com/bapi/futures/v1/public/future/aster",
  logoUrl: MAINNET.logoUrl,
  nativeToken: MAINNET.nativeToken,
  chains: [
    {
      chainId: 97,
      key: "PERPS_BSC_TESTNET", // not a CHAINS key: Perps uses its own RPCs below
      name: "BNB Testnet",
      asterName: "BSC",
      native: "tBNB",
      vault: "0x62904590b575ea1C3F4aC411EB6A5A3140d6956e",
      explorer: "https://testnet.bscscan.com",
      explorerName: "BscScan Testnet",
      rpcUrls: ["https://bsc-testnet-rpc.publicnode.com", "https://data-seed-prebsc-1-s1.bnbchain.org:8545"],
    },
  ],
  defaultChainId: 97,
  usdt: { chainId: 97, key: "PERPS_BSC_TESTNET", address: "0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7", decimals: 18 },
  approveSignatureChainId: 56,
  agentSigningChainId: 714,
  withdrawAsterChain: "Testnet",
  withdrawChainNames: { 97: "BSC" },
  // Sending deposits needs a BSC-Testnet broadcaster (the app's signer broadcasts mainnet chains
  // through the backend) and withdraw needs the native Aster signer to accept testnet values
  // (it only signs chainId 1666 / "Mainnet" / chains 1, 56, 42161). Both stay off until then.
  depositSendEnabled: false,
  withdrawEnabled: false,
  alertsEnabled: false, // liquidation alerts server is mainnet-only
  zeroAddress: ZERO_ADDRESS,
});

export const PERPS_NETWORKS = { MAINNET, TESTNET };
export const perpsNetworkFor = (env) => (env === "TESTNET" ? TESTNET : MAINNET);
export const PERPS_NETWORK = perpsNetworkFor(ENVIRONMENT);

// Local storage keys: mainnet keeps its keys exactly; testnet gets its own copies so switching the
// build between networks never mixes trading keys, caches or pending deposits/withdraws.
export const perpsStoreKey = (key) => (PERPS_NETWORK.isTestnet ? `${key}_testnet` : key);
