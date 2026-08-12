import { AERODROME, AERODROME_CLAIM } from '../protocols/config.js';
import { demoUnlock } from '../demo/data.js';
import { priceTokensUsd } from '../rpc-waterfall.js';
import { formatUnits, logErr, short, usd } from '../core/utils.js';

// Built lazily, not as a module-load-time array literal — AERODROME/AERODROME_CLAIM come from
// protocols/config.js, which sits in a large circular-import cluster with this file (config.js ->
// ... -> aerodrome/demo.js -> ... -> config.js among other paths), and evaluating these at module
// scope raced config.js's own initialization ("Cannot access 'AERODROME' before initialization").
let _demoAerodromeTokenPool = null;
export function demoAerodromeTokenPool() {
  if (!_demoAerodromeTokenPool) {
    _demoAerodromeTokenPool = [
      { addr: AERODROME.token, decimals: 18 }, // AERO
      { addr: AERODROME_CLAIM.usdc, decimals: 6 }, // USDC
      { addr: '0x4200000000000000000000000000000000000006', decimals: 18 }, // WETH
      { addr: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 }, // USDbC
      { addr: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 }, // cbBTC
    ];
  }
  return _demoAerodromeTokenPool;
}

// Resolved ONCE per page load and cached (not once per demo cycle — startDemoMode() only calls
// buildDemoResults() a single time; showDemoIndex() just toggles which card is expanded) so the
// portfolio card and the claim-to-mainnet popup this session opens always show the exact same
// live-priced, randomized amounts — the same "one source of truth, no two independent snapshots
// that can quietly disagree" rule buildVeNftRewardTotals()/aerodromeCardSnapshot enforce for the
// real Aerodrome path. Resolves to `null` (never rejects) if the live price lookup fails, so
// callers can fall back to buildDemoResults()'s static numbers rather than breaking demo mode
// entirely over a flaky price API.
export let demoAerodromeTokensPromise = null;
export function demoAerodromeTokens() {
  if (!demoAerodromeTokensPromise) {
    demoAerodromeTokensPromise = priceTokensUsd(demoAerodromeTokenPool().map((t) => t.addr), AERODROME.priceChain)
      .then((priced) => demoAerodromeTokenPool().map((t) => {
        const meta = priced[t.addr] || {};
        const decimals = meta.decimals ?? t.decimals;
        const price = meta.price ?? null;
        // A plausible single-epoch bribe/fee claim — a few to a few dozen dollars per token —
        // randomized once per page load rather than a fixed number, so demo mode doesn't show
        // identical figures on every visit. The AMOUNT is derived from this random $ figure and
        // the real live price, not the other way around, so amount * price always reconciles
        // exactly with the $ figure shown (no rounding-drift between the two).
        const usd = price != null ? 3 + Math.random() * 27 : null;
        const amount = usd != null ? BigInt(Math.round((usd / price) * 10 ** decimals)) : 0n;
        return { addr: t.addr, symbol: meta.symbol || short(t.addr), decimals, price, amount, usd };
      }))
      .catch((err) => {
        logErr('demo mode: live price lookup for Aerodrome bribe tokens failed', err);
        return null;
      });
  }
  return demoAerodromeTokensPromise;
}

// Builds a `preview` in the exact shape buildAerodromeClaimPreview() returns (see its own
// comment: { plan, claimTxs, swapSteps, skipped, unresolved, directUsdc, estimatedUsdc,
// acrossQuote, curveQuote, pricedTokens }), from the live-priced demo tokens above instead of a
// real veNFT scan. `pricedTokens` is populated with every claimed token's REAL live price/
// decimals/symbol, which priceClaimPreview() checks first (its `reusablePricing` fast path) —
// so opening this panel does NOT re-fetch Base-side prices over the network; it reuses exactly
// what's supplied here. priceClaimPreview() still fetches crvUSD's own live price (a real,
// always-listed stablecoin, via the same call every real claim makes) — that one network call is
// left alone on purpose, so the "delivered crvUSD" figure stays genuinely live even in demo mode.
//
// Builds the portfolio CARD's result object (fetchVeDex()'s own {status, claimSummary, claimUsd,
// rows, claimList} shape) from the SAME token array the popup above reads — deliberately not two
// independently-typed numbers. This is the exact "card and panel must derive from one shared
// source, never two snapshots that can quietly disagree" property the real Aerodrome path spent
// real effort getting right (see aerodromeCardSnapshot's comment); demo mode gets it for free by
// construction instead of needing its own parallel fix.
export function buildDemoAerodromeCardResult(tokens) {
  const claimUsd = tokens.reduce((sum, t) => sum + (t.usd || 0), 0);
  const claimList = tokens
    .filter((t) => t.usd != null)
    .map((t) => ({ symbol: t.symbol, amount: formatUnits(t.amount, t.decimals, 4), usd: t.usd }));
  return {
    status: 'ok',
    claimSummary: usd(claimUsd),
    claimUsd,
    rows: [
      { k: 'AERO locked', v: '3,240.0000 AERO · 2 locks' },
      { k: 'Locked until', v: `${demoUnlock(210)} (+1 permanent lock)`, sensitive: false },
      // Mirrors the veNFT row the real card now carries (see fetchVeDex) — demo mode has to show
      // the same metadata or a demo screenshot stops being representative of the real card.
      { k: 'veNFTs', v: '#48213 · #52990', sensitive: true },
    ],
    claimList,
  };
}
export function buildDemoAerodromeClaimPreview(tokens) {
  const usdcAddr = AERODROME_CLAIM.usdc.toLowerCase();
  const tokenTotals = new Map(tokens.filter((t) => t.usd != null).map((t) => [t.addr.toLowerCase(), t.amount]));
  const pricedTokens = {};
  tokens.forEach((t) => { pricedTokens[t.addr.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals, price: t.price }; });

  const usdcToken = tokens.find((t) => t.addr.toLowerCase() === usdcAddr && t.usd != null);
  const directUsdc = usdcToken ? usdcToken.amount : 0n;

  // Every non-USDC token gets one synthetic single-hop swap leg straight to USDC. The quoted
  // output is derived from the token's OWN live $ value (with a small synthetic slippage), same
  // as a real quote would land near — not a fixed/made-up conversion rate.
  const swapSteps = tokens
    .filter((t) => t.addr.toLowerCase() !== usdcAddr && t.usd != null)
    .map((t) => {
      const quotedUsdcOut = BigInt(Math.round(t.usd * 0.997 * 1e6)); // USDC is 6 decimals; ~0.3% synthetic slippage
      return {
        token: t.addr,
        amount: t.amount,
        legs: [{ tokenIn: t.addr, tokenOut: AERODROME_CLAIM.usdc, amountIn: t.amount, quotedOut: quotedUsdcOut, minOut: quotedUsdcOut }],
        quotedUsdcOut,
      };
    })
    // Largest claimed first — matches buildAerodromeClaimPreview()'s own build-time sort (see
    // usdValueOfSwapStep()), the same ordering contract the execution list and the label list
    // both depend on staying true to.
    .sort((a, b) => Number(b.quotedUsdcOut - a.quotedUsdcOut));

  const estimatedUsdc = swapSteps.reduce((sum, s) => sum + s.quotedUsdcOut, directUsdc);
  // Across bridge: a small synthetic relayer fee (~0.05%), same {inputAmount, outputAmount}
  // shape priceClaimPreview() reads off a real acrossQuote.
  const bridgeFeeRaw = estimatedUsdc / 2000n;
  const acrossQuote = { inputAmount: estimatedUsdc, outputAmount: estimatedUsdc - bridgeFeeRaw };
  // USDC (6 decimals) -> crvUSD (18 decimals), with a tiny synthetic positive spread.
  const curveQuote = (acrossQuote.outputAmount * 10n ** 12n * 9995n) / 10000n;

  return {
    plan: { tokenTotals, byVenft: new Map(), scanComplete: true },
    // Never actually sent (see demoExecuteAerodromeClaim) — `data`/`to` only need to exist so
    // anything that reads a claimTx's shape doesn't crash; the label is the only field the UI
    // (or the numbered execution list) actually displays.
    claimTxs: [
      { label: 'claimFees', to: AERODROME_CLAIM.voter, data: '0x', chainId: AERODROME.chainId },
      { label: 'claimBribes', to: AERODROME_CLAIM.voter, data: '0x', chainId: AERODROME.chainId },
    ],
    swapSteps,
    skipped: [],
    unresolved: [],
    directUsdc,
    estimatedUsdc,
    acrossQuote,
    curveQuote,
    pricedTokens,
    atomicClaimSwap: null, // forces the sequential (non-batched) execution path, same as a wallet without EIP-5792
    // Read by enterExecutionView() to keep the toasts and the final popup's wording honest —
    // "sent and confirmed on-chain" would be a false claim about a transaction that was never
    // actually broadcast.
    __demo: true,
  };
}

// The demo stand-in for executeAerodromeClaim() — same onStep(index, status) contract
// (enterExecutionView's callback drives stepRows/toasts/the final popup off exactly this, see
// its own comments), same step COUNT and ORDER (claimTxs, then approve+swap per selected swap
// leg, then approve+bridge if enabled — mirrors aerodromeExecutionLabelsForSelection()'s own
// branches exactly, since that's what built the numbered list this is walking against), just
// with a timed pause standing in for a real wallet round trip instead of eth_sendTransaction.
export async function demoExecuteAerodromeClaim(execPreview, onStep) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stepIndex = 0;
  async function track() {
    onStep(stepIndex, 'active');
    await sleep(500 + Math.random() * 700);
    onStep(stepIndex, 'done');
    stepIndex++;
  }
  for (const _tx of execPreview.claimTxs) await track();
  for (const step of execPreview.swapSteps) {
    for (const _leg of step.legs) {
      await track(); // approve
      await track(); // swap
    }
  }
  if (execPreview.bridgeEnabled && execPreview.swapSteps.length) {
    await track(); // approve bridge
    await track(); // bridge + swap to crvUSD
  }
}

