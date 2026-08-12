import { CLEVER } from './config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { encodeAddress, formatUnits, formatUnlock, log, logErr, toSigned, usd, word } from '../core/utils.js';

export async function fetchClever() {
  const arg = encodeAddress(state.account);
  const [locked, ...claims] = await Promise.allSettled([
    chainCall(ETH_MAINNET, CLEVER.votingEscrow, CLEVER.LOCKED + arg),
    ...CLEVER.rewards.map((r) => chainCall(ETH_MAINNET, r.feeDistributor, CLEVER.CLAIM + arg)),
  ]);

  const rows = [];
  if (locked.status === 'fulfilled') {
    const amount = toSigned(word(locked.value, 0));
    const end = Number(word(locked.value, 1));
    rows.push({ k: 'CLEV locked', v: `${formatUnits(amount, 18, 4)} CLEV` });
    rows.push({ k: 'Locked until', v: formatUnlock(end), sensitive: false });
  } else {
    logErr('veCLEV locked() failed', locked.reason);
    rows.push({ k: 'CLEV locked', v: 'error', sensitive: false }, { k: 'Locked until', v: 'error', sensitive: false });
  }

  const totals = new Map(); // reward token address (lowercase) -> raw bigint amount
  // A failed claim() read looks IDENTICAL to a genuine zero once it falls through this loop
  // (both just leave `totals` without that token) — tracked separately so an all-failed
  // outcome doesn't get reported as a confident "$0.00, nothing to claim" below.
  let anyClaimFailed = false;
  claims.forEach((c, i) => {
    const reward = CLEVER.rewards[i];
    if (c.status !== 'fulfilled') {
      logErr(`Clever ${reward.label} FeeDistributor claim() failed`, c.reason);
      anyClaimFailed = true;
      // Visible in the expanded row detail even when the OTHER reward succeeds and the
      // top-level badge still shows a real (but partial) dollar total below — otherwise a
      // partial failure here is invisible outside the console.
      rows.push({ k: `Claimable ${reward.label}`, v: 'error', sensitive: false });
      return;
    }
    const amount = word(c.value, 0);
    if (amount > 0n) totals.set(reward.token.toLowerCase(), amount);
  });

  const tokens = [...totals.keys()];
  if (!tokens.length) {
    if (anyClaimFailed) {
      return { status: 'error', message: 'failed to read one or more Clever reward claims', claimUsd: 0, rows };
    }
    return { status: 'ok', claimSummary: usd(0), claimUsd: 0, rows, claimList: [] };
  }

  const priced = await priceTokensUsd(tokens, 'ethereum');
  let totalUsd = 0;
  let missingPrice = false;
  const claimList = tokens.map((addr) => {
    const meta = priced[addr];
    const amount = totals.get(addr);
    const usdValue = meta.price != null ? (Number(amount) / 10 ** meta.decimals) * meta.price : null;
    if (usdValue != null) totalUsd += usdValue;
    else missingPrice = true;
    // Expanded view respects each reward token's own denomination, same rule as
    // every other protocol here — no forced USD conversion outside the summary.
    return { symbol: meta.symbol, amount: formatUnits(amount, meta.decimals, 4), usd: usdValue };
  });

  if (missingPrice) log('one or more Clever reward tokens have no listed USD price — excluded from the total', 'info');

  return { status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, claimList };
}

// Concentrator's veCTR lock + veDistributor claim. Ethereum mainnet only.
// Structurally identical to fetchCurveVeCrv() (one lock read + one single-token
// claim-preview read, no fan-out) — the one difference is the reward token address
// isn't a hardcoded constant, it's read live via veDistributor.token(), because
// unlike Curve's crvUSD, this file's own verification (see the CONCENTRATOR
// comment above) found governance can and does move which token/split reaches
// veCTR holders. Only aCRV currently does, at a live-verified 50% split. aCRV has
// no direct DefiLlama listing, but IS a real ERC4626 vault over cvxCRV (which
// does have a listing) — priceTokensUsd()'s ERC4626 fallback tier prices it via
// asset()+convertToAssets(), so the claim badge shows a real USD figure, not a
// misleading $0.00 (see that function's comment and the CONCENTRATOR block above
// for the verification numbers). If that ever fails for any reason (e.g. cvxCRV's
// own listing disappears), the claim badge falls back to showing the native aCRV
// amount rather than silently rendering $0.00 for a real nonzero claim.
