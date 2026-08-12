import { CONCENTRATOR } from './config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { addrAt, encodeAddress, formatUnits, formatUnlock, log, logErr, toSigned, usd, word } from '../core/utils.js';

export async function fetchConcentrator() {
  const arg = encodeAddress(state.account);
  const [locked, claimable] = await Promise.allSettled([
    chainCall(ETH_MAINNET, CONCENTRATOR.votingEscrow, CONCENTRATOR.LOCKED + arg),
    chainCall(ETH_MAINNET, CONCENTRATOR.feeDistributor, CONCENTRATOR.CLAIM + arg),
  ]);

  const rows = [];
  if (locked.status === 'fulfilled') {
    const amount = toSigned(word(locked.value, 0));
    const end = Number(word(locked.value, 1));
    rows.push({ k: 'CTR locked', v: `${formatUnits(amount, 18, 4)} CTR` });
    rows.push({ k: 'Locked until', v: formatUnlock(end), sensitive: false });
  } else {
    logErr('veCTR locked() failed', locked.reason);
    rows.push({ k: 'CTR locked', v: 'error', sensitive: false }, { k: 'Locked until', v: 'error', sensitive: false });
  }

  let claimSummary = usd(0);
  let claimUsd = 0;
  if (claimable.status === 'fulfilled') {
    const amount = word(claimable.value, 0);
    let symbol = 'reward token';
    let decimals = 18;
    let price = null;
    try {
      const rewardToken = addrAt(await chainCall(ETH_MAINNET, CONCENTRATOR.feeDistributor, CONCENTRATOR.TOKEN), 0);
      const meta = (await priceTokensUsd([rewardToken], 'ethereum'))[rewardToken];
      symbol = meta.symbol;
      decimals = meta.decimals;
      price = meta.price;
    } catch (err) {
      logErr('veDistributor token() lookup failed', err);
    }
    const native = `${formatUnits(amount, decimals, 4)} ${symbol}`;
    if (price != null) {
      claimUsd = (Number(amount) / 10 ** decimals) * price;
      claimSummary = usd(claimUsd);
    } else if (amount > 0n) {
      // priceTokensUsd() now prices aCRV for real via its ERC4626 asset()+
      // convertToAssets() route to cvxCRV (see the CONCENTRATOR comment above and
      // priceTokensUsd()'s own comment), so this branch should be effectively
      // unreachable in practice — it only fires if that pricing path itself ever
      // breaks (e.g. cvxCRV's own DefiLlama listing disappears). Deliberately NOT
      // putting the native-token string in the badge here: a prior version of
      // this file did that and it was reverted after live user testing on master
      // (commit 25ae662) — "summary badge is always a dollar figure; native
      // amounts only show in the expanded row" is the established, user-confirmed
      // convention every other protocol's `missingPrice` handling follows too.
      log('Concentrator reward token has no listed USD price — excluded from the summary total', 'info');
    }
    rows.push({ k: `Claimable ${symbol}`, v: native });
  } else {
    logErr('veDistributor claim() failed', claimable.reason);
    rows.push({ k: 'Claimable rewards', v: 'error', sensitive: false });
    // A failed claim() read is NOT "genuinely nothing claimable" — status:'ok' here would show
    // a confident, green $0.00 indistinguishable from a real zero balance. status:'error'
    // renders as a clickable retry (see setClaimStatusRetry()) instead of a wrong answer.
    return { status: 'error', message: 'failed to read claimable rewards', claimUsd: 0, rows };
  }

  return { status: 'ok', claimSummary, claimUsd, rows };
}

