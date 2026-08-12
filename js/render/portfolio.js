import { PROTOCOLS } from '../protocols/config.js';
import { fetchCurveVeCrv, fetchVotemarket } from '../protocols/curve.js';
import { refreshProtocol } from '../main.js';
import { buildClaimMenu, setClaimAvailable } from '../claim/orchestrate.js';
import { setSensitiveText } from '../core/prefs.js';
import { notifyUserPanelInteraction } from '../core/interaction.js';
import { $, fadeInSwap, log, spinnerNode, usd } from '../core/utils.js';
import { money, uiTrace } from '../core/ui-debug.js';

export function buildRow(k, v, isClaim, sensitive = true) {
  const row = document.createElement('div');
  row.className = isClaim ? 'row claim-row' : 'row';
  const kEl = document.createElement('span');
  kEl.className = 'k';
  if (isClaim) {
    const dot = document.createElement('span');
    dot.className = 'token-dot';
    kEl.appendChild(dot);
  }
  kEl.appendChild(document.createTextNode(k));
  const vEl = document.createElement('span');
  vEl.className = 'v';
  if (sensitive) setSensitiveText(vEl, v);
  else vEl.textContent = v;
  row.append(kEl, vEl);
  return row;
}

// Renders a flat result's detail rows + claimable-rewards basket into bodyEl.
// Shared by renderProtocolResult (top-level protocols) and renderSubsection
// (Curve's nested veCRV/Votemarket split) so the two stay pixel-identical.
export function renderRowsAndClaims(bodyEl, rows, claimList) {
  (rows || []).forEach((row) => bodyEl.appendChild(buildRow(row.k, row.v, false, row.sensitive !== false)));

  if (claimList) {
    const head = document.createElement('div');
    head.className = 'claims-head';
    head.textContent = 'Claimable rewards';
    bodyEl.appendChild(head);

    if (!claimList.length) {
      const note = document.createElement('div');
      note.className = 'protocol-note';
      note.textContent = 'none';
      bodyEl.appendChild(note);
    }

    for (const claim of claimList) {
      const row = buildRow(claim.symbol, claim.amount, true, true);
      if (claim.usd != null) {
        const usdSpan = document.createElement('span');
        usdSpan.className = 'usd';
        setSensitiveText(usdSpan, usd(claim.usd));
        row.querySelector('.v').appendChild(usdSpan);
      }
      bodyEl.appendChild(row);
    }
  }
}

// Smooth accordion open/close for a <details>/body pair, replacing the
// native instant show/hide — used for every .protocol and .protocol-sub in
// this app (wired in once, inside buildProtocolNode()/renderSubsection(),
// rather than at each call site). A user's own click on <summary> AND demo
// mode's auto-cycling (setAccordionOpen(), called from showDemoIndex())
// both go through this same path, so the effect is consistent everywhere —
// no parallel expand/collapse machinery. Respects prefers-reduced-motion
// (falls back to an instant native toggle, matching every other animation
// in this file).
export const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function setAccordionOpen(details, body, open) {
  if (details.open === open && details.dataset.animating !== 'true') return;
  if (details.dataset.animating === 'true') {
    // Worth a line rather than a silent bail: an accordion that "won't open" is almost always
    // this guard rejecting the click, and the stuck-`animating` failure mode the cleanup below
    // exists to prevent is invisible from the outside otherwise.
    uiTrace('accordion', 'ignored (mid-animation)', { target: details.dataset.protocol || details.className, wanted: open });
    return; // let the current animation finish rather than fight it
  }
  uiTrace('accordion', open ? 'open' : 'close', { target: details.dataset.protocol || details.className, reducedMotion: REDUCED_MOTION });

  if (REDUCED_MOTION) {
    details.open = open;
    return;
  }

  details.dataset.animating = 'true';
  body.style.overflow = 'hidden';

  // Web Animations' `finish` event isn't reliably delivered in every browser
  // context (confirmed live: playState reaches 'finished' but onfinish never
  // fires in some cases, e.g. an inactive/backgrounded tab) — relying on it
  // alone risks permanently stuck accordions (open forever, or unclickable
  // because `animating` never clears). `runOnce` + a duration+buffer
  // setTimeout fallback guarantees cleanup fires exactly once either way.
  const cleanup = open
    ? () => { body.style.overflow = ''; body.style.height = ''; details.dataset.animating = ''; }
    : () => { details.open = false; body.style.overflow = ''; body.style.height = ''; details.dataset.animating = ''; };
  let done = false;
  const runOnce = () => { if (done) return; done = true; cleanup(); };

  if (open) {
    details.open = true; // reveals content so scrollHeight below reflects real content height
    const target = body.scrollHeight;
    const anim = body.animate([{ height: '0px' }, { height: `${target}px` }], { duration: 220, easing: 'ease' });
    anim.onfinish = runOnce;
    setTimeout(runOnce, 220 + 100);
  } else {
    const start = body.scrollHeight;
    const anim = body.animate([{ height: `${start}px` }, { height: '0px' }], { duration: 200, easing: 'ease' });
    anim.onfinish = runOnce;
    setTimeout(runOnce, 200 + 100);
  }
}

// True accordion behavior: opening one closes every sibling at the same
// nesting level (other top-level .protocol cards, or other .protocol-sub
// rows within the same parent card) — not just during demo mode's
// auto-cycling, which already enforced this for itself via showDemoIndex().
// Siblings are found via the shared parent (#protocol-list for .protocol,
// or that specific protocol's body div for .protocol-sub), so both nesting
// levels get this for free from the same code with no special-casing.
export function closeSiblingAccordions(details) {
  const siblings = details.parentElement.querySelectorAll(':scope > details');
  siblings.forEach((sib) => {
    if (sib === details) return;
    const sibBody = sib.querySelector(':scope > .protocol-body, :scope > .protocol-sub-body');
    if (sibBody) setAccordionOpen(sib, sibBody, false);
  });
}

// Top-level page cards (Cash, Portfolio, Connection, Environment, Log — every `<details
// class="card">` in index.html) get the SAME smooth expand/collapse animation as protocol rows
// (reuses setAccordionOpen() directly, no separate animation logic) but deliberately WITHOUT
// enableAccordion()'s closeSiblingAccordions() call — these five are independent panels a user
// may reasonably want open at once (e.g. Cash and Portfolio both expanded together), not a
// single-open-at-a-time group the way Curve's veCRV/Votemarket subsections or the protocol list
// are. Called once per card at boot (see the bottom of this file) rather than requiring each
// card's own HTML to remember to opt in.
export function enableCardAccordion(details) {
  const summary = details.querySelector(':scope > summary');
  const body = details.querySelector(':scope > .card-body');
  if (!summary || !body) return;
  summary.addEventListener('click', (e) => {
    e.preventDefault();
    /* Announce that a HUMAN did this. Demo mode listens and stops its auto-tour, which would
       otherwise close the card on its next tick. Announced rather than acted on: this file has no
       business knowing demo mode exists, and importing it here would add an edge to a module graph
       that is already one cycle. showDemoIndex()'s own calls go straight to setAccordionOpen() and
       never through this listener, so the tour cannot cancel itself on its first tick. */
    notifyUserPanelInteraction('card accordion click');
    setAccordionOpen(details, body, !details.open);
  });
}

export function enableAccordion(details, body) {
  // :scope > summary, not a bare selector, so a .protocol's listener never
  // fires for clicks on a nested .protocol-sub's own summary (each has its
  // own enableAccordion() call, listening on its own distinct summary node —
  // this scoping just guards against ever accidentally matching the wrong one).
  const summary = details.querySelector(':scope > summary');
  summary.addEventListener('click', (e) => {
    e.preventDefault();
    notifyUserPanelInteraction('protocol accordion click'); // see enableCardAccordion above
    const opening = !details.open;
    if (opening) closeSiblingAccordions(details);
    setAccordionOpen(details, body, opening);
  });
}

// Animates one row of the claim panel's numbered transaction list (see buildExecutionStepRow())
// growing in from nothing — used for the initial cascading reveal once token symbols/icons have
// resolved, and for a row newly added by rebuildTransactionsList() when a checkbox toggle brings
// a token back into the selection. Same Web Animations technique as setAccordionOpen() above
// (measure the real target height via scrollHeight, animate max-height/opacity to it, then clear
// the inline height so a later content change — e.g. a symbol upgrading in place — isn't clipped)
// rather than a CSS transition class, for the same reasons: reliable `finish` cleanup via
// Promise/timeout fallback instead of depending on `transitionend` firing.
// `delayMs` staggers a whole list's entrance into a cascade (see revealInitialStepRows()) —
// omitted (0) for a single ad-hoc row insertion, where a delay would just look like lag.
export function expandExecStepRow(row, delayMs = 0) {
  if (REDUCED_MOTION) return;
  row.style.overflow = 'hidden';
  row.style.opacity = '0';
  row.style.maxHeight = '0px';
  row.style.paddingTop = '0px';
  row.style.paddingBottom = '0px';
  // scrollHeight measures the row's real, un-clipped content height even while max-height:0 is
  // visually collapsing it — the same trick setAccordionOpen() relies on via body.scrollHeight.
  const targetHeight = row.scrollHeight;
  const computed = getComputedStyle(row);
  const anim = row.animate(
    [
      { maxHeight: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' },
      { maxHeight: `${targetHeight}px`, opacity: 1, paddingTop: computed.paddingTop, paddingBottom: computed.paddingBottom },
    ],
    { duration: 260, easing: 'ease', delay: delayMs, fill: 'backwards' }
  );
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    row.style.maxHeight = '';
    row.style.opacity = '';
    row.style.paddingTop = '';
    row.style.paddingBottom = '';
    row.style.overflow = '';
  };
  anim.onfinish = finish;
  setTimeout(finish, delayMs + 260 + 100);
}

// Inverse of expandExecStepRow() — shrinks a row to nothing then removes it from the DOM, used by
// rebuildTransactionsList() when a checkbox toggle drops a token out of the selection. Rows
// above/below reflow smoothly through ordinary document layout as this row's own box shrinks —
// no separate position animation needed for them.
export function collapseAndRemoveExecStepRow(row) {
  if (REDUCED_MOTION) { row.remove(); return; }
  const startRect = row.getBoundingClientRect();
  const computed = getComputedStyle(row);
  row.style.overflow = 'hidden';
  const anim = row.animate(
    [
      { maxHeight: `${startRect.height}px`, opacity: 1, paddingTop: computed.paddingTop, paddingBottom: computed.paddingBottom },
      { maxHeight: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: 240, easing: 'ease', fill: 'forwards' }
  );
  let done = false;
  const finish = () => { if (done) return; done = true; row.remove(); };
  anim.onfinish = finish;
  setTimeout(finish, 340);
}

// One nested subsection inside a protocol's body (currently only Curve's veCRV and
// Votemarket splits). Mirrors the top-level protocol summary/body structure one
// level down — same status-driven claim text, same buildRow-based detail rendering
// — just smaller (.protocol-sub / .caret-xs, see styles.css) and collapsed by
// default like every other level of this hierarchy.
// Builds a subsection's DOM shell (name + spinner in place of the claim
// figure, empty body) and appends it immediately, before its data has
// resolved — see fillSubsection() below and renderCurveProgressive(), which
// use this pair to let veCRV render the moment it resolves instead of
// waiting on Votemarket's much slower up-to-25-epoch scan (see the VOTEMARKET
// comment above fetchVotemarket()). renderSubsection() (unchanged behavior,
// still used by demo mode and anywhere a subsection's result is already in
// hand) is now just these two calls back-to-back.
export function buildSubsectionNode(container, name) {
  const details = document.createElement('details');
  details.className = 'protocol-sub';
  details.dataset.status = 'loading';

  const summary = document.createElement('summary');
  const nameEl = document.createElement('span');
  nameEl.className = 'protocol-sub-name';
  nameEl.textContent = name;
  const claim = document.createElement('span');
  claim.className = 'protocol-sub-claim';
  claim.appendChild(spinnerNode(11));
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('class', 'caret-xs');
  caret.setAttribute('viewBox', '0 0 24 24');
  caret.innerHTML = '<path d="M6 9l6 6 6-6" />';
  summary.append(nameEl, claim, caret);

  const body = document.createElement('div');
  body.className = 'protocol-sub-body';

  details.append(summary, body);
  enableAccordion(details, body);
  container.appendChild(details);
  return { details, claimEl: claim, body };
}

// Fills a subsection node (from buildSubsectionNode) with its resolved
// result — the spinner-to-value fade mirrors buildProtocolNode()'s top-level
// claim badge (fadeInSwap), just one nesting level down.
// `onRetry`, when given, makes a failed subsection's status text clickable (same treatment as
// a top-level protocol row's retry — see setClaimStatusRetry()) instead of inert "error" text.
// Curve's veCRV/Votemarket subsections don't have their own protocol id to hand refreshProtocol,
// so renderCurveProgressive() passes a callback that re-runs the whole Curve fetch instead —
// coarser than retrying just the one broken subsection, but it reuses the exact same,
// already-correct refreshProtocol('curve') path rather than a second, untested retry mechanism.
export function fillSubsection(node, sub, onRetry) {
  const { details, claimEl, body } = node;
  details.dataset.status = sub.status;
  fadeInSwap(claimEl, () => {
    if (sub.status === 'ok') {
      clearClaimStatusRetry(claimEl);
      setSensitiveText(claimEl, sub.claimSummary);
      // Votemarket's $ figure is real and folds into Curve's top-level claimable total, but
      // clicking Curve's Claim button only ever sends FeeDistributor.claim() (veCRV) — Votemarket
      // needs its own cross-chain storage-proof relay (see the VOTEMARKET comment above
      // fetchVotemarket()) that isn't built. Without this, the top-level "Claim $X" reads as if
      // it covers everything the card shows, silently leaving the Votemarket portion behind.
      if (sub.id === 'votemarket') {
        const badge = document.createElement('span');
        badge.className = 'protocol-sub-badge';
        badge.textContent = 'not yet claimable';
        claimEl.appendChild(badge);
      }
    } else if (onRetry) {
      setClaimStatusRetry(claimEl, onRetry, sub.status === 'wrong-chain' ? 'wrong network' : 'error');
    } else {
      claimEl.textContent = sub.status === 'wrong-chain' ? 'wrong network' : 'error';
    }
  });

  if (sub.status !== 'ok') {
    const note = document.createElement('div');
    note.className = 'protocol-note';
    note.textContent = sub.message || 'failed to load — see log';
    body.appendChild(note);
  } else {
    renderRowsAndClaims(body, sub.rows, sub.claimList);
  }
}

export function renderSubsection(container, sub, onRetry) {
  // `onRetry` was previously dropped here — every call site (see renderProtocolResult) has always
  // passed a third argument, but this function only declared two params, so a failed subsection
  // rendered through this path (demo mode, or any full refresh) silently lost its clickable retry
  // wiring even though fillSubsection has always supported it.
  fillSubsection(buildSubsectionNode(container, sub.name), sub, onRetry);
}

// Curve's veCRV subsection is a couple of quick eth_calls; Votemarket's is an
// up-to-25-epoch, hundreds-of-calls scan (see the VOTEMARKET comment above
// fetchVotemarket()) — Promise.all-ing both behind a single one-shot render
// (the old fetchCurve()) made veCRV's fast result sit invisible behind
// Votemarket's slow one for the whole wait. This renders each subsection the
// moment ITS OWN fetch resolves, independent of the other. The top-level
// Curve claim badge still waits for both, since it's a combined total that
// can't show a partial number without being misleading — same spinner used
// while either subsection is still in flight.
export async function renderCurveProgressive(details, summary, body) {
  const claimEl = summary.querySelector('.protocol-claim');

  // This function ADDS subsection nodes to `body` (via buildSubsectionNode()) rather than
  // replacing its content wholesale — safe (a no-op) the first time, when body is a freshly
  // built, empty element from renderPortfolio()'s initial render. Not safe the second time: a
  // subsection's retry action (see fillSubsection()'s onRetry) calls refreshProtocol('curve'),
  // which re-runs this SAME function against the SAME, already-populated body — without this
  // clear, that duplicated every subsection row instead of replacing them (confirmed live:
  // clicking retry on veCRV left two veCRV rows and two Votemarket rows on screen).
  body.innerHTML = '';

  const veCrvNode = buildSubsectionNode(body, 'veCRV');
  const votemarketNode = buildSubsectionNode(body, 'Votemarket');

  const retryCurve = () => refreshProtocol('curve');
  const [veCrv, votemarket] = await Promise.all([
    fetchCurveVeCrv().then((sub) => {
      // `id` is normally only added when the outer `subsections` array is assembled below —
      // added here too (fillSubsection's own copy, not this closure's `sub`, so the `return sub`
      // that array is built from is untouched) since fillSubsection needs to tell Votemarket
      // apart from veCRV to render its "not yet claimable" badge (see fillSubsection's comment).
      fillSubsection(veCrvNode, { ...sub, id: 'vecrv' }, retryCurve);
      return sub;
    }),
    fetchVotemarket().then((sub) => {
      fillSubsection(votemarketNode, { ...sub, id: 'votemarket' }, retryCurve);
      return sub;
    }),
  ]);

  const subsections = [
    { id: 'vecrv', name: 'veCRV', ...veCrv },
    { id: 'votemarket', name: 'Votemarket', ...votemarket },
  ];
  const totalUsd = subsections.reduce((sum, s) => sum + (s.claimUsd || 0), 0);
  const anyOk = subsections.some((s) => s.status === 'ok');
  const status = anyOk ? 'ok' : 'error';
  const message = anyOk ? undefined : subsections.map((s) => `${s.name}: ${s.message || s.status}`).join(' · ');
  const result = { status, claimSummary: usd(totalUsd), claimUsd: totalUsd, message, subsections };

  details.dataset.status = result.status;
  fadeInSwap(claimEl, () => {
    if (result.status === 'ok') setSensitiveText(claimEl, result.claimSummary);
    else setClaimStatusRetry(claimEl, details.dataset.protocol, result.status === 'wrong-chain' ? 'wrong network' : 'error');
  });
  setClaimAvailable(summary, result.status === 'ok' && result.claimUsd > 0);

  return result;
}

// Paints a failed/wrong-network row's status label as a CLICKABLE retry that re-fetches just
// that protocol (refreshProtocol()). Uses the same gradient-text treatment as the Claim
// trigger (.is-retry reuses .claim-btn's styling — see styles.css) so the two "this is an
// action you can take on this row" affordances read as one visual language rather than two.
// Rebuilt from scratch on every render, so a row that later succeeds drops the handler with
// the element; the listener is attached with `once` semantics via the guard in
// refreshProtocol() (a click while a full refresh is running is ignored).
// `protoIdOrRetryFn` is either a protocol id string (existing top-level-row usage — wired to
// refreshProtocol(protoId)) or a callback (used by Curve's nested veCRV/Votemarket subsections,
// which don't have their own protocol id to refresh — see fillSubsection() below).
export function setClaimStatusRetry(claimEl, protoIdOrRetryFn, label) {
  claimEl.textContent = label;
  claimEl.classList.add('is-retry');
  claimEl.setAttribute('role', 'button');
  claimEl.setAttribute('tabindex', '0');
  claimEl.setAttribute('title', 'Click to retry this protocol');
  const doRetry = typeof protoIdOrRetryFn === 'function' ? protoIdOrRetryFn : () => refreshProtocol(protoIdOrRetryFn);
  const retry = (e) => {
    // Must not bubble to <summary>'s accordion toggle — same reason every control inside
    // .claim-menu-wrap stops propagation (see buildClaimMenu()).
    e.preventDefault();
    e.stopPropagation();
    doRetry();
  };
  claimEl.addEventListener('click', retry);
  claimEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') retry(e);
  });
}

export function renderProtocolResult(details, summaryEl, bodyEl, result) {
  details.dataset.status = result.status;
  const claimEl = summaryEl.querySelector('.protocol-claim');
  fadeInSwap(claimEl, () => {
    if (result.status === 'ok') setSensitiveText(claimEl, result.claimSummary);
    else setClaimStatusRetry(claimEl, details.dataset.protocol, result.status === 'wrong-chain' ? 'wrong network' : 'error');
  });
  setClaimAvailable(summaryEl, result.status === 'ok' && result.claimUsd > 0);

  bodyEl.innerHTML = '';

  // Curve carries two independently-gated nested subsections (veCRV/Votemarket) —
  // each renders its own status/message regardless of the rolled-up top-level
  // status, so e.g. "veCRV: wrong network" and real Votemarket data can both show
  // at once. Every other protocol has no `subsections` field and falls through to
  // the exact same flat rendering this function has always done. A failed subsection
  // (e.g. one Velodrome Superchain leaf chain whose scan didn't complete — see
  // fetchVelodromeLeafClaims()) gets the same clickable retry treatment as a
  // top-level row, wired to re-fetch the WHOLE protocol rather than just that one
  // leaf chain — reuses the already-correct refreshProtocol(protoId) path.
  if (result.subsections) {
    /* Card-level rows render ABOVE the subsections when a protocol supplies both. Previously
       `rows` was ignored outright whenever `subsections` existed, which is why Velodrome's card
       showed no locked/veNFT metadata while Aerodrome's did — the two cards looked like different
       components for no reason other than which branch they fell down. Optional, so Curve's
       subsection-only shape is unchanged. */
    if (result.rows?.length) renderRowsAndClaims(bodyEl, result.rows, null);
    const retryThisProtocol = () => refreshProtocol(details.dataset.protocol);
    result.subsections.forEach((sub) => renderSubsection(bodyEl, sub, retryThisProtocol));
    return;
  }

  if (result.status !== 'ok') {
    const note = document.createElement('div');
    note.className = 'protocol-note';
    const message = result.message || 'failed to load — see log';
    note.textContent = `${message} (click to retry)`;
    note.classList.add('is-retry');
    note.setAttribute('role', 'button');
    note.setAttribute('tabindex', '0');
    note.setAttribute('title', 'Click to retry this protocol');
    const retry = (e) => {
      e.preventDefault();
      e.stopPropagation();
      refreshProtocol(details.dataset.protocol);
    };
    note.addEventListener('click', retry);
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') retry(e);
    });
    bodyEl.appendChild(note);
    return;
  }

  renderRowsAndClaims(bodyEl, result.rows, result.claimList);
  // Logged AFTER the DOM writes, and counted off the DOM rather than off `result`, so this
  // reports what rendered rather than what was requested — the two diverging is precisely the
  // bug class this whole channel exists to catch without opening the app.
  uiTrace('card', 'rendered', {
    protocol: details.dataset.protocol,
    status: result.status,
    rows: bodyEl.querySelectorAll('.row').length,
    claimRows: bodyEl.querySelectorAll('.claim-row').length,
    claimable: money(result.claimSummary),
  });
}

/* ---------- demo mode (disconnected state) ---------- */

// `Locked until` needs a real, moving-forward timestamp (formatUnlock() computes
// "Nd left" off Date.now()) even though the lock itself is fake — daysFromNow
// keeps it looking alive no matter when the page happens to be viewed.
export function totalClaimUsd(results) {
  return Object.values(results).reduce((sum, r) => sum + ((r && typeof r.claimUsd === 'number') ? r.claimUsd : 0), 0);
}

export function renderPortfolioTotal(results) {
  const el = $('#portfolio-total');
  if (!el) return;
  fadeInSwap(el, () => setSensitiveText(el, `${usd(totalClaimUsd(results))} claimable`));
  el.classList.add('is-ready');
}

// Shown while a real refresh is in flight (demo mode's results are built
// synchronously so it never needs this transient state) — mirrors the
// per-protocol "loading…" text buildProtocolNode() already sets.
export function resetPortfolioTotal() {
  const el = $('#portfolio-total');
  if (!el) return;
  el.classList.remove('is-ready');
  el.innerHTML = '';
  el.appendChild(spinnerNode(14));
}

// Same idea as resetPortfolioTotal(), for the Cash card — called the instant a real refresh
// starts (see renderPortfolio()) so the demo card's stale sample numbers don't linger on screen
// during the gap before fetchCashBalances() actually resolves; a spinner reads as "updating",
// leftover demo numbers read as "this is real data", which it isn't yet.
export function renderAlphaIcons(results) {
  const el = $('#alpha-icons');
  if (!el) return;
  el.innerHTML = '';
  PROTOCOLS.forEach((proto, i) => {
    const r = results[proto.id];
    if (!r || typeof r.claimUsd !== 'number' || r.claimUsd <= 0) return;
    const icon = document.createElement('img');
    icon.className = 'alpha-icon';
    icon.src = proto.icon;
    icon.alt = `${proto.name} has claimable rewards`;
    icon.title = proto.name;
    // Stagger each icon's bounce so a row of several doesn't move in unison.
    icon.style.animationDelay = `${i * 0.2}s`;
    el.appendChild(icon);
  });
}

// Mirrors resetPortfolioTotal()'s "clear header state before a fresh
// refresh" role — called from renderPortfolio() right before the real fetch
// starts so stale icons from a previous account/refresh never linger while
// new results are in flight.
export function clearAlphaIcons() {
  const el = $('#alpha-icons');
  if (el) el.innerHTML = '';
}

export function clearClaimStatusRetry(claimEl) {
  claimEl.classList.remove('is-retry');
  claimEl.removeAttribute('role');
  claimEl.removeAttribute('tabindex');
  claimEl.removeAttribute('title');
}

export function buildProtocolNode(list, proto) {
  const details = document.createElement('details');
  details.className = 'protocol';
  details.dataset.protocol = proto.id;
  details.dataset.status = 'loading';

  const summary = document.createElement('summary');
  const icon = document.createElement('img');
  icon.className = 'protocol-icon';
  icon.src = proto.icon;
  icon.alt = '';
  const name = document.createElement('span');
  name.className = 'protocol-name';
  name.textContent = proto.name;
  const claim = document.createElement('span');
  claim.className = 'protocol-claim';
  claim.appendChild(spinnerNode(13));
  // Claim trigger + $ figure are grouped together (not just adjacent) so the
  // group's own margin-left:auto reliably pushes both to the right as one
  // unit — putting that margin on the claim button directly wouldn't work
  // since it's hidden (see setClaimAvailable()) until a real, nonzero $
  // figure is known, and a hidden element's margin doesn't push anything.
  const claimGroup = document.createElement('span');
  claimGroup.className = 'protocol-claim-group';
  claimGroup.append(buildClaimMenu(proto), claim);
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('class', 'caret-sm');
  caret.setAttribute('viewBox', '0 0 24 24');
  caret.innerHTML = '<path d="M6 9l6 6 6-6" />';
  summary.append(icon, name, claimGroup, caret);

  const body = document.createElement('div');
  body.className = 'protocol-body';

  details.append(summary, body);
  enableAccordion(details, body);
  list.appendChild(details);
  return { proto, details, summary, body };
}

