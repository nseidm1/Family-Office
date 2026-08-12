import { ACROSS, AERODROME, AERODROME_CLAIM, BY_ACCOUNT, CURVE, CURVE_CRVUSD_USDC_POOL } from '../protocols/config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, fetchJson, multicall } from '../rpc-waterfall.js';
import { addrAt, decodeVeNFTArray, encodeAddress, encodeUint256, log, logErr, short, word } from '../core/utils.js';
import { aerodromeCardSnapshot, buildVeNftRewardTotals, veNftPositionsSignature } from '../protocols/vedex.js';

export async function buildAerodromeClaimPlan(account) {
  const raw = await chainCall(AERODROME.chainId, AERODROME.veSugar, BY_ACCOUNT + encodeAddress(account));
  const positions = decodeVeNFTArray(raw);

  // Inherit the portfolio card's own reward computation when it's available, for this exact
  // account, and still fresh (same veNFTs voting for the same pools as when the card captured
  // it) — see aerodromeCardSnapshot's comment for why this, not an independent second scan, is
  // what actually guarantees the claim panel can never show a different token list than the
  // card: it uses the literal totals/byVenft the card already found, not a fresh approximation
  // of them raced against the card's own scan.
  // scanComplete is a REQUIRED condition here, not just account+positions matching — an
  // incomplete snapshot (some full-scan pages failed, e.g. under the RPC rate-limiting seen
  // live: mainnet.base.org returning 429) is exactly the situation where the card is MISSING
  // real tokens (like a historic, no-longer-voted AORA/TEA position). Inheriting that snapshot
  // as-is would hand the claim panel the very same gap the card has, and — now that the panel
  // syncs its own results back into the card unconditionally (see applyLedger's card-sync
  // below) — would durably overwrite the card with that same incomplete data instead of ever
  // correcting it. Recomputing fresh here gives this scan its own independent shot at the pages
  // that failed the first time, and its (hopefully complete) result becomes the new snapshot via
  // fetchVeDex the next portfolio refresh, or is pushed back into the card immediately by this
  // panel's own sync once it resolves.
  const cardSigMatches = aerodromeCardSnapshot &&
    aerodromeCardSnapshot.account === account &&
    aerodromeCardSnapshot.scanComplete &&
    veNftPositionsSignature(aerodromeCardSnapshot.positions) === veNftPositionsSignature(positions);

  if (cardSigMatches) {
    log(`claim plan: inheriting ${aerodromeCardSnapshot.totals.size} tokens from card snapshot`, 'info');
    return {
      byVenft: aerodromeCardSnapshot.byVenft,
      tokenTotals: aerodromeCardSnapshot.totals,
      scanComplete: aerodromeCardSnapshot.scanComplete,
    };
  }

  const reason = !aerodromeCardSnapshot ? 'no snapshot'
    : aerodromeCardSnapshot.account !== account ? 'account mismatch'
    : !aerodromeCardSnapshot.scanComplete ? 'card scan was incomplete'
    : 'position signature mismatch';
  log(`claim plan: computing fresh (${reason})`, 'info');

  // No usable snapshot (card hasn't loaded yet, different account, or positions moved since the
  // card last fetched) — fall back to computing fresh, same as before this inheritance was added.
  // Pass throwOnCheapPathFail=false to allow the historical full-pool scan to run even if cheap-path
  // (current votes) fails — a position with no current votes but historic claimables is a valid
  // case, and the historical scan will find them. Only reject the whole plan if the historical
  // scan also fails to find anything AND scanComplete=false (meaning we couldn't even complete
  // the full scan). publicRpc() already retries each call across every fallback endpoint before
  // rejecting, so a rejection reaching here is genuinely persistent.
  const { totals: tokenTotals, byVenft, cheapPathFailed, scanComplete } = await buildVeNftRewardTotals(
    AERODROME, positions, 'AERO', false
  );

  // Reject the plan only if both cheap-path AND historical scan failed to find data
  if (cheapPathFailed && !tokenTotals.size && !scanComplete) {
    throw new Error('failed to read claimable rewards (both current and historical scans inconclusive) — refusing to build an incomplete claim plan');
  }

  return { byVenft, tokenTotals, scanComplete };
}

/* The venue this builder and buildAerodromeSwapTxs() act on. Defaults to Aerodrome-on-Base, so
   every existing call site keeps its exact behaviour with no change — the parameter exists because
   Velodrome's ROOT (Optimism) leg needs the identical encoding against a different address set.
   That is not an assumption: Optimism's root Voter answers the same claimFees/claimBribes
   selectors, and its Router the same swap selector, as Base's — each confirmed present in the
   live bytecode (see VELODROME_CLAIM's write-side comment in protocols/config.js). So the
   Optimism leg is genuinely this code with different constants, which is why parameterising beats
   a parallel velodrome/ copy. Deliberately a small, surgical parameter rather than the full
   staged-pipeline refactor TASKS.md envisions: it is provably behaviour-preserving here (the
   default IS today's constants), where a wholesale restructure of the only working claim flow is
   not. */
export const aerodromeVenue = () => ({
  chainId: AERODROME.chainId,
  voter: AERODROME_CLAIM.voter,
  router: AERODROME_CLAIM.router,
  poolFactory: AERODROME_CLAIM.poolFactory,
});

// Builds the Voter.claimFees()/claimBribes() transactions for a claim plan — one of
// each per veNFT that actually has fee/bribe rewards (skips veNFTs with none of a
// given kind), batching every pool's Fee-or-Bribe contract into a single call each,
// per Voter.sol's own claimFees/claimBribes implementation (confirmed live against
// aerodrome-finance/contracts' Voter.sol).
export function buildAerodromeClaimTxs(plan, venue = aerodromeVenue()) {
  const txs = [];
  for (const [venftId, entry] of plan.byVenft) {
    for (const [group, selector, label] of [
      ['fees', '0x666256aa', 'claimFees'],
      ['bribes', '0x7715ee75', 'claimBribes'],
    ]) {
      const contracts = [...entry[group].keys()];
      if (!contracts.length) continue;
      const tokenArrays = contracts.map((c) => [...entry[group].get(c).keys()]);
      // address[] _fees/_bribes, address[][] _tokens, uint256 _tokenId
      const head = 3; // 3 head words: offset-to-arr1, offset-to-arr2, tokenId
      let data = selector;
      data += encodeUint256(BigInt(head) * 32n); // offset to _fees/_bribes array
      const arr2Offset = 32n * (BigInt(head) + 1n + BigInt(contracts.length));
      data += encodeUint256(arr2Offset); // offset to _tokens array (placeholder, fixed below)
      data += encodeUint256(BigInt(venftId));
      data += encodeUint256(BigInt(contracts.length));
      contracts.forEach((c) => { data += encodeAddress(c); });
      // _tokens: address[][] — length word, then one offset per outer element (relative to the
      // start of the _tokens array's own data), then each inner array's [length, elements...].
      data += encodeUint256(BigInt(contracts.length));
      let runningOffset = BigInt(contracts.length) * 32n;
      const innerOffsets = [];
      tokenArrays.forEach((arr) => { innerOffsets.push(runningOffset); runningOffset += 32n * BigInt(1 + arr.length); });
      innerOffsets.forEach((off) => { data += encodeUint256(off); });
      tokenArrays.forEach((arr) => {
        data += encodeUint256(BigInt(arr.length));
        arr.forEach((t) => { data += encodeAddress(t); });
      });
      txs.push({ label, to: venue.voter, data, chainId: venue.chainId });
    }
  }
  return txs;
}

// Every Aerodrome pool type this app knows how to swap through, for ONE token pair, emitted as
// plain Multicall3 (target, callData) probes: the legacy stable/volatile V2-style factory (both
// stable=true and stable=false) and all three Slipstream (concentrated-liquidity) factories at
// each of a handful of common tick spacings (1, 50, 100, 200, 2000 — Aerodrome's standard set
// per its own docs/UI). Emitted as raw probes rather than executed here so ANY number of pairs
// can be discovered in a SINGLE batched request — see discoverAerodromePools().
// PoolFactory.getPool(address,address,bool) = 0x79bc57d5 and Slipstream
// PoolFactory.getPool(address,address,int24) = 0x28af8d0b, both keccak-verified against those
// exact signatures in a scratchpad (2026-08-09), not assumed.
export const CL_TICK_SPACINGS = [1n, 50n, 100n, 200n, 2000n];
export const ROUTE_LOOKUP_RETRIES = 3;

/* A failure that means "the network never gave us usable signal", as opposed to "we asked and
   the answer is genuinely no". The distinction is load-bearing: a transient failure must NEVER
   cause a claimable token to be dropped from consolidation, because the portfolio card is
   already counting that token's value as claimable — silently skipping it would mean signing a
   batch that delivers less than the app told the user was claimable.

   Only the explicit total-batch-failure paths are tagged (discoverAerodromePools and
   quoteAerodromeCandidates, both of which retry internally and only throw once every RPC batch
   came back empty). A pool that answers and simply cannot quote the amount is NOT transient —
   it is a real answer, and tagging it would leave the token unresolvable forever and block
   Confirm permanently. */
export function transientError(message) {
  const err = new Error(message);
  err.transient = true;
  return err;
}

export function aerodromePoolProbes(tokenA, tokenB) {
  const v2 = [true, false].map((stable) => ({
    target: AERODROME_CLAIM.poolFactory,
    callData: '0x79bc57d5' + encodeAddress(tokenA) + encodeAddress(tokenB) + encodeUint256(stable ? 1n : 0n),
  }));
  const cl = AERODROME_CLAIM.clDeployments.flatMap((dep) =>
    CL_TICK_SPACINGS.map((spacing) => ({
      target: dep.factory,
      callData: '0x28af8d0b' + encodeAddress(tokenA) + encodeAddress(tokenB) + encodeUint256(spacing),
    }))
  );
  return [...v2, ...cl];
}
// Probe count per pair — the slice width used to map a flat multicall result array back to pairs.
// Lazily memoized rather than a module-load-time const: AERODROME_CLAIM comes from
// protocols/config.js, which sits in a circular-import cluster with this file, and reading it at
// module-evaluation time raced config.js's own initialization.
let _probesPerPair = null;
export function AERODROME_PROBES_PER_PAIR() {
  if (_probesPerPair == null) _probesPerPair = 2 + AERODROME_CLAIM.clDeployments.length * CL_TICK_SPACINGS.length;
  return _probesPerPair;
}
export const pairKey = (a, b) => `${a.toLowerCase()}|${b.toLowerCase()}`;

// Decodes one pair's slice of probe results into EVERY pool that actually exists for that pair,
// not just the first one found. `anySuccess` reports whether the RPC gave us any real signal at
// all for this pair (see discoverAerodromePools' retry contract below).
export function decodeAerodromePoolProbes(results) {
  const candidates = [];
  let anySuccess = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || !r.success) continue;
    anySuccess = true; // the node answered this probe — real signal, even if it's a zero address
    let pool;
    try {
      pool = addrAt(r.returnData, 0);
    } catch {
      continue; // short/empty return from a successful call — nothing to read, treat as no pool
    }
    if (pool === '0x0000000000000000000000000000000000000000') continue;
    if (i < 2) {
      candidates.push({ kind: 'v2', stable: i === 0, pool });
    } else {
      const j = i - 2;
      const dep = AERODROME_CLAIM.clDeployments[Math.floor(j / CL_TICK_SPACINGS.length)];
      candidates.push({ kind: 'cl', router: dep.router, quoter: dep.quoter, tickSpacing: CL_TICK_SPACINGS[j % CL_TICK_SPACINGS.length], pool });
    }
  }
  return { candidates, anySuccess };
}

// Discovers EVERY existing pool for a list of token pairs in a single batched Multicall3 request
// (AERODROME_PROBES_PER_PAIR probes per pair, all pairs in one batch), returning a
// pairKey -> candidates[] Map. Candidate lists may be empty — that's a real, checked "no pool
// for this pair", NOT an error.
//
// Enumerating ALL pools per pair (rather than returning the first hit, as this did before
// 2026-08-09) is the point: a pair routinely has many pools of wildly differing depth, and the
// first one probed is very often not the good one. Confirmed live on Base this session:
// WETH/USDC has 10 pools whose quotes for 1 WETH range from 0.386866 USDC (an all-but-empty
// CL pool) to 1920.376431 USDC; the first-probed pool (v2 stable) quoted 1581.408822, i.e. the
// old first-match behavior was silently giving up 17.6% of the position's value. cbBTC/USDC has
// 9 pools, AERO/USDC 7. Callers quote the candidates and pick the best — see quoteAerodromeRoute().
//
// RETRY CONTRACT (preserved verbatim in spirit from the 2026-08-09 fix this function grew out
// of — do not "simplify" it away): multicall() maps an RPC-level batch failure (e.g. a 429 under
// the burst of concurrent route-lookups the claim preview fires) to `{success:false}` for every
// call in that batch, which is INDISTINGUISHABLE from "checked, pool doesn't exist" if every
// single result comes back unsuccessful. Confirmed live: WETH, AERO and cbBTC all genuinely have
// deep, obviously-liquid USDC pools (verified via raw eth_call), yet route lookup returned "no
// pool" for all three under real page load — every probe had come back `{success:false}`, not a
// real "checked all combos, zero found." So: a PAIR whose every probe failed is treated as an
// RPC failure and re-probed (only the still-failing pairs are retried, not the whole batch); a
// pair with at least one successful (even zero-address) result is trusted as real "no pool here"
// signal and not retried. Throws — rather than reporting "no route" — if any pair is still a
// total failure after every attempt, so callers never confuse "the network gave us nothing to go
// on" with "checked, no route."
export async function discoverAerodromePools(pairs) {
  const found = new Map();
  let pending = pairs.filter(([a, b]) => {
    if (a.toLowerCase() === b.toLowerCase()) {
      found.set(pairKey(a, b), []); // a token has no pool with itself; nothing to probe
      return false;
    }
    return true;
  });

  for (let attempt = 1; attempt <= ROUTE_LOOKUP_RETRIES && pending.length; attempt++) {
    const results = await multicall(AERODROME.chainId, pending.flatMap(([a, b]) => aerodromePoolProbes(a, b)));
    const stillPending = [];
    pending.forEach(([a, b], i) => {
      const { candidates, anySuccess } = decodeAerodromePoolProbes(
        results.slice(i * AERODROME_PROBES_PER_PAIR(), (i + 1) * AERODROME_PROBES_PER_PAIR())
      );
      if (anySuccess) found.set(pairKey(a, b), candidates);
      else stillPending.push([a, b]);
    });
    pending = stillPending;
    if (pending.length && attempt < ROUTE_LOOKUP_RETRIES) {
      const names = pending.map(([a, b]) => `${short(a)} <-> ${short(b)}`).join(', ');
      logErr(`pool lookup for ${names}: every probe in the batch failed (attempt ${attempt}/${ROUTE_LOOKUP_RETRIES}) — retrying`, new Error('total batch failure'));
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  if (pending.length) {
    const names = pending.map(([a, b]) => `${short(a)} <-> ${short(b)}`).join(', ');
    throw transientError(`route lookup for ${names} failed after ${ROUTE_LOOKUP_RETRIES} attempts — every RPC batch came back empty`);
  }
  return found;
}

// Single-pair convenience over discoverAerodromePools(): returns ALL pool candidates for a pair,
// best-effort ordered (V2 stable, V2 volatile, then CL by deployment/tick spacing) — that order
// is only a provisional preference, the real winner is picked by live quote, see
// quoteAerodromeRoute(). An empty array means "checked every known factory/spacing, genuinely no
// pool"; a lookup that never got real signal throws instead.
export async function findAerodromePoolRoute(tokenA, tokenB) {
  const found = await discoverAerodromePools([[tokenA, tokenB]]);
  return found.get(pairKey(tokenA, tokenB)) || [];
}

export async function findAerodromeUsdcRoute(token) {
  return findAerodromePoolRoute(token, AERODROME_CLAIM.usdc);
}

// Bridge tokens tried as an intermediate hop when a claimed token has no DIRECT USDC pool —
// Aerodrome's three deepest, most-liquid non-USDC quote assets (confirmed live via symbol():
// WETH, AERO, USDbC — the legacy bridged USDC, ~1:1 with native USDC and itself deeply pooled
// against it). Bounded, deliberately: a token with no direct USDC pool AND no pool against any
// of these three is left unswapped rather than pathfinding further — Base has 34,707 registered
// pools with no reverse "pools containing token X" index (see the AERODROME_CLAIM session note),
// so true unbounded multi-hop pathfinding would mean enumerating pools rather than checking
// candidates, which is a different, much larger feature. Two hops (claimed token -> bridge
// token -> USDC) covers the realistic case: Aerodrome's own liquidity is concentrated around
// USDC/WETH/AERO, so anything with real liquidity at all almost always pairs with one of these.
// Lazily memoized (not a module-load-time array literal) — same circular-import init-order
// hazard as AERODROME_PROBES_PER_PAIR above.
let _bridgeTokens = null;
export function AERODROME_BRIDGE_TOKENS() {
  if (!_bridgeTokens) {
    _bridgeTokens = [
      '0x4200000000000000000000000000000000000006', // WETH (the standard OP-stack predeploy address)
      AERODROME.token, // AERO
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
    ];
  }
  return _bridgeTokens;
}

// Builds EVERY viable 2-hop route (claimed token -> bridge token -> USDC) for a token with no
// usable direct USDC route — one entry per AERODROME_BRIDGE_TOKENS candidate that has pools on
// BOTH hops, each entry being a ready-to-quote legs array `[{ tokenIn, tokenOut, route,
// candidates }]` in the same shape resolveAerodromeRoute() returns. Returns `[]` when no bridge
// works. Callers quote each entry and keep the best rather than committing to the first (see
// quoteAerodromeRoute) — before 2026-08-09 this returned only the first bridge with pools on
// both hops, so one bad/illiquid bridge pool disqualified the token outright.
//
// All six pairs (token<->each bridge, plus each bridge<->USDC) are discovered in ONE batched
// request, not six sequential lookups — this used to be up to 12 RPC round-trips per token and
// is now 1, which matters because rate limiting is exactly what was making these lookups fail.
// A lookup failure (see discoverAerodromePools' retry/throw contract) propagates rather than
// being swallowed as "no route" — a network failure isn't real "no route" signal.
export async function findAerodromeMultiHopRoute(token) {
  const bridges = AERODROME_BRIDGE_TOKENS().filter(
    (b) => b.toLowerCase() !== token.toLowerCase() && b.toLowerCase() !== AERODROME_CLAIM.usdc.toLowerCase()
  );
  const pools = await discoverAerodromePools([
    ...bridges.map((b) => [token, b]),
    ...bridges.map((b) => [b, AERODROME_CLAIM.usdc]),
  ]);

  const options = [];
  for (const bridge of bridges) {
    const hop1 = pools.get(pairKey(token, bridge)) || [];
    const hop2 = pools.get(pairKey(bridge, AERODROME_CLAIM.usdc)) || [];
    if (!hop1.length || !hop2.length) continue;
    options.push([
      { tokenIn: token, tokenOut: bridge, route: hop1[0], candidates: hop1 },
      { tokenIn: bridge, tokenOut: AERODROME_CLAIM.usdc, route: hop2[0], candidates: hop2 },
    ]);
  }
  return options;
}

// Builds the approve() + swap calldata to consolidate one claimed token into `tokenOut` — USDC
// for a direct route, or a bridge token (see AERODROME_BRIDGE_TOKENS) for a multi-hop route's
// first leg. V2-style pools go through Router.swapExactTokensForTokens(amountIn, amountOutMin,
// Route[], to, deadline) with a single-element Route (from, to, stable, factory); CL pools go
// through the latest Slipstream SwapRouter's exactInputSingle. minOut is the caller's
// responsibility (a live quote with slippage tolerance applied).
export function buildAerodromeSwapTxs(token, amount, route, tokenOut, minOut, recipient, deadline, venue = aerodromeVenue()) {
  const approveData = '0x095ea7b3' + encodeAddress(route.kind === 'v2' ? venue.router : route.router) + encodeUint256(amount);
  const approveTx = { label: `approve ${short(token)}`, to: token, data: approveData, chainId: venue.chainId };

  if (route.kind === 'v2') {
    // swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes,
    // address to, uint256 deadline) — 5 head words, routes offset points past all of them.
    const data = '0xcac88ea9'
      + encodeUint256(amount)
      + encodeUint256(minOut)
      + encodeUint256(5n * 32n)
      + encodeAddress(recipient)
      + encodeUint256(deadline)
      + encodeUint256(1n) // Route[] length
      + encodeAddress(token) // from
      + encodeAddress(tokenOut) // to
      + encodeUint256(route.stable ? 1n : 0n) // stable
      + encodeAddress(venue.poolFactory); // factory
    return [approveTx, { label: `swap ${short(token)} → ${short(tokenOut)}`, to: venue.router, data, chainId: venue.chainId }];
  }

  // CL: exactInputSingle(ExactInputSingleParams) — struct field order (tokenIn, tokenOut,
  // tickSpacing, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96) confirmed
  // against aerodrome-finance/slipstream's own ISwapRouter.sol; selector computed from that exact
  // signature (0xa026383e), not assumed from Uniswap V3's differently-shaped params (Uniswap uses
  // `fee`, not `tickSpacing`, which would produce a different selector entirely).
  const data = '0xa026383e'
    + encodeAddress(token)
    + encodeAddress(tokenOut)
    + encodeUint256(route.tickSpacing)
    + encodeAddress(recipient)
    + encodeUint256(deadline)
    + encodeUint256(amount)
    + encodeUint256(minOut)
    + encodeUint256(0n);
  return [approveTx, { label: `swap ${short(token)} → ${short(tokenOut)} (CL)`, to: route.router, data, chainId: venue.chainId }];
}

// ABI-encodes a `bytes` value the way a dynamic-bytes function argument is encoded: a length
// word followed by the data, right-padded to a 32-byte multiple.
export function encodeBytesArg(hexData) {
  const clean = hexData.replace(/^0x/, '');
  const byteLen = clean.length / 2;
  const paddedHexLen = Math.ceil(clean.length / 64) * 64;
  return encodeUint256(BigInt(byteLen)) + clean.padEnd(paddedHexLen, '0');
}

// Encodes Across's MulticallHandler `Instructions` struct — {Call[] calls, address
// fallbackRecipient}, Call = {address target, bytes callData, uint256 value} — into the raw
// bytes handleV3AcrossMessage() will abi.decode() as the deposit's `message` field. Verified
// byte-for-byte against ethers.js's AbiCoder.encode(['tuple(tuple(address,bytes,uint256)[],
// address)'], [...]) in a scratchpad, including the top-level offset word abi.decode(data, (T))
// expects even for a single dynamic-tuple parameter (confirmed this is required, not optional —
// an earlier version of this function omitted it and produced calldata 32 bytes short).
export function encodeMulticallInstructions(calls, fallbackRecipient) {
  let callsHead = encodeUint256(BigInt(calls.length));
  let callsTail = '';
  let runningOffset = BigInt(calls.length) * 32n;
  const callBlobs = calls.map((c) => {
    const callDataEnc = encodeBytesArg(c.data);
    return encodeAddress(c.to) + encodeUint256(3n * 32n) + encodeUint256(c.value || 0n) + callDataEnc;
  });
  callBlobs.forEach((blob) => {
    callsHead += encodeUint256(runningOffset);
    runningOffset += BigInt(blob.length / 2);
  });
  callBlobs.forEach((blob) => { callsTail += blob; });

  const instructionsBody = encodeUint256(2n * 32n) + encodeAddress(fallbackRecipient) + callsHead + callsTail;
  return '0x' + encodeUint256(32n) + instructionsBody;
}

// Builds the full Across bridge leg: approve USDC to Base's SpokePool, then
// depositV3Now() bridging it to Across's MulticallHandler on Ethereum mainnet with a
// composed message that swaps through Curve's crvUSD/USDC pool and sweeps the result
// to the user. `outputAmount` is Across's own quoted guarantee (from
// /api/suggested-fees) — the Handler is GUARANTEED to receive exactly this much USDC,
// so the approve/exchange calldata can use it directly with no on-chain balance
// injection needed; only the final crvUSD sweep (drainLeftoverTokens) needs to react
// to the swap's actual output, which it does by reading live balance, not calldata.
/* `origin` selects the chain the bridge STARTS on, defaulting to Base so Aerodrome's call sites are
   unchanged. Velodrome's mainnet leg departs from Optimism instead, and this must be a real
   parameter rather than a chain-id swap: **Across's SpokePool is a different address per chain**
   (it is not CREATE2-deterministic, unlike the MulticallHandler). Base's is
   0x6C99671B…, Optimism's is 0x6f26Bf09… — taken from Across's own suggested-fees API response for
   an Optimism origin and confirmed to have bytecode there. Reusing Base's address on an Optimism
   origin would approve and deposit into a contract that is not the SpokePool. */
// Lazy for the same import-cycle reason as aerodromeVenue() above.
export const acrossBaseOrigin = () => ({
  chainId: AERODROME.chainId,
  spokePool: ACROSS.baseSpokePool,
  usdc: AERODROME_CLAIM.usdc,
  name: 'Base',
});

export function buildAcrossBridgeTxs({ account, inputAmount, outputAmount, minCrvUsdOut, skipCrvUsdSwap, origin = acrossBaseOrigin() }) {
  const approveTx = {
    label: `approve USDC (${origin.name}) → Across SpokePool`,
    to: origin.usdc,
    data: '0x095ea7b3' + encodeAddress(origin.spokePool) + encodeUint256(inputAmount),
    chainId: origin.chainId,
  };

  // The user can opt out of the final Curve leg and keep the bridged USDC as USDC on mainnet
  // instead — same Handler self-call pattern (drainLeftoverTokens), just sweeping USDC directly
  // rather than swapping through the crvUSD/USDC pool first.
  let message;
  if (skipCrvUsdSwap) {
    const sweepUsdc = {
      to: ACROSS.multicallHandler,
      data: '0xef8738d3' + encodeAddress(ACROSS.mainnetUsdc) + encodeAddress(account),
      value: 0n,
    };
    message = encodeMulticallInstructions([sweepUsdc], account);
  } else {
    const curveApprove = {
      to: ACROSS.mainnetUsdc,
      data: '0x095ea7b3' + encodeAddress(CURVE_CRVUSD_USDC_POOL) + encodeUint256(outputAmount),
      value: 0n,
    };
    const curveExchange = {
      to: CURVE_CRVUSD_USDC_POOL,
      // exchange(int128 i=0 [USDC], int128 j=1 [crvUSD], uint256 dx, uint256 min_dy)
      data: '0x3df02124' + encodeUint256(0n) + encodeUint256(1n) + encodeUint256(outputAmount) + encodeUint256(minCrvUsdOut),
      value: 0n,
    };
    const sweepCrvUsd = {
      to: ACROSS.multicallHandler, // self-call — see drainLeftoverTokens()'s onlySelf modifier
      data: '0xef8738d3' + encodeAddress(CURVE.crvUsd) + encodeAddress(account),
      value: 0n,
    };
    message = encodeMulticallInstructions([curveApprove, curveExchange, sweepCrvUsd], account);
  }

  const depositTx = {
    label: skipCrvUsdSwap
      ? `bridge USDC (${origin.name} → mainnet) via Across`
      : `bridge USDC (${origin.name} → mainnet) + swap to crvUSD via Across`,
    to: origin.spokePool,
    data: '0x7aef642c'
      + encodeAddress(account) // depositor
      + encodeAddress(ACROSS.multicallHandler) // recipient (mainnet)
      + encodeAddress(origin.usdc) // inputToken (origin chain)
      + encodeAddress(ACROSS.mainnetUsdc) // outputToken (mainnet)
      + encodeUint256(inputAmount)
      + encodeUint256(outputAmount)
      + encodeUint256(BigInt(ETH_MAINNET)) // destinationChainId
      + encodeAddress('0x0000000000000000000000000000000000000000') // exclusiveRelayer — none required
      + encodeUint256(21600n) // fillDeadlineOffset — 6h, Across's own frontend default
      + encodeUint256(0n) // exclusivityParameter
      + encodeUint256(11n * 32n) // offset to message
      + encodeBytesArg(message),
    chainId: origin.chainId,
  };

  return [approveTx, depositTx];
}

// Assembles the full Aerodrome "claim to mainnet" plan: claim transactions, one
// approve+swap pair per distinct claimed token that has a direct USDC route, and the
// Across bridge+compose transaction — WITHOUT sending anything yet. Amounts for the
// swap/bridge legs are live quotes (Router.getAmountsOut / CL Quoter / Curve get_dy /
// Across's own fee API), each with a slippage tolerance applied for the min-out guard;
// actual on-chain execution re-quotes the bridge leg right before sending it (see
// runAerodromeClaimFlow()) since the exact USDC produced by the swaps isn't known
// until they've actually executed.
// Whole-preview re-sweeps for tokens the network never answered for, and the pause before each.
// Deliberately longer than the per-call retry backoff inside discoverAerodromePools /
// quoteAerodromeCandidates: those retries fire within a few hundred ms of each other, so a
// rate-limiting endpoint usually rejects all of them together. Waiting seconds between sweeps is
// what actually lets a 429 window expire.
export const PREVIEW_RESOLVE_SWEEPS = 3;
export const PREVIEW_RESOLVE_BACKOFF_MS = 1500;

export const SLIPPAGE_BPS = 100n; // 1% tolerance applied to every quoted min-out guard below
export const applySlippage = (amount) => amount - (amount * SLIPPAGE_BPS) / 10000n;

// Resolves how to get `token` into USDC — a direct pool if one exists, else a 2-hop route
// through AERODROME_BRIDGE_TOKENS (see findAerodromeMultiHopRoute) — as a uniform list of
// `{ tokenIn, tokenOut, route, candidates }` legs (length 1 for a direct route, length 2 for
// multi-hop) so every downstream caller (quoting, tx-building) can treat both cases identically.
// Returns `null` only when both attempts genuinely checked every known pool/factory and found
// nothing — a route-LOOKUP failure (RPC batch never came back with real signal — see
// discoverAerodromePools'/findAerodromePoolRoute's retry contract) throws instead, so callers
// don't confuse "the network gave us nothing to go on" with "checked, no route."
//
// `leg.route` is a PROVISIONAL pick (the first candidate) purely so the returned shape is
// immediately usable; `leg.candidates` carries every pool that exists for that hop and
// quoteAerodromeRoute() overwrites `leg.route` with whichever one actually quotes best.
//
// The returned array also carries `fallbackOptions`, an ASYNC THUNK yielding alternative
// complete routes to try if every candidate on this one fails to quote. It's a thunk, not an
// eagerly-computed array, on purpose: when a direct pool exists (the overwhelmingly common
// case) the bridge-token discovery it would do is a wasted RPC round-trip, and these lookups
// share heavily rate-limited public RPCs. It also has to live here rather than being re-derived
// at quote time because quoteAerodromeRoute() is given legs, not a token. Extra properties on
// the array are additive — the array itself is still exactly the documented legs list.
export async function resolveAerodromeRoute(token) {
  // Degenerate case, preserved from the previous implementation: callers already filter USDC
  // out of the swap set (it needs no consolidation), so this is defensive only.
  if (token.toLowerCase() === AERODROME_CLAIM.usdc.toLowerCase()) {
    return [{ tokenIn: token, tokenOut: AERODROME_CLAIM.usdc, route: { kind: 'none' }, candidates: [{ kind: 'none' }] }];
  }

  const direct = await findAerodromeUsdcRoute(token);
  if (direct.length) {
    const legs = [{ tokenIn: token, tokenOut: AERODROME_CLAIM.usdc, route: direct[0], candidates: direct }];
    legs.fallbackOptions = () => findAerodromeMultiHopRoute(token);
    return legs;
  }

  const options = await findAerodromeMultiHopRoute(token);
  if (!options.length) return null;
  const legs = options[0];
  legs.fallbackOptions = () => options.slice(1);
  return legs;
}

// Quotes EVERY candidate pool for ONE hop and returns the ones that produced a usable (strictly
// nonzero) output, best first. This is what makes a bad pool a non-event: a candidate whose
// quote reverts (an existing but empty/unusable pool — confirmed live: AERO/USDC's CL dep-1
// ts-1 pool and cbBTC/USDC's CL dep-0 ts-50 pool both revert while their siblings quote fine)
// simply loses, instead of disqualifying the whole token the way the old first-match lookup did.
//
// Candidates are quoted in a SINGLE Multicall3 batch rather than one eth_call each — verified
// live 2026-08-09 that both quote paths work inside aggregate3 and return byte-identical values
// to the un-batched eth_call (Slipstream's QuoterV2 catches its own simulated-swap revert
// internally, so a successful quote returns normally through Multicall3's low-level call, and a
// failing one lands in allowFailure's `success:false` rather than blowing up the batch). One
// candidate is quoted directly instead: it's the same single request either way, and the
// un-batched path surfaces the real revert reason for the error `detail` a batch would swallow.
//
// Same "a batch where EVERY call failed is RPC noise, not signal" contract as
// discoverAerodromePools(): retried while nothing at all comes back, then throws. A batch where
// at least one candidate answered is trusted, and `[]` from it means the real, checked
// "every pool for this hop exists but none can quote this amount."
//
// A zero output is treated as unusable, not as a valid quote: it would otherwise flow into
// applySlippage() and produce a minOut of 0 — a swap with no slippage guard at all.
export async function quoteAerodromeCandidates(tokenIn, amount, candidates, tokenOut) {
  if (candidates.length === 1) {
    const out = await quoteAerodromeSwapWithRetry(tokenIn, amount, candidates[0], tokenOut);
    return out > 0n ? [{ route: candidates[0], out }] : [];
  }

  const calls = candidates.map((route) => aerodromeQuoteCall(tokenIn, amount, route, tokenOut));
  for (let attempt = 1; attempt <= ROUTE_LOOKUP_RETRIES; attempt++) {
    const results = await multicall(AERODROME.chainId, calls);
    const quotes = [];
    let anySuccess = false;
    results.forEach((r, i) => {
      if (!r || !r.success) return;
      anySuccess = true;
      let out;
      try {
        out = decodeAerodromeQuote(candidates[i], r.returnData);
      } catch {
        return; // unreadable return from a "successful" call — treat this pool as unquotable
      }
      if (out > 0n) quotes.push({ route: candidates[i], out });
    });
    if (anySuccess) {
      quotes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
      return quotes;
    }
    if (attempt < ROUTE_LOOKUP_RETRIES) {
      logErr(`quotes for ${short(tokenIn)} → ${short(tokenOut)}: every one of ${candidates.length} candidate pools failed (attempt ${attempt}/${ROUTE_LOOKUP_RETRIES}) — retrying`, new Error('total batch failure'));
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw transientError(`quoting ${short(tokenIn)} → ${short(tokenOut)} failed after ${ROUTE_LOOKUP_RETRIES} attempts — every RPC batch came back empty`);
}

// Retries a single quote call up to ROUTE_LOOKUP_RETRIES times — quote calls hit the same
// shared public RPCs as route-lookups, so under the same burst load that made
// findAerodromePoolRoute need retries (see its comment), a quote can transiently fail (e.g.
// "over rate limit") even for a real, just-confirmed-to-exist pool. Without this, that
// transient failure would incorrectly mark an otherwise-swappable token as 'quote-failed'.
export async function quoteAerodromeSwapWithRetry(token, amount, route, tokenOut) {
  for (let attempt = 1; attempt <= ROUTE_LOOKUP_RETRIES; attempt++) {
    try {
      return await quoteAerodromeSwap(token, amount, route, tokenOut);
    } catch (err) {
      if (attempt === ROUTE_LOOKUP_RETRIES) throw err;
      logErr(`quote for ${short(token)} → ${short(tokenOut)} failed (attempt ${attempt}/${ROUTE_LOOKUP_RETRIES}) — retrying`, err);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

// Quotes a resolved route and returns the legs annotated with `quotedOut`/`minOut`
// (slippage-adjusted) plus the final USDC output. Each leg is quoted in sequence, feeding its
// output into the next leg's input — the only way to quote a 2-hop route, since there's no
// on-chain "quote a path" call for these pools.
//
// Two levels of graceful degradation, both added 2026-08-09 after live runs showed real,
// deeply-liquid tokens being dropped from the preview entirely:
//
//   1. WITHIN a leg — every pool that exists for that hop is quoted and the highest output
//      wins (quoteAerodromeCandidates). Picking per-leg maximum output is also the globally
//      optimal choice for a fixed route shape here, since a pool's output is monotonically
//      non-decreasing in its input, so the best hop-1 output also maximizes what hop 2 can
//      produce. This is a value fix as much as a reliability one: measured live, routing
//      1 WETH through the first-probed pool instead of the best one gave up 17.6% of it.
//
//   2. ACROSS routes — if EVERY candidate on the primary route fails to quote, the route's
//      `fallbackOptions` thunk (see resolveAerodromeRoute) is asked for alternatives — the
//      2-hop bridge-token routes — and every one of them is quoted, keeping the best. A direct
//      route that quotes is always preferred over any bridge route regardless of output: a
//      second hop means a second pool's slippage, a second approval, and more gas, and it is
//      only ever reached here because the direct route produced nothing usable at all.
//
// Throws only when NO route produced a usable quote, re-raising the last real failure so the
// caller's 'quote-failed' detail says what actually went wrong (a network-level "every RPC batch
// came back empty" and a real "these pools can't quote this amount" read differently on purpose).
export async function quoteAerodromeRoute(legs, amountIn) {
  const quoteOption = async (option) => {
    let amount = amountIn;
    const quotedLegs = [];
    for (const leg of option) {
      const candidates = leg.candidates && leg.candidates.length ? leg.candidates : [leg.route];
      const quotes = await quoteAerodromeCandidates(leg.tokenIn, amount, candidates, leg.tokenOut);
      if (!quotes.length) {
        throw new Error(`no usable quote for ${short(leg.tokenIn)} → ${short(leg.tokenOut)} across ${candidates.length} pool(s)`);
      }
      const winner = quotes[0];
      // `route` is overwritten with the winning candidate — buildAerodromeSwapTxs() and the
      // execution-time re-quote in runAerodromeClaimFlow() both read leg.route, so the pool the
      // preview quoted is exactly the pool the swap goes through.
      quotedLegs.push({ ...leg, route: winner.route, amountIn: amount, quotedOut: winner.out, minOut: applySlippage(winner.out), quotes });
      amount = winner.out;
    }
    return { legs: quotedLegs, quotedUsdcOut: amount };
  };

  let lastErr = null;
  let sawTransient = false;
  let optionsTried = 0;
  try {
    optionsTried++;
    const primary = await quoteOption(legs);
    // `via` names which route won, for the preview UI: 'direct' for a single-hop route, or the
    // bridge token's address for a 2-hop one.
    return { ...primary, optionsTried, via: legs.length === 1 ? 'direct' : legs[0].tokenOut };
  } catch (err) {
    lastErr = err;
    sawTransient = !!err.transient;
    logErr(`primary route for ${short(legs[0]?.tokenIn)} → USDC produced no usable quote — trying bridge routes`, err);
  }

  // Discovering the fallback routes can itself fail at the network level (see
  // discoverAerodromePools' throw contract). That must not replace the primary route's error —
  // the token is skipped either way, and the primary failure is the more informative `detail`.
  let fallbacks = [];
  try {
    fallbacks = (await legs.fallbackOptions?.()) || [];
  } catch (err) {
    logErr(`bridge-route lookup for ${short(legs[0]?.tokenIn)} failed — keeping the primary route's error`, err);
  }

  let best = null;
  for (const option of fallbacks) {
    optionsTried++;
    try {
      const quoted = await quoteOption(option);
      if (!best || quoted.quotedUsdcOut > best.quotedUsdcOut) best = { ...quoted, via: option[0].tokenOut };
    } catch (err) {
      sawTransient = sawTransient || !!err.transient;
      lastErr = err; // one bad bridge must not disqualify the rest
    }
  }
  if (best) return { ...best, optionsTried };
  // If ANY attempt failed for a network reason, the whole failure is transient regardless of
  // which error happens to be `lastErr` — a later non-transient bridge error must not mask an
  // earlier transient one and downgrade the token to a permanent skip. We genuinely do not know
  // this token is unroutable; we only know we never got a complete answer.
  if (sawTransient) lastErr.transient = true;
  throw lastErr;
}

// Resolves ONE claimed token into a swap step, a permanent skip, or "the network never
// answered" — the exact three-way outcome buildAerodromeClaimPreview's per-token loop needs,
// pulled out to a top-level function so it can ALSO be called for a single token in isolation
// (see showClaimPreviewPanel's per-row Retry, which re-resolves exactly the one token whose
// row it's on, in place, without rebuilding the rest of the preview — resolving a single token
// was never actually impossible, just not previously exposed as its own entry point). Logging
// lives here rather than at each call site so both callers get identical console output.
export async function resolveAerodromeToken(token, amount, label) {
  let legs;
  try {
    legs = await resolveAerodromeRoute(token);
  } catch (err) {
    if (err.transient) {
      logErr(`route lookup for ${short(token)} got no answer from any endpoint (${label}) — will retry, not skipping`, err);
      return { kind: 'unresolved', detail: err.message };
    }
    logErr(`route lookup failed for ${short(token)} — skipping this token`, err);
    return { kind: 'skipped', reason: 'no-route', detail: err.message };
  }
  if (!legs) return { kind: 'skipped', reason: 'no-route' };
  try {
    const { legs: quotedLegs, quotedUsdcOut } = await quoteAerodromeRoute(legs, amount);
    return { kind: 'resolved', step: { token, amount, legs: quotedLegs, quotedUsdcOut } };
  } catch (err) {
    if (err.transient) {
      logErr(`quoting ${short(token)} got no answer from any endpoint (${label}) — will retry, not skipping`, err);
      return { kind: 'unresolved', detail: err.message };
    }
    logErr(`quote failed for ${short(token)} → USDC — skipping this token`, err);
    return { kind: 'skipped', reason: 'quote-failed', detail: err.message };
  }
}

// Real per-token decimals for display only (e.g. cbBTC's 8 vs. the 18 most claimed reward
// tokens use) — a nonzero balance would otherwise render as a misleading "0.0000" by assuming
// every token is 18-decimal. Single-token version of the bulk multicall
// buildAerodromeClaimPreview does for its whole swapSteps list at once — used when a row-level
// Retry resolves just one token and needs its own decimals without re-fetching everyone else's.
// Defaults to 18 (this app's existing convention for an unreadable decimals()) rather than
// failing the whole retry over a display-only detail.
export async function fetchAerodromeTokenDecimals(token) {
  try {
    const raw = await chainCall(AERODROME.chainId, token, '0x313ce567');
    return Number(word(raw, 0));
  } catch {
    return 18;
  }
}

// Quotes the Across + Curve bridge leg for a given USDC amount — pulled out of
// buildAerodromeClaimPreview so the SAME logic can be re-run after a row-level Retry changes
// how much USDC there is to bridge (see showClaimPreviewPanel), not just once at preview-build
// time. Returns nulls (never throws) exactly as the inline version did — a bridge-quote failure
// is not fatal to the preview, just an "unavailable, will be re-quoted at send time" line.
export async function quoteAerodromeBridgeLeg(estimatedUsdc, onProgress = () => {}) {
  let acrossQuote = null;
  let curveQuote = null;
  if (estimatedUsdc > 0n) {
    onProgress({ fraction: 0.85, text: 'Quoting Across bridge to Ethereum mainnet…' });
    try {
      acrossQuote = await fetchAcrossSuggestedFees(estimatedUsdc);
    } catch (err) {
      logErr('Across fee quote failed', err);
    }
    if (acrossQuote) {
      onProgress({ fraction: 0.95, text: 'Quoting Curve crvUSD/USDC pool…' });
      try {
        const dy = await chainCall(
          ETH_MAINNET,
          CURVE_CRVUSD_USDC_POOL,
          '0x5e0d443f' + encodeUint256(0n) + encodeUint256(1n) + encodeUint256(acrossQuote.outputAmount)
        );
        curveQuote = word(dy, 0);
      } catch (err) {
        logErr('Curve crvUSD/USDC quote failed', err);
      }
    }
  }
  return { acrossQuote, curveQuote };
}

// `onProgress({ fraction, text })` is called at each phase boundary so a caller (the claim
// button's busy indicator — see setClaimProgress()) can show real, non-fake progress rather
// than an indefinite spinner for what can be a genuinely multi-second operation once
// findAerodromePoolRoute()'s retries kick in under RPC load. Phases are weighted roughly by
// how long they actually take in practice (route-finding/quoting per token dominates; reading
// the claim plan and quoting the bridge leg are comparatively quick), not evenly split —
// fractions are a UX approximation, not a real work-unit count.
// Spot USD value of one swap step's claimed amount, used only to ORDER the steps (largest first)
// so the transaction list matches the token list above it. Returns 0 for anything unpriced, which
// sorts those steps to the bottom — an unknown value can't be ranked, and guessing would put a
// dust token above a real one. Never used as a displayed figure; priceClaimPreview() owns those.
export function usdValueOfSwapStep(step, pricedTokens) {
  const meta = pricedTokens?.[String(step.token).toLowerCase()];
  if (!meta || meta.price == null) return 0;
  const decimals = meta.decimals ?? step.decimals ?? 18;
  return (Number(step.amount) / 10 ** decimals) * meta.price;
}

/* `origin` defaults to Base, unchanged for Aerodrome. Verified live for an Optimism origin
   (2026-08-12): a $1,000 probe quotes 999.878 USDC out, a 0.012% fee, so the OP Mainnet → Ethereum
   mainnet leg TASKS.md listed as unconfirmed is real and cheap. Its response is also where
   Optimism's SpokePool address came from. */
export async function fetchAcrossSuggestedFees(inputAmount, origin = acrossBaseOrigin()) {
  const url = `https://app.across.to/api/suggested-fees?inputToken=${origin.usdc}&outputToken=${ACROSS.mainnetUsdc}&originChainId=${Number(origin.chainId)}&destinationChainId=${Number(ETH_MAINNET)}&amount=${inputAmount}`;
  const json = await fetchJson(url);
  return { inputAmount, outputAmount: BigInt(json.outputAmount) };
}

// Builds the (target, callData) for a single swap route's output quote — Router.getAmountsOut()
// for V2 pools, the matching CL deployment's Quoter for concentrated-liquidity pools (QuoterV2's
// quoteExactInputSingle, a non-view function meant to be called via eth_call/staticcall rather
// than sent as a real transaction — same pattern this app already uses elsewhere for
// "state-changing but simulated via eth_call" reads, e.g. Curve's FeeDistributor.claim()).
// `tokenOut` is USDC for a direct route, or the bridge token for a multi-hop route's first leg
// (see AERODROME_BRIDGE_TOKENS/findAerodromeMultiHopRoute).
//
// Emitted as a probe rather than executed so the same encoding serves both the single
// eth_call path (quoteAerodromeSwap below) and the batched multi-candidate path
// (quoteAerodromeCandidates) — one encoder, so the two can never drift apart.
export function aerodromeQuoteCall(token, amount, route, tokenOut) {
  if (route.kind === 'v2') {
    // getAmountsOut(uint256,(address,address,bool,address)[]) — selector verified via keccak
    // in a scratchpad, not assumed. Route[] elements are a fully-static tuple, so the array is
    // [length][element...] inline with no per-element offsets (unlike a dynamic-element array).
    const routeTuple = encodeAddress(token) + encodeAddress(tokenOut) + encodeUint256(route.stable ? 1n : 0n) + encodeAddress(AERODROME_CLAIM.poolFactory);
    return {
      target: AERODROME_CLAIM.router,
      callData: '0x5509a1ac' + encodeUint256(amount) + encodeUint256(2n * 32n) + encodeUint256(1n) + routeTuple,
    };
  }
  // CL: quoteExactInputSingle(QuoteExactInputSingleParams) — struct field order (tokenIn,
  // tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96) and selector (0x9e7defe6) confirmed
  // against aerodrome-finance/slipstream's own IQuoterV2.sol, same verification standard as
  // exactInputSingle's selector above — NOT assumed from Uniswap's differently-ordered params.
  // Uses the SAME deployment's quoter as the pool findAerodromeUsdcRoute() found (route.quoter).
  return {
    target: route.quoter,
    callData: '0x9e7defe6'
      + encodeAddress(token)
      + encodeAddress(tokenOut)
      + encodeUint256(amount)
      + encodeUint256(route.tickSpacing)
      + encodeUint256(0n),
  };
}

// Decodes what aerodromeQuoteCall()'s probe returns into a plain output amount.
export function decodeAerodromeQuote(route, raw) {
  if (route.kind === 'v2') {
    // returns uint256[] amounts — last element is the output amount
    const arrStart = Number(word(raw, 0)) / 32;
    const len = Number(word(raw, arrStart));
    return word(raw, arrStart + len);
  }
  return word(raw, 0); // amountOut is the first return value
}

// Quotes ONE route's expected output via a single eth_call.
export async function quoteAerodromeSwap(token, amount, route, tokenOut) {
  const { target, callData } = aerodromeQuoteCall(token, amount, route, tokenOut);
  return decodeAerodromeQuote(route, await chainCall(AERODROME.chainId, target, callData));
}

// Polls for a transaction receipt — the wallet's own eth_sendTransaction resolves as soon as
// the tx is SIGNED AND BROADCAST, not once it's mined, so every step here that depends on a
// prior step's on-chain effect (e.g. reading the resulting USDC balance before swapping, or
// not sending the bridge deposit before the swaps have actually settled) needs to explicitly
// wait for inclusion first.
/* ---------- transaction success popup ---------- */
// Lightweight canvas confetti — no dependency, ~1.5s burst, respects prefers-reduced-motion by
// simply never being started (see showTxSuccessPopup). Runs on its own rAF loop and tears itself
// down (canvas removed) when every particle has left the viewport or faded out, whichever first.
