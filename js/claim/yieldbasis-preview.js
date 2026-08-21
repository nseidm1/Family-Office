/* Yield Basis's claim preview — the first protocol on the generic panel with a genuinely
 * rotating multi-token reward basket, unlike Curve's fixed single crvUSD, Clever's fixed
 * pair (CVX, FRAX), and Concentrator's fixed single veDistributor path.
 *
 * Unlike Velodrome (which claims across multiple chains and bridges to one destination),
 * Yield Basis claims a variable-token basket on Ethereum mainnet and delivers it there —
 * exactly one chain, exactly one tx, but the token list is read from the contract's own
 * return rather than hardcoded. This is the FIRST test of whether the generic panel's
 * abstraction holds for "claim a dynamic basket and deliver it as-is".
 *
 * DESIGN CHOICE: plain claim-and-deliver, no consolidation to crvUSD. The tokens are
 * delivered to the user's wallet as the protocol pays them — which may mean a mix of
 * market receipt tokens (yb-WBTC, yb-WETH, etc.) and base tokens. A consolidation leg
 * to crvUSD can be a separate ticket; this ships the plain claim first to keep the
 * implementation tractable and the generic panel's multi-token coverage clear.
 *
 * THE FIGURES COME FROM THE CARD, same as Curve — re-reading FeeDistributor.preview_claim()
 * here would cost an RPC round trip only to display what the user just saw. The execution
 * path does the same — buildCurveClaimPreview() comment explains why, and it applies
 * identically here.
 */

import { YIELD_BASIS } from '../protocols/config.js';
import { ETH_MAINNET, chainName } from '../core/chains.js';
import { TXT } from './ledger.js';

/* `yieldBasisSub` is the portfolio card's Yield Basis subsection — { claimSummary, rows: [{k, v}], claimList: [] }.
   Returns null when there is nothing claimable or the preview failed, so the caller can refuse
   before opening a panel that would review zero dollars or an error state. */
export function buildYieldBasisClaimPreview(yieldBasisSub, { demo = false } = {}) {
  const claimList = yieldBasisSub?.claimList || [];
  const claimedUsd = yieldBasisSub?.claimSummary || null;

  /* A failed preview read (status: 'error') has claimList = [] and claimSummary = null,
     so refusing here also refuses on the error path, same way Curve's builder does. */
  if (!claimList.length && !claimedUsd) return null;

  return {
    protocol: 'yieldbasis',
    title: 'Review claim — Yield Basis',
    __demo: demo,
    groups: [{
      id: 'yb-rewards',
      label: 'veYB rewards on Ethereum mainnet',
      // Multi-token basket is always selectable as a group (Yield Basis does not have a
      // "claim none of it" state the way Velodrome's per-chain toggles do), but individual
      // items in the basket are all-or-nothing since the contract's own claim() takes no
      // per-token routing parameters. selectable: false here means one checkbox at the group
      // level, not itemized checkboxes per token.
      selectable: false,
      items: claimList.map((c) => ({
        addr: null, // Tokens are discovered from preview_claim's return, not hardcoded config.
        symbol: c.symbol,
        // Pre-formatted from the card's own render, same as Curve — the panel must agree
        // with the card to the character for review to be honest.
        amountText: c.amount || '—',
        usd: c.usd,
      })),
    }],
    ledgerRows: [
      { key: 'claimed', label: 'Claimable' },
      { key: 'delivered', label: 'Delivered to your wallet', total: true },
    ],
    /* Claimed and delivered are the SAME number: no swap, no bridge, no consolidation
       between the two. Any gap would be a bug. */
    ledger: () => ({ claimed: claimedUsd || null, delivered: claimedUsd || null }),
    execSteps: [{
      kind: 'claim',
      always: true,
      parts: [TXT(`Claim veYB rewards to ${claimList.length} token${claimList.length === 1 ? '' : 's'}`)],
    }],
    summary: { destination: 'Ethereum mainnet' },
    // Carried through so the executor and the success popup can use the same figures
    // the panel showed.
    yieldbasis: { claimList, claimedUsd },
  };
}
