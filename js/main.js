import { fetchCashBalances, refreshCash, renderCash, resetCash } from './protocols/cash.js';
import { PROTOCOLS } from './protocols/config.js';
import { startDemoMode, stopDemoMode } from './demo/data.js';
import { setClaimAvailable } from './claim/orchestrate.js';
import { THEME_KEY, applyPrivacyMode, applyTheme, getStoredTheme, lightMediaQuery, privacyHidden, setPrivacyHidden } from './core/prefs.js';
import { buildProtocolNode, clearAlphaIcons, clearClaimStatusRetry, enableCardAccordion, renderAlphaIcons, renderCurveProgressive, renderPortfolioTotal, renderProtocolResult, resetPortfolioTotal, setClaimStatusRetry } from './render/portfolio.js';
import { preferWalletRpc } from './rpc-waterfall.js';
import { state } from './core/state.js';
import { $, fadeInSwap, log, logErr, spinnerNode } from './core/utils.js';
import { addr, money, uiLog, uiTime, uiWarn } from './core/ui-debug.js';
import { RELEASE_LABEL, RELEASE_NOTICE, RELEASE_TESTING } from './core/release.js';
import { discovered, renderConnection, renderEnv, requestProviders } from './wallet-connect.js';

export let portfolioInFlight = false;

// While true, setClaimAvailable() queues eligible Claim buttons instead of revealing them one
// at a time as each protocol's OWN fetch happens to finish — renderPortfolio() sets this at the
// start of a full refresh and reveals every queued button together, faded in at once, only once
// EVERY protocol has settled. Reason: with this off, an early-finishing protocol's Claim button
// (and the wallet-signing actions behind it) was clickable while the rest of the portfolio was
// still loading, which is exactly the state a since-fixed bug ("pressing claim while other
// positions are loading closes the busy dialog") happened in. Not touched by refreshProtocol()'s
// single-row retry — reveals its own row's button immediately, unchanged, since there's no
// "everything else is also loading" concern for a retry of one already-settled row.
export let deferClaimReveal = false;
export const pendingClaimReveals = [];

// Bumped by every renderPortfolio() run and by cancelPortfolioRefresh(). An in-flight refresh
// compares the generation it captured at start against this before painting anything, so a
// cancelled run's late-arriving fetches quietly discard their results instead of overwriting
// the UI the user is now looking at. Cancellation is necessarily COOPERATIVE — the underlying
// fetches aren't abortable from here (they're several layers down inside publicRpc's own retry
// machinery), so "cancel" means "stop paying attention to this run", not "stop the network
// traffic". Already-completed rows are deliberately left exactly as they are; only rows still
// spinning (or already errored) get reset, per the cancel semantics.
export let refreshGeneration = 0;

// Last full render's per-protocol results and DOM nodes, kept so a SINGLE protocol can be
// re-fetched in place (see refreshProtocol(), reached by clicking a failed row's "error"
// label) without tearing down and re-fetching the whole portfolio — every other protocol's
// already-good data stays on screen and un-refetched. Both are rebuilt from scratch by each
// full renderPortfolio() run.
export let portfolioResults = {};
export let protocolNodes = {};

// Re-fetches and re-renders exactly one protocol row. Used as the retry action on a row that
// errored — a failed fetch is usually a transient per-protocol RPC problem (this app's whole
// PUBLIC_RPCS/retry machinery exists because of them), so retrying just that one row is both
// faster and less disruptive than a full refresh. Deliberately a no-op while a full refresh is
// already running (portfolioInFlight), since that will re-render this row anyway.
// Strips the click-to-retry affordance setClaimStatusRetry() adds, so a row being put back
// into a loading/ok state doesn't keep a stale handler, role, or gradient styling.
export async function refreshProtocol(protoId) {
  if (portfolioInFlight) return;
  // Same reasoning as renderPortfolio()'s own preferWalletRpc check — a per-protocol retry is
  // still a portfolio-sync read, not part of the claim-preview build the flag is scoped to, and
  // must stay on public RPC only.
  if (preferWalletRpc) {
    log('protocol refresh deferred until the in-progress claim preview build finishes (keeps portfolio sync on public RPC only)', 'info');
    return;
  }
  const node = protocolNodes[protoId];
  if (!node || !state.account) return;
  const { proto, details, summary, body } = node;

  details.dataset.status = 'loading';
  const claimEl = summary.querySelector('.protocol-claim');
  clearClaimStatusRetry(claimEl);
  claimEl.textContent = '';
  claimEl.appendChild(spinnerNode(13));
  setClaimAvailable(summary, false);
  // The header total is a SUM over every row, so the moment one row goes back to loading the
  // displayed total is stale — it still includes this row's previous (or absent, if the row was
  // cancelled/errored) contribution. Without this it kept showing that stale figure, silently,
  // for the whole duration of the re-fetch, which reads as the total lagging behind the row.
  // Showing the same spinner a full refresh uses makes the staleness honest and immediate
  // instead; renderPortfolioTotal() below replaces it with the real number once this row lands.
  resetPortfolioTotal();

  let result;
  try {
    result = proto.id === 'curve'
      ? await renderCurveProgressive(details, summary, body)
      : await proto.fetch();
    if (proto.id !== 'curve') renderProtocolResult(details, summary, body, result);
  } catch (err) {
    logErr(`${proto.name} refresh failed`, err);
    result = { status: 'error' };
    renderProtocolResult(details, summary, body, result);
  }

  portfolioResults[protoId] = result;
  renderPortfolioTotal(portfolioResults);
  renderAlphaIcons(portfolioResults);
}

// Cancels an in-flight full refresh. Rows that already resolved keep their data untouched;
// rows still spinning (or left over in an error state) are reset to a 'cancelled' status whose
// label is itself a click-to-retry control (same affordance as an errored row — see
// setClaimStatusRetry), so a cancelled row is a starting point rather than a dead end. The
// header total/alpha icons are recomputed from whatever actually finished, so they describe
// what's really on screen rather than a half-applied run.
export function cancelPortfolioRefresh() {
  if (!portfolioInFlight) return;
  refreshGeneration++; // in-flight fetches will see the mismatch and discard their results
  portfolioInFlight = false;
  setRefreshUiBusy(false);
  log('portfolio refresh cancelled', 'info');

  Object.values(protocolNodes).forEach(({ proto, details, summary, body }) => {
    const status = details.dataset.status;
    if (status !== 'loading' && status !== 'error') return; // already-loaded rows stay as they are
    details.dataset.status = 'cancelled';
    const claimEl = summary.querySelector('.protocol-claim');
    clearClaimStatusRetry(claimEl);
    claimEl.textContent = '';
    setClaimAvailable(summary, false);
    body.innerHTML = '';
    delete portfolioResults[proto.id];
    setClaimStatusRetry(claimEl, proto.id, 'cancelled');
  });

  renderPortfolioTotal(portfolioResults);
  renderAlphaIcons(portfolioResults);
}

// Refresh/Cancel share one busy state — Cancel is only meaningful (and only visible) while a
// refresh is actually running, and Refresh is disabled for exactly that window.
export function setRefreshUiBusy(busy) {
  const btn = $('#refresh-portfolio');
  const cancel = $('#cancel-refresh');
  btn.disabled = busy;
  btn.classList.toggle('is-loading', busy);
  btn.textContent = busy ? 'Refreshing…' : 'Refresh';
  if (cancel) cancel.hidden = !busy;
}

// Per-protocol "claim rewards to mainnet" action, reached via a small dropdown
// (Claim to mainnet / Claim to another chain) sitting between the $ figure and
// the caret on each protocol's summary row. Only Curve's veCRV subsection is
// wired up for real right now — its crvUSD claim already pays out directly on
// Ethereum mainnet (FeeDistributor.claim(), see CURVE.feeDistributor above),
// so it's the one case that needs neither a swap nor a bridge: a single
// wallet-signed transaction is the whole flow. Every other protocol's rewards
// land on their own chain in non-mainnet tokens (Votemarket's LaPoste-wrapped
// Arbitrum tokens, Aerodrome's Base tokens, etc.) and need a real consolidate
// (swap) + bridge design before "claim to mainnet" can mean anything for
// them — CowSwap is intent-based (an off-chain signed order a solver settles
// later, not something that can be batched atomically into one transaction
// with the claim), and Votemarket's LaPoste bridge leg alone takes ~20
// minutes (Chainlink CCIP) — both deliberately deferred, not implemented yet.
// "Claim to another chain" is UI-only for now (disabled), reserved for a
// later pass across Arbitrum/Optimism (and Base for Aerodrome, since it left
// the OP Superchain) once the mainnet path is proven out.

// Reads the connected account's live Aerodrome position and builds a claim plan:
// which (venftId, Fee-or-Bribe contract) pairs have a real nonzero reward, and which
// tokens/amounts. Mirrors fetchVeDex's approach exactly: runs the cheap path (currently-voted
// pools via rewardsByAddress) first, then augments with the full-pool historical scan
// (past-epoch pools via RewardsSugar.rewards paginated) for Aerodrome, so the claim plan always
// matches what the portfolio card actually shows as claimable; nothing is claimed that wasn't
// already displayed. The veNFT REBASE is intentionally absent here and always should be: claiming
// it re-locks it into the veNFT rather than paying the wallet, so it is not free cash and cannot
// be swapped or bridged. Confirmed live against Aerodrome's RewardsDistributor — see the full
// derivation and evidence in the rebase comment inside fetchVeDex() before adding a claim leg for it.
export async function renderPortfolio() {
  const list = $('#protocol-list');

  if (!state.account) {
    startDemoMode();
    return;
  }

  // Demo mode's own timer/DOM must be fully gone before real data ever paints —
  // stopDemoMode() clears the interval and hides the badge synchronously (no
  // await between here and list.innerHTML below), so there's no frame where
  // both demo and real data (or demo and the loading state) are visible.
  stopDemoMode();

  // Refresh is async and can take a few seconds (Aerodrome fans out one call
  // per voted pool) — ignore re-clicks and show progress instead of racing.
  if (portfolioInFlight) return;
  // preferWalletRpc (see chainCall()'s comment) is a single module-level flag, not scoped per
  // call — a portfolio refresh that STARTS while it's true would have its own chainCall()s
  // routed through the wallet's provider too, not just the claim-preview build the flag exists
  // for. Deferring here (rather than, say, letting the flag apply to both) is what keeps the
  // regular portfolio sync on public RPC only, always — runAerodromeClaimFlow() holds up its own
  // side of this by waiting for any ALREADY-in-flight refresh to finish before it ever sets the
  // flag, so the two can never overlap in either direction.
  if (preferWalletRpc) {
    log('portfolio refresh deferred until the in-progress claim preview build finishes (keeps portfolio sync on public RPC only)', 'info');
    return;
  }
  portfolioInFlight = true;
  const myGen = ++refreshGeneration;
  // `gen` is on every line of this refresh's narrative on purpose: refreshes can overlap and be
  // superseded, and without it two interleaved runs' logs are indistinguishable — which is
  // exactly the situation (a stale run painting over a newer one) the myGen guards exist to
  // prevent and therefore the one you most need to be able to read.
  const endRefresh = uiTime('portfolio', 'refresh complete', { gen: myGen });
  uiLog('portfolio', 'refresh start', { gen: myGen, protocols: PROTOCOLS.length, account: addr(state.account) });
  setRefreshUiBusy(true);
  deferClaimReveal = true;
  pendingClaimReveals.length = 0;

  list.innerHTML = '';
  resetPortfolioTotal();
  resetCash();
  clearAlphaIcons();
  const nodes = PROTOCOLS.map((proto) => buildProtocolNode(list, proto));
  // Rebuilt every full render (the old nodes were just detached by list.innerHTML above, so
  // holding on to them would leave refreshProtocol() writing into orphaned DOM).
  protocolNodes = Object.fromEntries(nodes.map((n) => [n.proto.id, n]));
  const results = {};
  portfolioResults = results;

  // Fire-and-forget, independent of the protocol Promise.all below — Cash is a completely
  // separate read (wallet stablecoin balances, not protocol claims) and must not make the whole
  // portfolio refresh wait on it or fail because of it. Same cancellation guard (myGen) as every
  // other write in this refresh, so a superseded run's late-arriving balances never paint over
  // whatever a newer refresh (or a disconnect) has since put on screen.
  fetchCashBalances(state.account)
    .then((cash) => { if (myGen === refreshGeneration) renderCash(cash); })
    .catch((err) => {
      if (myGen !== refreshGeneration) return;
      logErr('cash balance read failed', err);
      renderCash({ status: 'error', totalUsd: 0, balances: [], l2: [] });
    });

  try {
    await Promise.all(nodes.map(async ({ proto, details, summary, body }) => {
      try {
        // Curve renders its veCRV/Votemarket subsections progressively (each
        // as soon as ITS OWN fetch resolves) instead of one-shot after both
        // settle — see renderCurveProgressive() above. It builds subsections
        // directly into `body` itself, so it doesn't go through
        // renderProtocolResult()'s generic (bodyEl.innerHTML = '', then loop
        // subsections) path, which is a one-shot render by design and would
        // just as blocked as the Promise.all it's built on top of if used here.
        const result = proto.id === 'curve'
          ? await renderCurveProgressive(details, summary, body)
          : await proto.fetch();
        // Cancelled (or superseded by a newer refresh) while this fetch was in flight — drop
        // the result rather than painting over whatever the user is looking at now.
        if (myGen !== refreshGeneration) return;
        results[proto.id] = result;
        if (proto.id !== 'curve') renderProtocolResult(details, summary, body, result);
        uiLog('portfolio', 'card settled', {
          gen: myGen,
          protocol: proto.id,
          status: result?.status,
          claimUsd: money(result?.claimUsd),
          rows: result?.rows?.length ?? 0,
          claimTokens: result?.claimList?.length ?? 0,
        });
      } catch (err) {
        if (myGen !== refreshGeneration) return;
        logErr(`${proto.name} portfolio fetch failed`, err);
        results[proto.id] = { status: 'error' };
        renderProtocolResult(details, summary, body, { status: 'error' });
        uiWarn('portfolio', 'card failed', { gen: myGen, protocol: proto.id, error: err?.message });
      }
    }));
    if (myGen !== refreshGeneration) return;
    // Computed once after every protocol has settled (rather than updated
    // incrementally per-protocol) — simpler to get right and avoids the total
    // visibly climbing/flickering as each fetch trickles in at its own pace.
    renderPortfolioTotal(results);
    renderAlphaIcons(results);
    // The one line that answers "did this refresh actually work?" without opening the app: a
    // per-status tally across every card plus the headline total they roll up into. `ok` short
    // of PROTOCOLS.length, or a total that doesn't match the cards, is visible right here.
    const byStatus = {};
    for (const r of Object.values(results)) byStatus[r?.status ?? 'missing'] = (byStatus[r?.status ?? 'missing'] || 0) + 1;
    endRefresh({ cards: Object.keys(results).length, byStatus, total: money($('#portfolio-total')?.textContent?.trim()) });
  } finally {
    // Only the CURRENT run owns the busy UI — a cancelled run's late `finally` must not
    // re-enable Refresh/hide Cancel out from under whatever replaced it.
    if (myGen === refreshGeneration) {
      portfolioInFlight = false;
      setRefreshUiBusy(false);
      // Reveal every Claim button queued during this run together, faded in at once, rather
      // than each appearing whenever its own protocol happened to finish — see deferClaimReveal.
      // Runs in `finally` (success, cancellation, or a synchronous throw before try) so this
      // flag can never get stuck true and silently swallow every future setClaimAvailable() call
      // for this or a later refresh.
      deferClaimReveal = false;
      for (const wrap of pendingClaimReveals) fadeInSwap(wrap, () => { wrap.hidden = false; });
      pendingClaimReveals.length = 0;
    }
  }
}

/* ---------- balance ---------- */

export const EYE_OPEN = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />';
export const EYE_CLOSED = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />';

// Release badge — driven entirely from core/release.js so flipping RELEASE_TESTING is the only
// edit needed to go live. Shown before any wallet is connected, deliberately: a visitor should
// learn this build won't sign transactions BEFORE they connect, not after they click Claim.
(() => {
  const badge = $('#release-badge');
  if (!badge || !RELEASE_TESTING) return;
  badge.textContent = RELEASE_LABEL;
  badge.title = RELEASE_NOTICE;
  badge.hidden = false;
  uiLog('release', 'gate active', { label: RELEASE_LABEL });
})();

$('#privacy-toggle').addEventListener('click', () => {
  setPrivacyHidden(!privacyHidden);
  const btn = $('#privacy-toggle');
  btn.setAttribute('aria-pressed', String(privacyHidden));
  btn.title = privacyHidden ? 'Show balances' : 'Hide balances';
  btn.querySelector('.eye-icon').innerHTML = privacyHidden ? EYE_CLOSED : EYE_OPEN;
  applyPrivacyMode();
  log(`privacy mode ${privacyHidden ? 'enabled — addresses/amounts masked' : 'disabled'}`, 'info');
  // `masked` counts the elements applyPrivacyMode() actually rewrote, which is the assertable
  // part: "privacy is on" is a flag anyone can set, "42 values are now masked" is evidence it
  // reached the DOM. A masked count of 0 while enabled is the bug this line exists to surface.
  uiLog('prefs', 'privacy toggled', {
    enabled: privacyHidden,
    masked: document.querySelectorAll('[data-real].is-masked').length,
    sensitiveTotal: document.querySelectorAll('[data-real]').length,
  });
});

// Own independent button/listener — deliberately not entangled with
// #privacy-toggle's state or wiring above, just the same pattern applied a
// second time.
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Persistence failed (e.g. private browsing) — theme still applies for
    // this page load, it just won't survive a reload.
  }
  applyTheme(next);
  log(`theme switched to ${next}`, 'info');
  // Reads the attribute back rather than echoing `next` — that is what makes this line evidence
  // applyTheme() actually landed, instead of just restating what we asked for.
  uiLog('prefs', 'theme toggled', { theme: document.documentElement.getAttribute('data-theme') });
});

// Until the user makes an explicit choice, keep following the OS preference
// live (e.g. the OS flips to dark at sunset while this tab stays open).
lightMediaQuery.addEventListener('change', (e) => {
  if (getStoredTheme()) return; // user already overrode — stop auto-following
  applyTheme(e.matches ? 'light' : 'dark');
});

// These buttons sit inside <summary>; without this the click would toggle the card.
$('#clear-log').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#log').innerHTML = '';
});

$('#refresh-portfolio').addEventListener('click', (e) => {
  e.stopPropagation();
  renderPortfolio();
});

$('#refresh-cash').addEventListener('click', (e) => {
  e.stopPropagation();
  refreshCash();
});

// Smooth expand/collapse for every top-level page card — see enableCardAccordion()'s own
// comment for why this is a distinct, sibling-preserving variant rather than reusing
// enableAccordion() (which closes siblings, wrong for independent panels like these).
document.querySelectorAll('details.card').forEach(enableCardAccordion);

$('#cancel-refresh').addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  cancelPortfolioRefresh();
});

// Scroll positions are 0 while the card is collapsed, so re-pin to the newest line on open.
$('.log-card').addEventListener('toggle', (e) => {
  if (e.target.open) $('#log').scrollTop = $('#log').scrollHeight;
});

$('#picker').addEventListener('click', (e) => {
  if (e.target.id === 'picker') $('#picker').close(); // backdrop click
});

window.addEventListener('error', (e) => log(`uncaught: ${e.message}`, 'err'));
window.addEventListener('unhandledrejection', (e) =>
  log(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`, 'err'));

// Framed pages do not boot. js/framebust.js has already set this attribute (at parse time, before
// any of this ran) and styles.css has already suppressed the UI, so the app is unclickable
// either way — this is the belt to that braces: no RPC traffic, no wallet discovery, and no
// eip6963 handshake initiated from inside someone else's page. Cheap, and it means a framing
// attempt costs the public endpoints nothing. See framebust.js's header for the whole design.
if (document.documentElement.hasAttribute('data-framed')) {
  uiLog('framebust', 'framed — boot refused', { href: location.href });
} else {
  renderEnv();
  renderConnection();
  renderPortfolio(); // disconnected at boot — this is what puts the app into demo mode
  log('bench ready — dispatching eip6963:requestProvider');
  requestProviders();
}

// Wallets that inject after page load still need to be picked up.
window.addEventListener('load', () => {
  requestProviders();
  renderEnv();
  if (!window.ethereum && discovered.size === 0) {
    log('no wallet detected yet; click Connect to re-scan', 'info');
  }
});
