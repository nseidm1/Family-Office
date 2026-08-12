import { YIELD_BASIS } from './config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { decodePreviewClaim, encodeAddress, encodeUint256, formatUnits, formatUnlock, log, logErr, toSigned, usd, word } from '../core/utils.js';

export async function fetchYieldBasis() {
  const arg = encodeAddress(state.account);
  const [locked, claimable] = await Promise.allSettled([
    chainCall(ETH_MAINNET, YIELD_BASIS.votingEscrow, YIELD_BASIS.LOCKED + arg),
    // epoch_count=50, use_vest=false — the contract's own defaults for a plain
    // read-only claim preview (see the YIELD_BASIS comment above for why these
    // are safe to simulate via eth_call rather than sending a real tx).
    chainCall(ETH_MAINNET, YIELD_BASIS.feeDistributor, YIELD_BASIS.PREVIEW_CLAIM + arg + encodeUint256(50) + encodeUint256(0)),
  ]);

  const rows = [];
  if (locked.status === 'fulfilled') {
    const amount = toSigned(word(locked.value, 0));
    const end = word(locked.value, 1);
    // veYB supports an "infinite lock" (infinite_lock_toggle()) that reports `end`
    // as UINT256_MAX instead of a real timestamp — formatUnlock()'s Date() would
    // choke on that, so it's called out explicitly instead, same idea as how
    // fetchVeDex reports Aerodrome/Velodrome's permanent locks.
    const isInfinite = end === (1n << 256n) - 1n;
    rows.push({ k: 'YB locked', v: `${formatUnits(amount, 18, 4)} YB` });
    rows.push({ k: 'Locked until', v: isInfinite ? 'no expiry (infinite lock)' : formatUnlock(Number(end)), sensitive: false });
  } else {
    logErr('veYB locked() failed', locked.reason);
    rows.push({ k: 'YB locked', v: 'error', sensitive: false }, { k: 'Locked until', v: 'error', sensitive: false });
  }

  if (claimable.status !== 'fulfilled') {
    logErr('FeeDistributor preview_claim() failed', claimable.reason);
    rows.push({ k: 'Claimable rewards', v: 'error', sensitive: false });
    // A failed claim-preview read is NOT "genuinely nothing claimable" — status:'ok' here would
    // show a confident, green $0.00 indistinguishable from a real zero balance. status:'error'
    // renders as a clickable retry (see setClaimStatusRetry()) instead of a wrong answer.
    return { status: 'error', message: 'failed to read claimable rewards', claimUsd: 0, rows };
  }

  const claims = decodePreviewClaim(claimable.value);
  if (!claims.length) {
    return { status: 'ok', claimSummary: usd(0), claimUsd: 0, rows, claimList: [] };
  }

  const priced = await priceTokensUsd(claims.map((c) => c.token), 'ethereum');
  let totalUsd = 0;
  let missingPrice = false;
  const claimList = claims.map(({ token, amount }) => {
    const meta = priced[token];
    const usdValue = meta.price != null ? (Number(amount) / 10 ** meta.decimals) * meta.price : null;
    if (usdValue != null) totalUsd += usdValue;
    else missingPrice = true;
    // Expanded view respects each reward token's own denomination, same rule as
    // every other protocol here — no forced USD conversion outside the summary.
    return { symbol: meta.symbol, amount: formatUnits(amount, meta.decimals, 4), usd: usdValue };
  });

  if (missingPrice) log('one or more Yield Basis reward tokens have no listed USD price — excluded from the total', 'info');

  return { status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, claimList };
}

// Clever's veCLEV lock + TWO independent FeeDistributor claims (CVX, FRAX). Same
// shape as fetchCurveVeCrv (one lock read) fanned out over fetchVeDex/
// fetchYieldBasis's claimList pattern, since the reward side is a multi-token
// basket here rather than one number. See the big CLEVER comment above for the
// mechanism and the live verification this is built on.
