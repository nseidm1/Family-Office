/* LI.FI routing for Velodrome leaf rewards — swap-and-bridge in one transaction, per token.
 *
 * WHY THIS EXISTS, measured rather than assumed. Velodrome's leaf deployments hold almost no
 * liquidity: Ink's entire WETH/XVELO pool is 0.0092 WETH and 1,006 XVELO, so ANY route that swaps a
 * reward token on the leaf caps at the pool's whole reserve (~$17) no matter the input. Quoted live
 * for veNFT #151, $20,933 of $23,216 claimable had nowhere to go. Across alone carries only four
 * token types off Ink (ETH/USDC/USDT/WETH), which reached 82%.
 *
 * LI.FI reaches 99.1%, measured on the same veNFT, because it combines a source-chain swap with
 * whichever bridge actually serves that pair — and it delivers straight to USDC on Optimism, which is
 * where this flow already consolidates:
 *
 *   Ink USDT0  $12,657.98 -> $12,614.53 (99.7%)  via Polymer
 *   Ink WETH    $3,852.46 ->  $3,839.39 (99.7%)  via Polymer
 *   Ink USDC.e  $1,413.54 ->  $1,414.17 (100%)   via Polymer
 *   Ink kBTC    $1,361.96 ->  $1,350.99 (99.2%)  via Across V4
 *   Ink USDG      $912.25 ->    $909.53 (99.7%)  via Stargate V2
 *   Celo USDT0    $322.14 ->    $320.15 (99.4%)  via Layerswap
 *   Soneium x2    $208.04 ->    $207.20 (99.5%)  via Across V4 / Relay
 *
 * Only Celo WETH ($201) had no route at all.
 *
 * VENDOR DEPENDENCY, stated plainly: this is the second third-party API this app depends on (Across
 * is the first) and the first that returns CALLDATA rather than only numbers. That is the trade being
 * made — a token this app cannot route itself is worth ~0.4% of its value on the leaf, and ~99.5%
 * through LI.FI. The mitigations are that every quote is re-fetched at execution time against the real
 * balance, the returned target is approved for exactly the amount being spent, and nothing is sent
 * while the release gate is on.
 *
 * `li.quest` must be in index.html's CSP `connect-src` or every call fails as "Failed to fetch" —
 * which is exactly how this was first discovered from inside the app.
 */

import { ETH_MAINNET, OPTIMISM } from '../core/chains.js';
import { VELODROME_CLAIM } from '../protocols/config.js';
import { fetchJson } from '../rpc-waterfall.js';
import { logErr, short } from '../core/utils.js';

const LIFI = 'https://li.quest/v1';

/* Quotes one leaf token all the way to USDC on Optimism. `account` is required by LI.FI and is also
   the recipient — funds go to the user's own address, never to this app or an intermediary.
   Returns null when LI.FI has no route, which is a normal answer for an exotic bribe token, not an
   error worth failing a preview over. */
export async function quoteLifiToOptimismUsdc({ chainId, token, amount, account }) {
  if (!account || !amount || amount <= 0n) return null;
  const url = `${LIFI}/quote?fromChain=${Number(chainId)}&toChain=${Number(OPTIMISM)}`
    + `&fromToken=${token}&toToken=${VELODROME_CLAIM.root.usdc}&fromAmount=${amount}`
    + `&fromAddress=${account}&toAddress=${account}`;
  try {
    const j = await fetchJson(url);
    const est = j?.estimate;
    const tx = j?.transactionRequest;
    if (!est?.toAmount || !tx?.to || !tx?.data) return null;
    return {
      usdcOut: BigInt(est.toAmount),
      tool: j.toolDetails?.name || j.tool || 'LI.FI',
      // The contract LI.FI expects to move the token. NOT assumed to be `tx.to`: for some tools they
      // differ, and approving the wrong address means an approve that grants nothing and a swap that
      // reverts.
      approvalAddress: est.approvalAddress || tx.to,
      tx: { to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n },
    };
  } catch (err) {
    // A 404 here means "no route", which LI.FI signals as an error status; do not shout about it.
    if (!/no available quotes|not found|404/i.test(String(err?.message))) {
      logErr(`LI.FI quote failed for ${short(token)} on chain ${chainId}`, err);
    }
    return null;
  }
}

/* approve() the exact amount to LI.FI's approval target, then send the routed transaction verbatim.
   The calldata is LI.FI's, deliberately unmodified — rewriting a router's own payload is how an
   integration silently breaks when the vendor changes tools. What this app controls is the approval
   (exact amount, specific spender) and the fact that the recipient in the quote is the user. */
export function buildLifiTxs({ chainId, token, amount, quote, symbol }) {
  if (!quote?.tx?.to) throw new Error('refusing to build a LI.FI transaction without a routed quote');
  const label = symbol || short(token);
  return [
    {
      label: `approve ${label} → ${quote.tool}`,
      to: token,
      data: '0x095ea7b3' + String(quote.approvalAddress).toLowerCase().replace('0x', '').padStart(64, '0')
        + amount.toString(16).padStart(64, '0'),
      chainId,
    },
    {
      label: `swap + bridge ${label} → USDC on Optimism (${quote.tool})`,
      to: quote.tx.to,
      data: quote.tx.data,
      value: quote.tx.value || 0n,
      chainId,
    },
  ];
}

// Kept for symmetry with the rest of the flow: everything LI.FI delivers is USDC on Optimism, so the
// destination chain is never in doubt and the mainnet leg stays the existing Across hop.
export const LIFI_DESTINATION = OPTIMISM;
export const LIFI_FINAL_HOP = ETH_MAINNET;
