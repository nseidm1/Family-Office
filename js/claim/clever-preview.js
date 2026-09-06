/* Clever's claim preview — the fourth single-transaction protocol on the generic panel (FA-10033,
 * skeleton FA-13549). Modelled on concentrator-preview.js; read curve-preview.js's header first for
 * the contract every preview here implements. Two differences from Concentrator, and they are the
 * whole file:
 *
 *   CLEVER CLAIMS FROM TWO FeeDistributors, NOT ONE. CLEVER.rewards (docs/js/protocols/config.js) is
 *   an array — CVX and FRAX today, each { feeDistributor, token, label } — and fetchClever()
 *   (docs/js/protocols/clever.js) already sums per token into `claimList` [{ symbol, amount, usd }].
 *   So the group has ONE ITEM PER REWARD TOKEN, and execution is one claim(address) per distributor,
 *   each through the named constant CLEVER.CLAIM — never a raw selector literal.
 *
 *   THE FIGURES COME FROM THE CARD, same reasoning as Curve and Concentrator: the user just saw them,
 *   and the real execution path re-reads nothing either.
 *
 * SKELETON: the shape below is the contract generic-panel.js documents. The two gaps marked
 * TODO(lane) are bounded fills for the local lane under symbol regions (FA-13537): `cleverGroupItems`
 * and `cleverExecSteps`. Nothing imports this file until orchestrate.js's Clever branch lands
 * (FA-13550), so an unfilled gap breaks nothing.
 */

import { TXT } from './ledger.js';
import { CLEVER } from '../protocols/config.js';

/* One panel item per reward token, from fetchClever()'s claimList. TODO(lane): map each claimList
   entry to { symbol, amountText, usd } — amount is already formatted by the fetch; `addr` is the
   reward token address from CLEVER.rewards matched by label, so applyTokenIcon() can find an icon. */
export function cleverGroupItems(claimList = []) {
  return claimList.map((c) => ({
    addr: (CLEVER.rewards.find((r) => r.label === c.symbol) || {}).token || null,
    symbol: c.symbol,
    amountText: c.amount,
    usd: c.usd ?? null,
  }));
}

/* One execution step per FeeDistributor with a claimable balance. TODO(lane): a step per reward with
   kind 'claim', always: true, and parts naming the token — `Claim veCLEV fees as CVX` — in
   CLEVER.rewards order; skip a reward whose claimList entry is absent or zero. */
export function cleverExecSteps(claimList = []) {
  /* `amount` is fetchClever()'s formatted string ('8.3400'); a formatted zero ('0.0000') is not claimable, so the
     test is numeric, never a string compare — driven: a '0.0000' reward yields no step. */
  const claimable = new Set(claimList.filter((c) => c && Number(String(c.amount || '0').replace(/,/g, '')) > 0).map((c) => c.symbol));
  return CLEVER.rewards
    .filter((r) => claimable.has(r.label))
    // `rewardLabel` is the KEY the executor pairs a step to its distributor by — never by position.
    .map((r) => ({ kind: 'claim', always: true, rewardLabel: r.label, parts: [TXT(`Claim veCLEV fees as ${r.label}`)] }));
}

/* `cleverResult` is fetchClever()'s top-level result — { status, claimSummary, claimUsd, rows,
   claimList }. Returns null when there is nothing claimable, so the caller can refuse before opening
   a panel that would review zero dollars — the same rule as the other single-tx previews. */
export function buildCleverClaimPreview(cleverResult, { demo = false } = {}) {
  const claimList = Array.isArray(cleverResult?.claimList) ? cleverResult.claimList : [];
  const claimedUsd = cleverResult?.claimUsd > 0 ? cleverResult.claimSummary : null;
  const items = cleverGroupItems(claimList);
  if (!items.length && !claimedUsd) return null;

  return {
    protocol: 'clever',
    title: 'Review claim — Clever',
    __demo: demo,
    groups: [{
      id: 'veclev',
      label: 'veCLEV fees on Ethereum mainnet',
      // Single group, nothing to toggle — see curve-preview.js's header for why selectable is false.
      selectable: false,
      items,
    }],
    ledgerRows: [
      { key: 'claimed', label: 'Claimable' },
      { key: 'delivered', label: 'Delivered to your wallet', total: true },
    ],
    /* Claimed and delivered are the SAME number: no swap, no bridge, no fee between the two. */
    ledger: () => ({ claimed: claimedUsd || '—', delivered: claimedUsd || '—' }),
    execSteps: cleverExecSteps(claimList),
    summary: { destination: 'Ethereum mainnet' },
    // Carried through for the executor and the success popup, same as CONCENTRATOR/CURVE.
    clever: { claimList, claimedUsd },
  };
}
