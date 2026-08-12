import { buildAerodromeClaimPreview, executeAerodromeClaim } from '../aerodrome/claim.js';
import { buildDemoAerodromeClaimPreview, demoAerodromeTokens, demoExecuteAerodromeClaim } from '../aerodrome/demo.js';
import { applyTokenIcon } from '../aerodrome/icons.js';
import { AERODROME, CURVE } from '../protocols/config.js';
import { ETH_MAINNET, chainName } from '../core/chains.js';
import { buildDemoResults, demoActive } from '../demo/data.js';
import { showTxSuccessPopup } from '../tx/feedback.js';
import { deferClaimReveal, pendingClaimReveals, portfolioInFlight, portfolioResults } from '../main.js';
import { showClaimPreviewPanel } from './panel.js';
import { showVelodromeClaimPanel } from './velodrome-panel.js';
import { showGenericClaimPanel } from './generic-panel.js';
import { buildCurveClaimPreview } from './curve-preview.js';
import { lastVelodromePositions } from '../protocols/velodrome.js';
import { buildDemoVelodromeClaimPreview, buildVelodromeClaimPreview, demoExecuteVelodromeClaim, demoVelodromeChains, executeVelodromeClaim } from '../velodrome/claim.js';
import { setPreferWalletRpc } from '../rpc-waterfall.js';
import { isUserRejection, waitForReceipt, walletAtomicCapability } from '../tx/send.js';
import { state } from '../core/state.js';
import { RELEASE_BTN_LABEL, RELEASE_LABEL, RELEASE_NOTICE, claimBlocked } from '../core/release.js';
import { addr, money, uiLog, uiTrace, uiWarn } from '../core/ui-debug.js';
import { encodeAddress, log, logErr, short, spinnerNode } from '../core/utils.js';
import { rpc, switchChain } from '../wallet-connect.js';

export async function runAerodromeClaimFlow() {
  // Busy state covers exactly the part that can genuinely take several seconds — switching
  // chains (if needed) and building the preview (route-finding + quoting, with retries under
  // RPC load) — see setClaimBusy()/buildAerodromeClaimPreview's progress-phase comment. Cleared
  // in `finally` so a failure here (e.g. the user rejects the chain switch, or every route
  // lookup exhausts its retries) never leaves the button stuck disabled/spinning.
  let preview;
  let buildError = null;
  setClaimBusy('aerodrome', true);
  try {
    if (state.chainId !== AERODROME.chainId) {
      setClaimProgress('aerodrome', 0, 'Switching wallet to Base…');
      log('switching wallet to Base to claim Aerodrome rewards...', 'info');
      await switchChain(AERODROME.chainId);
    }
    // Waits out any regular portfolio refresh already in flight before ever setting
    // preferWalletRpc — that flag is a single module-level switch (see chainCall()'s comment),
    // not scoped per call, so flipping it true while an unrelated refresh's chainCall()s are
    // still being issued would route THOSE onto the wallet's provider too, not just this claim
    // preview build. renderPortfolio() holds up the other side of this by refusing to start a
    // new refresh while preferWalletRpc is true, so the two phases can never overlap either way.
    while (portfolioInFlight) {
      setClaimProgress('aerodrome', 0, 'Waiting for the current portfolio refresh to finish…');
      await new Promise((r) => setTimeout(r, 200));
    }
    log('building Aerodrome claim plan (reading live positions + quotes)...', 'info');
    setPreferWalletRpc(true);
    preview = await buildAerodromeClaimPreview(state.account, (p) => setClaimProgress('aerodrome', p.fraction, p.text, p.tokenAddr));
  } catch (err) {
    buildError = err;
  } finally {
    setPreferWalletRpc(false);
    setClaimBusy('aerodrome', false);
  }

  // Reported separately from setClaimBusy(false) above — that call already hides the progress
  // popover, so flashing the error into it has to happen after, not inside the same finally,
  // or it would be hidden the instant it appears. Without this, a failed preview build (a
  // rejected chain switch, a route/quote lookup exhausting its retries, an RPC hiccup) looked
  // exactly like the busy popover "closing prematurely" — the button silently went back to idle
  // with nothing to explain why the review dialog never showed up.
  if (buildError) {
    logErr('failed to build Aerodrome claim preview', buildError);
    // A rejection is a deliberate, intentional user action — safe to retry immediately, same as
    // every other rejection in this flow (see isUserRejection()'s other callers). A genuine
    // build failure (RPC hiccup, retries exhausted) is NOT something hammering Claim again right
    // away is likely to fix, so that path forces a real pause via startClaimCooldown() instead of
    // leaving the button re-clickable the instant setClaimBusy(false) restores it.
    if (isUserRejection(buildError)) {
      flashClaimError('aerodrome', 'Cancelled — rejected in wallet');
    } else {
      // startClaimCooldown() owns the popover message itself (ticking countdown) — no separate
      // flashClaimError() call needed here.
      startClaimCooldown('aerodrome', 60);
    }
    return;
  }

  if (!preview.claimTxs.length) {
    log('nothing currently claimable on Aerodrome', 'info');
    return;
  }

  // Checked here (not inside buildAerodromeClaimPreview) deliberately — that function is a
  // pure chain-data reader (see this app's standing "portfolio data via public RPC, never the
  // wallet's provider" rule); asking the WALLET a question is a different kind of call, and
  // belongs in this orchestrator, which already requires a connected wallet before running.
  // Computed from the swapSteps known AT THIS MOMENT — if a later per-row Retry inside the panel
  // resolves an unresolved token into a new swap step, this does not get re-evaluated. That's a
  // safe, minor missed optimization, not a correctness issue: if it stays `null`/`unsupported`,
  // runAerodromeClaimFlow's execution path below just falls back to sequential transactions
  // instead of one atomic batch, which is fully correct either way.
  preview.atomicClaimSwap = preview.swapSteps.length ? await walletAtomicCapability(AERODROME.chainId) : null;

  // Every unresolved token is retried in place, per-row, inside the panel itself (see
  // showClaimPreviewPanel) — it only ever resolves once Confirm is actually clickable or the
  // user explicitly cancels, so there is no 'retry' outcome to loop on here anymore.
  //
  // The panel now owns execution too: clicking Confirm does not close it or return here —
  // it transforms in place into a live, numbered transaction tracker and calls
  // executeAerodromeClaim() itself, staying open until the LAST transaction is sent and
  // confirmed (or showing exactly which step failed, with its own Close action, if one
  // doesn't). This call only returns once the whole flow — review, sending, and confirmation —
  // has genuinely finished one way or another; there is nothing left to do here afterward
  // regardless of outcome, since the panel already logged and displayed it.
  await showClaimPreviewPanel(preview, executeAerodromeClaim);
}

// Demo mode's own claim-to-mainnet flow — checked FIRST, before the wallet check below, since
// demo mode by definition has no connected wallet and none of this needs one. Reuses the exact
// same panel/execution/toast/popup code the real flow does (see buildDemoAerodromeClaimPreview's
// comment); only the data source and the "sending" step are synthetic.
export async function claimToMainnetDemo(protoId) {
  if (protoId === 'aerodrome') {
    // Real runAerodromeClaimFlow() shows the button's busy popover for exactly as long as
    // buildAerodromeClaimPreview() genuinely takes (route-finding + quoting, several seconds
    // under real RPC load) — see its own comment. demoAerodromeTokens() is usually already
    // resolved/cached by the time Claim is clicked (fetched once at page load), so without this
    // the review panel would just appear instantly, which reads as this step not having
    // happened at all rather than as a fast version of it. This walks the same progress-popover
    // phases with a short simulated delay per phase, so demo mode shows the same "the app is
    // doing real work here" beat the real flow does, not a suspiciously instant panel.
    setClaimBusy('aerodrome', true);
    const phases = [
      [0.15, 'Reading claimable positions…'],
      [0.45, 'Quoting swap routes…'],
      [0.8, 'Fetching live prices…'],
    ];
    for (const [fraction, text] of phases) {
      setClaimProgress('aerodrome', fraction, text);
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 350));
    }
    let tokens;
    try {
      tokens = await demoAerodromeTokens();
    } finally {
      setClaimBusy('aerodrome', false);
    }
    if (!tokens) {
      log('demo: live price lookup is unavailable right now — try again shortly', 'err');
      return;
    }
    const preview = buildDemoAerodromeClaimPreview(tokens);
    await showClaimPreviewPanel(preview, demoExecuteAerodromeClaim);
    return;
  }
  if (protoId === 'velodrome') {
    // Same busy-popover beat the Aerodrome demo walks, and for the same reason: the demo data is
    // usually already cached, so without this the panel appears instantly and reads as the scan
    // step not having happened rather than as a fast version of it. Velodrome's phases name the
    // Superchain scan, because that is genuinely what the real flow spends its time on.
    setClaimBusy('velodrome', true);
    const phases = [
      [0.2, 'Reading veNFT positions…'],
      [0.55, 'Scanning Superchain leaf chains…'],
      [0.85, 'Fetching live prices…'],
    ];
    for (const [fraction, text] of phases) {
      setClaimProgress('velodrome', fraction, text);
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 350));
    }
    let chains;
    try {
      chains = await demoVelodromeChains();
    } finally {
      setClaimBusy('velodrome', false);
    }
    if (!chains) {
      log('demo: live price lookup is unavailable right now — try again shortly', 'err');
      return;
    }
    await showVelodromeClaimPanel(buildDemoVelodromeClaimPreview(chains), demoExecuteVelodromeClaim);
    return;
  }
  if (protoId === 'curve') {
    uiLog('claim', 'curve claim started', { demo: true });
    /* Demo mode drives the REAL panel with the REAL preview builder — only the sending is synthetic,
       which is the rule claimToMainnetDemo()'s own comment sets out. Curve's demo used to be a pair
       of sleeps followed by a success popup, i.e. a parallel code path that could not have caught a
       panel regression; now a demo run exercises exactly what a wallet run renders. */
    // Same demo veCRV figure the card itself shows — buildDemoResults() is cheap/synchronous and
    // rebuilding it here keeps this in step with whatever the card is currently displaying.
    const veCrvSub = buildDemoResults().curve.subsections.find((s) => s.id === 'vecrv');
    const preview = buildCurveClaimPreview(veCrvSub, { demo: true });
    await showGenericClaimPanel(preview, async (_execPreview, onStep) => {
      onStep?.(0, 'active');
      // Plain setTimeout, like every other simulated step — see CLAIM's note on Chrome throttling a
      // backgrounded tab, which makes this appear to stall rather than hang.
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
      onStep?.(0, 'done');
      uiLog('claim', 'curve claim complete', { demo: true, delivered: money(veCrvSub.claimSummary) });
    });
    return;
  }
  log(`Claim to mainnet: consolidation isn't built yet for this protocol — coming soon`, 'info');
}

export async function claimToMainnet(protoId) {
  /* demoActive, not demoTimer. This tested the TOUR's interval handle as a proxy for "demo mode is
     on", which stopped being equivalent when the tour learned to pause on user interaction — and the
     symptom was the Claim button doing nothing at all after any accordion click. */
  if (demoActive) {
    await claimToMainnetDemo(protoId);
    return;
  }
  if (!state.account || !state.provider) {
    log('connect a wallet first to claim', 'err');
    return;
  }
  /* NOTE: the release gate is deliberately NOT enforced here. An earlier version returned at
     this point, which also prevented the preview panel from ever opening on a real wallet —
     wrong, and it threw away the most useful part of the beta. Building the preview reads real
     positions, real rewards, real routes and real bridge quotes; none of that signs anything,
     and it is exactly what wants exercising before launch. The gate belongs at the moment of
     sending, not the moment of asking. See the two enforcement points below and in
     showClaimPreviewPanel(). */
  if (protoId === 'aerodrome') {
    await runAerodromeClaimFlow();
    return;
  }
  if (protoId === 'velodrome') {
    /* Gate is deliberately NOT applied here, same as Aerodrome — building the preview reads real
       positions, real leaf rewards and real prices without signing anything, and that is the part
       worth exercising in a beta. Execution is refused inside executeVelodromeClaim(), twice. */
    const positions = lastVelodromePositions;
    if (!positions || !positions.length) {
      log('no Velodrome veNFT found for this account — refresh the portfolio first', 'err');
      return;
    }
    setClaimBusy('velodrome', true);
    let preview;
    try {
      preview = await buildVelodromeClaimPreview(positions, ({ fraction, text }) => setClaimProgress('velodrome', fraction, text));
    } catch (err) {
      logErr('Velodrome claim preview failed', err);
      return;
    } finally {
      setClaimBusy('velodrome', false);
    }
    if (!preview.chains.length) {
      log('no claimable Velodrome rewards found on any Superchain leaf chain', 'info');
      return;
    }
    await showVelodromeClaimPanel(preview, executeVelodromeClaim);
    return;
  }
  if (protoId !== 'curve') {
    log(`Claim to mainnet: consolidation isn't built yet for this protocol — coming soon`, 'info');
    return;
  }
  // No discrete phases here (a single tx build, no route-finding) — just an indefinite
  // spinner + text (setClaimProgress's `fraction: null` hides the bar) so the button still
  // reads as "working" rather than unresponsive while the wallet switch/prompt is pending.
  // Curve's flow has NO preview panel and no discrete step list (unlike Aerodrome's 12-step
  // pipeline), so there is no per-step narrative to read and setClaimProgress runs with
  // fraction=null — an indefinite spinner. That makes these phase milestones the only record of
  // where a slow or stuck claim actually is, which is exactly why they matter more here than
  // they do on the flow that has a visible checklist.
  uiLog('claim', 'curve claim started', { demo: false, chain: chainName(state.chainId) });

  /* CURVE NOW HAS A PREVIEW PANEL (FA-003), which moves its release gate. It used to be enforced
     right here, because "Curve has no panel, so the button IS the confirmation" — that is no longer
     true, and leaving the gate here would refuse before the panel ever opened, hiding the review
     screen that is the most valuable part of a gated build. The gate now lives where every other
     protocol's does: on the panel's confirm button, plus the executor's own refusal below.
     What must NOT come back is a gate before switchChain() — but nothing switches chains until the
     user confirms now, so the ordering problem that motivated it is gone too. */
  const veCrvSub = portfolioResults?.curve?.subsections?.find((s) => s.id === 'vecrv');
  const preview = buildCurveClaimPreview(veCrvSub);
  if (!preview) {
    // The success popup used to degrade silently to "your crvUSD" when this snapshot was missing.
    // With a review panel there is nothing honest to review, so it refuses instead of showing a
    // panel with a blank figure in it.
    uiWarn('claim', 'curve card snapshot missing — cannot build a review', { haveSubsection: !!veCrvSub });
    log('No claimable veCRV figure to review yet — refresh the portfolio and try again.', 'info');
    return;
  }
  const confirmed = await showGenericClaimPanel(preview, executeCurveClaim);
  uiLog('claim', 'curve panel closed', { confirmed });
}

/* Curve's executor, in the shape the generic panel expects: (execPreview, onStep). One step, so the
   callback is called with index 0 — the same contract a twelve-step Aerodrome run uses, which is what
   makes the panel indifferent to the length of the list. */
async function executeCurveClaim(execPreview, onStep) {
  /* Last-resort refusal, on its own authority rather than trusting a disabled button layers away —
     the third enforcement point release.js describes. */
  if (claimBlocked(false)) {
    uiLog('claim', 'blocked by release gate', { protocol: 'curve', label: RELEASE_LABEL });
    throw new Error(RELEASE_NOTICE);
  }
  const { nativeAmount, claimedUsd } = execPreview.curve || {};
  setClaimBusy('curve', true);
  try {
    if (state.chainId !== ETH_MAINNET) {
      uiLog('claim', 'curve switching chain', { from: chainName(state.chainId), to: chainName(ETH_MAINNET) });
      setClaimProgress('curve', null, 'Switching wallet to Ethereum mainnet…');
      log('switching wallet to Ethereum mainnet to claim...', 'info');
      await switchChain(ETH_MAINNET);
    }
    setClaimProgress('curve', null, 'Waiting for wallet confirmation…');
    // The one step goes active before the wallet is prompted, so the row is spinning while the user
    // is deciding — the same beat every other flow has.
    onStep?.(0, 'active');
    const data = CURVE.CLAIM + encodeAddress(state.account);
    log('sending veCRV claim (crvUSD, Ethereum mainnet)...', 'info');
    const txHash = await rpc('eth_sendTransaction', [{ from: state.account, to: CURVE.feeDistributor, data }]);
    log(`claim transaction sent: ${txHash}, waiting for confirmation...`, 'info');
    // Broadcast, NOT confirmed — deliberately a separate event from the one below so the gap
    // between "wallet accepted it" and "chain confirmed it" is visible in the log. A claim that
    // dies in that gap is otherwise indistinguishable from one that never sent.
    uiLog('claim', 'curve tx sent', { tx: addr(txHash) });
    setClaimProgress('curve', null, 'Waiting for confirmation…');
    // Broadcasting is not "claimed" — eth_sendTransaction resolving only means the wallet
    // accepted and relayed it; it can still revert. The success popup below is specifically
    // gated on a real confirmed receipt (see waitForReceipt/showTxSuccessPopup's own comments).
    await waitForReceipt(txHash, ETH_MAINNET);
    log(`claim transaction confirmed: ${txHash}`, 'ok');
    onStep?.(0, 'done');
    uiLog('claim', 'curve claim complete', {
      demo: false,
      tx: addr(txHash),
      delivered: money(claimedUsd),
      amount: money(nativeAmount),
    });
    /* NO success popup here any more — the panel raises it on resolve, from the same ledger figures
       the user just approved. Raising one from both places showed two popups for one claim. */
  } catch (err) {
    logErr('veCRV claim failed', err);
    onStep?.(0, 'error');
    uiWarn('claim', 'curve claim failed', { error: err?.message, rejected: isUserRejection(err) });
    /* RETHROWN, unlike before. Swallowing it used to be the only sane option because Curve had no
       per-step UI to show a failure against; now the panel does, and it stays open naming the step
       that broke — but only if the rejection reaches it. */
    throw err;
  } finally {
    setClaimBusy('curve', false);
  }
}

export function closeAllClaimMenus() {
  document.querySelectorAll('.claim-menu').forEach((m) => { m.hidden = true; });
}

// Reveals/hides a protocol row's Claim trigger based on whether there's
// actually a nonzero $ figure to claim — called once a result (real or
// demo) is known, from renderProtocolResult() and renderCurveProgressive().
// During a full portfolio refresh (see deferClaimReveal above), an eligible button is queued
// instead of shown immediately — renderPortfolio() reveals every queued one together, faded in
// at once, only after every protocol has settled. Hiding an ineligible button is never deferred
// (nothing unsafe about hiding something sooner).
export function setClaimAvailable(summaryEl, available) {
  const wrap = summaryEl.querySelector('.claim-menu-wrap');
  if (!wrap) return;
  if (!available) {
    wrap.hidden = true;
    return;
  }
  if (deferClaimReveal) {
    pendingClaimReveals.push(wrap);
    return;
  }
  wrap.hidden = false;
}

export function claimMenuWrap(protoId) {
  return document.querySelector(`.protocol[data-protocol="${protoId}"] .claim-menu-wrap`);
}

// Puts a protocol's Claim button into/out of a busy state — building a claim preview involves
// real network round-trips (route-finding, quoting, possibly several retries under RPC load;
// see buildAerodromeClaimPreview's progress-phase comment) that can genuinely take several
// seconds, so this needs to read as "working," not "broken/unresponsive." Swaps the button's
// label for a spinner, disables it and the dropdown so a second click can't start a second
// flow concurrently, and opens the progress popover (see setClaimProgress) alongside it.
export function setClaimBusy(protoId, busy) {
  const wrap = claimMenuWrap(protoId);
  if (!wrap) return;
  const btn = wrap.querySelector('.claim-btn');
  const popover = wrap.querySelector('.claim-progress-popover');
  // A claim flow only ever starts from a button that was already visible and available — force
  // it back to visible here rather than trusting whatever setClaimAvailable() last left it as.
  // Edge case this closes: a full portfolio refresh racing with an in-flight claim replaces the
  // whole protocol list (see renderPortfolio()'s `list.innerHTML = ''`) with a fresh, hidden-by-
  // default wrap; without this, the button could still be sitting hidden once the claim flow's
  // own busy/error state finishes, with nothing left to reveal it again.
  wrap.hidden = false;
  // A fresh busy cycle always supersedes whatever the LAST cycle's error/cooldown state left
  // behind — otherwise a retry started before that state finished cleaning up on its own timer
  // could show stale red error text, or have its countdown silently keep running underneath it.
  if (busy) {
    clearTimeout(wrap._claimErrorTimer);
    clearTimeout(wrap._claimErrorFadeTimer);
    clearInterval(wrap._claimCooldownTimer);
    popover.classList.remove('claim-progress-popover--error', 'claim-progress-popover--fade-out');
  }
  btn.disabled = busy;
  uiLog('claim', busy ? 'busy on' : 'busy off', { protocol: protoId });
  if (busy) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
    btn.textContent = '';
    btn.appendChild(spinnerNode(11));
    popover.hidden = false;
  } else {
    btn.textContent = btn.dataset.idleLabel || 'Claim';
    popover.hidden = true;
  }
}

// Updates the progress popover's text and (optionally) its bar — `fraction` of `null` hides the
// bar entirely and shows text only, for flows (e.g. Curve's single-tx claim) that don't have
// discrete phases to report against, just an indefinite wait. `tokenAddr`, when given (currently
// only the Aerodrome route-finding phase — see buildAerodromeClaimPreview), gets its icon
// (applyTokenIcon — same 1inch-backed lookup the claim panel itself uses) inserted right before
// the token's name in `text`, so this busy dialog shows what it's actually working on rather than
// a bare shortened address.
export function setClaimProgress(protoId, fraction, text, tokenAddr) {
  const wrap = claimMenuWrap(protoId);
  if (!wrap) return;
  const label = wrap.querySelector('.claim-progress-text');
  const track = wrap.querySelector('.claim-progress-track');
  const fill = wrap.querySelector('.claim-progress-fill');
  label.textContent = '';
  if (tokenAddr) {
    const icon = document.createElement('img');
    icon.className = 'claim-progress-token-icon';
    icon.alt = '';
    icon.hidden = true;
    icon.addEventListener('error', () => icon.remove(), { once: true });
    label.appendChild(icon);
    applyTokenIcon(icon, tokenAddr);
  }
  label.appendChild(document.createTextNode(text));
  // The busy popover is the only feedback during the multi-second preview build, so its text is
  // the sole signal of WHERE a slow or wedged claim actually stalled. Tracing it makes that
  // readable after the fact instead of requiring someone to be watching the popover live.
  uiTrace('claim', 'progress', { protocol: protoId, pct: fraction == null ? null : Math.round(fraction * 100), text });
  track.hidden = fraction == null;
  if (fraction != null) fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

// Flashes an error message into the same progress popover setClaimProgress() uses, independent
// of the busy state (which has already been cleared by the time this runs — see
// runAerodromeClaimFlow's catch). Visible for 2s, then fades out over
// .claim-progress-popover--fade-out's CSS transition before actually hiding — going straight to
// hidden=true with no transition read as the popup abruptly vanishing rather than dismissing.
export function flashClaimError(protoId, message) {
  const wrap = claimMenuWrap(protoId);
  if (!wrap) return;
  const popover = wrap.querySelector('.claim-progress-popover');
  const label = wrap.querySelector('.claim-progress-text');
  const track = wrap.querySelector('.claim-progress-track');
  if (!popover || !label || !track) return;
  clearTimeout(wrap._claimErrorTimer);
  clearTimeout(wrap._claimErrorFadeTimer);
  popover.classList.remove('claim-progress-popover--fade-out');
  label.textContent = message;
  track.hidden = true;
  popover.hidden = false;
  popover.classList.add('claim-progress-popover--error');
  // This popover self-dismisses after 2s. Without a log line the only record that a claim failed
  // — and why — vanishes with it, which is exactly the report ("I clicked claim and nothing
  // happened") that is hardest to act on.
  uiWarn('claim', 'error flashed', { protocol: protoId, message });
  wrap._claimErrorTimer = setTimeout(() => {
    popover.classList.add('claim-progress-popover--fade-out');
    wrap._claimErrorFadeTimer = setTimeout(() => {
      popover.hidden = true;
      popover.classList.remove('claim-progress-popover--error', 'claim-progress-popover--fade-out');
    }, 300);
  }, 2000);
}

// Replaces the Claim button's own label with a live countdown and disables it for `seconds`,
// forcing a real pause before the same flaky preview-build path (RPC hiccup, retries exhausted)
// can be hammered again immediately. Reuses the button itself rather than injecting a separate
// widget — same idle-label save/restore dance setClaimBusy() already uses, so the two compose
// cleanly (a fresh busy cycle's clearInterval(wrap._claimCooldownTimer) always wins over this).
//
// Shown in TWO places at once for visibility: the button itself (bold, red-tinted via
// .claim-btn--cooldown, impossible to miss since it's exactly where the user just clicked) and
// the progress popover (which this now owns for the whole cooldown, superseding flashClaimError's
// own short-lived 4s auto-hide — clearTimeout(wrap._claimErrorTimer) below stops that timer from
// yanking the popover out from under this one).
export function startClaimCooldown(protoId, seconds) {
  const wrap = claimMenuWrap(protoId);
  if (!wrap) return;
  const btn = wrap.querySelector('.claim-btn');
  if (!btn) return;
  const popover = wrap.querySelector('.claim-progress-popover');
  const label = wrap.querySelector('.claim-progress-text');
  const track = wrap.querySelector('.claim-progress-track');
  wrap.hidden = false;
  clearInterval(wrap._claimCooldownTimer);
  clearTimeout(wrap._claimErrorTimer);
  clearTimeout(wrap._claimErrorFadeTimer);
  if (popover) popover.classList.remove('claim-progress-popover--fade-out');
  if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
  btn.disabled = true;
  btn.classList.add('claim-btn--cooldown');
  let remaining = seconds;
  const render = () => {
    btn.textContent = `Retry in ${remaining}s`;
    if (popover && label && track) {
      label.textContent = `Failed to build claim preview — retry available in ${remaining}s`;
      track.hidden = true;
      popover.hidden = false;
      popover.classList.add('claim-progress-popover--error');
    }
  };
  render();
  wrap._claimCooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(wrap._claimCooldownTimer);
      btn.disabled = false;
      btn.classList.remove('claim-btn--cooldown');
      btn.textContent = btn.dataset.idleLabel || 'Claim';
      if (popover) {
        popover.hidden = true;
        popover.classList.remove('claim-progress-popover--error');
      }
      return;
    }
    render();
  }, 1000);
}

// Protocols whose actual claim-to-mainnet consolidation flow (claim -> swap -> bridge) is built
// — everything else's Claim button is disabled and labeled "Coming soon" (see buildClaimMenu())
// rather than left clickable but silently a no-op, which is what claimToMainnet()'s own
// early-return for these ids used to mean in practice (a console log nobody but a developer
// would ever see). Read by both the real and demo-mode paths, since it's a statement about what
// this app can DO, not about which wallet is connected.
export const CLAIM_TO_MAINNET_SUPPORTED = new Set(['aerodrome', 'curve', 'velodrome']);

// Small dropdown (Claim to mainnet / Claim to another chain), reusing the
// same .dropdown-menu/.dropdown-item styling the header's Connect menu
// already established rather than inventing a second visual pattern.
export function buildClaimMenu(proto) {
  const wrap = document.createElement('span');
  wrap.className = 'claim-menu-wrap';
  // Hidden until setClaimAvailable() (called from renderProtocolResult()/
  // renderCurveProgressive() once the real $ figure is known) reveals it —
  // there's nothing to claim to show a button for while still loading, on
  // error, or when the resolved total is genuinely $0.
  wrap.hidden = true;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'claim-btn';
  const claimSupported = CLAIM_TO_MAINNET_SUPPORTED.has(proto.id);
  if (claimSupported) {
    btn.textContent = 'Claim';
  } else {
    // Previously this stayed a normal, shimmering, clickable-looking "Claim" button for every
    // protocol — but claimToMainnet() early-returns with only a console log for anything besides
    // aerodrome/curve, so clicking it did nothing visible at all, which read as broken rather
    // than "not built yet". Disabled + relabeled here is the same "not supported" fact
    // claimToMainnet() already knows, just surfaced where it's actually visible.
    btn.textContent = 'Coming soon';
    btn.disabled = true;
    btn.classList.add('claim-btn--soon');
    btn.title = 'Claim-to-mainnet for this protocol is coming soon';
  }

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu claim-menu';
  menu.hidden = true;

  const mainnetItem = document.createElement('button');
  mainnetItem.type = 'button';
  mainnetItem.className = 'dropdown-item';
  mainnetItem.textContent = 'Claim to mainnet';

  const otherChainItem = document.createElement('button');
  otherChainItem.type = 'button';
  otherChainItem.className = 'dropdown-item';
  otherChainItem.disabled = true;
  otherChainItem.textContent = 'Claim to another chain (soon)';

  menu.append(mainnetItem, otherChainItem);

  // Progress popover — same positioning pattern as .dropdown-menu (absolute, anchored to this
  // wrap), shown by setClaimBusy()/updated by setClaimProgress() while a claim preview is being
  // built. Hidden by default; never both this and .claim-menu open at once (opening one closes
  // the other via closeAllClaimMenus()/setClaimBusy()).
  const progress = document.createElement('div');
  progress.className = 'claim-progress-popover';
  progress.hidden = true;
  const progressText = document.createElement('div');
  progressText.className = 'claim-progress-text';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'claim-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'claim-progress-fill';
  progressTrack.appendChild(progressFill);
  progress.append(progressText, progressTrack);

  wrap.append(btn, menu, progress);

  // Every click inside this widget must not bubble up to <summary>'s own
  // click listener (enableAccordion), which would otherwise toggle the
  // protocol card open/closed on every claim-menu interaction.
  //
  // The dropdown menu itself is left fully built (menu/mainnetItem/otherChainItem below) but
  // never opened — with "Claim to another chain" permanently disabled, the menu currently offers
  // exactly one real choice, so making the user click twice (open menu, then pick the only
  // enabled item) was pure friction with no actual decision behind it. The button now goes
  // straight to claimToMainnet(), same target mainnetItem's own click handler already calls.
  // This does NOT skip the safety-critical step: runAerodromeClaimFlow() still builds a full
  // preview and requires an explicit Confirm and proceed in the review panel before anything is
  // signed — only the redundant menu click ahead of that panel is gone. Re-enabling the
  // dropdown (once "claim to another chain" ships) just means restoring this handler to its
  // previous open/close toggle.
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    closeAllClaimMenus();
    claimToMainnet(proto.id);
  });
  mainnetItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu.hidden = true;
    claimToMainnet(proto.id);
  });
  otherChainItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  return wrap;
}

// Builds one <details class="protocol"> node — the same summary/icon/name/
// claim/caret/body structure every protocol card uses, whether it ends up
// filled with real data (renderPortfolio) or demo data (startDemoMode).
// Shared so the two can never drift into slightly-different markup.
