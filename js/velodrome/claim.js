/* Velodrome claim-to-mainnet: preview building, demo simulation, and execution.
 *
 * THE FLOW (see VELODROME_CLAIM's comment in protocols/config.js for why VELO, not USDC, is the
 * asset that crosses):
 *
 *   per leaf chain:  claim rewards -> swap rewards to VELO -> sendToken() XVELO to Optimism
 *   then on Optimism: swap VELO -> USDC
 *   then optionally:  bridge USDC -> crvUSD on Ethereum mainnet
 *
 * `execSteps` is THE ordered list of everything that will be sent. showVelodromeClaimPanel()
 * renders its rows from it and hands the very same (selection-filtered) array back to the
 * executor, so index N means the same thing to both — see that panel's header for why deriving
 * the two separately is the bug class this avoids.
 *
 * WHAT IS REAL AND WHAT IS ESTIMATED, stated plainly because the distinction matters. The claimable
 * tokens, amounts and USD values are REAL — the same live leaf scan and DefiLlama pricing the
 * Velodrome card uses. Every swap leg is now quoted against the actual pool
 * (quoteLeafToVelo/quoteRootVeloToUsdc, both comparing stable against volatile), the bridge fee is
 * quoted from the Hyperlane Mailbox, and the mainnet leg from Across's own API plus Curve's pool. So
 * `estimated` is no longer hardcoded true: it reports whether any single leg actually fell back to
 * the placeholder cost model. An earlier version of this header said no pool had been quoted and
 * that execution refused everything on that basis — both were true then and are false now.
 *
 * What is still NOT quoted, and is therefore worth knowing before trusting a figure: the root
 * chain's OWN reward tokens swapping to USDC on Optimism (only VELO → USDC is quoted, since the
 * per-token root routes are not walked in the preview), which is why a claim including root rewards
 * still reports `estimated`.
 *
 * Execution now sends real transactions. It is gated by core/release.js like every other claim
 * flow, and it re-quotes and re-reads balances at send time rather than trusting anything above —
 * see executeVelodromeClaim()'s header for why every dependent leg must.
 */

import { ACROSS, CURVE_CRVUSD_USDC_POOL, POOL_COUNT, VELODROME, VELODROME_CLAIM, VELODROME_LEAF_CHAINS, velodromeLeafUsdc } from '../protocols/config.js';
import { CELO, ETH_MAINNET, INK, OPTIMISM, SONEIUM, SUPERSEED, chainName } from '../core/chains.js';
import { TOK, TXT } from '../claim/ledger.js';
import { fetchPoolRewardsFullScan } from '../protocols/vedex.js';
import { demoUnlock } from '../demo/data.js';
import { chainCall, multicall, priceTokensUsd } from '../rpc-waterfall.js';
import { encodeAddress, encodeUint256, formatUnits, log, logErr, short, usd, word } from '../core/utils.js';
import { RELEASE_NOTICE, claimBlocked } from '../core/release.js';
import { uiLog } from '../core/ui-debug.js';
import { state } from '../core/state.js';
import { switchChain } from '../wallet-connect.js';
import { isUserRejection, sendAndWait } from '../tx/send.js';
/* The root (Optimism) legs reuse Aerodrome's builders with a venue argument rather than
   reimplementing them — Optimism's root Voter and Router answer the SAME selectors as Base's, each
   confirmed in live bytecode. See velodrome/txs.js's header for why only the leaf side is new. */
import { buildAcrossBridgeTxs, buildAcrossTokenBridgeTxs, buildAerodromeClaimTxs, buildAerodromeSwapTxs, fetchAcrossSuggestedFees, quoteAcrossToken } from '../aerodrome/routing.js';
import { buildLifiTxs, quoteLifiToOptimismUsdc } from './lifi.js';
import {
  buildLeafBridgeTxs, buildLeafClaimTxs, buildLeafSwapTxs, erc20Balance,
  leafVeloBalance, quoteLeafBridgeFee, rootUsdcBalance, rootVeloBalance,
} from './txs.js';

/* Chain ids in core/chains.js are HEX STRINGS ('0xa4ec'), not numbers — they are used directly as
   wallet_switchEthereumChain parameters. That makes `VELODROME_CLAIM.leafUsdc[42220]` silently
   undefined while `leafUsdc[CELO]` works, and it cost a real bug here: a token part built with an
   undefined address rendered fine but threw inside execStepLabelKey(), which aborted the step-list
   build PART WAY THROUGH — so the panel appeared correct with a short list, and the Confirm
   listener registered after it never attached at all. Always index chain-keyed maps with the
   constants, never a decimal literal. Comparisons are safe either way, since Number('0xa4ec')
   === 42220. */
const OPTIMISM_ID = OPTIMISM;
// Same cap fetchVelodromeLeafClaims() uses — every leaf's pool count fits one page (see the
// VELODROME_LEAF_CHAINS comment in config.js).
const LEAF_CHAIN_POOL_CAP = 1000;

// A leaf is "dust" when what it holds cannot plausibly cover the cost of visiting it: a claim, a
// swap and a bridge transaction, plus the Hyperlane interchain gas payment. Deliberately a plain
// USD floor rather than a live gas estimate — a wrong-by-2x threshold here costs the user a few
// dollars of gas, whereas a live per-chain gas quote on ten chains would add ten more RPC round
// trips to a dialog that already waits on a full reward scan. Revisit if leaf gas ever stops
// being negligible. Skipped chains are always SHOWN with their value and reason, never hidden.
export const LEAF_DUST_USD = 5;


/* ---------- per-pool quoting through the shared leaf router ---------- */

// 1% tolerance, matching aerodrome/routing.js's SLIPPAGE_BPS so the two flows guard swaps the
// same way rather than each inventing a number.
/* A quote that survives less than this fraction of the token's USD value is NOT a route, and is
   treated exactly like a missing pool.
   MEASURED, and the reason this constant exists: veNFT #151 holds $20,202 of rewards on Ink whose
   tokens DO have XVELO pools — so they quoted "successfully" — but the Ink WETH/XVELO volatile pool
   holds 0.0092 WETH and 1,006 XVELO in total. A constant-product pool can never return more than its
   entire reserve, so every one of those quotes asymptotes at ~1,006 XVELO (~$17) regardless of input:
   1 WETH quotes 996.93, 5 WETH quotes 1004.23. $18,331 of routable value quoted to $74 of VELO.
   Detecting a pool is not finding a route — the repo's own "compare, don't just detect" rule — and a
   quote returning 0.4% of value is a pool that exists and a route that does not. 0.7 tolerates real
   slippage (a 30% haircut is already terrible) while catching destruction of this order. */
export const MIN_ROUTE_EFFICIENCY = 0.7;

export const SLIPPAGE_BPS = 100n;
export const applySlippage = (amount) => amount - (amount * SLIPPAGE_BPS) / 10000n;

/* Quotes tokenIn -> XVELO on ONE leaf chain, through the router every leaf shares.
   Velodrome pools come in stable and volatile flavours for the same pair and BOTH are quoted,
   because which one is better is not knowable up front — confirmed live on Ink, where WETH/XVELO
   exists as both yet the stable pool returns 0 (no liquidity) while the volatile pool quotes
   938.559 XVELO per WETH. Detecting a pool is not the same as it being usable, which is the whole
   point of the "compare, not just detect" rule; a detect-only implementation would have picked the
   stable pool here and quoted the claim at zero.
   Both quotes go out in ONE multicall, so adding the comparison costs no extra round trip.
   Returns null when neither pool can fill — the caller reports that rather than inventing a rate. */
export async function quoteLeafToVelo(chainId, tokenIn, amountIn) {
  if (!amountIn || amountIn <= 0n) return null;
  // Already the bridge asset — no swap needed, and quoting VELO->VELO would revert anyway.
  if (String(tokenIn).toLowerCase() === String(VELODROME.token).toLowerCase()) {
    return { amountOut: amountIn, stable: null, direct: true };
  }
  const xVelo = VELODROME_CLAIM.leaf.xVelo;
  // getAmountsOut(uint256 amountIn, Route[] routes) with the leaf's THREE-field Route
  // {from, to, stable} — see LEAF_GET_AMOUNTS_OUT's comment for why the four-field form reverts.
  const callFor = (stable) => VELODROME_CLAIM.LEAF_GET_AMOUNTS_OUT
    + encodeUint256(amountIn)
    + encodeUint256(64n) // offset to the array: head is [amountIn, offset] = 2 words
    + encodeUint256(1n) // one route
    + encodeAddress(tokenIn)
    + encodeAddress(xVelo)
    + encodeUint256(stable ? 1n : 0n);

  let results;
  try {
    results = await multicall(chainId, [
      { target: VELODROME_CLAIM.leaf.router, callData: callFor(false) },
      { target: VELODROME_CLAIM.leaf.router, callData: callFor(true) },
    ]);
  } catch (err) {
    logErr(`Velodrome leaf quote failed (${chainId})`, err);
    return null;
  }

  let best = null;
  [false, true].forEach((stable, i) => {
    const r = results[i];
    if (!r?.success) return; // a pool that does not exist reverts; that is expected, not an error
    // Return is uint256[]: word 0 is the array offset, word 1 the length, then the amounts. The
    // OUTPUT is the last element, not the first — the first is the input echoed back.
    const len = Number(word(r.returnData, 1));
    if (!len) return;
    const out = word(r.returnData, 1 + len);
    if (out > 0n && (!best || out > best.amountOut)) best = { amountOut: out, stable, direct: false };
  });
  return best;
}


/* Quotes the consolidation leg, VELO -> USDC on Optimism. Same stable-vs-volatile comparison as
   the leaf quote and for the same reason — verified live, the stable VELO/USDC pool quotes 0.24
   USDC per 1000 VELO against the volatile pool's 17.06, so picking the first pool that exists
   would lose ~99% of the claim. The route encoding differs from the leaf's: the root router takes
   a FOUR-field Route including the factory (see ROOT_GET_AMOUNTS_OUT). */
export async function quoteRootVeloToUsdc(amountIn) {
  if (!amountIn || amountIn <= 0n) return null;
  const { router, poolFactory, velo, usdc, chainId } = VELODROME_CLAIM.root;
  const callFor = (stable) => VELODROME_CLAIM.ROOT_GET_AMOUNTS_OUT
    + encodeUint256(amountIn)
    + encodeUint256(64n)
    + encodeUint256(1n)
    + encodeAddress(velo)
    + encodeAddress(usdc)
    + encodeUint256(stable ? 1n : 0n)
    + encodeAddress(poolFactory);
  let results;
  try {
    results = await multicall(chainId, [
      { target: router, callData: callFor(false) },
      { target: router, callData: callFor(true) },
    ]);
  } catch (err) {
    logErr('Velodrome root quote failed (Optimism)', err);
    return null;
  }
  let best = null;
  [false, true].forEach((stable, i) => {
    const r = results[i];
    if (!r?.success) return;
    const len = Number(word(r.returnData, 1));
    if (!len) return;
    const out = word(r.returnData, 1 + len);
    if (out > 0n && (!best || out > best.amountOut)) best = { amountOut: out, stable };
  });
  return best;
}

/* Merges one scan's byVenft into an accumulator, preserving the nesting the claim builder needs:
   venftId -> { fees|bribes -> Reward contract -> token -> amount }. A plain spread or Map merge at
   the top level would DISCARD the inner maps of any veNFT seen twice, and an account with several
   veNFTs on one leaf is the normal case, not an edge one — the demo account holds two. Amounts are
   summed at the leaf of the structure, exactly as `totals` is. */
function mergeByVenft(into, from) {
  if (!from) return into;
  for (const [venftId, entry] of from) {
    if (!into.has(venftId)) into.set(venftId, { fees: new Map(), bribes: new Map() });
    const target = into.get(venftId);
    for (const group of ['fees', 'bribes']) {
      for (const [contract, tokenMap] of entry[group] || []) {
        if (!target[group].has(contract)) target[group].set(contract, new Map());
        const dest = target[group].get(contract);
        for (const [token, amount] of tokenMap) dest.set(token, (dest.get(token) || 0n) + amount);
      }
    }
  }
  return into;
}

/* ---------- shared step-list construction ---------- */

// Built once, here, and used by the real preview, the demo preview and the executor alike, so the
// three can never disagree about what the sequence is. Every step carries the chain it happens on
// because on a multi-chain claim "step 7 failed" is not actionable and "step 7 failed on Celo" is.
/* Each step carries a machine-readable `kind` alongside its display `parts`, so the executor acts on
   the SAME array the panel renders instead of re-deriving what to send from a parallel structure.
   That is the property velodrome-panel.js was built around (see its header): rows are addressed by
   index, so anything derived twice can tick the wrong row rather than failing loudly. With `kind` on
   the step there is nothing to derive twice — the panel reads `parts`, the executor reads `kind`,
   and the user's chain selection filters both at once because it filters the one array.
   `token` is carried on swap steps because "which token does row 7 swap?" must not be answered by
   re-walking the chain's token list in the same order and hoping it matches. */
function buildExecSteps(chains, { mainnet }) {
  const steps = [];
  for (const c of chains) {
    /* Velodrome's ROOT (Optimism) rewards are claimable too, and they are ALREADY on the chain
       everything else is being bridged to — so a root chain claims and swaps straight to USDC,
       with no VELO hop and no bridge. Omitting the root entirely is what made the panel's total
       disagree with the card's: the card sums root + leaves, the preview summed leaves only, so
       the panel silently offered LESS than the card said was claimable. */
    if (c.isRoot) {
      steps.push({ kind: 'root-claim', chainId: c.chainId, group: 'root', parts: [TXT('claim rewards')] });
      for (const t of c.tokens) {
        if (String(t.addr).toLowerCase() === String(VELODROME_CLAIM.root.usdc).toLowerCase()) continue;
        steps.push({
          kind: 'root-swap',
          token: t.addr,
          chainId: c.chainId,
          group: 'root',
          parts: [TXT('swap '), t.addr ? { ...TOK(t.addr), symbol: t.symbol } : TXT(t.symbol || '?'), TXT(' → USDC')],
        });
      }
      continue;
    }
    steps.push({ kind: 'leaf-claim', chainId: c.chainId, group: 'leaf', parts: [TXT('claim rewards')] });
    for (const t of c.tokens) {
      // VELO claimed as a reward is ALREADY the bridge asset — emitting "swap VELO → VELO" would
      // be a transaction that does nothing, and it showed up immediately in demo mode because
      // VELO is itself one of the commonest leaf rewards.
      if (String(t.addr).toLowerCase() === String(VELODROME.token).toLowerCase()) continue;
      // No viable route: the ledger already excludes its value, so emitting a swap step would promise
      // a transaction that cannot be built (buildLeafSwapTxs refuses without a minOut) and would trip
      // the executor's own pre-flight refusal on every run.
      if (t.unquotable) continue;
      // Bridged straight to mainnet — it gets its own step below, not a swap-to-VELO step.
      if (t.route === 'across' || t.route === 'lifi') continue;
      // Falls back to a plain-text part when an address is missing rather than emitting a token
      // part without one. A malformed part does not fail where it is created — it throws later,
      // inside the panel's row build, which aborts the list PART WAY and leaves the panel looking
      // plausible but inert (see the chain-id comment above; this is that bug's second line of
      // defence). Degrading to text keeps the step readable and the list complete.
      const label = t.symbol || short(t.addr || '');
      steps.push({
        kind: 'leaf-swap',
        token: t.addr,
        chainId: c.chainId,
        group: 'leaf',
        parts: [TXT('swap '), t.addr ? { ...TOK(t.addr), symbol: t.symbol } : TXT(label), TXT(' → VELO')],
      });
    }
    // One step per Across-carried token: approve + deposit, straight to mainnet.
    for (const t of c.tokens) {
      if (t.route !== 'lifi') continue;
      steps.push({
        kind: 'leaf-lifi',
        token: t.addr,
        chainId: c.chainId,
        group: 'leaf',
        parts: [TXT('swap + bridge '), t.addr ? { ...TOK(t.addr), symbol: t.symbol } : TXT(t.symbol || '?'), TXT(` → USDC on Optimism (${t.lifi?.tool || 'LI.FI'})`)],
      });
    }
    for (const t of c.tokens) {
      if (t.route !== 'across') continue;
      steps.push({
        kind: 'leaf-across',
        token: t.addr,
        chainId: c.chainId,
        group: 'leaf',
        parts: [TXT('bridge '), t.addr ? { ...TOK(t.addr), symbol: t.symbol } : TXT(t.symbol || '?'), TXT(' → Ethereum mainnet (Across)')],
      });
    }
    // Only when something is actually becoming VELO on this leaf — with every token bridged directly
    // there is no XVELO to send, and a bridge step would sit there forever with nothing to move.
    if (c.tokens.some((t) => t.route !== 'across' && t.route !== 'lifi' && !t.unquotable)) {
      steps.push({ kind: 'leaf-bridge', chainId: c.chainId, group: 'leaf', parts: [TXT('bridge VELO → Optimism (Velodrome TokenBridge)')] });
    }
  }
  // Only when a leaf actually bridged something — with root-only rewards there is no VELO
  // arriving on Optimism to consolidate, and a step for it would never execute.
  if (chains.some((c) => !c.isRoot)) {
    steps.push({ kind: 'root-consolidate', chainId: OPTIMISM_ID, group: 'root', parts: [TXT('swap VELO → USDC')] });
  }
  // The Across leg, named explicitly. It is the same bridge Aerodrome uses to reach mainnet, just
  // originating on Optimism instead of Base — and naming the bridge matters here because this flow
  // already used a DIFFERENT bridge (Velodrome's own TokenBridge) to get from the leaves to
  // Optimism. Two bridges in one claim, so an unlabelled "bridge" step would be ambiguous.
  if (mainnet && chains.length) {
    steps.push({ kind: 'mainnet-approve', chainId: OPTIMISM_ID, group: 'mainnet', parts: [TXT('approve USDC for Across bridge')] });
    steps.push({ kind: 'mainnet-bridge', chainId: OPTIMISM_ID, group: 'mainnet', parts: [TXT('bridge USDC via Across → crvUSD on Ethereum mainnet')] });
  }
  return steps;
}

/* FALLBACK cost model, used only for a leg that has no quote. Percentages are deliberately
   conservative placeholders; they exist so the ledger shows a plausible shape rather than implying a
   lossless transfer, and any total that leans on one is marked `estimated` so the panel can say so
   rather than passing a guess off as a quote.
   These used to drive EVERY figure in the ledger. They no longer do — see buildTotals below. */
const LEAF_SWAP_COST = 0.005; // reward -> VELO on a leaf pool
const BRIDGE_COST = 0.001; // Velodrome TokenBridge (Hyperlane gas, refunded above actual use)
const ROOT_SWAP_COST = 0.003; // VELO -> USDC on Optimism, the deepest pool in the path
const MAINNET_BRIDGE_COST = 0.0015; // Across USDC -> mainnet, then crvUSD

/* Turns the claim into the ledger's chain of figures, preferring a REAL QUOTE at every leg and
   falling back to the percentages above only where a quote is missing.
   The quoted legs need no price lookup to become dollars, which is what makes this clean: the root
   quote's output is USDC and the mainnet quote's is crvUSD, both dollar-pegged 6/18-decimal tokens,
   so the quoted amount IS the USD figure rather than something to multiply by a price. `estimated`
   reports honestly whether anything in the chain fell back — one unquotable dust token is enough to
   set it, and the panel would rather say "estimated" than imply precision it does not have. */
function buildTotals(chains, { mainnet, rootQuote = null, mainnetQuote = null }) {
  const claimedUsd = chains.reduce((sum, c) => sum + c.tokens.reduce((s, t) => s + (t.usd || 0), 0), 0);
  const leafChains = chains.filter((c) => !c.isRoot);
  const rootChains = chains.filter((c) => c.isRoot);
  const leafClaimedUsd = leafChains.reduce((sum, c) => sum + c.tokens.reduce((s, t) => s + (t.usd || 0), 0), 0);
  const rootClaimedUsd = rootChains.reduce((sum, c) => sum + c.tokens.reduce((s, t) => s + (t.usd || 0), 0), 0);

  /* The root quote covers exactly the VELO the LEAVES bridge in — it was taken against the combined
     leaf total, on purpose, since price impact applies once to the whole amount rather than
     separately to each leaf's share. The root chain's OWN rewards swap to USDC on Optimism through
     their own pools, which are not quoted here (they are per-token and the preview does not walk
     them), so that portion still uses the fallback. Keeping the two separate is what stops a real
     quote from being diluted by a guess applied over the top of it. */
  /* Value on the leaves with no VELO route at all. The quoted path cannot carry it and the fallback
     must not pretend to either, so it is excluded from both and surfaced on its own ledger row. */
  const unroutableUsd = chains.reduce((sum, c) => sum + (c.unroutableUsd || 0), 0);
  /* Value bridged straight from a leaf to mainnet via Across. It never becomes VELO, never lands on
     Optimism, and so must be kept OUT of the VELO/consolidation rows and added at the end — folding it
     into them would misreport which chain the money is on at each step. */
  const acrossDirectUsd = chains.reduce((sum, c) => sum + (c.acrossUsd || 0), 0);
  const acrossClaimedUsd = chains.reduce((sum, c) => sum
    + (c.tokens || []).reduce((s2, t) => s2 + (t.route === 'across' ? (t.usd || 0) : 0), 0), 0);
  /* LI.FI lands USDC ON OPTIMISM, so it belongs in the consolidation row and then rides the existing
     Across hop to mainnet — unlike acrossDirect, which goes straight to mainnet and must bypass both. */
  const lifiUsdcUsd = chains.reduce((sum, c) => sum + (c.lifiUsd || 0), 0);
  const lifiClaimedUsd = chains.reduce((sum, c) => sum
    + (c.tokens || []).reduce((s2, t) => s2 + (t.route === 'lifi' ? (t.usd || 0) : 0), 0), 0);
  const routableLeafUsd = Math.max(0, leafClaimedUsd - unroutableUsd - acrossClaimedUsd - lifiClaimedUsd);

  const leafBridgedUsd = rootQuote
    ? Number(rootQuote.amountOut) / 1e6
    : routableLeafUsd * (1 - LEAF_SWAP_COST) * (1 - BRIDGE_COST) * (1 - ROOT_SWAP_COST);
  const rootConsolidatedUsd = rootClaimedUsd * (1 - ROOT_SWAP_COST);
  const usdcUsd = leafBridgedUsd + rootConsolidatedUsd + lifiUsdcUsd;

  const crvUsdUsd = (mainnetQuote ? Number(mainnetQuote.crvUsdOut) / 1e18 : usdcUsd * (1 - MAINNET_BRIDGE_COST))
    + acrossDirectUsd;

  /* Value on Optimism before consolidation: what the leaves delivered, plus the root's own claim which
     was already there. Built from `leafBridgedUsd` in BOTH branches deliberately — the fallback used
     to start from `claimedUsd`, i.e. EVERY claimable dollar including the value that has no viable
     route, which is how this row came to read $23,077 while the row below it read $2,275. Any figure
     downstream of the swap must descend from the routable subset, never from the gross claim. */
  // "On Optimism before consolidation": LI.FI's output is already USDC there, so it counts as arrived.
  const veloUsd = leafBridgedUsd + rootClaimedUsd + lifiUsdcUsd;

  const estimated = !rootQuote
    || (mainnet && !mainnetQuote)
    || rootClaimedUsd > 0
    || chains.some((c) => !c.quoted);

  return {
    claimedUsd,
    unroutableUsd,
    acrossDirectUsd,
    lifiUsdcUsd,
    root: { veloUsd, usdcUsd },
    mainnet: mainnet ? { crvUsdUsd } : null,
    deliveredUsd: mainnet ? crvUsdUsd : usdcUsd,
    estimated,
  };
}

function assemble(chains, { demo, mainnet = true, rootQuote = null, mainnetQuote = null }) {
  const live = chains.filter((c) => c.tokens.length);
  const t = buildTotals(live.filter((c) => !c.dust), { mainnet, rootQuote, mainnetQuote });
  /* Everything claimable, dust included — this is the figure the portfolio card shows, and the
     panel's "Claimed" row must equal it or the two appear to disagree about how much money exists.
     The dust chains are then subtracted on their own visible row, so the ledger RECONCILES rather
     than quietly starting from a smaller number than the card. */
  const allClaimedUsd = live.reduce((sum, c) => sum + c.tokens.reduce((s2, tk) => s2 + (tk.usd || 0), 0), 0);
  const dustUsd = allClaimedUsd - t.claimedUsd;
  return {
    __demo: !!demo,
    /* Was an unconditional `true`, back when every figure came from the fallback percentages. It is
       now whatever buildTotals actually did — so a fully-quoted claim can say so, and a partly-quoted
       one still admits it. Demo mode has no quotes at all and therefore stays estimated, which is
       correct and is also stated on its watermark. */
    estimated: t.estimated,
    chains: live,
    execSteps: buildExecSteps(live.filter((c) => !c.dust), { mainnet }),
    root: t.root,
    mainnet: t.mainnet,
    totals: {
      claimedUsd: allClaimedUsd, claimableAfterDustUsd: t.claimedUsd, dustUsd,
      unroutableUsd: t.unroutableUsd, acrossDirectUsd: t.acrossDirectUsd,
      lifiUsdcUsd: t.lifiUsdcUsd, deliveredUsd: t.deliveredUsd,
    },
  };
}

/* ---------- real preview ---------- */

export async function buildVelodromeClaimPreview(positions, onProgress = () => {}) {
  onProgress({ fraction: 0.05, text: 'Reading claimable positions…' });
  const chains = [];
  const leaves = VELODROME_LEAF_CHAINS;
  /* One VELO price for the whole preview, used to judge whether each leaf quote is economically a
     route at all (see MIN_ROUTE_EFFICIENCY). Fetched once rather than per token, and a failure leaves
     it null — in which case no quote is rejected on efficiency grounds, because guessing would be
     worse than the status quo. */
  const veloPriceUsd = await priceTokensUsd([VELODROME.token], VELODROME.priceChain)
    .then((p) => p[VELODROME.token]?.price ?? p[String(VELODROME.token).toLowerCase()]?.price ?? null)
    .catch(() => null);

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    onProgress({
      fraction: 0.05 + (0.8 * i) / leaves.length,
      text: `Scanning ${leaf.name}… (${i + 1}/${leaves.length})`,
    });
    try {
      const scans = await Promise.allSettled(
        positions.map((p) => fetchPoolRewardsFullScan(leaf.chainId, leaf.rewardsSugar, p.id, LEAF_CHAIN_POOL_CAP, LEAF_CHAIN_POOL_CAP))
      );
      const totals = new Map();
      /* The per-veNFT, per-Reward-contract breakdown, WITHOUT which no claim transaction can be
         built at all: a leaf claim is getReward() sent to each individual Reward contract, so it
         needs those addresses and the token list for each. The shared scan already computes this
         (see fetchPoolRewardsFullScan) and this preview used to throw it away, reading only
         `.totals` — which is why the entry in TASKS.md asked whether the Velodrome path retained
         it. It did not; it does now.
         Merged across veNFTs the same way `totals` is, since one account can hold several. */
      const byVenft = new Map();
      for (const r of scans) {
        if (r.status !== 'fulfilled') {
          // One leaf failing must not lose the other nine — the same partial-failure rule
          // fetchVelodromeLeafClaims() already follows.
          logErr(`Velodrome claim preview: scan failed on ${leaf.name}`, r.reason);
          continue;
        }
        for (const [token, amount] of r.value.totals) totals.set(token, (totals.get(token) || 0n) + amount);
        mergeByVenft(byVenft, r.value.byVenft);
      }
      if (!totals.size) continue;

      const addrs = [...totals.keys()];
      const priced = await priceTokensUsd(addrs, leaf.priceChain).catch(() => ({}));
      const tokens = addrs.map((addr) => {
        const meta = priced[addr] || {};
        const decimals = meta.decimals ?? 18;
        const amount = totals.get(addr);
        const usdValue = meta.price != null ? (Number(amount) / 10 ** decimals) * meta.price : null;
        return { addr, symbol: meta.symbol || short(addr), decimals, amount, usd: usdValue };
      });
      const chainUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);
      const dust = chainUsd < LEAF_DUST_USD;

      /* Quote each reward token into XVELO through this leaf's router. Skipped entirely for a dust
         chain: it is unchecked by default, so quoting it would spend RPC round trips on a chain
         the user is being advised not to claim. If they tick it, the quote is still missing — the
         ledger falls back to the price-derived figure and `quoted` stays false, which the panel
         shows rather than passing an estimate off as a quote. */
      let veloOut = 0n;
      let quoted = !dust;
      if (!dust) {
        for (const t of tokens) {
          /* ACROSS-DIRECT FIRST, and this ordering is the whole point of FA-012. Velodrome's leaf
             deployments hold almost no liquidity — Ink's entire WETH/XVELO pool is 0.0092 WETH — so
             swapping a reward token there destroys it. Across carries the majors and stables straight
             off the leaf to mainnet instead: measured on veNFT #151, that is $16,719 of the $20,933
             which previously had nowhere to go. Only tokens Across will not carry fall through to the
             leaf-swap path below. */
          /* LI.FI FIRST. Measured on veNFT #151 it delivers 99.2-100% of value as USDC on Optimism,
             against ~0.4% for the leaf pool and 82% coverage for Across alone, because it combines a
             source-chain swap with whichever bridge actually serves that pair. See lifi.js's header
             for the per-token table. */
          const lf = await quoteLifiToOptimismUsdc({ chainId: leaf.chainId, token: t.addr, amount: t.amount, account: state.account });
          if (lf) {
            t.lifi = lf;
            t.route = 'lifi';
            t.lifiOutUsdc = lf.usdcOut;
            // USDC is dollar-pegged and 6-decimal, so its own amount IS the USD figure.
            t.lifiOutUsd = Number(lf.usdcOut) / 1e6;
            continue;
          }

          const ax = await quoteAcrossToken(leaf.chainId, t.addr, t.amount);
          if (ax) {
            t.across = ax;
            t.route = 'across';
            // Across quotes in the token's own units; value it with the price already fetched for it.
            t.acrossOutUsd = t.usd != null && t.amount > 0n
              ? (Number(ax.outputAmount) / Number(t.amount)) * t.usd
              : null;
            continue;
          }

          const q = await quoteLeafToVelo(leaf.chainId, t.addr, t.amount);
          if (!q) { quoted = false; t.unquotable = true; t.noRouteReason = 'no Across route, no XVELO pool'; continue; }
          /* Reject a quote that destroys the value even though the pool exists — see
             MIN_ROUTE_EFFICIENCY. Skipped for a token already VELO (no swap happens, nothing to lose)
             and when either side is unpriced, since an efficiency ratio needs both numbers. */
          if (!q.direct && t.usd > 0 && veloPriceUsd != null) {
            const outUsd = (Number(q.amountOut) / 1e18) * veloPriceUsd;
            if (outUsd < t.usd * MIN_ROUTE_EFFICIENCY) {
              quoted = false;
              t.unquotable = true;
              t.noRouteReason = `pool too thin — ${usd(t.usd)} would swap to ${usd(outUsd)}`;
              continue;
            }
          }
          t.veloOut = q.amountOut;
          /* The stable/volatile flag the quote actually CHOSE, carried through to execution. The
             executor must send the same flavour that was quoted: on Ink the WETH/XVELO pair exists
             as both and the stable side holds no liquidity, so re-deciding at send time — or
             defaulting to either one — either reverts or fills at a ruinous rate. `direct` marks a
             token that is already VELO and needs no swap at all. */
          t.stable = q.stable;
          t.direct = !!q.direct;
          t.pool = q.direct ? 'none (already VELO)' : (q.stable ? 'stable' : 'volatile');
          veloOut += q.amountOut;
        }
      }
      /* The USD that has NO route to VELO on this leaf. Tracked as a figure, not just a per-token
         flag, because the ledger has to SUBTRACT it: `veloOut` (and therefore the root quote derived
         from it) covers only the tokens that could be quoted, so presenting it against a full-value
         "Claimed" row silently implies the rest arrives too. That is exactly the reported bug —
         $23,239 claimed against $74.49 delivered, with nothing on screen accounting for the
         difference, because a handful of exotic leaf bribe tokens have no XVELO pool at all. */
      const unroutableUsd = tokens.filter((t) => t.unquotable).reduce((sum, t) => sum + (t.usd || 0), 0);
      // Value leaving this leaf straight to mainnet, bypassing VELO and Optimism entirely.
      const acrossUsd = tokens.reduce((sum, t) => sum + (t.route === 'across' ? (t.acrossOutUsd ?? t.usd ?? 0) : 0), 0);
      // Value arriving as USDC on Optimism via LI.FI, and the raw 6-decimal amount the mainnet leg
      // must be quoted against.
      const lifiUsd = tokens.reduce((sum, t) => sum + (t.route === 'lifi' ? (t.lifiOutUsd || 0) : 0), 0);
      const lifiUsdc6 = tokens.reduce((sum, t) => sum + (t.route === 'lifi' ? (t.lifiOutUsdc || 0n) : 0n), 0n);
      chains.push({ chainId: leaf.chainId, tokens, dust, veloOut, quoted, unroutableUsd, acrossUsd, lifiUsd, lifiUsdc6, byVenft });
    } catch (err) {
      logErr(`Velodrome claim preview: ${leaf.name} failed`, err);
    }
  }

  /* Velodrome's OWN root (Optimism) rewards — the same veNFT votes fee/bribe rewards on Optimism
     pools, which is a separate scan from the leaves and was missing entirely. Its pool count fits
     one page like the leaves do (LpSugar.count() on Optimism is ~1,525, see VELODROME.lpSugar).
     Scanned last so a root failure cannot cost the leaf results already gathered. */
  onProgress({ fraction: 0.88, text: 'Scanning Optimism…' });
  try {
    /* Optimism's pool count is read LIVE from LpSugar.count(), never assumed. This scan first
       reused LEAF_CHAIN_POOL_CAP (500) — the leaf-chain cap, which is correct there because every
       leaf's real count is 18-212 — but Optimism carries ~1,525 pools, so it scanned barely a
       third of them and the panel under-reported the root claim by ~$2,200 against the card. The
       failure was silent: a capped scan returns fewer rewards, not an error.
       fetchVeDex() sizes the card's own scan exactly this way, so reading the same count is what
       makes the two agree rather than approximately agree. */
    const rootPoolCount = Number(word(await chainCall(VELODROME.chainId, VELODROME.lpSugar, POOL_COUNT), 0));
    if (!rootPoolCount) throw new Error('LpSugar.count() returned 0 for Optimism');
    const rootScans = await Promise.allSettled(
      positions.map((p) => fetchPoolRewardsFullScan(VELODROME.chainId, VELODROME.rewardsSugar, p.id, rootPoolCount))
    );
    const rootTotals = new Map();
    const rootByVenft = new Map();
    for (const r of rootScans) {
      if (r.status !== 'fulfilled') { logErr('Velodrome claim preview: Optimism root scan failed', r.reason); continue; }
      for (const [token, amount] of r.value.totals) rootTotals.set(token, (rootTotals.get(token) || 0n) + amount);
      mergeByVenft(rootByVenft, r.value.byVenft);
    }
    if (rootTotals.size) {
      const addrs = [...rootTotals.keys()];
      const priced = await priceTokensUsd(addrs, VELODROME.priceChain).catch(() => ({}));
      const tokens = addrs.map((addr) => {
        const meta = priced[addr] || {};
        const decimals = meta.decimals ?? 18;
        const amount = rootTotals.get(addr);
        const usdValue = meta.price != null ? (Number(amount) / 10 ** decimals) * meta.price : null;
        return { addr, symbol: meta.symbol || short(addr), decimals, amount, usd: usdValue };
      });
      const rootUsd = tokens.reduce((sum, t) => sum + (t.usd || 0), 0);
      // Root rewards need no bridge, so the dust floor that pays for a bridge hop does not apply.
      chains.push({ chainId: VELODROME.chainId, isRoot: true, tokens, dust: false, veloOut: 0n, quoted: true, rootUsd, byVenft: rootByVenft });
    }
  } catch (err) {
    logErr('Velodrome claim preview: Optimism root failed', err);
  }

  // One quote for the whole consolidation leg, against the TOTAL VELO arriving on Optimism —
  // quoting per chain would understate it, since price impact applies once to the combined amount,
  // not separately to each leaf's share.
  onProgress({ fraction: 0.92, text: 'Quoting consolidation on Optimism…' });
  const totalVelo = chains.filter((c) => !c.dust && !c.isRoot).reduce((sum, c) => sum + (c.veloOut || 0n), 0n);
  const rootQuote = totalVelo > 0n ? await quoteRootVeloToUsdc(totalVelo) : null;

  /* The mainnet leg, quoted the same way Aerodrome's preview quotes its own: Across's fee API for
     the bridge, then Curve's crvUSD/USDC pool for the arrival swap. Done here rather than only at
     execution time so the ledger's final "you receive" figure is a real quote instead of a
     percentage — this is the number the user actually decides on.
     Failure is non-fatal by design: a preview that cannot reach a third-party API should still open
     with the rest of its figures and fall back to the cost model, not refuse to render. */
  let mainnetQuote = null;
  /* Quote the mainnet hop whenever USDC will exist on Optimism — from a leaf VELO consolidation, from
     LI.FI, or from the root's own rewards. Gating it on `rootQuote` alone meant that with every leaf
     routed by LI.FI (no VELO at all) the final row silently fell back to the cost model. */
  const anyUsdcOnOptimism = !!rootQuote
    || chains.some((c) => (c.lifiUsdc6 || 0n) > 0n)
    || chains.some((c) => c.isRoot);
  if (anyUsdcOnOptimism) {
    onProgress({ fraction: 0.96, text: 'Quoting the bridge to Ethereum mainnet…' });
    try {
      const origin = {
        chainId: VELODROME_CLAIM.root.chainId,
        spokePool: ACROSS.optimismSpokePool,
        usdc: VELODROME_CLAIM.root.usdc,
        name: 'Optimism',
      };
      /* Quote the bridge against ALL the USDC that will be sitting on Optimism, not just the part the
         leaves bridged in. THIS WAS A REAL BUG and it is the second half of the reported mismatch:
         `rootQuote.amountOut` covers only VELO arriving from the leaves, so the Across+Curve quote
         derived from it excluded the root chain's OWN claimed rewards entirely — the ledger showed
         $2,353.49 consolidated to USDC and then $74.49 delivered, the difference being precisely the
         Optimism root's own value silently dropped between the two rows.
         The root portion is an ESTIMATE (its per-token routes are not walked in the preview), which is
         why a claim including root rewards still reports `estimated: true`. An estimate included is
         far better than real money excluded. */
      const rootOwnUsd = chains
        .filter((c) => c.isRoot)
        .reduce((sum, c) => sum + (c.tokens || []).reduce((s2, t) => s2 + (t.usd || 0), 0), 0);
      const rootOwnUsdc6 = BigInt(Math.max(0, Math.round(rootOwnUsd * (1 - ROOT_SWAP_COST) * 1e6)));
      const lifiUsdc6 = chains.reduce((sum, c) => sum + (c.lifiUsdc6 || 0n), 0n);
      const acrossQuote = await fetchAcrossSuggestedFees((rootQuote?.amountOut || 0n) + rootOwnUsdc6 + lifiUsdc6, origin);
      const dy = await chainCall(ETH_MAINNET, CURVE_CRVUSD_USDC_POOL,
        '0x5e0d443f' + encodeUint256(0n) + encodeUint256(1n) + encodeUint256(acrossQuote.outputAmount));
      mainnetQuote = { usdcOut: acrossQuote.outputAmount, crvUsdOut: word(dy, 0) };
    } catch (err) {
      logErr('Velodrome claim preview: mainnet leg quote failed (falling back to the cost model)', err);
    }
  }

  onProgress({ fraction: 1, text: 'Preview ready' });
  const preview = assemble(chains, { demo: false, rootQuote, mainnetQuote });
  preview.rootQuote = rootQuote;
  preview.mainnetQuote = mainnetQuote;
  preview.totalVelo = totalVelo;
  uiLog('velodrome-claim', 'preview built', {
    chains: preview.chains.length,
    dust: preview.chains.filter((c) => c.dust).length,
    steps: preview.execSteps.length,
    // Per-chain, because "was this quoted?" is the difference between a figure that can be
    // executed against and one that cannot, and it can differ chain by chain.
    quotedChains: preview.chains.filter((c) => c.quoted).length,
    rootQuoted: !!preview.rootQuote,
    mainnetQuoted: !!preview.mainnetQuote,
    // Whether ANY figure in the ledger fell back to the cost model — the difference between a
    // number the user can hold this build to and one that is a shape.
    estimated: preview.estimated,
    unquotable: preview.chains.reduce((n, c) => n + (c.tokens || []).filter((t) => t.unquotable).length, 0),
  });
  return preview;
}

/* ---------- demo ---------- */

// Three leaf chains carrying real, currently-deployed reward tokens, priced LIVE through the same
// DefiLlama path a real claim uses — the rule buildDemoResults()/demoAerodromeTokens() already
// follow, so demo figures move with the real market instead of going stale. A fourth chain is
// included deliberately holding almost nothing, so demo mode exercises the dust path (rendered,
// unchecked, with its reason) rather than only the happy one.
function demoLeafPool() {
  return [
    { chainId: INK, tokens: [{ addr: VELODROME.token, symbol: 'VELO', decimals: 18 }, { addr: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }] },
    { chainId: CELO, tokens: [{ addr: velodromeLeafUsdc(CELO), symbol: 'USDC', decimals: 6 }] },
    { chainId: SONEIUM, tokens: [{ addr: velodromeLeafUsdc(SONEIUM), symbol: 'USDC.e', decimals: 6 }] },
    { chainId: SUPERSEED, tokens: [{ addr: VELODROME.token, symbol: 'VELO', decimals: 18 }], dustDemo: true },
    // Optimism root — claims and swaps straight to USDC with no bridge. Included so demo mode
    // exercises the root path, and so the demo panel's total reflects root + leaves exactly as a
    // real claim (and the portfolio card) does.
    { chainId: OPTIMISM, isRoot: true, tokens: [{ addr: VELODROME.token, symbol: 'VELO', decimals: 18 }, { addr: VELODROME_CLAIM.root.usdc, symbol: 'USDC', decimals: 6 }] },
  ];
}

let demoPromise = null;
export function demoVelodromeChains() {
  if (!demoPromise) {
    demoPromise = priceTokensUsd([VELODROME.token], VELODROME.priceChain)
      .then((priced) => {
        const veloPrice = priced[VELODROME.token]?.price ?? null;
        return demoLeafPool().map((leaf) => ({
          chainId: leaf.chainId,
          isRoot: !!leaf.isRoot,
          dust: !!leaf.dustDemo,
          tokens: leaf.tokens.map((t) => {
            // A dust chain must land UNDER the threshold and a live chain comfortably over it, so
            // the demo reliably shows both paths regardless of what VELO happens to cost today.
            const usdValue = leaf.dustDemo ? 0.4 + Math.random() * 2 : 40 + Math.random() * 260;
            const price = t.symbol === 'VELO' ? veloPrice : null;
            const unit = price ?? 1;
            return {
              addr: t.addr,
              symbol: t.symbol,
              decimals: t.decimals,
              amount: BigInt(Math.round((usdValue / unit) * 10 ** t.decimals)),
              usd: usdValue,
            };
          }),
        }));
      })
      .catch((err) => {
        logErr('demo mode: live price lookup for Velodrome failed', err);
        return null;
      });
  }
  return demoPromise;
}


/* The demo CARD, built from the SAME chains array the demo claim panel reads — the rule
   buildDemoAerodromeCardResult() already follows, and the one this flow was violating. The demo
   card's numbers were previously hardcoded in demo/data.js while the panel synthesised its own,
   so the two disagreed by orders of magnitude the moment the panel opened. Deriving both from one
   source makes them agree by construction rather than by maintenance.
   Shaped like fetchVelodrome()'s own {status, claimSummary, claimUsd, subsections} return so the
   card renders identically to a real one. */
export function buildDemoVelodromeCardResult(chains) {
  const subsections = chains.map((c) => {
    const claimUsd = c.tokens.reduce((sum, t) => sum + (t.usd || 0), 0);
    return {
      id: String(c.chainId),
      name: c.isRoot ? 'Optimism' : (VELODROME_LEAF_CHAINS.find((l) => String(l.chainId) === String(c.chainId))?.name || String(c.chainId)),
      status: 'ok',
      claimSummary: usd(claimUsd),
      claimUsd,
      rows: [{ k: 'Pool(s) with rewards', v: `${c.tokens.length} token${c.tokens.length === 1 ? '' : 's'}`, sensitive: false }],
      claimList: c.tokens.map((t) => ({ symbol: t.symbol, amount: formatUnits(t.amount, t.decimals, 4), usd: t.usd })),
    };
  });
  const totalUsd = subsections.reduce((sum, s) => sum + s.claimUsd, 0);
  /* Same metadata rows, in the same order, as the Aerodrome card — this builder originally emitted
     only per-chain subsections, which silently dropped the "locked" summary the card had before
     and made the two protocols' cards look like different components. The real Velodrome card gets
     these from fetchVeDex() on its Optimism root; demo mode has to state them explicitly. */
  const rows = [
    { k: 'VELO locked', v: '5,600.0000 VELO · 2 locks' },
    { k: 'Locked until', v: demoUnlock(365), sensitive: false },
    { k: 'veNFTs', v: '#3117 · #9042', sensitive: true },
  ];
  return { status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, subsections };
}

export function buildDemoVelodromeClaimPreview(chains) {
  return assemble(chains, { demo: true });
}

// Same onStep(index, status) contract the real executor uses, walking the SAME execSteps array
// the panel rendered — a timed pause stands in for the wallet round trip. Nothing is signed.
export async function demoExecuteVelodromeClaim(execPreview, onStep) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < execPreview.execSteps.length; i++) {
    onStep(i, 'active');
    await sleep(420 + Math.random() * 520);
    onStep(i, 'done');
  }
}

/* ---------- real execution ---------- */

/* How long to wait for Velodrome's TokenBridge to deliver XVELO to Optimism before giving up and
   telling the user where their funds are. Hyperlane delivery is typically well under a minute, but
   it is a separate relayed message with no delivery receipt available to this app, so the bound has
   to be generous enough not to abandon a slow-but-fine delivery. 15 minutes with a 10-second poll.
   NOT a guess dressed up as a measurement: leaf→root latency is listed in TASKS.md as unverified,
   and this timeout is a UX bound, not a claim about how fast the bridge is. */
export const BRIDGE_DELIVERY_TIMEOUT_MS = 15 * 60 * 1000;
export const BRIDGE_DELIVERY_POLL_MS = 10 * 1000;

/* Polls Optimism until the account's VELO balance reaches `target`. Returns true on arrival, false
   on timeout — the caller turns a false into an explicit "your funds are in transit, here is what to
   do" error rather than a bare failure, because this is the one place in the flow where money is
   genuinely somewhere the user cannot see it. */
async function waitForBridgedVelo(account, target) {
  const deadlineAt = Date.now() + BRIDGE_DELIVERY_TIMEOUT_MS;
  log(`waiting for bridged VELO to arrive on Optimism (expecting ${formatUnits(target, 18, 2)} VELO)…`, 'info');
  uiLog('velodrome-claim', 'awaiting bridge delivery', { expecting: formatUnits(target, 18, 2) });
  for (;;) {
    const balance = await rootVeloBalance(account).catch(() => 0n);
    if (balance >= target) {
      log(`bridged VELO arrived on Optimism (${formatUnits(balance, 18, 2)} VELO)`, 'ok');
      uiLog('velodrome-claim', 'bridge delivered', { balance: formatUnits(balance, 18, 2) });
      return true;
    }
    if (Date.now() >= deadlineAt) {
      uiLog('velodrome-claim', 'bridge delivery timed out', { expecting: formatUnits(target, 18, 2), have: formatUnits(balance, 18, 2) });
      return false;
    }
    await new Promise((r) => setTimeout(r, BRIDGE_DELIVERY_POLL_MS));
  }
}

/* Walks `execPreview.execSteps` — the exact array the panel rendered, already filtered to the user's
 * chain selection — and sends the real transactions for each. Index N here is row N there, because
 * it is the same array and each step says what it is via `kind`; nothing is re-derived.
 *
 * ONE STEP IS NOT ONE TRANSACTION, and that is deliberate. A "swap X → VELO" row is an approve plus
 * a swap; a leaf "claim rewards" row is one getReward() per Reward contract, which on a
 * heavily-voted leaf can be many. Rows are the units a person reasons about ("Ink is swapping"),
 * not the units a wallet signs, and the alternative — a row per signature — produced a list nobody
 * could read. Every signature inside a step still goes through `track()`, so a rejection is
 * retryable at the signature that was actually rejected.
 *
 * WHY EVERY DEPENDENT LEG RE-READS THE CHAIN. The preview's figures are quotes taken before anything
 * executed. By the time VELO arrives on Optimism it has been swapped on a leaf, moved across a
 * message bus and (for several leaves) merged with other leaves' VELO — so the preview's number is
 * several estimates deep. Each stage therefore reads the REAL balance it is about to spend and
 * re-quotes against it, which is the same rule executeAerodromeClaim() applies to its bridge leg,
 * for the same reason. The preview is what the user approved; it is not the arithmetic used to send.
 *
 * THE BRIDGE IS ASYNCHRONOUS, and this is the honest limitation of this flow. Velodrome's TokenBridge
 * delivers XVELO to Optimism via Hyperlane, which is a separate message with its own latency — the
 * `sendToken` receipt confirms the send, NOT the arrival. So this waits for VELO to actually show up
 * on Optimism before consolidating, with a bounded timeout, and says plainly where the funds are if
 * it gives up. Funds sitting on an intermediate chain must never be silent; that is the worst
 * outcome this flow has and TASKS.md calls it out explicitly.
 */
export async function executeVelodromeClaim(execPreview, onStep) {
  /* Refuses on its own authority, exactly as executeAerodromeClaim() does, rather than trusting a
     disabled button several layers away. THIS is the gate that keeps the beta from signing; the
     second, quoting-related refusal that used to sit below is gone because the thing it was waiting
     for now exists (real per-pool quotes, real minOuts, a real Hyperlane fee quote). */
  if (claimBlocked(false)) {
    logErr('Velodrome claim execution blocked', new Error(RELEASE_NOTICE));
    throw new Error(RELEASE_NOTICE);
  }

  const steps = execPreview.execSteps || [];
  const account = state.account;
  if (!account) throw new Error('no wallet account connected');

  /* A step that cannot be executed safely must stop the run BEFORE anything is signed, not halfway
     through. An unquoted token has no minOut, and this flow refuses to send a swap without one
     (buildLeafSwapTxs throws on it) — but discovering that at step 9 of 14 leaves the user claimed
     and half-swapped, which is precisely the stranded state to avoid. So it is checked up front. */
  const unquotable = [];
  for (const step of steps) {
    if (step.kind !== 'leaf-swap' && step.kind !== 'root-swap') continue;
    const chain = (execPreview.chains || []).find((c) => Number(c.chainId) === Number(step.chainId));
    const token = (chain?.tokens || []).find((t) => String(t.addr).toLowerCase() === String(step.token).toLowerCase());
    if (step.kind === 'leaf-swap' && (!token || token.unquotable || (!token.direct && token.veloOut == null))) {
      unquotable.push(`${chainName(step.chainId)}: ${token?.symbol || short(step.token || '')}`);
    }
  }
  if (unquotable.length) {
    onStep(0, 'error');
    const msg = `refusing to start: ${unquotable.length} token(s) have no pool quote, so no minimum `
      + `output can be guaranteed for their swap (${unquotable.join(', ')}). Retry the preview — a `
      + 'quote that failed is usually an RPC failure, not an absent pool.';
    log(msg, 'err');
    uiLog('velodrome-claim', 'execution refused', { reason: 'unquoted tokens', unquotable: unquotable.length });
    throw new Error(msg);
  }

  uiLog('velodrome-claim', 'execution start', {
    steps: steps.length,
    chains: new Set(steps.map((s) => String(s.chainId))).size,
    mainnet: !!execPreview.mainnetEnabled,
  });

  let stepIndex = 0;
  /* Same contract as executeAerodromeClaim()'s track(): every real signature goes through here
     exactly once per ATTEMPT, and a user rejection is NOT terminal — onStep(...,'rejected') returns
     a promise the panel resolves when the user retries, and the identical call is tried again.
     Unlike Aerodrome's, this takes the step index explicitly, because several signatures share one
     row (see the header) — the index advances per STEP, via nextStep() below. */
  const track = async (fn) => {
    for (;;) {
      onStep(stepIndex, 'active');
      try {
        return await fn();
      } catch (err) {
        if (isUserRejection(err)) {
          await onStep(stepIndex, 'rejected');
          continue;
        }
        onStep(stepIndex, 'error');
        throw err;
      }
    }
  };
  const finishStep = () => { onStep(stepIndex, 'done'); stepIndex++; };

  // The wallet is on one chain at a time, so a ten-chain claim is a sequence of chain switches. Only
  // switched when it actually changes — a redundant wallet_switchEthereumChain still prompts in some
  // wallets, which on a 14-step run would be a lot of pointless dialogs.
  /* How much VELO the leaves sent, and how much was already on Optimism before any of it. Together
     they give the consolidation step a concrete target to wait for — "at least what was there plus
     what was sent" — rather than a guess like "wait until the balance changes", which would be
     satisfied by a single leaf's delivery out of nine and consolidate far too early, stranding the
     rest. Read BEFORE anything executes, since a claim on the root itself also adds VELO here. */
  let bridgedFromLeaves = 0n;
  const veloOnRootBefore = await rootVeloBalance(account).catch(() => 0n);

  let currentChain = null;
  const ensureChain = async (chainId) => {
    if (currentChain === chainId) return;
    log(`switching wallet to ${chainName(chainId)}…`, 'info');
    await switchChain(chainId);
    currentChain = chainId;
    uiLog('velodrome-claim', 'chain switched', { chain: chainName(chainId) });
  };

  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);
  const chainFor = (step) => (execPreview.chains || []).find((c) => Number(c.chainId) === Number(step.chainId));

  for (const step of steps) {
    await ensureChain(step.chainId);
    const chain = chainFor(step);

    if (step.kind === 'leaf-claim' || step.kind === 'root-claim') {
      const byVenft = chain?.byVenft;
      if (!byVenft || !byVenft.size) {
        /* Reported on the row rather than thrown bare, so the failure is visible where the user is
           looking. This means the scan produced totals but no per-contract breakdown, which would be
           a bug in the preview rather than a chain problem — say so instead of implying the chain
           failed. */
        onStep(stepIndex, 'error');
        throw new Error(`no claimable reward contracts recorded for ${chainName(step.chainId)} — cannot build its claim transaction`);
      }
      if (step.kind === 'root-claim') {
        /* Optimism's root Voter takes Aerodrome's exact claimFees/claimBribes calls, so this is
           aerodrome/routing.js's own builder pointed at Velodrome's root addresses — not a
           reimplementation. Both selectors were confirmed present in the root Voter's live bytecode. */
        const txs = buildAerodromeClaimTxs({ byVenft }, {
          chainId: VELODROME_CLAIM.root.chainId,
          voter: VELODROME_CLAIM.root.voter,
          router: VELODROME_CLAIM.root.router,
          poolFactory: VELODROME_CLAIM.root.poolFactory,
        });
        for (const tx of txs) await track(() => sendAndWait(tx));
      } else {
        const txs = buildLeafClaimTxs(step.chainId, byVenft, account);
        log(`${chainName(step.chainId)}: claiming from ${txs.length} reward contract(s)…`, 'info');
        for (const tx of txs) await track(() => sendAndWait(tx));
      }
      finishStep();
      continue;
    }

    if (step.kind === 'leaf-swap') {
      const token = (chain?.tokens || []).find((t) => String(t.addr).toLowerCase() === String(step.token).toLowerCase());
      // Already VELO — the bridge step moves it, and a VELO→VELO swap would be a transaction that
      // does nothing. buildExecSteps() does not emit a row for this, so reaching it means the
      // preview and the step list disagree; skipping is the safe reading, but say so.
      if (!token || token.direct) {
        log(`${chainName(step.chainId)}: ${token?.symbol || 'token'} is already VELO — nothing to swap`, 'info');
        finishStep();
        continue;
      }
      /* Re-read the claimed balance rather than trusting the preview's amount: the claim just
         executed, and what actually landed is what can be swapped. A reward can also accrue between
         preview and execution, in which case the preview's figure is an UNDERSTATEMENT and swapping
         it would leave the remainder stranded on the leaf. */
      const balance = await erc20Balance(step.chainId, token.addr, account);
      if (balance <= 0n) {
        log(`${chainName(step.chainId)}: no ${token.symbol} balance after the claim — skipping its swap`, 'info');
        finishStep();
        continue;
      }
      const quote = await quoteLeafToVelo(step.chainId, token.addr, balance);
      if (!quote) {
        onStep(stepIndex, 'error');
        throw new Error(`could not quote ${token.symbol} → VELO on ${chainName(step.chainId)} at execution time — refusing to swap without a minimum output`);
      }
      const [approveTx, swapTx] = buildLeafSwapTxs({
        chainId: step.chainId,
        token: token.addr,
        amount: balance,
        minOut: applySlippage(quote.amountOut),
        stable: quote.stable,
        recipient: account,
        deadline: deadline(),
      });
      await track(() => sendAndWait(approveTx));
      await track(() => sendAndWait(swapTx));
      finishStep();
      continue;
    }

    if (step.kind === 'leaf-lifi') {
      const token = (chain?.tokens || []).find((t) => String(t.addr).toLowerCase() === String(step.token).toLowerCase());
      if (!token) { onStep(stepIndex, 'error'); throw new Error(`no token record for the LI.FI step on ${chainName(step.chainId)}`); }
      /* Re-read the balance and RE-QUOTE at send time. A LI.FI quote carries calldata with an embedded
         amount and a deadline, so a preview quote minutes old is not safe to send: the claim has since
         executed (so the real balance may differ) and the route may have moved. Same rule every other
         dependent leg here follows, and it matters more for a vendor payload we do not build ourselves. */
      const balance = await erc20Balance(step.chainId, token.addr, account);
      if (balance <= 0n) {
        log(`${chainName(step.chainId)}: no ${token.symbol} balance after the claim — skipping its bridge`, 'info');
        finishStep();
        continue;
      }
      const quote = await quoteLifiToOptimismUsdc({ chainId: step.chainId, token: token.addr, amount: balance, account });
      if (!quote) {
        onStep(stepIndex, 'error');
        throw new Error(`LI.FI has no route for ${token.symbol} on ${chainName(step.chainId)} at execution time — it quoted one when the preview was built, so retry the claim`);
      }
      const [approveTx, routeTx] = buildLifiTxs({
        chainId: step.chainId, token: token.addr, amount: balance, quote, symbol: token.symbol,
      });
      await track(() => sendAndWait(approveTx));
      await track(() => sendAndWait(routeTx));
      log(`${chainName(step.chainId)}: ${token.symbol} routed to USDC on Optimism via ${quote.tool} — arrival is asynchronous`, 'ok');
      finishStep();
      continue;
    }

    if (step.kind === 'leaf-across') {
      const token = (chain?.tokens || []).find((t) => String(t.addr).toLowerCase() === String(step.token).toLowerCase());
      if (!token?.across) { onStep(stepIndex, 'error'); throw new Error(`no Across route recorded for the step on ${chainName(step.chainId)}`); }
      const balance = await erc20Balance(step.chainId, token.addr, account);
      if (balance <= 0n) {
        log(`${chainName(step.chainId)}: no ${token.symbol} balance after the claim — skipping its bridge`, 'info');
        finishStep();
        continue;
      }
      // Re-quote for the real balance: Across's outputAmount is a guarantee tied to a specific input.
      const fresh = await quoteAcrossToken(step.chainId, token.addr, balance);
      if (!fresh) {
        onStep(stepIndex, 'error');
        throw new Error(`Across no longer quotes ${token.symbol} on ${chainName(step.chainId)} — retry the claim`);
      }
      const [approveTx, depositTx] = buildAcrossTokenBridgeTxs({
        account, chainId: step.chainId, spokePool: fresh.spokePool, inputToken: token.addr,
        outputToken: fresh.outputToken, inputAmount: balance, outputAmount: fresh.outputAmount,
        label: token.symbol,
      });
      await track(() => sendAndWait(approveTx));
      await track(() => sendAndWait(depositTx));
      finishStep();
      continue;
    }

    if (step.kind === 'leaf-bridge') {
      // The REAL VELO balance on this leaf, which is what should cross — not the sum of the swap
      // outputs. VELO is itself a common leaf reward, so a claim can deliver VELO with no swap at
      // all, and summing swaps alone would leave that behind. See leafVeloBalance()'s comment.
      const amount = await leafVeloBalance(step.chainId, account);
      if (amount <= 0n) {
        log(`${chainName(step.chainId)}: no VELO to bridge — skipping`, 'info');
        finishStep();
        continue;
      }
      const { fee } = await quoteLeafBridgeFee(step.chainId, account, amount);
      const [approveTx, bridgeTx] = buildLeafBridgeTxs({ chainId: step.chainId, amount, recipient: account, fee });
      await track(() => sendAndWait(approveTx));
      await track(() => sendAndWait(bridgeTx));
      bridgedFromLeaves += amount;
      finishStep();
      continue;
    }

    if (step.kind === 'root-swap' || step.kind === 'root-consolidate') {
      const tokenAddr = step.kind === 'root-consolidate' ? VELODROME_CLAIM.root.velo : step.token;
      const symbol = step.kind === 'root-consolidate'
        ? 'VELO'
        : ((chain?.tokens || []).find((t) => String(t.addr).toLowerCase() === String(tokenAddr).toLowerCase())?.symbol || short(tokenAddr));

      /* The consolidation step waits for the bridge to actually DELIVER before swapping. A
         `sendToken` receipt confirms the send, not the arrival — Hyperlane delivery is a separate
         message — so consolidating immediately would swap only whatever VELO happened to already be
         on Optimism and leave the bridged amount behind. */
      if (step.kind === 'root-consolidate' && bridgedFromLeaves > 0n) {
        const arrived = await waitForBridgedVelo(account, veloOnRootBefore + bridgedFromLeaves);
        if (!arrived) {
          onStep(stepIndex, 'error');
          throw new Error(
            `bridged VELO has not arrived on Optimism yet after ${Math.round(BRIDGE_DELIVERY_TIMEOUT_MS / 60000)} minutes. `
            + 'Nothing is lost — the VELO is in transit on Velodrome\'s TokenBridge and will land on '
            + 'Optimism. Re-run the claim once it has, and it will consolidate from there; the leaf '
            + 'claims already completed will simply find nothing left to claim.'
          );
        }
      }

      const amount = await erc20Balance(VELODROME.chainId, tokenAddr, account);
      if (amount <= 0n) {
        log(`Optimism: no ${symbol} balance to swap — skipping`, 'info');
        finishStep();
        continue;
      }
      /* Root swaps go through Aerodrome's own builder with Velodrome's root addresses — the root
         Router answers the same swap selector, confirmed in its live bytecode. `kind: 'v2'` selects
         the FOUR-field Route the root uses (the leaf's three-field form is a different selector
         entirely; see velodrome/txs.js's header).
         VELO → USDC is quoted stable-vs-volatile because the difference is not marginal: measured
         live, the stable pool quotes 0.24 USDC per 1000 VELO against the volatile pool's 17.06. */
      let quote = null;
      if (String(tokenAddr).toLowerCase() === String(VELODROME_CLAIM.root.velo).toLowerCase()) {
        quote = await quoteRootVeloToUsdc(amount);
      }
      if (!quote) {
        onStep(stepIndex, 'error');
        throw new Error(`could not quote ${symbol} → USDC on Optimism at execution time — refusing to swap without a minimum output`);
      }
      const rootVenue = {
        chainId: VELODROME_CLAIM.root.chainId,
        voter: VELODROME_CLAIM.root.voter,
        router: VELODROME_CLAIM.root.router,
        poolFactory: VELODROME_CLAIM.root.poolFactory,
      };
      const [approveTx, swapTx] = buildAerodromeSwapTxs(
        tokenAddr, amount, { kind: 'v2', stable: quote.stable }, VELODROME_CLAIM.root.usdc,
        applySlippage(quote.amountOut), account, deadline(), rootVenue
      );
      await track(() => sendAndWait(approveTx));
      await track(() => sendAndWait(swapTx));
      finishStep();
      continue;
    }

    if (step.kind === 'mainnet-approve' || step.kind === 'mainnet-bridge') {
      /* Both Across rows are handled when the FIRST of them is reached, because the builder produces
         the approve and the deposit together from one re-quote — splitting the quote across two
         steps would risk quoting twice and approving an amount the deposit no longer matches. The
         second row is then marked done without sending anything of its own. */
      if (step.kind === 'mainnet-approve') {
        const bridgeAmount = await rootUsdcBalance(account);
        if (bridgeAmount <= 0n) {
          onStep(stepIndex, 'error');
          throw new Error('no USDC ended up on Optimism to bridge after consolidation');
        }
        log(`re-quoting Across for the actual consolidated amount (${formatUnits(bridgeAmount, 6, 2)} USDC)…`, 'info');
        /* Across FROM OPTIMISM, not Base. The SpokePool address differs per chain and the origin
           must be passed explicitly — see buildAcrossBridgeTxs's `origin` comment. Verified live:
           an Optimism-origin quote returns 0.012% fees. */
        const origin = {
          chainId: VELODROME_CLAIM.root.chainId,
          spokePool: ACROSS.optimismSpokePool,
          usdc: VELODROME_CLAIM.root.usdc,
          name: 'Optimism',
        };
        const acrossQuote = await fetchAcrossSuggestedFees(bridgeAmount, origin);
        const dy = await chainCall(ETH_MAINNET, CURVE_CRVUSD_USDC_POOL,
          '0x5e0d443f' + encodeUint256(0n) + encodeUint256(1n) + encodeUint256(acrossQuote.outputAmount));
        const minCrvUsdOut = applySlippage(word(dy, 0));
        const [bridgeApprove, bridgeDeposit] = buildAcrossBridgeTxs({
          account,
          inputAmount: bridgeAmount,
          outputAmount: acrossQuote.outputAmount,
          minCrvUsdOut,
          skipCrvUsdSwap: false,
          origin,
        });
        await track(() => sendAndWait(bridgeApprove));
        finishStep();
        const depositHash = await track(() => sendAndWait(bridgeDeposit));
        log(`bridge sent — crvUSD should arrive on Ethereum mainnet shortly via Across: ${depositHash}`, 'ok');
        finishStep();
        continue;
      }
      // Reached only if the approve row was filtered out, which the panel does not do — treat as a
      // no-op rather than silently sending an unquoted deposit.
      finishStep();
      continue;
    }

    // An unknown kind means buildExecSteps() grew a step this executor was not taught. Refusing is
    // the only safe response: skipping it would silently drop a leg of the user's claim.
    onStep(stepIndex, 'error');
    throw new Error(`unrecognised claim step "${step.kind}" — refusing to continue a claim this build does not fully understand`);
  }

  uiLog('velodrome-claim', 'execution complete', { steps: steps.length });
}
