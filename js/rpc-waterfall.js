import { MULTICALL3, MULTICALL_CHUNK_SIZE } from './protocols/config.js';
import { ARBITRUM, BASE_MAINNET, CELO, ETH_MAINNET, FRAXTAL, INK, LISK, METAL_L2, MODE, OPTIMISM, SONEIUM, SUPERSEED, SWELLCHAIN, UNICHAIN, chainName } from './core/chains.js';
import { state } from './core/state.js';
import { addrAt, decodeAggregate3, decodeString, encodeAggregate3, encodeUint256, log, logErr, short, word } from './core/utils.js';
import { rpc } from './wallet-connect.js';

export const PUBLIC_RPCS = {
  [ETH_MAINNET]: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://eth.drpc.org', 'https://eth-mainnet.public.blastapi.io', 'https://1rpc.io/eth'],
  [BASE_MAINNET]: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base-mainnet.public.blastapi.io', 'https://1rpc.io/base'],
  [OPTIMISM]: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org', 'https://mainnet.optimism.io', 'https://1rpc.io/op'],
  [ARBITRUM]: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum-one.public.blastapi.io', 'https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb'],
  // OP Superchain leaf chains (see VELODROME_LEAF_CHAINS above) — primary endpoint
  // is each chain's own official/foundation RPC, confirmed live via eth_chainId +
  // LpSugar.count() during that feature's verification. Swellchain's own
  // (swell-mainnet.alt.technology) returned 401 Unauthorized when tested — Ankr's
  // public proxy for it works and is used instead.
  [CELO]: ['https://celo-rpc.publicnode.com', 'https://forno.celo.org'],
  [FRAXTAL]: ['https://rpc.frax.com', 'https://fraxtal-rpc.publicnode.com'],
  [INK]: ['https://rpc-qnd.inkonchain.com', 'https://rpc-gel.inkonchain.com'],
  [LISK]: ['https://rpc.api.lisk.com', 'https://lisk.drpc.org'],
  [METAL_L2]: ['https://rpc.metall2.com', 'https://metall2.drpc.org'],
  [MODE]: ['https://mainnet.mode.network', 'https://mode.drpc.org'],
  [SONEIUM]: ['https://soneium-rpc.publicnode.com', 'https://rpc.soneium.org'],
  [SUPERSEED]: ['https://mainnet.superseed.xyz', 'https://superseed.drpc.org'],
  [SWELLCHAIN]: ['https://rpc.ankr.com/swell', 'https://1923.rpc.thirdweb.com'],
  [UNICHAIN]: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'],
};

/* All six portfolio data sources (veCRV, Votemarket, Aerodrome, Velodrome, Yield
   Basis, Clever veCLEV) are read straight from each protocol's own chain via a public RPC —
   never through the connected wallet's provider. The wallet is only used for
   eth_requestAccounts/eth_accounts (the address) and for the Connection card's
   own live balance/chain display. This means every data source can be fetched in
   parallel regardless of which network the wallet's extension happens to be
   pointed at, with no wallet-side network-switch prompts and no risk of leaving
   the wallet parked on a chain the user didn't choose. Endpoints are the same
   official public nodes (Ethereum: PublicNode, Base/Optimism: their own
   Foundation RPCs, Arbitrum: Offchain Labs') used throughout this app's own
   development verification. */
// Last-resort rescue shared by every publicRpc() exhaustion point below (both the network-level
// fetch-failure branch and the 429/eth_getLogs-capability-limit branch) — this is the single choke
// point every portfolio data source (Curve, Aerodrome, Velodrome, Votemarket, Yield Basis, Clever,
// Concentrator) already calls through, so fixing graceful degradation HERE covers all of them at
// once rather than needing a bespoke fallback at each call site. Deliberately NOT reached by
// eth_call's fail-fast revert path (see the `rotatable` comment below) — that failure is often
// expected/probed for (e.g. the ASSET_TOKEN() pricing probe trying candidate calls), and retrying
// it anywhere, wallet included, would be pure noise rather than a rescue.
// Fires only when a wallet happens to already be connected and sitting on the EXACT chain this
// call targets — this app's normal rule (portfolio data via public RPC only, see PUBLIC_RPCS's
// comment) still holds for the overwhelming majority of calls, which succeed through the public
// rotation; this exists purely so an otherwise-permanently-lost call (and the display gap it
// causes — a card silently missing tokens like AORA/TEA whose full-scan page never got an answer)
// gets one more real chance, sparingly, instead of none. A wallet vendor's own RPC infrastructure
// isn't sharing the public pool's rate limit, so it can succeed exactly when every public endpoint
// is saturated by this app's own request burst.
export async function walletRpcRescue(chainId, method, params) {
  if (!state.provider || state.chainId !== chainId) return undefined;
  try {
    return await rpc(method, params);
  } catch (err) {
    logErr(`wallet ${method} rescue also failed (${chainName(chainId)})`, err);
    return undefined;
  }
}

// "This endpoint is throttling me" — deliberately NOT just `code === 429`. Confirmed live
// (2026-08-11) against Base's primary public endpoint under this app's own full-pool-scan burst:
// mainnet.base.org rejects with JSON-RPC `code -32016, message "over rate limit"`, never the
// HTTP-style 429 the original check looked for. The consequence was severe and silent — a
// rate-limited window was classified as non-rotatable, so publicRpc skipped its endpoint
// rotation entirely and abandoned the call on the FIRST failure instead of trying any of the
// four healthy fallbacks. Measured on the test veNFT (34,771 pools / 232 windows): 105
// windows failed this way and 198 were still empty after the retry sweep, leaving the Aerodrome
// card showing 5 tokens where the claim panel (which rescans later, unthrottled) found 10 —
// exactly the "card silently missing tokens" symptom.
//
// Providers disagree on how to say this, so match the whole family rather than one code:
// -32005 is the standard JSON-RPC "limit exceeded" (Infura/Alchemy), -32016 is Base/QuickNode's
// "over rate limit", and some gateways only say it in the message. Matching the message too
// means a provider we haven't catalogued still degrades gracefully instead of silently dropping
// data. Costs nothing when wrong: the worst case is one extra pass through the endpoint rotation.
export function isRateLimited(error) {
  if (!error) return false;
  if (error.code === 429 || error.code === -32005 || error.code === -32016) return true;
  return /rate.?limit|too many requests|quota|throttl/i.test(String(error.message || ''));
}

/* Endpoints that have told us, recently, that we are over their rate limit — url -> timestamp
   until which to stop STARTING calls there. This is the single highest-impact performance fix in
   the app's RPC layer, and it is worth understanding why, because the naive reading of the code
   without it is that rotation already handles throttling.

   Measured live (2026-08-11, Aerodrome full-pool scan, test veNFT, 34,771 pools / 232 windows,
   3 runs each, otherwise identical code):

     before (always start at urls[0], 250ms backoff before rotating)   8.8s   ~500 calls  ~245 429s
     backoff only after the rotation wraps                             4.2s   ~503 calls  ~248 429s
     + skip recently-throttled endpoints (this)                        2.5s    275 calls    20 429s

   Confirmed in the browser too, running the real module against the real veNFT — 8,318ms before
   vs 2,641ms after, both returning the identical 10 reward tokens with complete=true. This is
   pure overhead removal, not a correctness/coverage trade. (Two things not worth re-deriving:
   `FULL_SCAN_CONCURRENCY` 24 -> 48 makes it WORSE — 12.5s, 15 unreadable windows, 5 tokens
   instead of 10 — and spreading each call's STARTING endpoint round-robin across the pool is also
   worse, 7.9-44s, because it moves real work onto the slower endpoints and wrecks tail latency.
   Skipping known-throttled endpoints beats both precisely because it keeps the work concentrated
   on the fastest endpoint that is currently answering.)

   The mechanism: under this app's own scan burst, Base's primary public endpoint
   (mainnet.base.org) rate-limits ~98% of what it is sent — across a full scan it served 6
   successes against 249 rejections. Because every call unconditionally STARTS at urls[0], each of
   the ~240 pages paid a guaranteed-to-fail round trip there before rotating to the endpoint that
   actually works. Rotation "handled" it in the sense that no data was lost; it just paid the toll
   232 times over. Remembering the rejection for a few seconds means the burst pays it roughly
   once per cooldown window instead.

   Deliberately NOT a permanent demotion or a reordering of PUBLIC_RPCS: mainnet.base.org is a
   perfectly good endpoint when this app isn't bursting (an idle single call never trips this at
   all, and the entry keeps its normal first-choice position), and a fixed short TTL means one
   unlucky 429 can't exile it. Set only on a genuine rate-limit signal (isRateLimited) — never on
   a revert, which is about the CALL's gas cost, not the endpoint's health, and would otherwise
   sideline a healthy endpoint over the full-pool scan's expected gas-cap reverts. */
export const THROTTLE_COOLDOWN_MS = 15_000;
export const endpointThrottledUntil = new Map(); // url -> epoch ms

// First endpoint at or after `from` that isn't in cooldown. Falls back to `from` when every
// endpoint is throttled — degrading to the old always-try-anyway behaviour is strictly better
// than refusing to make the call at all.
function firstHealthyIdx(urls, from) {
  const now = Date.now();
  for (let i = 0; i < urls.length; i++) {
    const idx = (from + i) % urls.length;
    if (!(endpointThrottledUntil.get(urls[idx]) > now)) return idx;
  }
  return from;
}

export async function publicRpc(chainId, method, params, attempt = 1, opts = {}) {
  const urls = PUBLIC_RPCS[chainId];
  // Rotate to the next fallback endpoint on every retry (see the PUBLIC_RPCS
  // comment above) rather than retrying the same URL — a 429 or dropped fetch
  // is most often that ONE endpoint being rate-limited/unhappy, not the request
  // itself being invalid, so a different endpoint is far more likely to succeed
  // than an identical retry against the same one.
  //
  // The FIRST attempt skips endpoints known to be throttling us (see
  // endpointThrottledUntil); every later attempt rotates onward from wherever that landed, so
  // the retries still walk distinct endpoints rather than re-offering the one just chosen.
  const startIdx = opts.startIdx ?? firstHealthyIdx(urls, 0);
  if (attempt === 1) opts = { ...opts, startIdx };
  const url = urls[(startIdx + attempt - 1) % urls.length];
  log(`→ [${chainName(chainId)}] ${method} ${params.length ? JSON.stringify(params) : ''}`.trim());
  const started = performance.now();
  // eth_getLogs gets extra passes through the rotation (wrapping back around to
  // retry the primary endpoint) rather than stopping once every fallback has
  // been tried once — confirmed live that NEITHER of Arbitrum's fallbacks can
  // serve a full-history eth_getLogs at all (one refuses archive queries
  // without a paid token, the other caps the block range to 50), so if the
  // primary's failure was transient, retrying IT again is the only path that
  // can actually succeed. A plain eth_call has no such asymmetry — any
  // endpoint in the list can serve it — so one pass through the rotation is
  // enough there.
  const maxAttempts = method === 'eth_getLogs' ? Math.max(6, urls.length * 2) : Math.max(3, urls.length);

  /* Backoff before a retry, but ONLY once the rotation has wrapped back onto an endpoint this
     call already tried. The pause is there to give a struggling endpoint time to recover — and
     while there are still untried endpoints, we aren't going back to it, we're going somewhere
     that hasn't seen this request at all. Sleeping first bought nothing and cost a great deal:
     across a full-pool scan the old unconditional `250 * attempt` accumulated ~61 SECONDS of
     sleep (measured live, see endpointThrottledUntil above) purely to delay rotations that were
     going to succeed immediately, taking the scan from 2.5s to 8.8s. Past the wrap, the delay is
     real backoff again and grows per extra lap — that path only exists for eth_getLogs, whose
     maxAttempts is two laps precisely so it CAN retry the primary (see maxAttempts above). */
  const backoffMs = (n) => (n < urls.length ? 0 : 250 * (n - urls.length + 1));
  const retryAfter = async (n) => {
    const ms = backoffMs(n);
    if (ms) await new Promise((r) => setTimeout(r, ms));
  };

  let json;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    json = await res.json();
  } catch (err) {
    // A blocked/dropped fetch (e.g. Arbitrum's official RPC intermittently
    // emits a malformed duplicate CORS header under burst load — seen live
    // during Votemarket's ~260-gauge fan-out) throws here with no detail the
    // browser will expose; retry against the next fallback endpoint before
    // giving up, since the same request usually succeeds against a different one.
    //
    // This also counts as "throttling" for endpointThrottledUntil's purposes. An endpoint under
    // enough load to start DROPPING connections is not a healthy first choice, and it says so
    // here rather than through a JSON-RPC error — measured live bursting mainnet.base.org: 566
    // of 600 requests came back as a readable HTTP 429 + `-32016` body (which the branch below
    // catches), but 16 simply failed the fetch outright with nothing to inspect. Without this,
    // exactly the endpoint that is falling over hardest keeps its first-choice slot.
    endpointThrottledUntil.set(url, Date.now() + THROTTLE_COOLDOWN_MS);
    if (attempt < maxAttempts) {
      await retryAfter(attempt);
      return publicRpc(chainId, method, params, attempt + 1, opts);
    }
    const rescued = await walletRpcRescue(chainId, method, params);
    if (rescued !== undefined) return rescued;
    log(`← [${chainName(chainId)}] ${method} failed after ${attempt} attempts: ${err.message}`, 'err');
    throw err;
  }

  const ms = Math.round(performance.now() - started);
  if (json.error) {
    // 429 (Too Many Requests) is a JSON-RPC-level error response, not a fetch
    // throw, so it needs its own retry path — the catch block above only covers
    // network-level failures. This started mattering more once Multicall3
    // batching (see MULTICALL3 above) shrank the NUMBER of requests but grew
    // EACH one's blast radius: a single unretried 429 on a Votemarket epoch's
    // multicall now zeroes out that epoch's ENTIRE ~260-gauge slope check at
    // once (returned as all "no data" by multicall()'s chunk-failure fallback),
    // which can trip the two-consecutive-empty-epoch early stop on a false
    // negative — confirmed live: a jsdom test harness under heavier concurrent
    // load from other sessions hit exactly this, truncating a real scan at 3
    // epochs where a directly-verified individual-call sweep of the same
    // account/epochs showed 34-43 touched gauges (nowhere near empty). Rotating
    // to the next fallback endpoint on a 429 (rather than retrying the SAME
    // rate-limited one) fixes it at the source for every caller, not just
    // Votemarket — a fresh endpoint hasn't seen this session's request burst.
    // eth_getLogs failures are near-always an endpoint CAPABILITY limit, not a
    // fundamentally invalid request — confirmed live: rotating Votemarket's
    // full-history CampaignCreated scan onto Arbitrum's fallback endpoints hit
    // TWO different such limits (publicnode.com refusing archive queries
    // without a paid token, 1rpc.io capping eth_getLogs to a 50-block range),
    // neither a 429, both fixed by trying yet another endpoint. eth_call is
    // NOT included here on purpose — plenty of call sites (e.g. the
    // ASSET_TOKEN()/pricePerShare() pricing probe chain) deliberately rely on
    // a revert failing fast, and retrying every expected revert across every
    // fallback endpoint would multiply their latency for no benefit.
    const throttled = isRateLimited(json.error);
    // Remember this so the rest of the burst doesn't keep starting at an endpoint that is
    // currently rejecting ~everything — see endpointThrottledUntil.
    if (throttled) endpointThrottledUntil.set(url, Date.now() + THROTTLE_COOLDOWN_MS);
    const rotatable = throttled || method === 'eth_getLogs';
    if (rotatable && attempt < maxAttempts) {
      await retryAfter(attempt);
      return publicRpc(chainId, method, params, attempt + 1, opts);
    }
    // The wallet tier of the waterfall. Normally only the exhausted-rotation case reaches it —
    // a non-rotatable eth_call error (attempt === 1, `rotatable` false) is the deliberate
    // fail-fast revert path called out above, and routing every expected-revert probe through
    // the wallet would cost a wallet round trip for nothing.
    //
    // `opts.walletRescueOnError` opts a caller into that degradation for eth_call errors too.
    // That exists because "public endpoint reverted" and "the contract says no" are genuinely
    // different things and only the CALLER can tell them apart: RewardsSugar.rewards() reverts
    // purely because the window exceeded THAT endpoint's eth_call gas cap (measured live — see
    // fetchPoolRewardsFullScan), and the wallet's own provider, with a higher cap, answers the
    // identical call successfully. Without this, the app's public->wallet degradation simply
    // never engaged for the one call in the app that most needs it.
    if (rotatable || opts.walletRescueOnError) {
      const rescued = await walletRpcRescue(chainId, method, params);
      if (rescued !== undefined) return rescued;
    }
    log(`← [${chainName(chainId)}] ${method} (${ms}ms) ERROR ${json.error.message}`, 'err');
    const err = new Error(json.error.message);
    err.code = json.error.code;
    throw err;
  }
  log(`← [${chainName(chainId)}] ${method} (${ms}ms) ${JSON.stringify(json.result)}`, 'ok');
  return json.result;
}

// When true, chainCall() prefers the connected wallet's own injected provider over this app's
// public RPC fallback pool — set by runAerodromeClaimFlow() only around building a claim preview
// (position reads, per-pool reward reads, route/quote lookups, balance checks), which fans out
// enough calls fast enough to reliably get an already-loaded portfolio card's public RPC rotation
// rate-limited. A wallet's own provider is usually backed by the wallet vendor's dedicated RPC
// infrastructure and holds up far better under that burst. Everywhere else (the regular portfolio
// refresh, disconnected/demo mode) keeps reading via public RPC only, per this app's normal
// "portfolio data via public RPC, never the wallet's provider" rule — this is a narrow, explicit
// exception for the one flow that already requires a connected wallet on the right chain, with a
// per-call fallback to public RPC if the wallet's own eth_call errors.
export let preferWalletRpc = false;
// ES module imports of `let` bindings are read-only live views — claim/orchestrate.js needs to
// flip this flag around the claim-preview build, so it goes through this setter instead of
// reassigning the imported binding directly (which throws "Assignment to constant variable").
export function setPreferWalletRpc(v) {
  preferWalletRpc = v;
}

// `opts.walletRescueOnError` opts this call into the wallet tier of the RPC waterfall for
// JSON-RPC *errors* too, not just network failures — see publicRpc's own handling. Off by
// default because the pricing probe chain (ASSET_TOKEN()/pricePerShare()/asset() above) leans on
// a revert failing FAST to decide "this token isn't that kind of vault", and routing every one of
// those expected reverts through the wallet would add a wallet round trip per probe for nothing.
// Callers where a revert means "this endpoint couldn't serve it" rather than "the answer is no"
// — the full-pool scan's gas-capped pages — pass true and get the normal degradation.
export async function chainCall(chainId, to, data, opts) {
  if (preferWalletRpc && state.provider && state.chainId === chainId) {
    try {
      return await rpc('eth_call', [{ to, data }, 'latest']);
    } catch (err) {
      logErr(`wallet eth_call failed (${chainName(chainId)}), falling back to public RPC`, err);
    }
  }
  return publicRpc(chainId, 'eth_call', [{ to, data }, 'latest'], 1, opts);
}
export const chainGetLogs = (chainId, filter) => publicRpc(chainId, 'eth_getLogs', [filter]);

// Batches many (target, callData) eth_calls into a small number of Multicall3
// aggregate3 requests instead of one HTTP round-trip per call — see the big
// MULTICALL3 comment above and the VOTEMARKET comment for why this matters
// (Votemarket's gauge/epoch fan-out was up to ~6,500 individual eth_calls before
// this). Splits into MULTICALL_CHUNK_SIZE-sized chunks (all chunks in flight
// together via Promise.allSettled, same "don't let one bad call/chunk kill the
// rest" contract the old per-call Promise.allSettled loops had) and returns
// results flattened back into the SAME order/length as `calls`, one
// `{ success, returnData }` per call. A chunk-level failure (e.g. the retried
// fetch in publicRpc still throwing) maps every call in that chunk to
// `{ success: false, returnData: '0x' }` rather than propagating — callers
// already treat `success: false` as "no data for this one", identical to how a
// rejected promise was skipped before.
export async function multicall(chainId, calls) {
  if (!calls.length) return [];
  const chunks = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK_SIZE) chunks.push(calls.slice(i, i + MULTICALL_CHUNK_SIZE));

  const chunkResults = await Promise.allSettled(
    chunks.map((chunk) => chainCall(chainId, MULTICALL3, encodeAggregate3(chunk)).then(decodeAggregate3))
  );

  const out = [];
  chunkResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.push(...r.value);
    } else {
      logErr('Multicall3 aggregate3 batch failed', r.reason);
      out.push(...chunks[i].map(() => ({ success: false, returnData: '0x' })));
    }
  });
  return out;
}
export const PRICE_CHAIN_TO_ID = {
  ethereum: ETH_MAINNET, base: BASE_MAINNET, optimism: OPTIMISM, arbitrum: ARBITRUM,
  celo: CELO, fraxtal: FRAXTAL, ink: INK, lisk: LISK, metall2: METAL_L2,
  mode: MODE, sseed: SUPERSEED, swellchain: SWELLCHAIN, unichain: UNICHAIN,
};

export async function fetchJson(url) {
  log(`→ GET ${url}`);
  const started = performance.now();
  const res = await fetch(url);
  const ms = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  log(`← GET (${ms}ms) ${new URL(url).pathname.split('/').pop()}`, 'ok');
  return json;
}

// Resolves symbol/decimals/USD price for a batch of tokens on one chain via
// DefiLlama (public, no key, CORS-open). If DefiLlama has no listing, tries two
// more things before giving up on a price — both are share/vault-token
// conventions where the real value lives in a listed underlying asset:
//   1. A standard-looking ASSET_TOKEN() + pricePerShare() pair (Yield Basis's
//      yb-cbBTC/yb-WBTC/yb-tBTC/yb-WETH receipts) — verified live against
//      yb-WBTC (ASSET_TOKEN() correctly returns WBTC's real address;
//      pricePerShare() returned 1.007230, a sane ~0.7% premium from accrued
//      yield) and confirmed this doesn't false-positive on an ordinary token
//      (crvUSD's ASSET_TOKEN() cleanly reverts).
//   2. A standard ERC4626 asset() + convertToAssets(uint256) pair (Concentrator's
//      aCRV, an actual ERC4626 vault over cvxCRV, despite having no direct
//      DefiLlama listing of its own) — verified live: aCRV.asset() returns
//      cvxCRV's real address, convertToAssets(10**shareDecimals) returned
//      2.253740041061027487 cvxCRV per aCRV, which matches totalAssets()/
//      totalSupply() (4,098,420.03 / 1,818,497.23 = 2.25374...) exactly, and
//      cvxCRV has a live DefiLlama price. Cross-checked byte-for-byte against
//      ethers.js's Interface.decodeFunctionResult() before shipping.
// Only after both of those come up empty does it fall back to plain on-chain
// symbol()/decimals() with no price, so units still display correctly either way.
export async function priceTokensUsd(tokens, priceChain) {
  const chainId = PRICE_CHAIN_TO_ID[priceChain];
  const out = {};
  let coins = {};
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${tokens.map((t) => `${priceChain}:${t}`).join(',')}`);
    coins = json.coins || {};
  } catch (err) {
    logErr('token price lookup failed', err);
  }

  await Promise.all(tokens.map(async (addr) => {
    const entry = coins[`${priceChain}:${addr}`];
    if (entry) {
      out[addr] = { symbol: entry.symbol, decimals: entry.decimals, price: entry.price };
      return;
    }

    try {
      const assetRaw = await chainCall(chainId, addr, '0xd7062005'); // ASSET_TOKEN()
      const asset = addrAt(assetRaw, 0);
      const [ppsRaw, symRaw, decRaw, assetPriced] = await Promise.all([
        chainCall(chainId, addr, '0x99530b06'), // pricePerShare()
        chainCall(chainId, addr, '0x95d89b41'),
        chainCall(chainId, addr, '0x313ce567'),
        priceTokensUsd([asset], priceChain),
      ]);
      const assetPrice = assetPriced[asset]?.price;
      const pricePerShare = Number(word(ppsRaw, 0)) / 1e18;
      out[addr] = {
        symbol: decodeString(symRaw) || short(addr),
        decimals: Number(word(decRaw, 0)),
        price: assetPrice != null ? pricePerShare * assetPrice : null,
      };
      return;
    } catch {
      // Not an ASSET_TOKEN()/pricePerShare() share token — try ERC4626 next.
    }

    try {
      const assetRaw = await chainCall(chainId, addr, '0x38d52e0f'); // asset() — ERC4626
      const asset = addrAt(assetRaw, 0);
      const [decRaw, symRaw, assetPriced] = await Promise.all([
        chainCall(chainId, addr, '0x313ce567'),
        chainCall(chainId, addr, '0x95d89b41'),
        priceTokensUsd([asset], priceChain),
      ]);
      const shareDecimals = Number(word(decRaw, 0));
      // convertToAssets() takes shares in the share token's own decimals and
      // returns assets in the underlying asset's decimals — neither is safe to
      // assume is 18, unlike pricePerShare()'s fixed 1e18-scaled convention above.
      const convRaw = await chainCall(chainId, addr, '0x07a2d13a' + encodeUint256(10n ** BigInt(shareDecimals))); // convertToAssets(uint256)
      const assetMeta = assetPriced[asset];
      const assetDecimals = assetMeta?.decimals ?? 18;
      const assetsPerShare = Number(word(convRaw, 0)) / 10 ** assetDecimals;
      out[addr] = {
        symbol: decodeString(symRaw) || short(addr),
        decimals: shareDecimals,
        price: assetMeta?.price != null ? assetsPerShare * assetMeta.price : null,
      };
      return;
    } catch {
      // Not an ERC4626 vault either — fall through to plain metadata, no price.
    }

    try {
      const [symRaw, decRaw] = await Promise.all([chainCall(chainId, addr, '0x95d89b41'), chainCall(chainId, addr, '0x313ce567')]);
      out[addr] = { symbol: decodeString(symRaw) || short(addr), decimals: Number(word(decRaw, 0)), price: null };
    } catch (err) {
      logErr(`token metadata read failed for ${addr}`, err);
      out[addr] = { symbol: short(addr), decimals: 18, price: null };
    }
  }));

  return out;
}

// veCRV lock + crvUSD FeeDistributor claim — one of Curve's two nested Portfolio
// subsections (see renderCurveProgressive() below, which calls this and
// fetchVotemarket() directly and combines them).
