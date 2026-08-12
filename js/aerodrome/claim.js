import { PREVIEW_RESOLVE_BACKOFF_MS, PREVIEW_RESOLVE_SWEEPS, applySlippage, buildAcrossBridgeTxs, buildAerodromeClaimPlan, buildAerodromeClaimTxs, buildAerodromeSwapTxs, fetchAcrossSuggestedFees, quoteAerodromeBridgeLeg, quoteAerodromeSwapWithRetry, resolveAerodromeToken, usdValueOfSwapStep } from './routing.js';
import { AERODROME, AERODROME_CLAIM, CURVE_CRVUSD_USDC_POOL } from '../protocols/config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, multicall, priceTokensUsd } from '../rpc-waterfall.js';
import { isAtomicCapable, isUserRejection, sendAndWait, sendBatchAndWait } from '../tx/send.js';
import { state } from '../core/state.js';
import { encodeAddress, encodeUint256, formatUnits, log, logErr, short, word } from '../core/utils.js';
import { RELEASE_NOTICE, claimBlocked } from '../core/release.js';

export async function buildAerodromeClaimPreview(account, onProgress = () => {}) {
  onProgress({ fraction: 0.02, text: 'Reading claimable positions…' });
  // Used to re-fetch the Aerodrome card fresh here via an entirely separate fetchVeDex() call,
  // run in parallel with plan-building, specifically to avoid comparing a stale on-screen card
  // against a freshly-built plan (which produced false "card shows more than this claim"
  // warnings when on-chain vote/reward state simply moved between the two reads). That worked,
  // but at a real cost: fetchVeDex() and buildAerodromeClaimPlan() both run the exact same
  // RewardsSugar.rewards() full-pool paginated scan (same venftId, same ~232 parallel pages on
  // Aerodrome's 34,707 pools) completely independently — doubling the RPC load this dialog puts
  // out at once, which is exactly the condition under which a page is most likely to fail in ONE
  // of the two scans and not the other. That's what caused tokens (e.g. DRV, LMTS) to show up in
  // one total but not the other despite both being "fresh" — not a pricing or logic bug, a
  // load-induced partial-scan asymmetry. Now there is only ONE scan (buildAerodromeClaimPlan's),
  // and the "fresh card" snapshot below is derived directly from that same plan once it's priced
  // — by construction the two can never disagree over data that actually resolved, and the busy
  // dialog does half the RPC work it used to for the exact same information.
  const plan = await buildAerodromeClaimPlan(account);
  const claimTxs = buildAerodromeClaimTxs(plan);

  const tokens = [...plan.tokenTotals.keys()].filter((t) => t.toLowerCase() !== AERODROME_CLAIM.usdc.toLowerCase());

  // Priced once, early, in a single batched DefiLlama lookup — reused for (1) real token symbols
  // in the busy dialog's route-finding progress below (route-finding itself only needs on-chain
  // reserves, not USD prices, so this text previously fell back to a raw shortened address) and
  // (2) passed through as `pricedTokens` so priceClaimPreview() — called moments later once this
  // preview is shown — can reuse this exact result instead of re-fetching the exact same tokens
  // from the exact same API a few seconds after this call already did.
  const usdcAddr = AERODROME_CLAIM.usdc.toLowerCase();
  const priceLookupList = [...new Set([...plan.tokenTotals.keys()].map((t) => t.toLowerCase()).concat(usdcAddr))];
  const pricedTokens = await priceTokensUsd(priceLookupList, AERODROME.priceChain).catch(() => ({}));

  const swapSteps = []; // { token, amount, legs, quotedUsdcOut }
  const skipped = []; // { token, reason: 'no-route' | 'quote-failed', detail? } — PERMANENT only
  // Tokens we could not resolve because the network never answered, NOT because they are
  // unroutable. These are deliberately kept out of `skipped`: the portfolio card already counts
  // their value as claimable, so treating a transient RPC failure as "will not be swapped" would
  // mean signing a batch that quietly delivers less than the app said was claimable. They are
  // surfaced separately and block Confirm until they resolve (see showClaimPreviewPanel).
  const unresolved = []; // { token, amount, detail }

  // This loop is the slow part — each token needs its own sequential route lookup + quote (and
  // possibly retries), so progress is reported per-token rather than once for the whole loop.
  const ROUTE_PHASE_START = 0.1;
  const ROUTE_PHASE_END = 0.8;

  // Resolves one token via resolveAerodromeToken() and files the result into this closure's
  // three buckets. Returns true when the token reached a terminal state (swapped or permanently
  // skipped), false when it's still unresolved and needs another sweep.
  async function resolveToken(token, amount, label) {
    const result = await resolveAerodromeToken(token, amount, label);
    if (result.kind === 'resolved') {
      swapSteps.push(result.step);
      return true;
    }
    if (result.kind === 'skipped') {
      skipped.push({ token, reason: result.reason, detail: result.detail });
      return true;
    }
    unresolved.push({ token, amount, detail: result.detail });
    return false;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tokenFraction = ROUTE_PHASE_START + ((ROUTE_PHASE_END - ROUTE_PHASE_START) * i) / Math.max(tokens.length, 1);
    const tokenSymbol = pricedTokens[token]?.symbol || short(token);
    onProgress({ fraction: tokenFraction, text: `Finding route for ${tokenSymbol}… (${i + 1}/${tokens.length})`, tokenAddr: token });
    await resolveToken(token, plan.tokenTotals.get(token), `pass 1`);
  }

  // Re-sweep whatever the network refused to answer for. The per-call retries inside
  // discoverAerodromePools/quoteAerodromeCandidates all run within a few hundred ms of each
  // other, so when an endpoint is rate-limiting they tend to fail together; waiting longer
  // between whole sweeps is what actually recovers them. Bounded so a genuinely dead network
  // can't hang the preview — anything still unresolved after this is reported, not dropped.
  for (let sweep = 2; sweep <= PREVIEW_RESOLVE_SWEEPS && unresolved.length; sweep++) {
    const retryList = unresolved.splice(0, unresolved.length);
    onProgress({
      fraction: ROUTE_PHASE_END,
      text: `Retrying ${retryList.length} token${retryList.length === 1 ? '' : 's'} the network didn't answer for… (attempt ${sweep}/${PREVIEW_RESOLVE_SWEEPS})`,
    });
    await new Promise((r) => setTimeout(r, PREVIEW_RESOLVE_BACKOFF_MS * (sweep - 1)));
    for (const { token, amount } of retryList) await resolveToken(token, amount, `sweep ${sweep}`);
  }

  // Real per-token decimals for display only (e.g. cbBTC's 8 vs. the 18 most claimed reward
  // tokens use) — the preview panel would otherwise render a real, nonzero cbBTC balance as a
  // misleading "0.0000" by assuming every token is 18-decimal. Batched into one multicall;
  // defaults to 18 (this app's existing convention for an unreadable decimals()) rather than
  // failing the whole preview over a display-only detail.
  if (swapSteps.length) {
    const decCalls = swapSteps.map((s) => ({ target: s.token, callData: '0x313ce567' }));
    const decResults = await multicall(AERODROME.chainId, decCalls);
    swapSteps.forEach((s, i) => {
      s.decimals = decResults[i]?.success ? Number(word(decResults[i].returnData, 0)) : 18;
    });
  }

  // Order the swap steps by claimed USD value, largest first, so the numbered transaction list
  // reads in the same order as the token list above it (priceClaimPreview sorts led.tokens by
  // value too). Sorted HERE, on the array itself, rather than when building the labels: both
  // aerodromeExecutionLabels() and executeAerodromeClaim() walk `preview.swapSteps` in plain
  // array order, and the panel maps execution progress onto rows POSITIONALLY
  // (stepRows[index].setStatus(...) as each transaction settles). Sorting only the labels would
  // leave the list reading largest-first while execution still ran in the original order, so
  // signing the 3rd transaction would tick off whichever row happened to sit 3rd in the sorted
  // display — a different token entirely. One array, one order, both readers agree.
  swapSteps.sort((a, b) => usdValueOfSwapStep(b, pricedTokens) - usdValueOfSwapStep(a, pricedTokens));

  // USDC claimed directly as a fee/bribe reward token (no swap leg needed) plus every swap
  // step's QUOTED output — a preview estimate only. The actual bridge amount is re-derived from
  // real post-swap balances right before it's sent (see runAerodromeClaimFlow()), since live
  // pool state can move between this quote and execution.
  const directUsdc = plan.tokenTotals.get(AERODROME_CLAIM.usdc.toLowerCase()) || 0n;
  const estimatedUsdc = swapSteps.reduce((sum, s) => sum + s.quotedUsdcOut, directUsdc);

  const { acrossQuote, curveQuote } = await quoteAerodromeBridgeLeg(estimatedUsdc, onProgress);

  onProgress({ fraction: 1, text: 'Preview ready' });
  return { plan, claimTxs, swapSteps, skipped, unresolved, directUsdc, estimatedUsdc, acrossQuote, curveQuote, pricedTokens };
}

// Across's own public fee-quote API (app.across.to) — gives the exact `outputAmount` their
// SpokePool guarantees will be delivered on the destination chain for a given input, so this
// app never has to estimate or hardcode Across's relayer/LP fee itself. Same-origin CORS is
// permissive on this endpoint (confirmed live); no API key required.
export async function executeAerodromeClaim(preview, onStep) {
  /* Last-resort gate. The panel's Confirm button is already disabled under the release gate, so
     reaching here in a gated build means something upstream failed — a re-enabled button, a
     console call, a future edit that forgets. This function broadcasts irreversible,
     money-moving transactions, so it refuses on its own authority rather than trusting a
     disabled attribute several layers away. Demo mode never reaches this (it is handed
     demoExecuteAerodromeClaim instead), so no demo exemption is needed. */
  if (claimBlocked(false)) {
    logErr('claim execution blocked', new Error(RELEASE_NOTICE));
    throw new Error(RELEASE_NOTICE);
  }
  let stepIndex = 0;
  const track = async (fn) => {
    for (;;) {
      onStep(stepIndex, 'active');
      try {
        const result = await fn();
        onStep(stepIndex, 'done');
        stepIndex++;
        return result;
      } catch (err) {
        if (isUserRejection(err)) {
          await onStep(stepIndex, 'rejected');
          continue;
        }
        onStep(stepIndex, 'error');
        throw err;
      }
    }
  };

  const usdcBefore = word(await chainCall(AERODROME.chainId, AERODROME_CLAIM.usdc, '0x70a08231' + encodeAddress(state.account)), 0);

  if (isAtomicCapable(preview.atomicClaimSwap) && preview.swapSteps.length) {
    // One atomic batch: claim + every swap leg. Built entirely from the PREVIEW's own quoted
    // amounts — inside one atomic batch there's no opportunity to read a real intermediate
    // balance between calls the way the sequential fallback below does for a multi-hop step's
    // second leg, so this trusts the quote chain quoteAerodromeRoute() already computed (leg
    // N's quotedOut feeds leg N+1's amountIn). Acceptable specifically BECAUSE it's atomic:
    // `atomicRequired: true` means if a real output ends up under its minOut, the WHOLE batch
    // reverts together — no way to end up claimed-but-partially-swapped, which is exactly the
    // partial-failure state the live re-quote in the sequential path exists to avoid there.
    const calls = [...preview.claimTxs];
    for (const step of preview.swapSteps) {
      let amountIn = step.amount;
      for (const leg of step.legs) {
        const [approveTx, swapTx] = buildAerodromeSwapTxs(
          leg.tokenIn, amountIn, leg.route, leg.tokenOut, leg.minOut, state.account, BigInt(Math.floor(Date.now() / 1000) + 1200)
        );
        calls.push(approveTx, swapTx);
        amountIn = leg.quotedOut;
      }
    }
    await track(() => sendBatchAndWait(calls, AERODROME.chainId, 'claim + consolidate to USDC'));
  } else {
    for (const tx of preview.claimTxs) await track(() => sendAndWait(tx));

    for (const step of preview.swapSteps) {
      // Each leg is approve+swap'd in sequence. The first leg uses the claim plan's known
      // amount; every subsequent leg (multi-hop only) re-reads the bridge token's REAL
      // post-swap balance and re-quotes fresh against it, rather than trusting the preview's
      // estimate — the same "don't trust a pre-trade quote for a later dependent step" rule
      // this flow already applies to the bridge leg below, since leg 1's actual output can
      // differ from what was quoted when the preview was built.
      for (let i = 0; i < step.legs.length; i++) {
        const leg = step.legs[i];
        let amountIn, minOut;
        if (i === 0) {
          amountIn = step.amount;
          minOut = leg.minOut;
        } else {
          amountIn = word(await chainCall(AERODROME.chainId, leg.tokenIn, '0x70a08231' + encodeAddress(state.account)), 0);
          const quotedOut = await quoteAerodromeSwapWithRetry(leg.tokenIn, amountIn, leg.route, leg.tokenOut);
          minOut = applySlippage(quotedOut);
        }
        const [approveTx, swapTx] = buildAerodromeSwapTxs(
          leg.tokenIn, amountIn, leg.route, leg.tokenOut, minOut, state.account, BigInt(Math.floor(Date.now() / 1000) + 1200)
        );
        await track(() => sendAndWait(approveTx));
        await track(() => sendAndWait(swapTx));
      }
    }
  }

  // Matches aerodromeExecutionLabels() not adding bridge steps when there was nothing to
  // consolidate, OR when the user explicitly opted to keep the consolidated USDC on Base —
  // nothing more to do, and nothing more was ever displayed as coming.
  if (preview.estimatedUsdc <= 0n || preview.bridgeEnabled === false) return;

  const usdcAfter = word(await chainCall(AERODROME.chainId, AERODROME_CLAIM.usdc, '0x70a08231' + encodeAddress(state.account)), 0);
  const bridgeAmount = usdcAfter - usdcBefore + preview.directUsdc;
  if (bridgeAmount <= 0n) {
    // A real failure, on what would have been the next tracked step — reported explicitly
    // (rather than left for `track()` to catch) since nothing has called sendAndWait yet here;
    // without this the UI would show no error at all on the row this actually broke.
    onStep(stepIndex, 'error');
    throw new Error('no USDC ended up available to bridge after consolidation');
  }

  const skipCrvUsdSwap = preview.skipCrvUsdSwap === true;
  log(skipCrvUsdSwap
    ? `re-quoting Across for the actual consolidated amount (${formatUnits(bridgeAmount, 6, 2)} USDC)...`
    : `re-quoting Across + Curve for the actual consolidated amount (${formatUnits(bridgeAmount, 6, 2)} USDC)...`, 'info');
  const acrossQuote = await fetchAcrossSuggestedFees(bridgeAmount);
  let minCrvUsdOut = 0n;
  if (!skipCrvUsdSwap) {
    const dy = await chainCall(ETH_MAINNET, CURVE_CRVUSD_USDC_POOL, '0x5e0d443f' + encodeUint256(0n) + encodeUint256(1n) + encodeUint256(acrossQuote.outputAmount));
    minCrvUsdOut = applySlippage(word(dy, 0));
  }

  const [bridgeApprove, bridgeDeposit] = buildAcrossBridgeTxs({
    account: state.account,
    inputAmount: bridgeAmount,
    outputAmount: acrossQuote.outputAmount,
    minCrvUsdOut,
    skipCrvUsdSwap,
  });
  await track(() => sendAndWait(bridgeApprove));
  const depositHash = await track(() => sendAndWait(bridgeDeposit));
  log(skipCrvUsdSwap
    ? `bridge sent — USDC should arrive on Ethereum mainnet shortly via Across: ${depositHash}`
    : `bridge sent — crvUSD should arrive on Ethereum mainnet shortly via Across: ${depositHash}`, 'ok');
}

// Reviews AND executes the Aerodrome "claim to mainnet" flow in one panel that never closes
// mid-flight. Always a centered modal overlay — this used to dock beside the Portfolio card on
// wide viewports instead, back when the panel was a single narrow column, but the two-column
// layout (see .claim-preview-columns) is wide enough that side-docking never really fit anymore.
//
// Two phases, same panel instance:
//   1. Review — exactly as before: browse the claim/consolidate/bridge breakdown, retry any
//      unresolved token in place, Cancel or Confirm. Resolves `false` here on Cancel/close.
//   2. Execution — entered the moment Confirm is clicked (only possible once every token has
//      resolved). The body is replaced with a numbered, top-to-bottom list of every transaction
//      executeClaim() is about to send (see aerodromeExecutionLabels()), each row updating live
//      as executeClaim() calls back into it. Cancel/close/backdrop-click are all disabled for
//      this phase — a signed transaction can't be un-sent, so there is nothing left to usefully
//      cancel, only progress to watch. Resolves `true` only once the LAST transaction has been
//      sent and confirmed; on failure the panel stays open showing exactly which step broke,
//      with its own Close action, rather than vanishing mid-sequence with no trace of where it
//      stopped.
/* ---------- demo mode: claim-to-mainnet ---------- */
// Feeds the EXACT same showClaimPreviewPanel()/priceClaimPreview() pipeline real Aerodrome
// claims use — no parallel rendering path, same rule buildDemoResults() already follows for the
// portfolio cards — so a demo claim looks, ledgers, and animates identically to a real one. Only
// two things are synthetic: WHERE the tokens/amounts come from (below, not a live veNFT reward
// scan) and HOW the transactions "send" (demoExecuteAerodromeClaim(), a timed no-op instead of
// eth_sendTransaction). Everything downstream of that — pricing, the ledger reconciliation, the
// review UI, execution progress, the toasts and the final success popup — is the real code.

// 5 REAL, currently-listed Base tokens standing in for "this epoch's top Aerodrome LP bribes".
// AERO and USDC are this file's own ground truth (AERODROME.token, AERODROME_CLAIM.usdc); the
// other three were independently confirmed live (an eth_call symbol()/decimals() against
// mainnet.base.org, then a coins.llama.fi price lookup, both returning a real, priced result)
// before being hardcoded here — the same bar this file holds every other contract address to.
// WETH is the standard OP-stack predeploy address (identical on every OP-stack chain, including
// Base). Deliberately NOT invented/placeholder addresses: demo mode showing a live, real price
// for a real token is more honest than a fabricated number that goes stale the moment the
// market moves, and it's what makes "query live price" (rather than a hardcoded demo figure)
// actually mean something.
