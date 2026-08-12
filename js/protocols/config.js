import { ARBITRUM, BASE_MAINNET, CELO, FRAXTAL, INK, LISK, METAL_L2, MODE, OPTIMISM, SONEIUM, SUPERSEED, SWELLCHAIN, UNICHAIN, chainKeyedMap, chainNum } from '../core/chains.js';
import { fetchClever } from './clever.js';
import { ICONS } from './icon-data.js';
import { fetchConcentrator } from './concentrator.js';
import { fetchVeDex } from './vedex.js';
import { fetchVelodrome } from './velodrome.js';
import { fetchYieldBasis } from './yieldbasis.js';

export const CURVE = {
  // VotingEscrow — locked(address) -> (int128 amount, uint256 end)
  votingEscrow: '0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2',
  LOCKED: '0xcbf9fe5f',
  // FeeDistributor (pays crvUSD) — claim(address) -> uint256.
  // State-changing, but eth_call simulates it to read the pending amount.
  feeDistributor: '0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914',
  CLAIM: '0x1e83409a',
  crvUsd: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E',
};

// "Cash" — stablecoins actually sitting spendable in the connected wallet, across every chain
// this app knows how to read, as distinct from everything else this app tracks (claimable, not
// yet in hand). One row per SYMBOL (crvUSD, USDC, ...), each a sub-accordion over every chain
// that symbol was found on — a user holding USDC on both mainnet and Base sees one "USDC" row,
// not two separate ones, since it's the same asset with the same peg either side, just sitting
// in different places. Every (symbol, chain, address) entry below was independently verified
// live (an eth_call symbol()/decimals() against that chain's own public RPC, matching the
// expected symbol) before being hardcoded here, same bar every other contract address in this
// file is held to.
//   - crvUSD (mainnet only): this file's own existing constant (CURVE.crvUsd) — what this app's
//     own Aerodrome claim flow actually delivers, so it's the one thing here guaranteed to be
//     relevant to every user of this app. Kept first/`hero` for that reason.
//   - scrvUSD (mainnet only): Curve's Savings crvUSD — an ERC4626 vault wrapping crvUSD (verified
//     live: scrvUSD.asset() returns crvUSD's own address exactly). priceTokensUsd() already knows
//     how to price a standard ERC4626 vault share (asset() + convertToAssets(), see its own
//     comment) against its underlying, so this needs no special-casing — listing it is enough for
//     it to price correctly as "however much crvUSD these shares are worth right now".
//   - USDC (mainnet + Base/Optimism/Arbitrum): the one stablecoin that's both native (not
//     bridged) and liquid on every chain this app already tracks positions on — genuinely the
//     same asset in four places, which is exactly the case this per-symbol/per-chain structure
//     is for. Base's address was already verified elsewhere in this file (see
//     AERODROME_CLAIM.usdc's own comment) and matches exactly; Optimism/Arbitrum verified fresh.
//   - USDT / DAI (mainnet only): the next-most-held stablecoins on Ethereum mainnet by a wide
//     margin. Not an exhaustive list of every stablecoin or every chain; extend it here (address,
//     decimals, verified live first) as more become worth covering.
export const VOTEMARKET = {
  chainId: ARBITRUM,
  priceChain: 'arbitrum',
  // Two independent "platform" contracts both route Curve gauge bribes — same ABI,
  // same Oracle, different campaign pools (confirmed live: 141 + 1846 campaigns).
  platforms: [
    '0x5e5C922a5Eeab508486eB906ebE7bDFFB05D81e5',
    '0x8c2c5A295450DDFf4CB360cA73FCCC12243D14D9',
  ],
  oracle: '0x36F5B50D70df3D3E1c7E1BAf06c32119408Ef7D8',
  // event CampaignCreated(uint256 campaignId, address gauge, address manager,
  //   address rewardToken, uint8 numberOfPeriods, uint256 maxRewardPerVote,
  //   uint256 totalRewardAmount) — no indexed fields, so everything (including
  //   gauge/manager/rewardToken) sits in the log's `data`, not `topics`.
  CAMPAIGN_CREATED: '0x0e291713fc4cb1bcf9276bc9ae54317736576d5353a44151e2e31c191b1ee62a',
  CURRENT_EPOCH: '0x76671808', // currentEpoch() -> uint256
  GET_PERIOD: '0x52aed578', // getPeriodPerCampaign(uint256,uint256) -> Period
  FEE: '0xddca3f43', // fee() -> uint256 (platform-wide default, 1e18 = 100%)
  CUSTOM_FEE: '0x03f17e56', // customFeeByManager(address) -> uint256
  TOTAL_CLAIMED: '0x66629f12', // totalClaimedByAccount(uint256,uint256,address) -> uint256
  VOTED_SLOPE: '0xbef3ba99', // Oracle.votedSlopeByEpoch(address,address,uint256) -> VotedSlope
};
// Curve's own GaugeController on Ethereum mainnet — supplements (does NOT
// replace) Arbitrum's Oracle relay above. See the big comment above the
// eligibility loop in fetchVotemarket() for why BOTH sources are needed and
// why the GaugeController one is only consulted as a per-epoch fallback, not
// applied unconditionally (that was tried and reverted — combinatorial blowup,
// see that comment).
export const GAUGE_CONTROLLER = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB';
export const VOTE_USER_SLOPES = '0x0f467f98'; // vote_user_slopes(address,address) -> (slope,power,end)
export const LAST_USER_VOTE = '0x7e418fa0'; // last_user_vote(address,address) -> uint256
export const WEEK = 7n * 24n * 60n * 60n; // Votemarket.EPOCH_LENGTH, confirmed live (consecutive currentEpoch() reads differ by exactly this)
// Was 24 (assumed == Votemarket.sol's CLAIM_WINDOW_LENGTH), which turned out to
// be wrong and hid real money: live testing against account
// the test account (found via a user report — the
// official Votemarket UI showed $7,043.72 claimable, this app showed $0) found
// this account's ONLY relayed vote proof sitting at epoch -25, one past the old
// cutoff, and confirmed still eligible/unclaimed there. Bumped to 52 (a full
// year of weekly epochs) as a safer bound — still finite, and Votemarket
// campaigns are practically never funded for anywhere near that long, so this
// is very unlikely to itself become the new cutoff that hides money. See the
// emptyStreak comment in fetchVotemarket() below for the other half of this
// fix (the early-stop heuristic that was ALSO short-circuiting past this
// account's real vote before the loop even reached epoch -25).
export const MAX_EPOCHS_BACK = 52;

// Many Votemarket bribes are paid out as LaPoste-bridged wrapped reward tokens
// (symbol prefixed "p...", e.g. pUSDC, pASF — LaPoste's Token.sol literally
// prepends "p"/"LaPoste " to the wrapped name/symbol) rather than the reward
// token's real mainnet address. These have no DefiLlama listing of their own
// on Arbitrum, so priceTokensUsd() used to silently price them at null and the
// claim badge showed $0.00 despite real, substantial value (found live:
// $7,043.72 unclaimed for 0xf147b8125D2eF93Fb6965Db97D6746952a133934, entirely
// wiped out by this). LaPoste's TokenFactory (same deployed address on every
// supported chain, confirmed via stake-dao/laposte's README) keeps a public
// wrapped->native mapping; resolving through it and pricing the real mainnet
// token instead is what fetchVotemarket() below does. Verified live: calling
// nativeTokens(0x20e31285...fab02) ["pASF"] on this contract via Arbitrum
// returns 0x59a52907...cf8aa, and nativeTokens(0xc8a096b7...ced844) ["pUSDC"]
// returns 0xa0b86991...06eb48 — the real mainnet USDC address, byte-for-byte.
export const LAPOSTE_TOKEN_FACTORY = '0x96006425Da428E45c282008b00004a00002B345e';
export const LAPOSTE_NATIVE_TOKEN_OF = '0xc86726f6'; // TokenFactory.nativeTokens(address) -> address

/* Multicall3 (github.com/mds1/multicall) — deployed via a deterministic CREATE2
   factory at the SAME address on effectively every EVM chain, including Arbitrum.
   Not assumed: confirmed live via eth_getCode returning real bytecode at this
   address on Arbitrum specifically, and an aggregate3() round-trip against
   getBlockNumber()/getEthBalance() decoded correctly before this was relied on
   for anything real. Used to collapse Votemarket's gauge/epoch fan-out (see the
   big VOTEMARKET comment above and MULTICALL_CHUNK_SIZE below) from thousands of
   individual eth_call HTTP round-trips into a small number of batched ones — see
   multicall() near chainCall()/chainGetLogs() for the batching helper. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const AGGREGATE3_SELECTOR = '82ad56cb'; // aggregate3((address,bool,bytes)[]) -> (bool,bytes)[]
// Calls per aggregate3 batch. Verified live on Arbitrum up to 2000 votedSlopeByEpoch-
// sized calls in a single eth_call (550ms, well under any timeout) with no gas-cap or
// response-size error — 500 leaves generous headroom while still collapsing any
// realistic Votemarket fan-out (≤260 gauges, or a few hundred claim-job pairs) into
// a single request per chunk.
export const MULTICALL_CHUNK_SIZE = 500;

/* Aerodrome (Base) and Velodrome (Optimism) are the same ve(3,3) codebase — Aerodrome
   is Velodrome's fork onto Base — so both are read through the same "Sugar" lens
   contracts (github.com/velodrome-finance/sugar), the read-only aggregators their
   own dashboards are built on. Unlike Curve's single-token FeeDistributor, a veNFT
   here accrues fees + bribes independently per pool it voted for, in whatever token
   each pool pays out — so "claimable" is a basket, not one number:
     - VeSugar.byAccount(address) -> every veNFT the account owns, each with its
       locked amount, expiry, and the pools it voted for.
     - RewardsSugar.rewardsByAddress(tokenId, pool) -> the fee/bribe tokens and
       amounts currently claimable by that veNFT from that pool.
   This avoids fanning out over every pool on the exchange — only the pools actually
   voted for are queried. */
export const BY_ACCOUNT = '0x47f7e06f'; // byAccount(address) -> VeNFT[]
export const REWARDS_BY_ADDRESS = '0xcd824fb4'; // rewardsByAddress(uint256,address) -> Reward[]

/* RewardsSugar.rewards(_limit, _offset, _venft_id) -> DynArray[Reward, lp_shared.MAX_POOLS] — the
   full-pool-enumeration sibling of rewardsByAddress() above. Selector computed against
   RewardsSugar.vy fetched fresh from github.com/velodrome-finance/sugar and confirmed byte-for-byte
   with ethers.js's Interface.getSighash() in a scratchpad (0xa9c57fee), then confirmed live: it's
   what actually surfaced this file's Celo/Ink findings below (see the fetchVeDex/
   fetchVelodromeLeafClaims comments). Internally it walks lp_shared._pools() (every pool registered
   across every non-root-placeholder PoolFactory the chain's FactoryRegistry knows about — the exact
   same enumeration LpSugar.all()/.count() use) and calls Fee.earned(token, _venft_id) /
   Bribe.earned(token, _venft_id) on each, entirely independent of Voter's current-epoch vote
   registry — this is what makes it able to find rewards for pools a veNFT USED to vote for and no
   longer does, unlike rewardsByAddress()'s vote-filtered fan-out. `lp_shared.MAX_POOLS` (the
   DynArray's own capacity, confirmed live by reading lp_shared.vy) is 2000 — this bounds how many
   pools ONE call can enumerate before the pools its own internal loop reads are truncated, not how
   many Reward line-items can be returned (which is separately capped at the same 2000, but in
   practice only a handful of pools ever have anything to report). LpSugar.count() -> uint256 (also
   confirmed live, github.com/velodrome-finance/sugar's LpSugar.vy `count()`) reports the live total
   pool count per chain, used below to size pagination. */
export const POOL_REWARDS = '0xa9c57fee'; // rewards(uint256,uint256,uint256) -> Reward[]
export const POOL_COUNT = '0x06661abd'; // LpSugar.count() -> uint256

export const AERODROME = {
  chainId: BASE_MAINNET,
  priceChain: 'base',
  token: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
  veSugar: '0x4d6A741cEE6A8cC5632B2d948C050303F6246D24',
  rewardsSugar: '0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678',
  // Used to read a live pool count (LpSugar.count()) so fetchVeDex/buildAerodromeClaimPlan can
  // paginate the full-pool historical scan — see FULL_SCAN_MAX_POOLS below. Base's count (34,707
  // pools, confirmed live) is far over that generic cap, but Aerodrome is explicitly exempted
  // from it (paginating efficiently enough at ~232 parallel pages) — the scan DOES run for
  // Aerodrome, unlike most chains over the cap.
  lpSugar: '0x69dD9db6d8f8E7d83887A704f447b1a584b599A1',
};

/* "Claim to mainnet" for Aerodrome: claim (Base) -> consolidate to USDC via Aerodrome's own
   DEX (Base) -> bridge + swap to crvUSD on arrival via Across (Base -> Ethereum mainnet), all
   real wallet-signed transactions, no funds ever custodied by this app. Every address below was
   cross-checked against at least two independent sources (the protocol's own GitHub deployments
   list/README AND a live on-chain read, e.g. a Sugar/Voter contract's own getter for a related
   address) before being hardcoded, same standard as every other contract this file talks to.

   CLAIM — Voter.claimFees(address[] fees, address[][] tokens, tokenId) / claimBribes(...) each
   batch across every pool's Fee/Bribe contract for one veNFT in a single transaction. Confirmed
   live: AERODROME.veSugar's own voter() getter (selector 0x46c96aac) returns this exact address,
   matching aerodrome-finance/contracts' README deployment table byte-for-byte. Reward token +
   Fee/Bribe contract addresses per pool come from RewardsSugar's own Reward struct (see
   decodeRewardArray) — no separate lookup needed.

   CONSOLIDATE — Aerodrome's Router batches multi-hop swaps; PoolFactory (legacy stable/volatile
   AMM) and the three historical Slipstream (concentrated-liquidity) PoolFactory deployments are
   all checked for a DIRECT pool to USDC per claimed token (single-hop only — see the session
   note on why full pathfinding was deliberately out of scope). All four addresses + Router come
   from aerodrome-finance/contracts and aerodrome-finance/slipstream's own README deployment
   tables on GitHub.

   BRIDGE + FINAL SWAP — Across Protocol's SpokePool.depositV3Now() bridges the consolidated USDC
   from Base to Across's MulticallHandler contract on Ethereum mainnet (same address on both
   chains, confirmed live via each chain's eth_getCode returning real bytecode), carrying a
   `message` that has the Handler approve + swap through Curve's own crvUSD/USDC pool
   (0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E, $15M+ TVL, confirmed via Curve's own
   api.curve.finance pool listing) and then self-call drainLeftoverTokens() to sweep the
   resulting crvUSD to the user. This exact "approve, swap, drainLeftoverTokens" pattern isn't
   guessed — it's the same one found live inside a real transaction Across's own official
   /api/swap/approval endpoint generated (0xef8738d3 appearing 3 times in that transaction's
   calldata, once per drain). If the Handler's calls fail for any reason (e.g. Curve pool slippage
   exceeds the min_dy guard), Across's own contract automatically routes the bridged USDC to
   `fallbackRecipient` (set to the user's own address) instead — worst case the user receives
   USDC on mainnet rather than crvUSD, never a stuck or lost transaction. Approve/swap amounts are
   the exact `outputAmount` WE specify to depositV3Now (Across guarantees exact delivery of that
   amount to the recipient, not an estimate), so no on-chain balance-based amount injection is
   needed for that leg — only the final crvUSD sweep needs "whatever the swap produced", which
   drainLeftoverTokens already handles by reading the Handler's own live balance, no calldata
   surgery required. */
export const AERODROME_CLAIM = {
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  poolFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // legacy stable/volatile AMM
  // Slipstream (concentrated-liquidity) PoolFactory has been redeployed twice as the protocol
  // added features (see aerodrome-finance/slipstream's README "Deployments" section) — existing
  // pools under the older factories are still live/liquid, so all three are checked for a direct
  // USDC pool, not just the current one.
  // Each Slipstream (concentrated-liquidity) deployment's factory + its OWN paired SwapRouter —
  // confirmed live against SwapRouter.sol's source that a router is constructed with exactly one
  // immutable `factory` and computes pool addresses via CREATE2 off of it (PoolAddress.
  // computeAddress(factory, ...)), so a pool from an OLDER factory is only swappable through
  // THAT factory's own router, never the current one. Existing pools under the older factories
  // are still live/liquid (aerodrome-finance/slipstream's README: "Existing gauges are still in
  // use"), so all three are checked for a direct USDC pool, not just the current one.
  // `quoter` addresses (QuoterV2/Quoter per deployment) are only used for a live pre-swap
  // amountOut estimate — confirmed against the CURRENT deployment's ISwapRouter/IQuoter
  // interface source (quoteExactInputSingle's struct shape), applied to all three
  // deployments on the assumption their Quoter interface shape didn't change across
  // versions (aerodrome-finance/slipstream's own README doesn't call out a Quoter
  // interface change between deployments, unlike the documented SwapRouter/Router
  // changes) — a wrong quote here would only produce an inaccurate PREVIEW number, never
  // an unsafe swap, since the actual min-out guard sent on-chain is still derived from
  // whatever this returns with slippage applied.
  clDeployments: [
    { factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', router: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5', quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0' }, // Initial
    { factory: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a', router: '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D', quoter: '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C' }, // Gauge Caps
    { factory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef', router: '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F', quoter: '0x514c8B5f54112481E28028F1166Bd78501089259' }, // Gauges V3 (current)
  ],
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // native Base USDC, confirmed via symbol()/decimals()
};

export const ACROSS = {
  // SpokePool addresses differ per chain (not a CREATE2-deterministic shared address, unlike
  // MulticallHandler below) — from across-protocol/contracts' deployments/<chain>/*_SpokePool.json.
  baseSpokePool: '0x6C99671B249af73B2847D92123d823Cb3875E399',
  /* Optimism's SpokePool — Velodrome's mainnet leg departs from there, not Base. A DIFFERENT
     address, which is the whole reason buildAcrossBridgeTxs() takes an `origin` rather than just a
     chain id: reusing Base's here would approve and deposit into a contract that is not the
     SpokePool on Optimism. Taken from Across's own suggested-fees response for an Optimism origin
     (2026-08-12), which is the authoritative source, and confirmed to hold bytecode on Optimism.
     The same probe quoted the OP → mainnet USDC route at a 0.012% fee on $1,000, which is what
     confirmed that leg exists at all — TASKS.md had it listed as unverified. */
  optimismSpokePool: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  // Same address on every chain (CREATE2), confirmed live via eth_getCode on both Base and
  // mainnet. This is the contract that receives the bridged USDC and executes our compose calls.
  multicallHandler: '0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E',
  mainnetUsdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

// Curve's own crvUSD/USDC plain pool on Ethereum mainnet — the destination-chain swap target for
// the Across compose message above. Same `exchange(int128,int128,uint256,uint256)` interface as
// every other Curve StableSwap pool this app already reads from (CURVE.feeDistributor etc.);
// coin order confirmed live (coins[0] = USDC, coins[1] = crvUSD) via api.curve.finance.
export const CURVE_CRVUSD_USDC_POOL = '0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E';

export const VELODROME = {
  chainId: OPTIMISM,
  priceChain: 'optimism',
  token: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', // VELO
  veSugar: '0xFE0a44d356a9F52c9F1bE0ba0f0877d986438c9C',
  rewardsSugar: '0x62CCFB2496f49A80B0184AD720379B529E9152fB',
  lpSugar: '0x347512180804A8B40AA7525AE932a31198F074aA', // Optimism's pool count (1,525 live) fits the full-scan cap
};

/* Velodrome's ve(3,3) system doesn't stop at Optimism — the same codebase (and the
   same VELO-backed veNFT/voting power) reaches 10 more "leaf" chains across the OP
   Superchain (celo, fraxtal, ink, lisk, metall2, mode, soneium, superseed, swell,
   unichain — github.com/velodrome-finance/sugar's deployments/ dir has an .env per
   chain). Only Optimism and Base define a VE_SUGAR_ADDRESS (a VotingEscrow) — Base
   is Aerodrome's own separate root, out of scope here — the 10 leaf chains only have
   LP_SUGAR_ADDRESS + REWARDS_SUGAR_ADDRESS, no voting-escrow contract of their own.
   A veNFT is always locked on Optimism (or Base, for Aerodrome).

   An earlier version of this file resolved leaf-chain claims by reading VeSugar.byAccount()'s
   CURRENT `votes: LpVotes[]` list, matching each voted "root placeholder" address (a stand-in pool
   registered on Optimism's Voter purely for cross-chain vote accounting — see LpSugar.vy's
   `Lp.root` field) against a map built from LpSugar.all() on each leaf chain, and only then reading
   that leaf chain's real pool. That had a real bug, found and confirmed live against account
   the test account's Velodrome veNFT (a permanent lock):
   VeSugar's `votes` field is Voter's CURRENT-epoch registry, so a veNFT that voted for a leaf pool
   in a past epoch and has since moved its vote elsewhere was invisible to that resolution entirely,
   even though the old pool's Fee/Bribe contracts still hold real, unclaimed rewards for it (fees and
   bribes don't get swept away just because the vote moved). Exactly this: that veNFT has a real
   322.427939 USDT + 0.106560951702218224 WETH fee claim sitting in a Celo USDT/WETH pool
   (0xa6a14e6767c07ffba3786ac0054a8647cfdca58d, Fee contract
   0xb837edcf60c1cb6df49111df7fd28611b3321345) it no longer votes for — confirmed independent of this
   app's own code via a direct `Fee.earned(token, 151)` eth_call on both reward tokens, byte-for-byte
   matching what RewardsSugar.rewards() returns (see fetchVelodromeLeafClaims below). Also found real
   unclaimed rewards on several Ink pools the same veNFT isn't currently voting for either — this is a
   real, broader gap, not a one-off tied to the one pool the user happened to notice on the official
   dashboard.

   Fixed by dropping the root-placeholder resolution entirely: each leaf chain's own pool count is
   small (confirmed live via LpSugar.count(): celo 28, fraxtal 71, ink 212, lisk 81, metall2 18, mode
   161, soneium 136, superseed 29, swell 52, unichain 31 — 819 total, every one comfortably inside a
   single RewardsSugar.rewards() page), so fetchVelodromeLeafClaims now just calls
   RewardsSugar.rewards(limit, 0, venft_id) directly on each leaf chain for each veNFT the account
   owns — Fee/Bribe .earned() there is keyed by venft_id regardless of current vote status, so this
   finds current AND historical claims in one shot, with no LpSugar/root-placeholder map needed at
   all. See fetchPoolRewardsFullScan()/fetchVelodromeLeafClaims() below for the implementation, and
   the FULL_SCAN_MAX_POOLS comment above fetchVeDex for why this same technique is only safe to apply
   unconditionally on these small leaf chains and Velodrome's own Optimism root, not Aerodrome's
   34,707-pool Base root. */

/* Velodrome claim-to-mainnet venue. Every address below was verified live on 2026-08-11 by
   eth_getCode (and, where noted, by calling the contract), not taken on trust from a docs page.

   THE SHAPE IS NOT AERODROME'S, and the difference is the whole design. Aerodrome claims and
   consolidates on ONE chain (Base) and bridges once. Velodrome's rewards are spread over 10 leaf
   chains, so each leaf runs its own stage and they converge on Optimism (the "root"):

     claim on leaf -> swap rewards to VELO on leaf -> sendToken() XVELO to Optimism
       -> swap VELO to USDC on Optimism -> (optional) bridge USDC to Ethereum mainnet

   WHY VELO IS THE BRIDGE ASSET, not USDC. The obvious design — swap to USDC on the leaf, then
   bridge USDC — is what Aerodrome does and is wrong here. Only 6 of the 10 leaves have any USDC
   bridge route at all (Celo, Ink, Lisk, Mode, Soneium, Unichain; Fraxtal, Metal L2, Superseed and
   Swellchain have none from any aggregator, and CCTP covers only Ink/Unichain — see TASKS.md for
   the measured rail table). VELO has no such gap: it is the emission token, so it has the deepest
   pool on every leaf by construction, and Velodrome bridges it natively on all 10 via its own
   TokenBridge. Routing through VELO therefore covers 10/10 chains using only Velodrome's own
   infrastructure, with no third-party bridge dependency anywhere in the path.

   LEAF ADDRESSES ARE THE SAME ON ALL TEN CHAINS — a deterministic deploy, taken from Velodrome's
   own deployment-addresses/*.json (velodrome-finance/superchain-contracts) and confirmed to have
   bytecode on every leaf. So a leaf is described by { chainId, usdc }, NOT by its own address set
   the way AERODROME_CLAIM needs for Base. Adding a leaf chain is one verified USDC address. */
export const VELODROME_CLAIM = {
  // Shared by all 10 leaf chains. leafXVelo answers symbol() = "XVELO", decimals() = 18 with live
  // nonzero totalSupply() on every one of them (Ink 8.6M down to Superseed 421k) — a real
  // deployment carrying real balances, which is why the four otherwise-unroutable chains are
  // reachable at all.
  leaf: {
    router: '0x3a63171DD9BebF4D07BC782FECC7eb0b890C2A45',
    poolFactory: '0x31832f2a97Fd20664D76Cc421207669b55CE4BC0',
    voter: '0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123',
    tokenBridge: '0x1A9d17828897d6289C6dff9DC9F5cc3bAEa17814',
    xVelo: '0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81',
  },
  // Optimism root — where every leaf's XVELO lands and is consolidated. router.defaultFactory()
  // was called live and returns exactly `poolFactory` below, so the two are a matched pair rather
  // than two separately-sourced addresses that merely look right. A real VELO/USDC volatile pool
  // exists at 0xa0a215de234276cac1b844fd58901351a50fec8a (PoolFactory.getPool(VELO, USDC, false)),
  // so the final consolidation leg has a confirmed venue, not an assumed one.
  root: {
    chainId: OPTIMISM,
    router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
    poolFactory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
    voter: '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    velo: VELODROME.token,
  },
  // Per-leaf USDC, each confirmed on-chain at decimals() == 6. Only the six chains that have one;
  // the other four route via VELO alone, which is precisely why VELO is the bridge asset. Present
  // so the routing layer can COMPARE swapping to USDC on the leaf against bridging VELO, per the
  // "compare, not just detect" rule — not so it can assume leaf USDC is always the better path.
  // NOT a plain object, deliberately — see velodromeLeafUsdc() below.
  // LeafTokenBridge.sendToken(address _recipient, uint256 _amount, uint256 _chainid) — payable,
  // selector confirmed against the verified signature. The msg.value is a Hyperlane interchain
  // gas payment, NOT part of the transfer; BaseTokenBridge._generateGasMetadata() sets
  // _refundAddress: msg.sender with a 200,000 GAS_LIMIT default, so overpaying is refunded to the
  // sender rather than lost. That refund behaviour is what makes this leg safe to over-fund
  // slightly instead of needing an exact Mailbox.quoteDispatch() to the wei.
  SEND_TOKEN: '0x587faab6',
  /* Reading the bridge's gas limit and its Mailbox, rather than hardcoding either.
     A previous revision of this file recorded the gas limit as a hardcoded 200000n, described as
     "a 200,000 GAS_LIMIT default". Read live on Ink 2026-08-12, `GAS_LIMIT()` returns **190,000**.
     It is a getter on a deployment that can change it, and it is on a chain the claim is already
     talking to, so reading it costs nothing and cannot go stale — whereas the wrong hardcoded value
     would have over-quoted the Hyperlane fee by 5%, which is harmless, but the same
     assume-don't-read habit is what put the wrong number here in the first place. */
  BRIDGE_GAS_LIMIT_GETTER: '0x091d2788', // TokenBridge.GAS_LIMIT() -> uint256
  MAILBOX: '0xd5438eae', // TokenBridge.mailbox() -> address (Hyperlane Mailbox)
  /* Mailbox.quoteDispatch(uint32 destinationDomain, bytes32 recipient, bytes body, bytes metadata,
     address hook) — the FIVE-argument overload, and using the three-argument one instead is a real
     trap that costs a failed transaction. See quoteLeafBridgeFee()'s comment in velodrome/txs.js
     for the measured numbers: the short form quotes DEFAULT destination gas and under-funds the
     real dispatch by ~62%. */
  QUOTE_DISPATCH: '0x81d2ea95',
  /* Leaf Router.getAmountsOut(uint256, Route[]) where **Route is {from, to, stable} — THREE
     fields, no `factory`**. That matters: Velodrome V2 on Optimism and Aerodrome on Base both use
     a FOUR-field Route including the factory, which is a different signature and therefore a
     different selector (0x5509a1ac). Calling the four-field one against a leaf router reverts with
     a bare "execution reverted" and no hint — confirmed live on Ink before this was corrected.
     Verified working: 1 WETH -> 938.559 XVELO through the volatile pool on Ink. */
  LEAF_GET_AMOUNTS_OUT: '0x9881fcb4',
  /* Optimism ROOT router uses the FOUR-field Route {from, to, stable, factory} — Velodrome V2's
     own shape, and a different selector from the leaf one above. Both are needed in this one flow
     precisely because a Velodrome claim spans both codebases. Verified live: 1000 VELO -> 17.06
     USDC through the volatile pool (the stable pool quotes 0.24, i.e. effectively no route), so
     the same stable-vs-volatile comparison the leaf quote makes is required here too. */
  ROOT_GET_AMOUNTS_OUT: '0x5509a1ac',

  /* ---- the write side: every selector a Velodrome claim actually SENDS ----
     All derived with `node tools/selector.mjs` (which reproduces 30 known-good selectors from this
     file before it will answer — see its header for why that gate is the point) and then each one
     confirmed PRESENT in the live dispatch table of the exact deployed contract it will be sent
     to, via eth_getCode on Ink and Optimism, 2026-08-12. Bytecode presence, not a docs page.

     THE SHAPE OF THIS FLOW, now that the write side is pinned down: the LEAF half is genuinely
     new, and the ROOT half is Aerodrome's, byte-for-byte. Optimism's root Voter answers the same
     claimFees/claimBribes selectors as Base's Aerodrome Voter, and the root Router answers the
     same swap selector (0xcac88ea9, already hardcoded in aerodrome/routing.js). So the Optimism
     leg is reuse of existing builders with a different address set, and only the four leaf
     builders are new work. That is a much smaller job than "a second claim flow", and it is
     evidence FOR the generalisation TASKS.md asks for rather than an assumption about it. */

  /* Leaf fees/bribes claim. NOT Aerodrome's shape, in both directions — different contract AND
     different signature. Aerodrome claims through the Voter
     (claimFees(address[],address[][],uint256)); a leaf veNFT claims from each Reward contract
     directly, and takes an explicit recipient. Proven live on Ink: this selector is present in
     both the FeesVotingReward (0xd18ec4…, 5435 bytes) and the IncentiveVotingReward (0xbca91e…,
     5501 bytes) of a real gauged pool, while claimFees/claimBribes are absent from both AND from
     LeafVoter. LeafVoter carries only claimRewards(address[]) (0xf9f031df), which is gauge
     emissions, not veNFT fees — do not mistake it for this. */
  LEAF_GET_REWARD: '0xa44d113f', // Reward.getReward(address _recipient, uint256 _tokenId, address[] _tokens)
  /* Leaf swap, THREE-field Route — the write-side twin of LEAF_GET_AMOUNTS_OUT above, and it
     carries the same trap: the four-field version (0xcac88ea9) is a different selector and
     reverts bare against a leaf router. Present in Ink's LeafRouter (10934 bytes). */
  LEAF_SWAP: '0xf41766d8', // swapExactTokensForTokens(uint256,uint256,(address,address,bool)[],address,uint256)
  /* Root swap, FOUR-field Route. Present in Optimism's root Router (24479 bytes) — and identical
     to the selector aerodrome/routing.js already sends on Base. */
  ROOT_SWAP: '0xcac88ea9',
  /* Root fees/bribes claim — Velodrome V2's Voter, Aerodrome's exact selectors. Both present in
     Optimism's root Voter (17087 bytes). This is why the root claim step can reuse Aerodrome's
     existing batch builder instead of needing its own. */
  ROOT_CLAIM_FEES: '0x666256aa', // claimFees(address[],address[][],uint256)
  ROOT_CLAIM_BRIBES: '0x7715ee75', // claimBribes(address[],address[][],uint256)
  /* Finding a leaf's per-gauge Reward contracts. Note the NAMING difference from Aerodrome: the
     leaf voter has gaugeToIncentive, NOT gaugeToBribe — 0x929c8dcd is absent from its bytecode and
     reverts when called, while these two answer with real addresses. "Incentive" is the Superchain
     codebase's word for what Base calls a bribe. Only needed if the existing leaf scan does not
     already carry the Fee/Incentive addresses per pool (it should — see TASKS.md). */
  LEAF_GAUGE_TO_FEES: '0xc4f08165', // LeafVoter.gaugeToFees(address) -> address
  LEAF_GAUGE_TO_INCENTIVE: '0x3231cfee', // LeafVoter.gaugeToIncentive(address) -> address

  // PoolFactory.getPool(address,address,bool) — used to check a pool exists before quoting it.
  GET_POOL: '0x79bc57d5',
};

export const VELODROME_LEAF_CHAINS = [
  { chainId: CELO, name: 'Celo', priceChain: 'celo', rewardsSugar: '0x03D74f82AdcD10242864B1560c5e2467C2bC2Cc2' },
  { chainId: FRAXTAL, name: 'Fraxtal', priceChain: 'fraxtal', rewardsSugar: '0x03010FCe5BECD2a8B52F0C01A02E5EcaC1168845' },
  { chainId: INK, name: 'Ink', priceChain: 'ink', rewardsSugar: '0x9972174fcE4bdDFFff14bf2e18A287FDfE62c45E' },
  { chainId: LISK, name: 'Lisk', priceChain: 'lisk', rewardsSugar: '0x066D31221152f1f483DA474d1Ce47a4F50433e22' },
  { chainId: METAL_L2, name: 'Metal L2', priceChain: 'metall2', rewardsSugar: '0x2F44BD0Aff1826aec123cE3eA9Ce44445b64BB34' },
  { chainId: MODE, name: 'Mode', priceChain: 'mode', rewardsSugar: '0xc0373b68246A65ff8a3ae138dDc179020c905f76' },
  { chainId: SONEIUM, name: 'Soneium', priceChain: 'soneium', rewardsSugar: '0x14b61ef12138c60AC8AB7B86556D6698E58Ec42D' },
  { chainId: SUPERSEED, name: 'Superseed', priceChain: 'sseed', rewardsSugar: '0x9972174fcE4bdDFFff14bf2e18A287FDfE62c45E' },
  { chainId: SWELLCHAIN, name: 'Swellchain', priceChain: 'swellchain', rewardsSugar: '0xCA10F2EEfcCC3cDAEd50113227132037718947Da' },
  { chainId: UNICHAIN, name: 'Unichain', priceChain: 'unichain', rewardsSugar: '0x215cEad02e0b9E0E494DD179585C18a772048a43' },
];

/* Yield Basis (yieldbasis.com/lock) — veYB locking + FeeDistributor claim, Ethereum
   mainnet only. Built by Curve's founder and reuses Curve's DAO contract lineage:
   VotingEscrow.locked(address) has the exact same signature (and selector,
   0xcbf9fe5f) as Curve's veCRV, confirmed against the contract's verified source
   (Sourcify full-match) rather than assumed. FeeDistributor is a multi-token
   evolution of Curve's single-token FeeDistributor — preview_claim() returns a
   (address[] tokens, uint256[] amounts) pair rather than one uint256, also
   confirmed against verified source, not guessed. Only the lock/claim side is
   covered here — Yield Basis's separate LP deposit/vault position is out of scope.
   Reward tokens are intentionally NOT hardcoded here: the live FeeDistributor's
   current on-chain token_set (BTC/ETH market receipt tokens like yb-WBTC,
   yb-cbBTC, yb-tBTC, yb-WETH) has already rotated past the addresses published on
   Yield Basis's own docs page as of 2026-08-08, and a single claim can span
   multiple historical token generations at once — so, exactly like Aerodrome and
   Velodrome's reward baskets, tokens are read from preview_claim()'s own return. */
export const YIELD_BASIS = {
  votingEscrow: '0x8235c179E9e84688FBd8B12295EfC26834dAC211',
  LOCKED: '0xcbf9fe5f', // locked(address) -> (int256 amount, uint256 end)
  feeDistributor: '0xD11b416573EbC59b6B2387DA0D2c0D1b3b1F7A90',
  // preview_claim(address,uint256,bool) -> (address[] tokens, uint256[] amounts).
  // Vyper source's own natspec: "This method MUST be renamed to view in ABI
  // (despite compiler making it transacting) - otherwise it is useless" — i.e. it's
  // explicitly meant to be read via eth_call simulation, same as Curve's CLAIM.
  PREVIEW_CLAIM: '0xc190808b',
};

/* Clever (clever.aladdin.club/locker) — veCLEV locking, Ethereum mainnet only.
   veCLEV is a near-verbatim fork of Curve's VotingEscrow.vy — confirmed exact-match
   verified on Sourcify (chain 1, matchId 5925727) rather than assumed from the
   selector alone — so locked(address) -> (int128 amount, uint256 end) is the exact
   same signature/selector (0xcbf9fe5f) as Curve's veCRV and Yield Basis's veYB,
   confirmed to decode unchanged against live data (test address
   0x84afb4B60844F8759154d6Ff7B0580Daa2D4e37d: 25920.00233479083 CLEV locked,
   end 1909353600 = 2030-07-04).
   Unlike Curve/Yield Basis's single FeeDistributor, Clever protocol revenue is
   paid weekly in TWO separate reward tokens (CVX and FRAX), each through its own
   independent, immutable, single-token Curve-style FeeDistributor contract — same
   claim(address) -> uint256 selector (0x1e83409a) as Curve's, state-changing but
   safe to simulate via eth_call the same way. Both FeeDistributors' bytecode is
   byte-identical to each other (same Vyper template, just constructor-configured
   with a different reward token), and both aren't independently Sourcify-verified,
   so this was cross-checked live instead: each FeeDistributor's own token()
   (selector 0xfc0c546a) returns exactly the CVX/FRAX address hardcoded below, and
   voting_escrow() (selector 0xdfe05031) on both correctly points back at veCLEV —
   confirmed against ethers.js decoding, not just raw hex. is_killed() (selector
   0x9c868ac0) reads false on both as of this check. Because each FeeDistributor is
   single-token and immutable, hardcoding the two reward tokens here is safe (unlike
   Yield Basis's dynamic, rotating multi-token case, where tokens are deliberately
   read from the contract's own return instead). Live verification: test address
   0x78bf5AF472d5f6014b641eD70DE01862C05dA8c3 had 0.43920986605270057 CVX and 0 FRAX
   pending at time of check (weekly payouts, so these numbers drift — re-verify
   fresh if this comment is ever doubted). CVX/FRAX symbol()/decimals() also
   confirmed live (both 18 decimals) rather than assumed. */
export const CLEVER = {
  votingEscrow: '0x94be07d45d57c7973A535C1c517Bd79E602E051e', // veCLEV
  LOCKED: '0xcbf9fe5f', // locked(address) -> (int128 amount, uint256 end)
  CLAIM: '0x1e83409a', // claim(address) -> uint256, simulated via eth_call
  clev: '0x72953a5C32413614d24C29c84a66AE4B59581Bbf', // CLEV (locked token, not a reward)
  rewards: [
    { feeDistributor: '0x261E3aEB4cd1ebfD0Fa532d6AcDd4B21EbdCd2De', token: '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B', label: 'CVX' },
    { feeDistributor: '0xb5e7F9cb9d3897808658F1991AD32912959b42E2', token: '0x853d955aCEf822Db058eb8505911ED77F175b99e', label: 'FRAX' },
  ],
};

/* Concentrator (concentrator.aladdin.club/lock) — AladdinDAO's veTokenomics locker.
   Ethereum mainnet only. Users lock CTR (up to 4 years) for veCTR, a Curve-style
   VotingEscrow: locked(address) -> (int128 amount, uint256 end), same selector
   0xcbf9fe5f already used for CURVE/YIELD_BASIS. Confirmed (not assumed from the
   family resemblance) against veCTR's Sourcify-verified source, which is a literal
   Curve VotingEscrow.vy fork.

   The claim side is NOT PlatformFeeDistributor or GaugeRewardDistributor — the two
   addresses Concentrator's own docs page (docs.aladdin.club/concentrator/contracts)
   publishes. Both are permissioned routing contracts, not per-user reads:
   PlatformFeeDistributor.claim() is gauge-gated (`require(msg.sender == gauge)`,
   see contracts/misc/PlatformFeeDistributor.sol in AladdinDAO/aladdin-v3-contracts).
   Reading its actual source: PlatformFeeDistributor holds a list of reward tokens,
   each split by governance-set percentages into three destinations —
   `gauge` (0xF57b53df7326e2c6bCFA81b4A128A92E69Cb87B0, GaugeRewardDistributor,
   confirmed live via PlatformFeeDistributor.gauge()), `treasury`, and a third,
   UNDOCUMENTED destination `veDistributor` (found live via
   PlatformFeeDistributor.veDistributor(), not published anywhere on the docs page)
   that receives 100% - gaugePct - treasuryPct of each token's balance.
   veDistributor (0xA5D9358c60fC9Bd2b508eDa17c78C67A43A4458C) is itself a plain
   single-token Curve-style FeeDistributor — claim(address), claim(), token(),
   start_time(), time_cursor() — the exact same shape and CLAIM selector
   (0x1e83409a) already used for Curve's own FeeDistributor — that pays out
   directly to individual veCTR holders. This is the real per-user claim contract.

   Live on 2026-08-08, PlatformFeeDistributor.rewards() lists 4 reward tokens: CTR
   (100% gauge / 0% treasury / 0% ve), aCRV (0% gauge / 50% treasury / 50% ve),
   afrxETH and asdCRV (0% gauge / 100% treasury / 0% ve each) — i.e. of the tokens
   the protocol currently collects, only aCRV (Aladdin's auto-compounded cvxCRV
   vault share — Concentrator's original, flagship product, so "protocol revenue"
   in the literal sense) reaches veCTR holders today, and at exactly the 50% split
   this task's brief described. veDistributor is architecturally single-token by
   design (its own `token()` is fixed at deploy time, same as Curve's — no dynamic
   token_set the way Yield Basis's preview_claim() has), so this is NOT the
   multi-token-basket shape YIELD_BASIS is. Still, the reward token address is read
   live via veDistributor.token() below rather than hardcoded as a constant "aCRV"
   address, matching this file's standing preference for dynamic reads over
   hardcoded token addresses (see the YIELD_BASIS comment above for the prior
   staleness bug this avoids) — if governance ever repoints veDistributor at a
   contract paying a different token via PlatformFeeDistributor.updateDistributor(),
   this keeps working unchanged.

   Verified byte-for-byte against ethers.js AND live mainnet data before shipping
   (per this file's standing bar), across three real veCTR lockers found via
   Etherscan's transaction list for the veCTR contract (its Holders tab is empty —
   0 Transfer events, expected for a non-transferable ve-token, same as veCRV):
     - 0x97475723b146785264C28A7a0b2BAC3737D65247: 100,000.00006972889 CTR locked
       until 2030-07-25; ethers.Contract and this file's manual word()-decode both
       computed locked() and claim() identically; claim() =
       97.582138312995604246 aCRV.
     - 0xFdbBfB0Fe2986672af97Eca0e797D76A0bbF35c9: 17,007.035984834821319520 CTR
       locked until 2030-07-18; claim() = 40.547760766211790214 aCRV, exact match.
     - 0xa219712cC2Aaa5AA98CcF2A7ba055231F1752323: 3,507.943691063394300053 CTR
       locked until 2030-08-01; claim() = 0 (no error — a real address can simply
       have nothing pending), exact match. */
export const CONCENTRATOR = {
  votingEscrow: '0xe4C09928d834cd58D233CD77B5af3545484B4968', // veCTR
  LOCKED: '0xcbf9fe5f', // locked(address) -> (int128 amount, uint256 end)
  // veDistributor — the actual per-user claim contract, found via
  // PlatformFeeDistributor.veDistributor() (see the comment above). Deliberately
  // NOT one of the two addresses Concentrator's own docs page publishes.
  feeDistributor: '0xA5D9358c60fC9Bd2b508eDa17c78C67A43A4458C',
  CLAIM: '0x1e83409a', // claim(address) -> uint256, same shape/selector as Curve's FeeDistributor
  TOKEN: '0xfc0c546a', // token() -> address — read live, never hardcoded (see comment above)
};


export const PROTOCOLS = [
  // No `fetch` — Curve is special-cased in renderPortfolio() to call
  // renderCurveProgressive() instead (see the comment there), which is the
  // only thing that ever needs to resolve this protocol's data.
  { id: 'curve', name: 'Curve', icon: ICONS.curve },
  { id: 'aerodrome', name: 'Aerodrome', icon: ICONS.aerodrome, fetch: () => fetchVeDex(AERODROME, 'AERO') },
  { id: 'velodrome', name: 'Velodrome', icon: ICONS.velodrome, fetch: fetchVelodrome },
  { id: 'yieldbasis', name: 'Yield Basis', icon: ICONS.yieldbasis, fetch: fetchYieldBasis },
  { id: 'clever', name: 'Clever', icon: ICONS.clever, fetch: fetchClever },
  { id: 'concentrator', name: 'Concentrator', icon: ICONS.concentrator, fetch: fetchConcentrator },
];

/* Per-leaf USDC, each confirmed on-chain at decimals() == 6. Only the six leaves that have one;
   the other four route via VELO alone, which is exactly why VELO is the bridge asset.

   EXPOSED AS A FUNCTION, NOT A MAP, ON PURPOSE. Chain ids in core/chains.js are hex strings, so a
   plain object keyed by them answers `undefined` to `leafUsdc[42220]` — silently, with the failure
   surfacing far from the mistake. That exact bug shipped once here: an undefined address produced
   a malformed step, which threw inside the claim panel's row builder and aborted the step-list
   build partway, leaving a panel that looked right but whose Confirm button had no listener. A
   normalising accessor removes the whole class of mistake rather than documenting it — callers
   cannot index it wrongly because they cannot index it at all. */
const LEAF_USDC = chainKeyedMap([
  [CELO, '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'],
  [INK, '0x2D270e6886d130D724215A266106e6832161EAEd'],
  [LISK, '0xF242275d3a6527d877f2c927a82D9b057609cc71'], // USDC.e
  [MODE, '0xd988097fb8612cc24eeC14542bC03424c656005f'],
  [SONEIUM, '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369'], // USDC.e
  [UNICHAIN, '0x078D782b760474a361dDA0AF3839290b0EF57AD6'],
]);

export function velodromeLeafUsdc(chainId) {
  return LEAF_USDC.get(chainNum(chainId));
}
