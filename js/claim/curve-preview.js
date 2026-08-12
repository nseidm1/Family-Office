/* Curve's claim preview — the first protocol on the generic panel, and the reason it has the shape
 * it has (TASKS.md FA-003, which absorbed FA-004).
 *
 * Curve is the SIMPLEST possible claim and therefore the sharpest test of the abstraction: one
 * transaction, on Ethereum mainnet, no swap, no bridge, one chain, no destination choice, and a
 * ledger where claimed and delivered are the same number. If the generic panel can express this
 * without special-casing it, Yield Basis, Clever and Concentrator — all mainnet-native, all
 * display-only today — follow almost for free, which is the actual prize.
 *
 * WHAT CURVE DELIBERATELY DOES NOT SUPPLY, each of which the panel then omits rather than renders
 * empty. These absences are the contract being tested:
 *   - no `destination`      => no toggle. Curve always pays crvUSD on mainnet; a disabled toggle
 *                              would advertise a choice that does not exist.
 *   - `selectable: false`   => no checkbox. A lone tickbox that cannot be unticked implies a decision
 *                              the user does not have; "claim none of it" is the Cancel button.
 *   - two ledger rows only  => the intermediate rows (bridged, consolidated, dust, unroutable) are
 *                              simply absent, and the panel hides a row the builder says nothing
 *                              about instead of printing "—".
 *   - no chain chips        => single-chain flow, so naming the chain on the one step is noise.
 *
 * THE FIGURES COME FROM THE CARD, not from a fresh read. This is the same number the user just saw
 * before clicking Claim, and re-reading FeeDistributor.claim() here would cost an RPC round trip only
 * to display a figure that (barring a claim landing in between) is identical. The real execution path
 * does re-read nothing either — it sends the claim and reports the receipt.
 */

import { CURVE } from '../protocols/config.js';
import { TXT } from './ledger.js';

/* `veCrvSub` is the portfolio card's veCRV subsection — { claimSummary, rows: [{k, v}] }.
   Returns null when there is nothing claimable, so the caller can refuse before opening a panel that
   would review zero dollars. */
export function buildCurveClaimPreview(veCrvSub, { demo = false } = {}) {
  const claimedRow = veCrvSub?.rows?.find((r) => r.k === 'Claimable crvUSD');
  const nativeAmount = claimedRow?.v || null;
  const claimedUsd = veCrvSub?.claimSummary || null;
  if (!nativeAmount && !claimedUsd) return null;

  return {
    protocol: 'curve',
    title: 'Review claim — Curve',
    __demo: demo,
    groups: [{
      id: 'vecrv',
      label: 'veCRV fees on Ethereum mainnet',
      // `selectable: false` is the whole point of this entry — see the header.
      selectable: false,
      items: [{
        addr: CURVE.crvUsd,
        symbol: 'crvUSD',
        // Pre-formatted: the card already rendered this figure and the panel must agree with it to
        // the character. Re-deriving from raw units risks the panel and the card disagreeing about
        // the same claim, which is the one thing a review screen may not do.
        amountText: nativeAmount || '—',
        usd: null,
      }],
    }],
    ledgerRows: [
      { key: 'claimed', label: 'Claimable' },
      { key: 'delivered', label: 'Delivered to your wallet', total: true },
    ],
    /* Claimed and delivered are the SAME number here, and saying so explicitly is the honest version:
       there is no swap, no bridge and no fee taken between the two, so any gap would be a bug. */
    ledger: () => ({ claimed: claimedUsd || nativeAmount, delivered: claimedUsd || nativeAmount }),
    execSteps: [{
      kind: 'claim',
      always: true,
      parts: [TXT('Claim veCRV fees as crvUSD')],
    }],
    summary: { destination: 'Ethereum mainnet' },
    // Carried through so the executor and the success popup can use the same figures the panel showed.
    curve: { nativeAmount, claimedUsd },
  };
}
