/* Concentrator's claim preview — the third protocol on the generic panel, and the CLOSEST of the
 * three display-only protocols to Curve's shape (TASKS.md FA-038, which followed FA-003's own
 * prediction that Yield Basis/Clever/Concentrator would "follow almost for free").
 *
 * Structurally identical to curve-preview.js: one transaction, on Ethereum mainnet, no swap, no
 * bridge, one chain, no destination choice, claimed and delivered are the same number. Read that
 * file's header first — everything below is the same contract with one difference, and the
 * difference is why this is its own file rather than a thin wrapper:
 *
 *   CURVE'S REWARD TOKEN IS A CONSTANT (crvUSD); CONCENTRATOR'S IS READ LIVE. `fetchConcentrator()`
 *   (docs/js/protocols/concentrator.js) discovers the reward token via veDistributor.token() and
 *   folds BOTH the symbol and the formatted amount into one row, `Claimable ${symbol}` — never a
 *   fixed key the way Curve's `Claimable crvUSD` is. So this builder locates that row by PREFIX
 *   (`Claimable `) rather than by exact match, and derives the symbol from what is left over. See
 *   the CONCENTRATOR block in protocols/config.js for why the token cannot be hardcoded (governance
 *   can and has changed which token/split reaches veCTR holders) — this file inherits that property
 *   by construction rather than repeating it, since it never names a token itself.
 *
 * THE FIGURES COME FROM THE CARD, not from a fresh read — same reasoning as Curve's preview: the
 * user just saw this number, re-reading FeeDistributor.claim() here would cost an RPC round trip to
 * display something that (barring a claim landing in between) is identical, and the real execution
 * path re-reads nothing either.
 */

import { TXT } from './ledger.js';

/* `concentratorResult` is the protocol's own top-level result — {status, claimSummary, claimUsd,
   rows} — NOT a subsection the way Curve's veCrvSub is; Concentrator has no subsections. Returns
   null when there is nothing claimable, so the caller can refuse before opening a panel that would
   review zero dollars. */
export function buildConcentratorClaimPreview(concentratorResult, { demo = false } = {}) {
  const claimedRow = concentratorResult?.rows?.find((r) => typeof r.k === 'string' && r.k.startsWith('Claimable '));
  const nativeAmount = claimedRow?.v || null;
  const symbol = claimedRow ? claimedRow.k.slice('Claimable '.length) : null;
  const claimedUsd = concentratorResult?.claimSummary || null;
  if (!nativeAmount && !claimedUsd) return null;

  return {
    protocol: 'concentrator',
    title: 'Review claim — Concentrator',
    __demo: demo,
    groups: [{
      id: 'vectr',
      label: 'veCTR fees on Ethereum mainnet',
      // `selectable: false` is the whole point of this entry — see curve-preview.js's header.
      selectable: false,
      items: [{
        // No token address to hand to applyTokenIcon(): the card's own fetch never carried one
        // through (only the symbol, resolved via token() and priced via priceTokensUsd()), so the
        // row renders symbol + amount with no icon rather than guessing an address.
        symbol: symbol || 'reward token',
        amountText: nativeAmount || '—',
        usd: null,
      }],
    }],
    ledgerRows: [
      { key: 'claimed', label: 'Claimable' },
      { key: 'delivered', label: 'Delivered to your wallet', total: true },
    ],
    /* Claimed and delivered are the SAME number here, for the same reason as Curve: no swap, no
       bridge and no fee taken between the two. */
    ledger: () => ({ claimed: claimedUsd || nativeAmount, delivered: claimedUsd || nativeAmount }),
    execSteps: [{
      kind: 'claim',
      always: true,
      parts: [TXT(symbol ? `Claim veCTR fees as ${symbol}` : 'Claim veCTR fees')],
    }],
    summary: { destination: 'Ethereum mainnet' },
    // Carried through so the executor and the success popup can use the same figures the panel
    // showed, same as CURVE.nativeAmount/claimedUsd.
    concentrator: { nativeAmount, claimedUsd },
  };
}
