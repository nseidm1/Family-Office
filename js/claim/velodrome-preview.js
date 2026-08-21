/* Velodrome's declarative preview for the generic claim panel (TASKS.md FA-003, step 1 of 2 — see
 * generic-panel.js's header for the contract this builds against, and its own header for why
 * `ledgerLabel`/`summary.destination`-as-function/`summary.extraDetails` exist at all: Velodrome is
 * the first protocol with a REAL destination toggle, which Curve (the design target) has none of.
 *
 * WHAT THIS FILE DOES AND DOES NOT DO. It is a pure ADAPTER: `docs/js/velodrome/claim.js` already
 * builds the real preview (chains, execSteps, quotes, totals) and already executes it — none of
 * that moves. This only reshapes that preview into groups/ledgerRows/ledger()/execSteps the panel
 * understands, and reshapes the panel's selection back into the shape `executeVelodromeClaim`
 * expects. Per TASKS.md's explicit instruction, the execution code in claim.js is untouched.
 *
 * SELECTION SEMANTICS ARE PRESERVED EXACTLY, not redesigned, because changing what a claim actually
 * sends is exactly the risk a panel-only migration must not take. `velodrome-panel.js`'s own
 * `selectedSteps()` used three rules: a `mainnet`-group step needs the destination toggle on; a
 * step whose `chainId` is Optimism (the root) survives as long as ANY chain is still selected,
 * root's own included or not; every other step needs its OWN chain's toggle on. The generic panel's
 * built-in `selectedSteps()` already expresses exactly those three rules — `group === 'destination'`,
 * `groupId == null` (falls back to "any group selected"), `groupId` matched against `selected` — so
 * reproducing the old behavior is a matter of tagging each step correctly below, not writing new
 * filtering logic. Root steps deliberately get NO groupId, even though "Optimism" is itself one of
 * the checkable groups: that is not an oversight, it is the exact behavior the old panel shipped
 * (unticking the Optimism group alone does not stop its own claim/swap as long as another chain is
 * still selected), preserved rather than quietly fixed in the same change that was only supposed to
 * change where the rows are drawn.
 */

import { VELODROME_LEAF_CHAINS } from '../protocols/config.js';
import { OPTIMISM } from '../core/chains.js';
import { usd } from '../core/utils.js';
import { executeVelodromeClaim } from '../velodrome/claim.js';

const OPTIMISM_ID = Number(OPTIMISM);

/* THE ONE FUNCTION EVERY ID IN THIS FILE MUST GO THROUGH, and the reason it exists rather than
   `String(chainId)` inline. Chain ids in `core/chains.js` are HEX STRINGS ('0xa', '0xdef1') because
   they are passed straight to `wallet_switchEthereumChain` — but `buildExecSteps()` in
   velodrome/claim.js carries them through unchanged while the panel matches a step's `groupId`
   against a group's `id` by STRING equality. So a group keyed '0xdef1' and a step keyed '57073' are
   the same chain and never match, and the generic panel silently filters every leaf step out: the
   panel opens looking entirely plausible with only the Optimism rows in it, and a user would sign a
   claim missing every leaf. Caught in a browser after all five gates passed, because the checks
   asserted "more than four steps" and "the Optimism root is present" — both true of the broken list.
   Normalising through Number() first makes '0xdef1' and 57073 the same key by construction. */
const groupKey = (chainId) => String(Number(chainId));

// Same lookup velodrome-panel.js used: names come from VELODROME_LEAF_CHAINS' own `name` field
// rather than a second hardcoded map, so a chain added there is named correctly here for free.
function chainLabel(chainId) {
  if (Number(chainId) === OPTIMISM_ID) return 'Optimism';
  return VELODROME_LEAF_CHAINS.find((c) => Number(c.chainId) === Number(chainId))?.name || `chain ${chainId}`;
}

const LEDGER_ROWS = [
  { key: 'claimed', label: 'Claimed' },
  { key: 'dust', label: 'Skipped — not worth the gas' },
  { key: 'unroutable', label: 'No route to VELO — cannot be moved' },
  { key: 'velo', label: 'Bridged to Optimism' },
  { key: 'usdc', label: 'Consolidated to USDC' },
  { key: 'delivered', label: 'Delivered', total: true },
];

/* Turns the raw preview from buildVelodromeClaimPreview()/buildDemoVelodromeClaimPreview() into the
 * generic panel's declarative shape. `raw` is unchanged by this — the panel keeps reading `raw`'s
 * own `chains`/`execSteps`/`root`/`mainnet`/`totals` via closures, exactly as velodrome-panel.js did
 * as a plain module-scope closure rather than a class; nothing here is copied into a new state
 * container that could drift from it. */
export function buildVelodromeGenericPreview(raw) {
  const chains = raw.chains || [];

  const groups = chains.map((c) => {
    const chainUsd = (c.tokens || []).reduce((sum, t) => sum + (t.usd || 0), 0);
    return {
      id: groupKey(c.chainId),
      label: chainLabel(c.chainId),
      usd: chainUsd,
      selected: !c.dust,
      // Says the amount AND the reason — a skipped chain with no figure is the silent omission the
      // dust policy exists to rule out. FA-122: a root claim that is partly already USDC on Optimism
      // gets the same treatment — the panel names the amount that needs no swap at all, rather than
      // folding it silently into "will be swapped".
      note: c.dust
        ? `Not worth the gas — ${usd(chainUsd)} would cost more to claim and bridge than it is worth. Tick to claim anyway.`
        : (c.alreadyUsdcUsd > 0.005 ? `${usd(c.alreadyUsdcUsd)} of this is already USDC on Optimism — no swap needed` : undefined),
      warn: !!c.dust,
      /* The root (Optimism) leg does not bridge and does not touch VELO for tokens that aren't
         already VELO — it claims and swaps straight to USDC on the chain it is already on. The old
         panel printed the leaf route text ("swap to VELO ... bridge to Optimism") on every chain
         including this one, which was simply wrong for the root; fixed here since it is a pure
         wording bug in the exact text this migration is rewriting anyway, not a change to what gets
         sent. */
      route: c.isRoot
        ? 'Claims and swaps straight to USDC on Optimism — already the destination chain, no VELO hop or bridge needed'
        : `→ swap to VELO on ${chainLabel(c.chainId)} → bridge to Optimism`,
      items: (c.tokens || []).map((t) => ({ addr: t.addr, symbol: t.symbol, amount: t.amount, decimals: t.decimals, usd: t.usd })),
    };
  });

  /* The leaf groups — every selectable chain that is NOT the Optimism root. Needed as a set because
     the consolidation step's condition is "any LEAF is selected", which is not expressible as one
     group id. */
  const leafGroupIds = new Set(chains.filter((c) => !c.isRoot).map((c) => groupKey(c.chainId)));

  /* Every step re-tagged for the generic panel's selectedSteps().
   *
   * THE ROOT CHAIN CARRIES TWO DIFFERENT KINDS OF WORK, and conflating them was FA-034. Both live on
   * Optimism and therefore share a `chainId` (VELODROME.chainId IS OPTIMISM, and claim.js's
   * OPTIMISM_ID is the same constant), so they can only be told apart by `kind`:
   *
   *   - `root-claim` / `root-swap` are OPTIMISM'S OWN REWARDS — the root veNFT's fees and bribes,
   *     claimed and swapped to USDC on the chain they already sit on. That is exactly what the
   *     Optimism checkbox names, so it must gate them. Previously it did not: they were emitted with
   *     no groupId, which the panel reads as "any group selected", so unticking Optimism left its own
   *     claim running anyway. A checkbox that does not stop the thing it names is the "toggle that
   *     implies a decision the user does not have" failure this panel's own design rules call out.
   *   - `root-consolidate` is the LEAVES' LANDING LEG — it swaps the VELO the leaves bridged in. It
   *     is required whenever any leaf is claiming, whether or not Optimism's own rewards are, because
   *     without it those leaf claims strand as VELO on Optimism. So it follows the LEAVES, not the
   *     root checkbox. "Any group selected" was also wrong for it in the other direction: with only
   *     Optimism ticked it survived with nothing to consolidate, rendering a step row that the
   *     executor then no-ops past.
   *
   * `mainnet-*` steps also carry Optimism's chainId (the Across leg departs from there) and are
   * matched FIRST, so they keep following the destination toggle rather than any of the above. */
  const execSteps = (raw.execSteps || []).map((s) => {
    const chainId = s.chainId != null ? Number(s.chainId) : null;
    const isMainnet = s.group === 'mainnet';
    const common = { ...s, chainLabel: s.chainId != null ? chainLabel(s.chainId) : undefined };

    if (isMainnet) return { ...common, groupId: undefined, group: 'destination' };
    if (s.kind === 'root-consolidate') {
      return {
        ...common,
        groupId: undefined,
        group: undefined,
        when: (selectedIds) => (selectedIds || []).some((id) => leafGroupIds.has(id)),
      };
    }
    // Everything else — leaf steps AND the root's own claim/swap — follows its own chain's checkbox.
    return {
      ...common,
      groupId: chainId != null ? groupKey(chainId) : undefined,
      group: undefined,
    };
  });

  function ledger(selectedIds, destinationEnabled) {
    const selectedChains = new Set((selectedIds || []).map(Number));
    const selectedClaimedUsd = chains
      .filter((c) => selectedChains.has(Number(c.chainId)))
      .reduce((sum, c) => sum + (c.tokens || []).reduce((s, t) => s + (t.usd || 0), 0), 0);
    /* "Claimed" is EVERY claimable dollar, matching the portfolio card exactly — the same reasoning
       velodrome-panel.js's own comment gives: showing only the selected total here made the panel
       look like it disagreed with the card about how much was claimable, when it was really
       disagreeing about how much was worth claiming. */
    const allClaimable = raw.totals?.claimedUsd ?? selectedClaimedUsd;
    const skipped = allClaimable - selectedClaimedUsd;
    const unroutable = chains
      .filter((c) => selectedChains.has(Number(c.chainId)))
      .reduce((sum, c) => sum + (c.unroutableUsd || 0), 0);
    const fullBase = raw.totals?.claimableAfterDustUsd || raw.totals?.claimedUsd || 0;
    const base = Math.max(0, fullBase - (raw.totals?.unroutableUsd || 0));
    const share = base ? Math.max(0, selectedClaimedUsd - unroutable) / base : 0;
    const veloUsd = (raw.root?.veloUsd ?? selectedClaimedUsd) * share || 0;
    const usdcUsd = (raw.root?.usdcUsd ?? veloUsd) * share || 0;
    const deliveredUsd = destinationEnabled ? (raw.mainnet?.crvUsdUsd ?? usdcUsd) * share || 0 : usdcUsd;
    return {
      claimed: usd(allClaimable),
      dust: skipped > 0.005 ? `−${usd(skipped)}` : null,
      unroutable: unroutable > 0.005 ? `−${usd(unroutable)}` : null,
      velo: selectedChains.size ? usd(veloUsd) : '—',
      usdc: selectedChains.size ? usd(usdcUsd) : '—',
      delivered: selectedChains.size ? usd(deliveredUsd) : usd(0),
    };
  }

  function ledgerLabel(key, destinationEnabled) {
    if (key !== 'delivered') return null;
    return destinationEnabled ? 'Delivered on Ethereum mainnet' : 'Delivered on Optimism';
  }

  return {
    protocol: 'velodrome',
    title: 'Review claim — Velodrome',
    __demo: !!raw.__demo,
    groups,
    ledgerRows: LEDGER_ROWS,
    ledger,
    ledgerLabel,
    execSteps,
    // Rendered whenever the flow HAS a mainnet leg to offer, even if this specific run's quote
    // failed — the checkbox still shows, disabled, rather than vanishing (same behavior
    // velodrome-panel.js had via `mainnetCb.disabled = !preview.mainnet`).
    destination: { label: 'Continue to crvUSD on Ethereum mainnet', available: !!raw.mainnet, enabled: !!raw.mainnet },
    summary: {
      destination: (destinationEnabled) => (destinationEnabled ? 'Ethereum mainnet' : 'Optimism'),
      extraDetails: (selectedIds) => [{ k: 'Chains', v: String((selectedIds || []).length) }],
    },
  };
}

/* Thin adapter, not a rewrite: the generic panel hands executeClaim an execPreview carrying
 * `destinationEnabled` (its own vocabulary, shared with every protocol on the panel);
 * `executeVelodromeClaim` in claim.js reads `mainnetEnabled` (Velodrome's own name for the same
 * flag, predating the generic panel). This renames the one field and calls straight through —
 * nothing about how transactions are built or sent changes, which is the line TASKS.md draws
 * between "migrate the panel" and "touch the Velodrome execution code" in the same change. */
export async function executeVelodromeClaimGeneric(execPreview, onStep) {
  return executeVelodromeClaim({ ...execPreview, mainnetEnabled: execPreview.destinationEnabled }, onStep);
}
