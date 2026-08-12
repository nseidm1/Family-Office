import { BY_ACCOUNT, VELODROME, VELODROME_LEAF_CHAINS } from './config.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { decodeVeNFTArray, encodeAddress, formatUnits, log, logErr, usd } from '../core/utils.js';
import { uiLog } from '../core/ui-debug.js';
import { LEAF_CHAIN_POOL_CAP, fetchPoolRewardsFullScan, fetchVeDex } from './vedex.js';

export async function fetchVelodromeLeafClaims(positions) {
  if (!positions.length) return [];

  /* allSettled at BOTH levels, matching the fix buildVeNftRewardTotals already carries for
     Aerodrome. The fan-out here is two-dimensional — 10 leaf chains x every veNFT owned — and
     under Promise.all a single rejection anywhere in that grid rejects the outer Promise.all,
     falls into fetchVelodrome's catch, and pushes NO subsections at all: every other chain's
     rewards vanish from the card over one unrelated failure.

     Scope that honestly, because it is narrower than it first looks. A plain RPC outage does
     NOT trigger it — measured live (2026-08-11) by killing both of Celo's endpoints mid-scan:
     Promise.all and allSettled behave identically, dropping only Celo and keeping Ink's
     $20,192.75. fetchPoolRewardsFullScan absorbs transport failures internally (fetchWindow
     returns `{pages: [], complete: false}` rather than throwing), so the common failure never
     surfaces as a rejection. What CAN still reject is everything else in this leaf pipeline —
     priceTokensUsd, the decode, and whatever a future edit adds — and the cost of being wrong
     about that is losing nine healthy chains, so this is deliberate defence in depth rather
     than a fix for an observed outage.

     The parts that DO change observable behaviour: a failed (chain, veNFT) pair is now logged
     individually instead of being invisible, and `complete` is honoured rather than discarded —
     an incomplete scan is a FLOOR, so the subsection says so instead of presenting a partial
     total as if it were final. */
  const settledLeaves = await Promise.allSettled(
    VELODROME_LEAF_CHAINS.map(async (leaf) => {
      const settledScans = await Promise.allSettled(
        positions.map((p) => fetchPoolRewardsFullScan(leaf.chainId, leaf.rewardsSugar, p.id, LEAF_CHAIN_POOL_CAP, LEAF_CHAIN_POOL_CAP))
      );

      const totals = new Map();
      const pools = new Set();
      let complete = true;
      settledScans.forEach((r, i) => {
        if (r.status !== 'fulfilled') {
          complete = false;
          logErr(`Velodrome leaf scan failed (${leaf.name}, veNFT ${positions[i].id})`, r.reason);
          return;
        }
        if (!r.value.complete) complete = false;
        for (const [token, amount] of r.value.totals) totals.set(token, (totals.get(token) || 0n) + amount);
        for (const pool of r.value.pools) pools.add(pool);
      });

      if (!pools.size) return null;

      log(`Velodrome Superchain: ${pools.size} pool(s) with a claimable balance found on ${leaf.name}`);

      const rows = [{ k: 'Pool(s) with rewards', v: `${pools.size} pool${pools.size > 1 ? 's' : ''} on ${leaf.name}`, sensitive: false }];
      // An incomplete scan under-reports, never over-reports, so say "at least" rather than
      // presenting a floor as a final figure.
      if (!complete) rows.push({ k: 'Scan', v: 'partial — total is a floor, retry for the full figure', sensitive: false });
      const tokens = [...totals.keys()];

      const priced = await priceTokensUsd(tokens, leaf.priceChain);
      let totalUsd = 0;
      let missingPrice = false;
      const claimList = tokens.map((addr) => {
        const meta = priced[addr];
        const amount = totals.get(addr);
        const usdValue = meta.price != null ? (Number(amount) / 10 ** meta.decimals) * meta.price : null;
        if (usdValue != null) totalUsd += usdValue;
        else missingPrice = true;
        return { symbol: meta.symbol, amount: formatUnits(amount, meta.decimals, 4), usd: usdValue };
      });

      if (missingPrice) log(`one or more VELO reward tokens on ${leaf.name} have no listed USD price — excluded from the total`, 'info');

      return { id: leaf.chainId, name: leaf.name, status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, claimList };
    })
  );

  const subsections = [];
  settledLeaves.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value) subsections.push(r.value);
      return;
    }
    // A whole leaf chain failing is worth surfacing, not swallowing — but only as its own
    // subsection, so the nine that worked still render.
    logErr(`Velodrome Superchain scan failed (${VELODROME_LEAF_CHAINS[i].name})`, r.reason);
  });
  uiLog('velodrome', 'leaf scan', {
    chains: VELODROME_LEAF_CHAINS.length,
    withRewards: subsections.length,
    failed: settledLeaves.filter((r) => r.status === 'rejected').length,
    partial: subsections.filter((s) => s.rows.some((row) => row.k === 'Scan')).length,
  });
  return subsections;
}

// Velodrome's Portfolio entry: the 'Optimism' subsection is the same veVELO
// lock+claim read fetchVeDex has always done, now joined by zero or more
// Superchain leaf-chain subsections (see fetchVelodromeLeafClaims above) — mirrors
// Curve's veCRV/Votemarket bifurcation pattern (fetchCurve() above).
/* The veNFTs the last refresh found, cached so the claim flow does not repeat VeSugar.byAccount()
   just to learn what the card already read moments earlier. Owned by this module and only ever
   mutated through setLastVelodromePositions() — the ESM rule this codebase already follows for
   cross-file mutable state (an imported binding is read-only to the importer), same shape as
   setPreferWalletRpc()/setPrivacyHidden(). */
export let lastVelodromePositions = null;
export function setLastVelodromePositions(p) { lastVelodromePositions = p; }

export async function fetchVelodrome() {
  let positions = null;
  try {
    const raw = await chainCall(VELODROME.chainId, VELODROME.veSugar, BY_ACCOUNT + encodeAddress(state.account));
    positions = decodeVeNFTArray(raw);
  } catch (err) {
    logErr('VeSugar.byAccount failed (VELO)', err);
  }
  setLastVelodromePositions(positions);

  const rootSub = positions ? await fetchVeDex(VELODROME, 'VELO', positions) : await fetchVeDex(VELODROME, 'VELO');
  const subsections = [{ id: 'optimism', name: 'Optimism', ...rootSub }];

  // Gated on owning a veNFT at all, not on having a CURRENT vote — a veNFT that has since
  // abstained or moved every vote elsewhere can still have real unclaimed leaf-chain rewards
  // sitting from a past vote (see fetchVelodromeLeafClaims' comment); gating on `votes.length`
  // here would silently skip exactly the accounts this fix is for.
  if (positions && positions.length) {
    try {
      subsections.push(...(await fetchVelodromeLeafClaims(positions)));
    } catch (err) {
      logErr('Velodrome Superchain leaf-chain scan failed', err);
    }
  }

  const totalUsd = subsections.reduce((sum, s) => sum + (s.claimUsd || 0), 0);
  const anyOk = subsections.some((s) => s.status === 'ok');
  const status = anyOk ? 'ok' : 'error';
  const message = anyOk ? undefined : subsections.map((s) => `${s.name}: ${s.message || s.status}`).join(' · ');

  /* Hoist the root's position metadata (locked amount, unlock, veNFT ids) to CARD level so the
     Velodrome card presents the same header information as Aerodrome's, rather than burying it
     inside the Optimism subsection where it reads as a per-chain detail. It is not per-chain: a
     veNFT is always locked on Optimism and backs the rewards on every leaf, so card level is
     where it belongs. Same row objects, so styling and the privacy mask follow automatically. */
  const rootRows = subsections[0]?.rows?.filter((r) => /locked|veNFT/i.test(r.k)) || [];
  return { status, claimSummary: usd(totalUsd), claimUsd: totalUsd, message, rows: rootRows, subsections };
}

// Yield Basis's veYB lock + FeeDistributor claim. Structurally closer to Curve's
// fetchCurve (one lock read + one claim-preview read, no fan-out) but shaped like
// fetchVeDex's return since the claim is a multi-token basket, not one number.
