import { AERODROME, BY_ACCOUNT, POOL_COUNT, POOL_REWARDS, REWARDS_BY_ADDRESS } from './config.js';
import { BASE_MAINNET } from '../core/chains.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { decodeRewardArray, decodeVeNFTArray, encodeAddress, encodeUint256, formatUnits, formatUnlock, log, logErr, usd, word } from '../core/utils.js';
import { rpc } from '../wallet-connect.js';

export const FULL_SCAN_MAX_POOLS = 3000;
// Page size for a single RewardsSugar.rewards() call. Empirically tuned against Optimism's official
// public RPC: a single call spanning all ~1,525 pools at once was found to intermittently revert
// (3 of 4 tries failed in one test run, including at limit=2000 with offset=0) — seemingly load-
// balancer/backend-replica-dependent, not a genuine gas/size limit, since the SAME range split into
// 100-pool pages succeeded 15/16 and 16/16 times across repeated live test runs, each page landing
// in well under a second. 150 keeps Optimism's full scan to ~11 parallel pages.
export const FULL_SCAN_PAGE_SIZE = 150;
// Every Superchain leaf chain's live pool count (18-212, see the VELODROME_LEAF_CHAINS comment
// above) fits in one page at this size, so fetchVelodromeLeafClaims always does exactly one
// RewardsSugar.rewards() call per (leaf chain, veNFT) — no pagination, no LpSugar.count() call
// needed there.
export const LEAF_CHAIN_POOL_CAP = 500;

// Both the Aerodrome portfolio card (fetchVeDex) and the "claim to mainnet" panel
// (buildAerodromeClaimPlan) need this exact same full-pool scan for the exact same veNFT — the
// card to display what's claimable, the panel to build real claim transactions for it. Running
// it twice (once per caller, independently) doubles this scan's RPC load — up to ~232 parallel
// pages on Aerodrome's 34,707 pools — and under that doubled load a page is measurably more
// likely to fail in ONE of the two runs and not the other, which showed up as tokens (e.g. DRV,
// LMTS, MOLT) appearing in the claim panel's total but not the portfolio card's, and vice versa,
// despite both nominally being "fresh". This cache is the fix: whichever caller runs first
// populates it, and the other reuses that exact result — not just a similar one — for
// `AERODROME_FULL_SCAN_CACHE_TTL_MS`, so within that window the two can never disagree over data
// that actually resolved, and the second caller does zero extra RPC. Keyed by
// `chainId:rewardsSugar:venftId:poolCount` — a pool-count change (new pools registered) or a
// different chain/venft is always treated as a fresh scan.
export const AERODROME_FULL_SCAN_CACHE_TTL_MS = 3 * 60 * 1000;
export const aerodromeFullScanCache = new Map(); // cache key -> { result, fetchedAt }
// In-flight dedup, separate from the TTL cache above. The TTL cache only helps once a scan has
// FINISHED — it does nothing for the actual race that caused DRV/LMTS/MOLT-style asymmetry: the
// portfolio card kicks off its full scan the moment the page loads, and if the user opens the
// claim panel a few seconds later (before that first scan has finished), the old code found no
// completed cache entry yet and started a SECOND, fully independent 232-page fan-out — doubling
// RPC load at exactly the moment load-induced page failures are most likely, and letting the two
// scans resolve with different failed pages. Keyed identically to aerodromeFullScanCache; holds
// the in-flight PROMISE (not yet a settled result) so a second caller arriving while the first is
// still running awaits that same promise instead of starting its own.
export const aerodromeFullScanInFlight = new Map(); // cache key -> Promise<result>

// Shared concurrency gate for RewardsSugar.rewards() full-pool scan page requests — ACROSS every
// concurrent call to fetchPoolRewardsFullScan, not per-call. Without this, a wallet holding
// multiple veNFT locks fires one ~232-page burst PER LOCK simultaneously on page load (each
// position's own fan-out below has no idea another position is scanning at the same instant), all
// racing for the same handful of public Base RPC endpoints at once. That self-inflicted burst —
// not individual page bad luck — is the actual reason the FIRST scan (the portfolio card's, on
// page load) fails to complete far more often than a LATER one (e.g. the claim panel's, triggered
// minutes later once the user has read the card and clicked Claim): by the time the panel's scan
// runs, the initial burst is long over and it has the RPC pool to itself. Capping how many page
// requests are truly in flight AT ONCE (not how many are eventually made) removes that
// self-DDoS instead of trying to out-retry it after the fact, so the FIRST scan gets the same
// quiet conditions the "healing" second scan was accidentally benefiting from. 24 was chosen to
// stay comfortably under the ~429-triggering threshold observed live for Base's endpoints while
// still keeping a 232-page scan's wall-clock time reasonable (roughly 232/24 ≈ 10 sequential
// waves at typical per-call latency, well under the old effectively-unbounded-at-once approach's
// worst case once failures/retries are counted). Genuinely global and cross-position/cross-scan:
// two veNFT locks scanning "in parallel" now interleave through this one gate rather than each
// getting their own 24-wide allowance, so the total in-flight count across the whole app never
// exceeds it regardless of how many scans are nominally running.
export const FULL_SCAN_CONCURRENCY = 24;
export let fullScanInFlightCount = 0;
export const fullScanWaiters = [];
export async function withFullScanSlot(fn) {
  if (fullScanInFlightCount >= FULL_SCAN_CONCURRENCY) {
    await new Promise((resolve) => fullScanWaiters.push(resolve));
  }
  fullScanInFlightCount++;
  try {
    return await fn();
  } finally {
    fullScanInFlightCount--;
    const next = fullScanWaiters.shift();
    if (next) next();
  }
}

/* Enumerates every registered pool on one chain (via RewardsSugar.rewards(), see the POOL_REWARDS
   comment above) checking Fee/Bribe .earned() for one veNFT id, paginated across `poolCount` pools
   at `pageSize` per call and run in parallel. A page that fails is retried up to 4 times (5
   attempts total) with a short exponential backoff between tries — live testing against
   Optimism's official RPC found individual pages fail intermittently (~1/16 per full pass at a
   single-retry budget, apparently backend-replica-dependent rather than a genuine size/gas
   problem — see FULL_SCAN_PAGE_SIZE's comment) and that rate climbs further whenever this scan
   runs alongside heavy concurrent RPC load elsewhere (e.g. a full portfolio refresh hitting many
   other chains/protocols at once) — the extra retry budget and backoff measurably reduce (without
   fully eliminating) how often a page's rewards go unscanned. Returns per-token raw totals, the
   set of distinct pool addresses that had something claimable, a per-veNFT Fee/Bribe contract
   breakdown (`byVenft` — only the claim panel needs this, but it's cheap to always compute from
   data already in hand), and whether every page succeeded (`complete: false` means the totals are
   a floor, not a guarantee — callers that also have a cheaper, reliable source should take the max
   of the two rather than trusting an incomplete scan outright). */
export async function fetchPoolRewardsFullScan(chainId, rewardsSugar, venftId, poolCount, pageSize = FULL_SCAN_PAGE_SIZE) {
  const cacheKey = `${chainId}:${rewardsSugar}:${venftId}:${poolCount}`;
  const cached = aerodromeFullScanCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AERODROME_FULL_SCAN_CACHE_TTL_MS) {
    return cached.result;
  }

  // A scan for this exact key is already in flight (e.g. the portfolio card's page-load fetch)
  // — await that one instead of starting a second, independent 232-page fan-out. See
  // aerodromeFullScanInFlight's comment for why this in-flight dedup is what the TTL cache alone
  // can't provide.
  const inFlight = aerodromeFullScanInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const offsets = [];
  for (let o = 0; o < poolCount; o += pageSize) offsets.push(o);

  /* Why a page can fail no matter how many times it is retried, and why the fix is to SPLIT it.

     A RewardsSugar.rewards() page is uniquely expensive: one call walks up to `pageSize` pools
     and probes Fee/Bribe .earned() on each. When a window happens to contain enough
     reward-BEARING pools, that work exceeds the endpoint's eth_call gas cap and the call
     REVERTS. Retrying is useless — identical parameters produce an identical revert, forever.

     Measured live (2026-08-11, test veNFT, 34,766 pools, base-rpc.publicnode.com):
       * pageSize=150 -> 7 of 232 pages revert, every one of them on all retries.
       * The same windows re-read at pageSize=25 (and 10 for one of them) succeed outright, and
         yield 2 reward tokens — DRV and LMTS — that the pageSize=150 scan never sees at all.
     Those are exactly the tokens this app's own claim panel had been finding while the portfolio
     card did not. The card ran on public RPC; the claim panel runs after switchChain() puts the
     wallet on Base, so its pages go to the wallet's provider, whose gas cap is high enough for
     the heavy window to succeed. Same function, same veNFT — only the gas ceiling differed.

     An earlier revision of this comment concluded the opposite: that endpoints were returning
     "SUCCESSFUL-but-incomplete" pages with no detectable signal, and inverted the transport to
     try the wallet FIRST as the mitigation. That diagnosis is disproven — a full scan at
     pageSize=150 and pageSize=50 return byte-identical token sets from the same endpoint, so
     nothing is being silently truncated. There IS a signal (the revert), and the wallet-first
     inversion only ever masked the bug for users who happened to be on Base: the card scans on
     whatever chain the wallet is currently on, and this app's own Curve claim leaves it on
     Ethereum mainnet, at which point `walletUsable` is false and the reverting pages come back.

     So: on a revert, bisect the window and read the halves. Costs extra requests only for the
     handful of windows that actually revert (7 of 232 here), needs no wallet at all, and is
     deterministic. The wallet is still tried first when it's already on the right chain — it
     usually swallows the whole window in one call and saves the subdivision — but correctness no
     longer depends on it. Both paths stay behind withFullScanSlot so neither gets burst. */
  const isWindowTooHeavy = (err) =>
    /revert|out of gas|gas required exceeds|intrinsic gas|exceeds.*limit/i.test(String((err && err.message) || err));

  async function fetchPage(offset, size, attempt = 1) {
    const data = POOL_REWARDS + encodeUint256(size) + encodeUint256(offset) + encodeUint256(venftId);
    // Only on the first attempt — once the wallet has declined this page, the retry budget below
    // belongs to public RPC rather than re-asking a provider that just said no.
    const walletUsable = attempt === 1 && state.provider && state.chainId === chainId;
    if (walletUsable) {
      try {
        return await withFullScanSlot(() => rpc('eth_call', [{ to: rewardsSugar, data }, 'latest']));
      } catch (walletErr) {
        // A gas-cap revert is about the WINDOW, not the transport — surface it so the caller
        // bisects rather than burning public-RPC retries that will revert identically.
        if (isWindowTooHeavy(walletErr)) throw walletErr;
        // Any other wallet failure (declined, rate-limited) is no reason to lose the page when
        // the public pool may well serve it.
        logErr(`wallet eth_call failed, falling back to public RPC (offset ${offset}, venft ${venftId})`, walletErr);
      }
    }
    try {
      // walletRescueOnError: a gas-cap revert here is "this endpoint can't serve this window",
      // not "the answer is no", so it takes the app's normal public->wallet degradation (see
      // chainCall/publicRpc). The wallet's higher gas cap usually answers the whole window in
      // ONE call, which is why this is tried before the bisect below rather than after.
      return await withFullScanSlot(() => chainCall(chainId, rewardsSugar, data, { walletRescueOnError: true }));
    } catch (err) {
      // Deterministic by construction — same window, same gas cap, same revert. Retrying it 5
      // times (as this used to) just spends five round trips to arrive at the same failure.
      // Reaching here means public RPC reverted AND the wallet tier couldn't rescue it (no
      // wallet, wrong chain, or the wallet's cap is too low too) — so bisect, which needs
      // no wallet at all.
      if (isWindowTooHeavy(err)) throw err;
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        return fetchPage(offset, size, attempt + 1);
      }
      throw err;
    }
  }

  // Reads [offset, offset+size), halving on a gas-cap revert until the pieces fit (or a single
  // pool still won't read, which is a real failure worth reporting as incomplete). Never rejects:
  // returns whatever pages it did get plus whether the window was covered in full, so one
  // unreadable half can't discard the other half's rewards the way a rejecting Promise.all would.
  async function fetchWindow(offset, size) {
    const capped = Math.min(size, poolCount - offset);
    if (capped <= 0) return { pages: [], complete: true };
    try {
      return { pages: [await fetchPage(offset, capped)], complete: true };
    } catch (err) {
      if (!isWindowTooHeavy(err) || capped <= 1) {
        logErr(`RewardsSugar.rewards window failed (offset ${offset}, size ${capped}, venft ${venftId})`, err);
        return { pages: [], complete: false };
      }
      const half = Math.ceil(capped / 2);
      const [a, b] = await Promise.all([fetchWindow(offset, half), fetchWindow(offset + half, capped - half)]);
      return { pages: [...a.pages, ...b.pages], complete: a.complete && b.complete };
    }
  }

  const scanPromise = (async () => {
    const results = await Promise.all(offsets.map((o) => fetchWindow(o, pageSize)));
    // offset -> raw hex page results for that window. An ARRAY, not one page: a window that hit
    // the gas cap was bisected (see fetchWindow) and comes back as several smaller pages. Patched
    // by the retry sweep below for whichever windows came back incomplete — final totals are
    // built from this map once, after both passes, so a window that succeeds on the sweep is
    // indistinguishable from one that succeeded immediately.
    const pageData = new Map();
    const failedOffsets = [];
    results.forEach((r, i) => {
      pageData.set(offsets[i], r.pages);
      if (!r.complete) failedOffsets.push(offsets[i]);
    });

    // withFullScanSlot (see its comment above) now removes the SELF-inflicted version of the
    // burst that used to be this sweep's main reason for existing — but a page can still fail all
    // 5 of fetchPage()'s own retries (each already routed through publicRpc's full endpoint
    // rotation AND its wallet-RPC rescue once that's exhausted, see walletRpcRescue) from causes
    // outside this app's control: a genuinely down/degraded public endpoint, unrelated traffic on
    // the same free tier, or a moment where even the wallet's own provider is unavailable. This
    // sweep is the remaining line of defence for THAT category — it waits, then gives just the
    // stragglers (not the whole scan) one more full attempt, on the theory that a transient outage
    // is more likely to have cleared a couple seconds later than to still be down.
    const incompleteOffsets = new Set(failedOffsets);
    if (failedOffsets.length) {
      await new Promise((r) => setTimeout(r, 1500));
      const retryResults = await Promise.all(failedOffsets.map((o) => fetchWindow(o, pageSize)));
      retryResults.forEach((r, i) => {
        const offset = failedOffsets[i];
        // REPLACE, never append — this window may already hold pages from the first pass (a
        // bisect that covered part of it before one half failed), and the sweep re-reads the
        // whole window. Appending would count those pools' rewards twice, since the decode
        // below sums every page it is given.
        pageData.set(offset, r.pages);
        if (r.complete) incompleteOffsets.delete(offset);
        else logErr(`RewardsSugar.rewards window still incomplete after retry sweep (offset ${offset}, venft ${venftId})`, r.pages.length ? 'partial data kept' : 'no data');
      });
    }

    const totals = new Map(); // token address (lowercase) -> raw bigint amount
    const pools = new Set(); // pool addresses (lowercase) that had something claimable
    const byVenft = new Map(); // venftId (string) -> { fees: Map<contract, Map<token, amount>>, bribes: ... }
    let decodeFailures = 0;
    for (const offset of offsets) {
      for (const value of pageData.get(offset) || []) {
        // Decoding is per-page and fault-isolated on purpose. wordHex() THROWS on a malformed or
        // truncated response ("short return"), and this loop used to run outside any try — so a
        // single bad page rejected the whole scanPromise, which rejected the Promise.all in
        // buildVeNftRewardTotals, which hit its catch and threw away EVERY page's rewards for
        // every veNFT. The card then silently fell back to cheap-path-only totals (currently-voted
        // pools), which is precisely the "card shows a subset, claim panel shows everything"
        // symptom this whole area exists to prevent. One unreadable page should cost that page,
        // not the scan.
        let decoded;
        try {
          decoded = decodeRewardArray(value);
        } catch (err) {
          decodeFailures++;
          incompleteOffsets.add(offset);
          logErr(`RewardsSugar.rewards page decode failed (offset ${offset}, venft ${venftId})`, err);
          continue;
        }
        for (const reward of decoded) {
          if (reward.amount === 0n) continue;
          const key = reward.token.toLowerCase();
          totals.set(key, (totals.get(key) || 0n) + reward.amount);
          pools.add(reward.lp.toLowerCase());

          const vidStr = reward.venftId.toString();
          if (!byVenft.has(vidStr)) byVenft.set(vidStr, { fees: new Map(), bribes: new Map() });
          const entry = byVenft.get(vidStr);
          for (const [group, contract] of [['fees', reward.fee], ['bribes', reward.bribe]]) {
            if (contract === '0x0000000000000000000000000000000000000000') continue;
            if (!entry[group].has(contract)) entry[group].set(contract, new Map());
            const tokenMap = entry[group].get(contract);
            tokenMap.set(reward.token, (tokenMap.get(reward.token) || 0n) + reward.amount);
          }
        }
      }
    }
    const complete = incompleteOffsets.size === 0;
    if (decodeFailures) log(`full-pool scan venft ${venftId}: ${decodeFailures} page(s) failed to decode`, 'err');
    const result = { totals, pools, byVenft, complete };
    const totalPages = [...pageData.values()].reduce((n, arr) => n + arr.length, 0);
    log(`full-pool scan venft ${venftId}: ${offsets.length - incompleteOffsets.size}/${offsets.length} windows ok (${totalPages} pages after bisecting), ${totals.size} token(s) found, complete=${complete}`, complete ? 'ok' : 'err');
    // Only a COMPLETE scan is cached — an incomplete one is a floor for whichever caller hit it,
    // not something the other caller should be stuck reusing for the next 3 minutes.
    if (complete) aerodromeFullScanCache.set(cacheKey, { result, fetchedAt: Date.now() });
    return result;
  })();

  // Registered before awaiting so any concurrent caller that arrives while this is running finds
  // it. Cleared in `finally` (success OR failure) so a failed scan doesn't permanently wedge this
  // key — the next caller (even moments later) should get a fresh attempt, not an eternally
  // rejected promise.
  aerodromeFullScanInFlight.set(cacheKey, scanPromise);
  try {
    return await scanPromise;
  } finally {
    aerodromeFullScanInFlight.delete(cacheKey);
  }
}

// Shared by Aerodrome (Base) and Velodrome (Optimism) — same ve(3,3) contracts,
// same Sugar lens ABI, different chain and token addresses. `preFetchedPositions`
// is optional — Velodrome's orchestrator (fetchVelodrome() below) already has to
// fetch VeSugar.byAccount() itself for its leaf-chain scan, so it passes its copy
// through here to avoid fetching it twice; Aerodrome's call site doesn't pass it
// Shared by fetchVeDex (portfolio card) and buildAerodromeClaimPlan (claim panel) — both need
// to answer "what rewards does this veNFT have?" by combining cheap-path (currently-voted
// pools) and historical-path (full-pool scan) results. This single function builds the
// authoritative token totals and Fee/Bribe contract mappings, and the two callers add their
// own domain-specific logic on top (card adds rows/formatting for display, panel adds
// transaction-building logic).
export async function buildVeNftRewardTotals(cfg, positions, tokenLabel = 'AERO', throwOnCheapPathFail = false) {
  // Cheap path: rewards for pools the veNFT is CURRENTLY voted for. Also builds byVenft
  // mapping (fee/bribe contract per veNFT per pool) used for building claim transactions.
  const jobs = positions.flatMap((p) => p.votes.map((v) => ({ id: p.id, lp: v.lp })));
  const rewardResults = await Promise.allSettled(
    jobs.map((j) => chainCall(cfg.chainId, cfg.rewardsSugar, REWARDS_BY_ADDRESS + encodeUint256(j.id) + encodeAddress(j.lp)))
  );

  const totals = new Map();
  const byVenft = new Map(); // venftId -> { fees: Map<contract, Map<token, amount>>, bribes: ... }
  let anyRewardCallOk = false;
  rewardResults.forEach((r) => {
    if (r.status !== 'fulfilled') {
      if (r.reason) logErr(`RewardsSugar.rewardsByAddress failed`, r.reason);
      return;
    }
    anyRewardCallOk = true;
    for (const reward of decodeRewardArray(r.value)) {
      if (reward.amount === 0n) continue;
      const key = reward.token.toLowerCase();
      totals.set(key, (totals.get(key) || 0n) + reward.amount);
      // Build Fee/Bribe contract mappings (used by claim panel for transactions).
      const venftId = reward.venftId.toString();
      if (!byVenft.has(venftId)) byVenft.set(venftId, { fees: new Map(), bribes: new Map() });
      const entry = byVenft.get(venftId);
      for (const [group, contract] of [['fees', reward.fee], ['bribes', reward.bribe]]) {
        if (contract === '0x0000000000000000000000000000000000000000') continue;
        if (!entry[group].has(contract)) entry[group].set(contract, new Map());
        const tokenMap = entry[group].get(contract);
        tokenMap.set(reward.token, (tokenMap.get(reward.token) || 0n) + reward.amount);
      }
    }
  });
  const cheapPathFailed = jobs.length > 0 && !anyRewardCallOk;
  if (throwOnCheapPathFail && cheapPathFailed) {
    const failedJobs = rewardResults.filter((r) => r.status !== 'fulfilled').length;
    throw new Error(`failed to read rewards for ${failedJobs}/${jobs.length} voted pool(s) — refusing to build an incomplete claim plan`);
  }

  log(`${tokenLabel} cheap path: ${totals.size} token(s) from ${jobs.length} voted pool(s), cheapPathFailed=${cheapPathFailed}`, 'info');

  // Historical path: full-pool scan for past-epoch pools (optional, skipped if lpSugar not configured).
  let scanComplete = true;
  if (cfg.lpSugar) {
    try {
      const poolCount = Number(word(await chainCall(cfg.chainId, cfg.lpSugar, POOL_COUNT), 0));
      const shouldScanFull = poolCount <= FULL_SCAN_MAX_POOLS || cfg.chainId === BASE_MAINNET;
      log(`${tokenLabel} historical path: poolCount=${poolCount}, shouldScanFull=${shouldScanFull}, positions=${positions.length}`, 'info');
      if (shouldScanFull && poolCount > 0) {
        // allSettled, not all: one veNFT's scan rejecting used to reject this Promise.all, which
        // fell into the catch below and threw away EVERY veNFT's scan results — collapsing the
        // card to cheap-path-only totals (currently-voted pools) with no indication anything was
        // lost. That is exactly the "card shows a subset of what the claim panel finds" symptom.
        // A failed position now costs that position's historical rewards and marks the scan
        // incomplete; it can no longer discard the positions that succeeded.
        const settled = await Promise.allSettled(
          positions.map((p) => fetchPoolRewardsFullScan(cfg.chainId, cfg.rewardsSugar, p.id, poolCount))
        );
        const scans = [];
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled') scans.push(r.value);
          else {
            scanComplete = false;
            logErr(`full-pool scan threw for veNFT ${positions[i].id} (${tokenLabel})`, r.reason);
          }
        });
        if (scans.some((s) => !s.complete)) scanComplete = false;
        for (const scan of scans) {
          // Merge token totals via per-token max, never replacing cheap-path numbers.
          for (const [token, amount] of scan.totals) {
            if (amount > (totals.get(token) || 0n)) totals.set(token, amount);
          }
          // Merge Fee/Bribe contract mappings: add new contracts from historical scan.
          for (const [venftId, entry] of scan.byVenft) {
            if (!byVenft.has(venftId)) byVenft.set(venftId, { fees: new Map(), bribes: new Map() });
            const existing = byVenft.get(venftId);
            for (const [group, contracts] of [['fees', entry.fees], ['bribes', entry.bribes]]) {
              for (const [contract, tokens] of contracts) {
                if (!existing[group].has(contract)) existing[group].set(contract, new Map());
                const existingTokens = existing[group].get(contract);
                for (const [token, amount] of tokens) {
                  const existingAmount = existingTokens.get(token) || 0n;
                  if (amount > existingAmount) existingTokens.set(token, amount);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logErr(`LpSugar.count / full-pool historical scan failed (${tokenLabel})`, err);
      scanComplete = false;
    }
  }

  log(`${tokenLabel} merged totals: ${totals.size} token(s), scanComplete=${scanComplete}`, scanComplete ? 'ok' : 'err');
  return { totals, byVenft, cheapPathFailed, scanComplete };
}

// and this fetches its own, exactly as before.
// Snapshot of the portfolio card's own Aerodrome reward computation, captured the instant
// fetchVeDex resolves for Aerodrome (see the bottom of fetchVeDex below). buildAerodromeClaimPlan
// (the claim panel) reads this directly instead of recomputing independently when it's available
// and fresh for the connected account — the panel now INHERITS the card's own numbers rather than
// racing a second, independent 232-page scan against the card's, which is what let the two show
// different token lists (a scan under page-load RPC contention finding fewer tokens than one run
// later, alone). Overwritten every time the card's Aerodrome fetch completes (connect, Refresh,
// or retry) — always "the card's current state", not a permanent record.
export let aerodromeCardSnapshot = null; // { account, positions, totals, byVenft, scanComplete }

// Freshness check for aerodromeCardSnapshot: same veNFT ids voting for the same pools as when the
// snapshot was captured. A vote move or a new/burned lock since the card last fetched means the
// snapshot's cheap-path numbers no longer reflect reality, so it's treated as stale and the claim
// panel falls back to computing fresh (same as if no snapshot existed at all).
export function veNftPositionsSignature(positions) {
  return positions.map((p) => `${p.id}:${[...p.votes.map((v) => v.lp)].sort().join(',')}`).sort().join('|');
}

export async function fetchVeDex(cfg, tokenLabel, preFetchedPositions) {
  let positions;
  if (preFetchedPositions) {
    positions = preFetchedPositions;
  } else {
    try {
      const raw = await chainCall(cfg.chainId, cfg.veSugar, BY_ACCOUNT + encodeAddress(state.account));
      positions = decodeVeNFTArray(raw);
    } catch (err) {
      logErr(`VeSugar.byAccount failed (${tokenLabel})`, err);
      return { status: 'error', message: `failed to read ve${tokenLabel} positions` };
    }
  }

  const lockedAmount = positions.reduce((sum, p) => sum + p.amount, 0n);
  const permanentCount = positions.filter((p) => p.permanent).length;
  const expiries = positions.filter((p) => !p.permanent && p.expiresAt > 0).map((p) => p.expiresAt);
  let lockedUntil = formatUnlock(expiries.length ? Math.max(...expiries) : 0);
  if (permanentCount) lockedUntil += ` (+${permanentCount} permanent lock${permanentCount > 1 ? 's' : ''})`;

  const rows = [
    { k: `${tokenLabel} locked`, v: `${formatUnits(lockedAmount, 18, 4)} ${tokenLabel}${positions.length > 1 ? ` · ${positions.length} locks` : ''}` },
    { k: 'Locked until', v: lockedUntil, sensitive: false },
  ];

  /* The veNFT id(s) backing this position. Added here rather than in either protocol's own file
     precisely because both Aerodrome and Velodrome's root come through this one function — one row
     definition keeps the two cards identical by construction instead of by maintenance, which is
     the same "one shared source" rule this flow follows for totals.
     Worth surfacing: the id is the key everything else about a position is looked up by — every
     reward scan, every Fee/Bribe .earned() call and every claim transaction is keyed by venft_id
     (see fetchPoolRewardsFullScan) — so it is the one identifier that makes a figure on this card
     checkable against a block explorer or the protocol's own UI.
     `sensitive` so the privacy mask covers it: a veNFT id identifies the holder's position as
     directly as an address does, and this app already masks amounts and addresses. */
  if (positions.length) {
    rows.push({
      k: positions.length > 1 ? 'veNFTs' : 'veNFT',
      v: positions.map((p) => `#${p.id}`).join(' · '),
      sensitive: true,
    });
  }

  /* The veNFT rebase (VeSugar's `rebase_amount` field) is deliberately shown here as
     INFORMATION ONLY and never folded into the claimable total below — it is not free cash.
     This app manages free cash: things it can claim, consolidate to USDC and bridge out. The
     rebase can't be, because claiming it re-locks it straight back into the veNFT instead of
     paying the wallet.

     Mechanism, derived and confirmed live on Base (2026-08-09) rather than taken from docs:
     the rebase is paid by a Curve/Solidly-style RewardsDistributor at
     0x227f65131a261548b057215bb1d5ab2997964c7d, reached two INDEPENDENT ways that agree —
     Voter.minter() (0x07546172) -> 0xeb018363f0a9af8f91f06fee6613a751b2a33fe5, then
     Minter.rewardsDistributor() (0x3f2a5540); and VeSugar.dist() (0xa2d57df1) directly. Its own
     ve() returns 0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4 (== Voter.ve()) and token() returns
     AERO, and eth_getCode returns ~5,961 bytes of real bytecode. Its claimable(uint256)
     (0xd1d58b25) returns EXACTLY this `rebase_amount` per veNFT (verified against test account
     the test account's veNFT: both 1118045482112651834425 wei,
     1118.0455 AERO), and an eth_call simulation of claim(uint256) (0x379607f5) returns the same
     number — so a claim leg WOULD "work", which is exactly why this needs to be written down.

     Why it's still not claimed: claim() pays via VotingEscrow.depositFor(), not a transfer to
     the owner. Confirmed live, not assumed — sampling 163 AERO Transfer events with
     from == the distributor across three block ranges, 162 went to the VotingEscrow itself
     (re-locked) and the single exception (tokenId 116980) was a lock that had already been
     withdrawn to zero, i.e. the expired-lock branch that pays the owner instead (the
     distributor's bytecode carries depositFor, transfer, locked and ownerOf, matching that
     two-branch shape). The test veNFT is a PERMANENT lock (VotingEscrow.locked() ->
     isPermanent = true, end = 0), so its rebase can only ever re-lock.

     So: buildAerodromeClaimPlan() is CORRECT to omit the rebase — do not "fix" it back by
     adding a RewardsDistributor claim tx or folding rebase into plan.tokenTotals. Doing so
     would emit a transaction whose output is a bigger lock, then try to swap and bridge AERO
     the wallet never received. The one case this simplification under-reports is an EXPIRED
     lock, where the rebase does pay out as spendable AERO; that's left out on purpose until
     an expired-lock position actually needs supporting. */
  const rebaseTotal = positions.reduce((sum, p) => sum + p.rebaseAmount, 0n);
  if (rebaseTotal > 0n) {
    rows.push({ k: 'Rebase (not claimable)', v: `${formatUnits(rebaseTotal, 18, 4)} ${tokenLabel} — re-locks into the veNFT` });
  }

  // Build reward totals via the shared helper (cheap path + full-pool scan merge).
  const jobs = positions.flatMap((p) => p.votes.map((v) => ({ id: p.id, lp: v.lp })));
  log(`${tokenLabel}: ${positions.length} ve${tokenLabel} position(s), ${jobs.length} currently-voted pool(s) to check for rewards`);
  const { totals, byVenft, cheapPathFailed, scanComplete } = await buildVeNftRewardTotals(cfg, positions, tokenLabel);

  // Captured for buildAerodromeClaimPlan() to inherit directly — see aerodromeCardSnapshot's
  // comment. Only meaningful for Aerodrome (cfg identity check, not string compare, since this is
  // literally the same AERODROME config object the PROTOCOLS table and the claim panel both use).
  if (cfg === AERODROME) {
    aerodromeCardSnapshot = { account: state.account, positions, totals, byVenft, scanComplete };
  }

  // NOTE: the rebase is deliberately NOT merged into `totals` here — see the long comment above
  // where `rebaseTotal` is computed. `totals` is strictly free cash (fees + bribes), so what this
  // card reports as claimable reconciles with what buildAerodromeClaimPlan() can actually claim,
  // swap and bridge.
  const tokens = [...totals.keys()];
  if (!tokens.length) {
    if (cheapPathFailed) {
      return { status: 'error', message: `failed to read claimable ${tokenLabel} rewards`, claimUsd: 0, rows, claimList: [] };
    }
    return { status: 'ok', claimSummary: usd(0), claimUsd: 0, rows, claimList: [] };
  }

  const priced = await priceTokensUsd(tokens, cfg.priceChain);
  let totalUsd = 0;
  let missingPrice = false;
  const claimList = tokens.map((addr) => {
    const meta = priced[addr];
    const amount = totals.get(addr);
    const usdValue = meta.price != null ? (Number(amount) / 10 ** meta.decimals) * meta.price : null;
    if (usdValue != null) totalUsd += usdValue;
    else missingPrice = true;
    // Expanded view respects each token's own denomination — no forced USD conversion here.
    return { symbol: meta.symbol, amount: formatUnits(amount, meta.decimals, 4), usd: usdValue };
  });

  if (missingPrice) log(`one or more ${tokenLabel} reward tokens have no listed USD price — excluded from the total`, 'info');

  log(`${tokenLabel} card claimList: ${claimList.map((c) => c.symbol).join(', ')}`, 'info');

  return { status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, claimList };
}

/* Reads Velodrome's Superchain leaf-chain claims for a set of already-fetched Optimism veNFT
   positions — see the big comment above VELODROME_LEAF_CHAINS for the full mechanism and the real
   bug this fixes (a historical-vote claim on Celo, invisible to the old root-placeholder-resolution
   approach, found and verified live). For each leaf chain and each veNFT the account owns, this
   calls RewardsSugar.rewards() directly with that chain's own live pool count (fits in one page —
   LEAF_CHAIN_POOL_CAP — since every leaf chain's real count is 18-212) — no VeSugar votes, no
   LpSugar, no root-placeholder map needed at all, because Fee/Bribe .earned() is keyed by venft_id
   independent of current vote status. Returns one subsection per leaf chain that actually has
   something claimable — chains with nothing found are omitted entirely, same "no empty-state
   clutter" rule as everywhere else in this app. */
