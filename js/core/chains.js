export const ETH_MAINNET = '0x1';
export const BASE_MAINNET = '0x2105';
export const OPTIMISM = '0xa';
export const ARBITRUM = '0xa4b1';

/* OP Superchain "leaf" chains Velodrome's ve(3,3) gauges reach — see the big
   comment above VELODROME_LEAF_CHAINS below for what these are for. */
export const CELO = '0xa4ec';
export const FRAXTAL = '0xfc';
export const INK = '0xdef1';
export const LISK = '0x46f';
export const METAL_L2 = '0x6d6';
export const MODE = '0x868b';
export const SONEIUM = '0x74c';
export const SUPERSEED = '0x14d2';
export const SWELLCHAIN = '0x783';
export const UNICHAIN = '0x82';

/* Curve contracts backing curve.finance/dex/ethereum/dashboard. Mainnet only —
   veCRV locks and crvUSD fee distribution both live on Ethereum. */
export const CHAINS = {
  '0x1': 'Ethereum Mainnet',
  '0x5': 'Goerli',
  '0xaa36a7': 'Sepolia',
  '0x89': 'Polygon',
  '0xa': 'Optimism',
  '0xa4b1': 'Arbitrum One',
  '0x2105': 'Base',
  '0x38': 'BNB Chain',
  '0x7a69': 'Anvil / Hardhat',
  [CELO]: 'Celo',
  [FRAXTAL]: 'Fraxtal',
  [INK]: 'Ink',
  [LISK]: 'Lisk',
  [METAL_L2]: 'Metal L2',
  [MODE]: 'Mode',
  [SONEIUM]: 'Soneium',
  [SUPERSEED]: 'Superseed',
  [SWELLCHAIN]: 'Swellchain',
  [UNICHAIN]: 'Unichain',
};

/* ---------- logging ---------- */

/* Every RPC request AND response goes through log(), and a single portfolio refresh fires
   hundreds of them (Votemarket's epoch scan, Velodrome's 10 leaf chains, each protocol's own
   fan-out — plus retries). An earlier version wrote each line to the DOM synchronously and read
   scrollHeight/scrollTop/clientHeight first, which forces a synchronous layout PER LINE against
   a log element that grew without bound — hundreds of progressively-more-expensive forced
   reflows, saturating the main thread so clicks (accordions, the Claim menu) went unanswered
   while a refresh ran. Fixed by buffering lines and flushing once per animation frame (one
   layout read + one DOM insert per frame regardless of volume) and capping retained lines. */
export const chainName = (id) => (CHAINS[id] ? `${CHAINS[id]} (${id})` : id || '—');

export const CHAIN_PARAMS = {
  [BASE_MAINNET]: { chainId: BASE_MAINNET, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  [OPTIMISM]: { chainId: OPTIMISM, chainName: 'OP Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'] },
  [ARBITRUM]: { chainId: ARBITRUM, chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },

  /* The 10 Velodrome Superchain leaf chains. These are NOT here for convenience, unlike the three
     above — a Velodrome claim genuinely cannot run without them. switchChain() only falls back to
     wallet_addEthereumChain when CHAIN_PARAMS has an entry, so with these missing a claim touching
     Ink or Superseed dies at `switchChain` with error 4902 for any wallet that has not already
     added the chain by hand, which for most of these is every wallet. A ten-chain flow has to be
     able to introduce the chains it uses.
     `rpcUrls` deliberately reuse the FIRST endpoint of each chain's PUBLIC_RPCS list in
     rpc-waterfall.js rather than introducing new hosts: those are already load-tested here, and
     already enumerated in index.html's CSP connect-src — a new host would be silently blocked and
     would look like an endpoint failure (the trap CLAUDE.md calls out, which verify-ui asserts
     against). Native currency is ETH on every one of these except Celo, whose gas token is CELO. */
  [CELO]: { chainId: CELO, chainName: 'Celo', nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 }, rpcUrls: ['https://celo-rpc.publicnode.com'], blockExplorerUrls: ['https://celoscan.io'] },
  [FRAXTAL]: { chainId: FRAXTAL, chainName: 'Fraxtal', nativeCurrency: { name: 'Frax Ether', symbol: 'frxETH', decimals: 18 }, rpcUrls: ['https://rpc.frax.com'], blockExplorerUrls: ['https://fraxscan.com'] },
  [INK]: { chainId: INK, chainName: 'Ink', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc-qnd.inkonchain.com'], blockExplorerUrls: ['https://explorer.inkonchain.com'] },
  [LISK]: { chainId: LISK, chainName: 'Lisk', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.api.lisk.com'], blockExplorerUrls: ['https://blockscout.lisk.com'] },
  [METAL_L2]: { chainId: METAL_L2, chainName: 'Metal L2', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.metall2.com'], blockExplorerUrls: ['https://explorer.metall2.com'] },
  [MODE]: { chainId: MODE, chainName: 'Mode', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.mode.network'], blockExplorerUrls: ['https://explorer.mode.network'] },
  [SONEIUM]: { chainId: SONEIUM, chainName: 'Soneium', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://soneium-rpc.publicnode.com'], blockExplorerUrls: ['https://soneium.blockscout.com'] },
  [SUPERSEED]: { chainId: SUPERSEED, chainName: 'Superseed', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.superseed.xyz'], blockExplorerUrls: ['https://explorer.superseed.xyz'] },
  [SWELLCHAIN]: { chainId: SWELLCHAIN, chainName: 'Swellchain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.ankr.com/swell'], blockExplorerUrls: ['https://explorer.swellnetwork.io'] },
  [UNICHAIN]: { chainId: UNICHAIN, chainName: 'Unichain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://unichain-rpc.publicnode.com'], blockExplorerUrls: ['https://uniscan.xyz'] },
};

// Purely a convenience for the user's own wallet-parking/transacting purposes —
// portfolio data reads via public RPCs (see chainCall() below) and doesn't
// depend on this at all.

/* Chain ids in this file are HEX STRINGS ('0xa4ec'), because that is the form
   wallet_switchEthereumChain takes and converting at every wallet call site would be worse. The
   cost is that they are treacherous as OBJECT KEYS and in comparisons: `map[42220]` silently
   misses `map['0xa4ec']`, and it misses SILENTLY — no throw, just undefined, which then surfaces
   somewhere far away. That cost a real bug in the Velodrome claim flow (an undefined token address
   aborted the panel's step-list build partway, leaving a panel that looked correct but had no
   working Confirm button).

   So: never index a chain-keyed map with a raw literal, and never compare chain ids with ===.
   Use these two. chainNum() accepts hex ('0xa4ec'), decimal string ('42220') and number alike —
   Number() handles the 0x prefix natively, which parseInt(x, 16) would get wrong for decimals. */
export function chainNum(id) {
  return typeof id === 'number' ? id : Number(id);
}

export function sameChain(a, b) {
  return chainNum(a) === chainNum(b);
}

// Builds a Map from [chainId, value] pairs with every key normalised, so lookups through it
// cannot depend on which spelling the caller happened to have. Pair with chainNum() on read.
export function chainKeyedMap(entries) {
  return new Map(entries.map(([id, value]) => [chainNum(id), value]));
}
