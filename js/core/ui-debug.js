/* UI-state debug logging — the console counterpart to the on-page RPC log.

   WHY THIS EXISTS, and what it is deliberately NOT.

   `log()` in core/utils.js narrates the NETWORK: every eth_call, every price fetch, every retry.
   It answers "did the data arrive?". It says nothing about what the UI then did with that data,
   so answering "did the card actually render?", "did privacy mode mask the total?", "how far did
   the claim flow get?" has meant opening a browser and hand-writing throwaway `querySelectorAll`
   probes against the live DOM — re-derived from scratch every debugging session, and impossible
   from a terminal, a CI run, or a log paste in a bug report.

   This module is the other half: a narration of the UI's own state transitions, structured
   enough that reading the console replaces reading the screen for most functional questions.
   The bar it is written to — "could I confirm this feature works from the log alone, without
   looking?" — is why the events carry counts, states and outcomes rather than bare "rendered"
   markers. A line like

     [ui:cash] render { symbols: 4, rows: 7, total: '$6,615.65', status: 'ok' }

   settles in one glance what previously took a DOM query, and unlike a screenshot it diffs
   cleanly between runs.

   It is NOT an analytics or telemetry channel: everything here is local, console-only, and never
   leaves the page. It is also NOT a replacement for looking at the app when the question is
   genuinely visual — layout, spacing, colour, animation. Those need eyes; correctness of
   structure, state and sequence does not.

   Design constraints, each load-bearing:

   * OFF by default, and cheap when off. Every entry point early-returns on a boolean before
     touching its arguments, so a disabled logger costs one property read per call. Call sites
     pass plain values, never pre-formatted strings, so nothing is built that won't be printed.
   * Privacy mode is honoured. Amounts and addresses routed through `money()`/`addr()` mask
     exactly as the UI masks them, so a console paste from a privacy-mode session leaks no more
     than a screenshot of it would. Structural facts (counts, states, symbols) are never masked —
     they are the whole point and reveal nothing.
   * Grep-friendly over pretty, and deliberately UNSTYLED. An earlier revision used `%c` console
     styling for the scope prefix; it looks good in devtools and is pure noise everywhere else —
     piped output, a copied stack, a bug report — rendering as a literal `%c...color:#7c5cff` in
     each line. Since reading these logs OUTSIDE a devtools window is the entire point of this
     module, the colour lost and the plain prefix won. Detail stays a real object (not an
     interpolated string) so devtools still keeps it inspectable and `JSON.stringify` works on
     captured output. */

import { MASK, privacyHidden } from './prefs.js';

export const UI_DEBUG_KEY = 'uiDebug';

/* Levels are cumulative: 'milestone' is the readable narrative (a card rendered, a toggle
   flipped, a claim advanced a step) and is what you want almost always; 'verbose' adds
   per-element and per-row detail that is useful when a specific component misbehaves but would
   otherwise drown the milestones it sits between. 'off' is the default — this app's normal
   console should stay clean for real use, and a debug channel nobody asked for is noise. */
export const UI_LEVELS = { off: 0, milestone: 1, verbose: 2 };
let level = UI_LEVELS.off;

// Enabled by, in precedence order: ?uidebug=<level> on the URL (wins, and persists so a reload
// keeps it), then localStorage. Both are wrapped — localStorage throws in locked-down/private
// contexts, the same way getStoredTheme() in prefs.js already guards for.
function initLevel() {
  let requested = null;
  try {
    const q = new URLSearchParams(location.search).get('uidebug');
    if (q !== null) requested = q === '' || q === '1' ? 'milestone' : q;
  } catch { /* no URL access — fall through to storage */ }
  if (requested === null) {
    try { requested = localStorage.getItem(UI_DEBUG_KEY); } catch { requested = null; }
  } else {
    try { localStorage.setItem(UI_DEBUG_KEY, requested); } catch { /* non-persistent session */ }
  }
  level = UI_LEVELS[requested] ?? UI_LEVELS.off;
}
initLevel();

export function setUiDebugLevel(name) {
  level = UI_LEVELS[name] ?? UI_LEVELS.off;
  try {
    if (level === UI_LEVELS.off) localStorage.removeItem(UI_DEBUG_KEY);
    else localStorage.setItem(UI_DEBUG_KEY, name);
  } catch { /* non-persistent session */ }
  // Deliberately a plain console.log and not uiLog(): this one line has to print even when the
  // level was just set to 'off', otherwise turning logging off looks like the app broke.
  console.log(`[ui] debug level = ${name}${level ? '' : ' (logging disabled)'}`);
  return level;
}

/* Mask helpers for anything that would be masked on screen. Call these at the LOG SITE rather
   than masking centrally, because only the call site knows whether a given number is a real
   balance (mask it) or a structural count (never mask it) — a central guess would either leak
   balances or redact the counts that make these logs worth reading. */
export const money = (v) => (privacyHidden ? MASK : v);
export const addr = (a) => (privacyHidden ? MASK : a);

/* The single logging entry point. `detail` is optional and printed as a live object.

   Note the argument shape: `uiLog('cash', 'render', { symbols: 4 })` and NOT
   `uiLog(\`cash render ${n} symbols\`)`. The split keeps the scope greppable, keeps
   the object inspectable in devtools, and — the reason it matters most — means a disabled
   logger never pays for string interpolation that would be thrown away. */
export function uiLog(scope, event, detail) {
  if (level === UI_LEVELS.off) return;
  if (detail === undefined) console.log(`[ui:${scope}] ${event}`);
  else console.log(`[ui:${scope}] ${event}`, detail);
}

// Verbose-only variant — same signature, skipped entirely below level 2. Kept separate from a
// `uiLog(..., {verbose:true})` flag so the level check happens before the detail object is built.
export function uiTrace(scope, event, detail) {
  if (level < UI_LEVELS.verbose) return;
  if (detail === undefined) console.log(`[ui:${scope}] ${event}`);
  else console.log(`[ui:${scope}] ${event}`, detail);
}

export function uiWarn(scope, event, detail) {
  if (level === UI_LEVELS.off) return;
  console.warn(`[ui:${scope}] ${event}`, detail ?? '');
}

/* Wall-clock timing for a UI operation. Returns the end() function; calling it logs the
   duration. Measures RENDER cost specifically — the network side is already timed by publicRpc's
   own log lines, and conflating the two is what makes "the card is slow" hard to attribute.
   No-ops cleanly when logging is off, so call sites need no conditional of their own. */
export function uiTime(scope, event, detail) {
  if (level === UI_LEVELS.off) return () => {};
  const t0 = performance.now();
  return (extra) => {
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    uiLog(scope, event, { ms, ...detail, ...extra });
  };
}

/* ---------- snapshot ---------- */

/* A structured read of what is on screen RIGHT NOW, for when the event stream isn't enough —
   you arrived late, or you want to assert against final state rather than the transitions that
   produced it. This is the direct replacement for hand-written `querySelectorAll` probes: it
   encodes, once and in the repo, the selectors and shape that debugging this app actually needs,
   so the knowledge stops being re-derived per session.

   Deliberately available even when logging is OFF (it is a pull, not a push — it costs nothing
   until called) and deliberately NOT privacy-masked: it is an explicit, interactive request by
   whoever already has the console open, the same trust level as reading the DOM by hand. The
   push-based uiLog path masks because its output accumulates and gets pasted around; this
   doesn't accumulate. */
export function uiSnapshot() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const panel = document.querySelector('.claim-preview-panel');
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    privacyHidden,
    cash: {
      total: text(document.querySelector('#cash-total')),
      symbols: [...document.querySelectorAll('.cash-symbol')].map(text),
      rows: document.querySelectorAll('#cash-list .cash-chain-row').length,
    },
    portfolio: {
      total: text(document.querySelector('#portfolio-total')),
      cards: [...document.querySelectorAll('#protocol-list > details')].map((d) => ({
        name: text(d.querySelector('.protocol-name')) || text(d.querySelector('summary'))?.slice(0, 24),
        open: d.open,
        rows: d.querySelectorAll('.row').length,
        subsections: d.querySelectorAll('.protocol-sub').length,
        buttons: [...d.querySelectorAll('button')].map((b) => ({ label: text(b), disabled: b.disabled })),
      })),
    },
    claimPanel: panel && {
      demo: panel.classList.contains('claim-preview-panel--demo'),
      // Both toggle kinds carry .claim-token-toggle; what distinguishes them is the row they
      // sit in — .claim-preview-token-row for a claimable token, .claim-preview-step for the
      // bridge/crvUSD step switches. Naming them off that row is what makes the output readable
      // instead of seven anonymous booleans.
      toggles: [...panel.querySelectorAll('input.claim-token-toggle')].map((c) => {
        const row = c.closest('.claim-preview-token-row, .claim-preview-step');
        return {
          kind: row?.classList.contains('claim-preview-step') ? 'step' : 'token',
          name: text(row) || '?',
          checked: c.checked,
        };
      }),
      steps: [...panel.querySelectorAll('.claim-exec-step')].map((s) => ({
        label: text(s.querySelector('.claim-exec-step-label')) || text(s),
        // setStatus() writes the row's live state to data-status ('pending' at build, then
        // active/done/rejected as execution reports) — surfacing it is what lets a snapshot
        // answer "how far did execution get" as precisely as the step event stream does.
        status: s.dataset.status,
      })),
    },
    // Class names verified against tx/feedback.js, not guessed — the first draft of these two
    // selectors ('.tx-step-toast', '.tx-success-popup') matched nothing at all, and a snapshot
    // field that is silently always null is worse than an absent one because it reads as
    // "nothing is showing" rather than "this is not wired up".
    toasts: [...document.querySelectorAll('.tx-toast')].map(text),
    successPopup: text(document.querySelector('.tx-success-card')),
  };
}

/* Exposed as `window.__ui` so it is reachable from a paused breakpoint, a devtools console, or
   an automated driver, with no import needed and no build step to thread it through.
   `window.__ui.snapshot()` / `window.__ui.on()` / `window.__ui.off()`. */
window.__ui = {
  snapshot: uiSnapshot,
  on: (lvl = 'milestone') => setUiDebugLevel(lvl),
  off: () => setUiDebugLevel('off'),
  verbose: () => setUiDebugLevel('verbose'),
  level: () => Object.keys(UI_LEVELS).find((k) => UI_LEVELS[k] === level),
};
