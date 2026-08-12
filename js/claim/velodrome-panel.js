/* Velodrome's claim review + execution panel.
 *
 * WHY THIS IS A SECOND PANEL AND NOT A FLAG ON THE FIRST ONE.
 * `panel.js` does not accept an execution list — it BUILDS one internally
 * (`aerodromeExecutionLabelsForSelection()`), hardcoded to Aerodrome's shape: one chain, a fixed
 * claim -> swap -> bridge sequence, "swap X → USDC" wording. `enterExecutionView()` then maps
 * progress onto those rows POSITIONALLY. Velodrome's list is neither fixed-length nor
 * single-chain: rewards sit on 1..10 Superchain leaves, and each participating leaf contributes
 * its own claim + swap + bridge steps before anything converges on Optimism. Threading that
 * through panel.js's label builder would have meant rewriting the part of a 1,623-line file that
 * CLAUDE.md explicitly flags as too interlinked to decompose safely, with the Aerodrome flow —
 * the only claim flow that currently works — as collateral.
 *
 * So this file exists to get Velodrome's shape right FIRST, on its own, and the two panels are
 * deliberately, temporarily duplicated. Unifying them into one generic panel (also covering
 * Curve, Yield Basis, Clever and Concentrator previews) is a tracked follow-up in TASKS.md and is
 * the intended end state — this is not the place to add a sixth protocol's special case.
 *
 * THE ONE ARCHITECTURAL DIFFERENCE, and the reason unification later is worth doing:
 * **labels come from the preview, not from this file.** `preview.execSteps` is the single ordered
 * list of everything that will be sent, and it is the SAME array the executor walks. That is what
 * makes a variable, multi-chain sequence expressible at all, and it removes the failure mode
 * panel.js has to work to avoid — a label list and an execution sequence derived separately can
 * disagree, and because rows are addressed by index, a disagreement ticks the WRONG row rather
 * than raising anything. One array, one order, both readers agree (the same rule the
 * `swapSteps.sort()` comment in aerodrome/claim.js spells out).
 *
 * Visual language is deliberately identical to panel.js — same claim.css classes throughout — so
 * this reads as the same product, not a second design.
 */

import { VELODROME_LEAF_CHAINS } from '../protocols/config.js';
import { applyTokenIcon } from '../aerodrome/icons.js';
import { execStepLabelKey } from './ledger.js';
import { showTxStepToast, showTxSuccessPopup } from '../tx/feedback.js';
import { formatUnits, log, short, spinnerNode, usd } from '../core/utils.js';
import { RELEASE_BTN_LABEL, RELEASE_NOTICE, claimBlocked } from '../core/release.js';
import { money, uiLog } from '../core/ui-debug.js';

// Leaf display names come from VELODROME_LEAF_CHAINS' own `name` field rather than a second
// hardcoded map, so a chain added there is named correctly here for free. Optimism is the root and
// is not in that list, hence the explicit entry.
function chainLabel(chainId) {
  if (Number(chainId) === 10) return 'Optimism';
  if (Number(chainId) === 1) return 'Ethereum mainnet';
  return VELODROME_LEAF_CHAINS.find((c) => Number(c.chainId) === Number(chainId))?.name || `chain ${chainId}`;
}

/* preview shape (built by the Velodrome claim builder / its demo counterpart):
 *   {
 *     __demo?: boolean,
 *     chains: [{ chainId, tokens: [{ addr, symbol, decimals, amount, usd }], veloOut, veloUsd }],
 *     execSteps: [{ chainId, parts: [TXT|TOK], group }],   // THE ordered list, see header
 *     root: { veloIn, usdcOut, usdcUsd },
 *     mainnet?: { usdcIn, crvUsdOut, crvUsdUsd },
 *     totals: { claimedUsd, deliveredUsd },
 *   }
 * Returns a Promise<boolean> — true once every step confirmed, false on cancel/close.
 */
export function showVelodromeClaimPanel(preview, executeClaim) {
  const chains = preview.chains || [];
  uiLog('velodrome-panel', 'open', {
    demo: !!preview.__demo,
    chains: chains.length,
    tokens: chains.reduce((n, c) => n + (c.tokens?.length || 0), 0),
    steps: preview.execSteps?.length ?? 0,
    claimedUsd: money(preview.totals?.claimedUsd),
    mainnetLeg: !!preview.mainnet,
  });

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'claim-preview-backdrop';
    const panel = document.createElement('div');
    panel.className = 'claim-preview-panel claim-preview-panel--modal velo-claim-panel';
    // Demo panels are otherwise pixel-identical to real ones, and this panel shows real live
    // prices — the watermark is the only thing preventing a screenshot of it being mistaken for a
    // real claim. Same treatment, same classes, as the Aerodrome panel.
    if (preview.__demo) panel.classList.add('claim-preview-panel--demo');

    /* ---------- header ---------- */
    const header = document.createElement('div');
    header.className = 'claim-preview-header';
    const title = document.createElement('span');
    title.textContent = 'Review claim — Velodrome';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'claim-preview-close';
    closeBtn.textContent = '×';
    header.append(title, closeBtn);

    if (preview.__demo) {
      const banner = document.createElement('div');
      banner.className = 'claim-preview-demo-banner';
      banner.textContent = 'Demo mode — nothing here is real and nothing will be signed.';
      panel.appendChild(banner);
      // Tiled, not a single word: claim.css styles `.claim-preview-demo-watermark span`, so the
      // repeated spans ARE the effect — a bare textContent matches no rule and renders invisible
      // at the watermark's 0.09 opacity. Same 24 tiles, same aria-hidden, same prepend as
      // panel.js, so both panels carry an identical wash rather than two different demo markings.
      // prepend (not append) matters with the watermark's negative z-index painting order.
      const wm = document.createElement('div');
      wm.className = 'claim-preview-demo-watermark';
      wm.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 24; i++) {
        const wordEl = document.createElement('span');
        wordEl.textContent = 'DEMO MODE';
        wm.appendChild(wordEl);
      }
      panel.prepend(wm);
    }

    const body = document.createElement('div');
    body.className = 'claim-preview-body';
    const columns = document.createElement('div');
    columns.className = 'claim-preview-columns';

    /* ---------- left column: what gets claimed, grouped BY CHAIN ---------- */
    // Per-CHAIN toggles rather than per-token. On Aerodrome a token is the natural unit because
    // everything is on one chain; here the unit that actually costs money is the chain — every
    // participating leaf adds a claim, a swap and a bridge transaction, each with its own gas and
    // its own Hyperlane payment. Deselecting one token on a leaf you are already paying to visit
    // saves almost nothing; skipping the whole leaf is the decision worth offering, and it is
    // exactly what the agreed dust policy acts on.
    const left = document.createElement('div');
    left.className = 'claim-preview-steps-col';
    const selectedChains = new Set();
    const chainRows = new Map();

    for (const c of chains) {
      const chainUsd = (c.tokens || []).reduce((sum, t) => sum + (t.usd || 0), 0);
      // Dust default: a leaf worth less than it plausibly costs to visit starts UNCHECKED rather
      // than hidden. The user still sees it, and sees why — silently dropping value is the one
      // outcome TASKS.md rules out. `dust` is decided by the builder (which knows real gas and
      // bridge costs); this only renders the decision.
      if (!c.dust) selectedChains.add(Number(c.chainId));

      const section = document.createElement('div');
      section.className = 'claim-preview-step';

      const label = document.createElement('label');
      label.className = 'velo-toggle-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'claim-token-toggle';
      cb.checked = !c.dust;
      const labelText = document.createElement('span');
      labelText.textContent = `${chainLabel(c.chainId)} — ${usd(chainUsd)}`;
      label.append(cb, labelText);
      section.appendChild(label);

      if (c.dust) {
        const note = document.createElement('div');
        note.className = 'claim-preview-step-note claim-preview-note--warn';
        // Says the amount AND the reason. "Skipped" with no figure is the kind of silent omission
        // this flow is not allowed to make.
        note.textContent = `Not worth the gas — ${usd(chainUsd)} would cost more to claim and bridge than it is worth. Tick to claim anyway.`;
        section.appendChild(note);
      }

      const list = document.createElement('div');
      list.className = 'claim-preview-token-list';
      for (const t of c.tokens || []) {
        const row = document.createElement('div');
        row.className = 'claim-preview-token-row';
        const img = document.createElement('img');
        img.className = 'claim-preview-token-icon';
        img.alt = '';
        img.hidden = true;
        img.addEventListener('error', () => img.remove(), { once: true });
        applyTokenIcon(img, t.addr);
        const sym = document.createElement('span');
        sym.className = 'claim-preview-token-symbol';
        sym.textContent = t.symbol || short(t.addr);
        const amt = document.createElement('span');
        amt.className = 'claim-preview-token-amount';
        amt.textContent = formatUnits(t.amount, t.decimals ?? 18, 4);
        const val = document.createElement('span');
        val.className = 'claim-preview-token-usd';
        val.textContent = t.usd != null ? usd(t.usd) : '—';
        row.append(img, sym, amt, val);
        list.appendChild(row);
      }
      section.appendChild(list);

      // Every leaf's route is the same shape and it is worth stating per chain, because it is the
      // non-obvious part of this flow: rewards become VELO on the leaf, and VELO (not USDC) is
      // what crosses. See VELODROME_CLAIM's comment for why.
      const route = document.createElement('div');
      route.className = 'claim-preview-step-note';
      route.textContent = `→ swap to VELO on ${chainLabel(c.chainId)} → bridge to Optimism`;
      section.appendChild(route);

      left.appendChild(section);
      chainRows.set(Number(c.chainId), { cb, section });

      cb.addEventListener('change', () => {
        if (cb.checked) selectedChains.add(Number(c.chainId));
        else selectedChains.delete(Number(c.chainId));
        uiLog('velodrome-panel', 'chain toggle', {
          chain: chainLabel(c.chainId),
          on: cb.checked,
          selected: selectedChains.size,
          of: chains.length,
        });
        updateLedger();
        rebuildStepList();
      });
    }

    /* ---------- right column: ledger + the numbered transaction list ---------- */
    const right = document.createElement('div');
    right.className = 'claim-preview-steps-col velo-right-col';

    const ledger = document.createElement('div');
    const ledgerRows = {};
    for (const [key, name] of [['claimed', 'Claimed'], ['dust', 'Skipped — not worth the gas'], ['velo', 'Bridged to Optimism'], ['usdc', 'Consolidated to USDC'], ['delivered', 'Delivered']]) {
      const row = document.createElement('div');
      row.className = 'claim-preview-ledger-row' + (key === 'delivered' ? ' claim-preview-ledger-row--total' : '');
      const l = document.createElement('span');
      l.className = 'claim-preview-ledger-label';
      l.textContent = name;
      const v = document.createElement('span');
      v.className = 'claim-preview-ledger-value';
      v.textContent = '—';
      row.append(l, v);
      ledger.appendChild(row);
      ledgerRows[key] = { row, label: l, value: v };
    }
    right.appendChild(ledger);

    // Final-destination toggle. Per the user: Optimism is a legitimate terminal state, chosen
    // per-run, exactly as Aerodrome lets the user stop at Base. Off => stop at USDC on Optimism.
    let mainnetEnabled = !!preview.mainnet;
    const mainnetLabel = document.createElement('label');
    mainnetLabel.className = 'velo-toggle-row';
    const mainnetCb = document.createElement('input');
    mainnetCb.type = 'checkbox';
    mainnetCb.className = 'claim-token-toggle';
    mainnetCb.checked = mainnetEnabled;
    mainnetCb.disabled = !preview.mainnet;
    const mainnetText = document.createElement('span');
    mainnetText.textContent = 'Continue to crvUSD on Ethereum mainnet';
    mainnetLabel.append(mainnetCb, mainnetText);
    right.appendChild(mainnetLabel);
    mainnetCb.addEventListener('change', () => {
      mainnetEnabled = mainnetCb.checked;
      uiLog('velodrome-panel', 'mainnet toggle', { on: mainnetEnabled });
      updateLedger();
      rebuildStepList();
    });

    const stepsLabel = document.createElement('div');
    stepsLabel.className = 'claim-preview-section-label';
    right.appendChild(stepsLabel);
    // Only this box scrolls — the ledger and destination toggle above it stay visible. The
    // active-step scrollIntoView({block:'nearest'}) during execution scrolls within it, which is
    // what keeps the running transaction on screen without moving the figures being approved.
    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'velo-steps-scroll';
    right.appendChild(stepsWrap);

    columns.append(left, right);
    body.appendChild(columns);

    /* ---------- footer ---------- */
    const footer = document.createElement('div');
    footer.className = 'claim-preview-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-primary';
    confirmBtn.textContent = 'Confirm and proceed';
    footer.append(cancelBtn, confirmBtn);

    panel.append(header, body, footer);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    /* ---------- selection-driven derivations ---------- */
    // The steps actually about to run, filtered to the current selection. THE one ordered list:
    // the step rows are built from it and the executor is handed the very same array, so index N
    // means the same thing to both. Anything derived twice could diverge; this is derived once.
    function selectedSteps() {
      return (preview.execSteps || []).filter((s) => {
        if (s.group === 'mainnet') return mainnetEnabled;
        if (s.chainId == null) return true;
        // Root (Optimism) steps survive as long as ANY leaf is still selected — with nothing
        // bridged there is nothing on Optimism to consolidate.
        if (Number(s.chainId) === 10) return selectedChains.size > 0;
        return selectedChains.has(Number(s.chainId));
      });
    }

    function selectedClaimedUsd() {
      return chains
        .filter((c) => selectedChains.has(Number(c.chainId)))
        .reduce((sum, c) => sum + (c.tokens || []).reduce((s, t) => s + (t.usd || 0), 0), 0);
    }

    function updateLedger() {
      const claimed = selectedClaimedUsd();
      /* "Claimed" is EVERY claimable dollar, matching the portfolio card exactly, and the skipped
         dust is shown as its own subtraction. Showing only the selected total here made the panel
         look like it disagreed with the card about how much was claimable, when it was really
         disagreeing about how much was worth claiming — a very different statement. */
      const allClaimable = preview.totals?.claimedUsd ?? claimed;
      ledgerRows.claimed.value.textContent = usd(allClaimable);
      const skipped = allClaimable - claimed;
      ledgerRows.dust.row.hidden = skipped <= 0.005;
      ledgerRows.dust.value.textContent = `−${usd(skipped)}`;
      // Costs are proportional to what is actually selected — showing the full-claim figures
      // while the user has unticked half the chains would misstate what they are approving.
      const base = preview.totals?.claimableAfterDustUsd || preview.totals?.claimedUsd || 0;
      const share = base ? claimed / base : 0;
      const veloUsd = (preview.root?.veloUsd ?? claimed) * share || 0;
      const usdcUsd = (preview.root?.usdcUsd ?? veloUsd) * share || 0;
      ledgerRows.velo.value.textContent = selectedChains.size ? usd(veloUsd) : '—';
      ledgerRows.usdc.value.textContent = selectedChains.size ? usd(usdcUsd) : '—';
      const deliveredUsd = mainnetEnabled ? (preview.mainnet?.crvUsdUsd ?? usdcUsd) * share || 0 : usdcUsd;
      ledgerRows.delivered.label.textContent = mainnetEnabled ? 'Delivered on Ethereum mainnet' : 'Delivered on Optimism';
      ledgerRows.delivered.value.textContent = selectedChains.size ? usd(deliveredUsd) : usd(0);
      updateConfirmGate();
    }

    let stepRows = [];
    function rebuildStepList() {
      const steps = selectedSteps();
      stepsWrap.innerHTML = '';
      stepRows = steps.map((s, i) => {
        const r = buildStepRow(i + 1, s);
        stepsWrap.appendChild(r.row);
        return r;
      });
      stepsLabel.textContent = `${steps.length} transaction${steps.length === 1 ? '' : 's'}`;
    }

    function buildStepRow(number, step) {
      const row = document.createElement('div');
      row.className = 'claim-exec-step';
      row.dataset.status = 'pending';
      const num = document.createElement('span');
      num.className = 'claim-exec-step-num';
      num.textContent = String(number);
      const text = document.createElement('span');
      text.className = 'claim-exec-step-label';
      // Every step names its chain. On a single-chain flow that would be noise; here it is the
      // difference between "step 7 failed" and "step 7 failed on Celo, and your funds are sitting
      // on Celo as VELO" — which is the whole point of the partial-failure requirement.
      if (step.chainId != null) {
        const chip = document.createElement('span');
        chip.className = 'claim-exec-token claim-exec-token--chain';
        chip.textContent = chainLabel(step.chainId);
        text.appendChild(chip);
      }
      for (const part of step.parts || []) {
        if (part.t === 'text') { text.appendChild(document.createTextNode(part.v)); continue; }
        const badge = document.createElement('span');
        badge.className = 'claim-exec-token';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = part.symbol || short(part.addr);
        badge.appendChild(nameSpan);
        const img = document.createElement('img');
        img.className = 'claim-exec-token-icon';
        img.alt = '';
        img.hidden = true;
        img.addEventListener('error', () => img.remove(), { once: true });
        badge.appendChild(img);
        applyTokenIcon(img, part.addr);
        text.appendChild(badge);
      }
      const icon = document.createElement('span');
      icon.className = 'claim-exec-step-icon';
      row.append(num, text, icon);
      function setStatus(status) {
        row.dataset.status = status;
        icon.innerHTML = '';
        if (status === 'active') icon.appendChild(spinnerNode(14));
        else if (status === 'done') icon.textContent = '✓';
        else if (status === 'error') icon.textContent = '✕';
      }
      // A rejected signature is not terminal — same retry affordance, same classes, as panel.js.
      function setRejected(onRetry) {
        row.dataset.status = 'rejected';
        icon.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'claim-preview-retry-btn claim-preview-retry-btn--sm';
        btn.textContent = 'Retry';
        btn.addEventListener('click', () => onRetry(), { once: true });
        icon.appendChild(btn);
      }
      return { row, setStatus, setRejected, step, key: execStepLabelKey(step) };
    }

    /* ---------- release gate ---------- */
    // Gates EXECUTION, not review: the panel above builds and displays in full on a real wallet.
    // This must outrank anything else that touches the button (see release.js's comment on the
    // three enforcement points), so it is applied last on every update.
    function updateConfirmGate() {
      if (preview.__demo) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm and proceed'; return; }
      if (claimBlocked(false)) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = RELEASE_BTN_LABEL;
        confirmBtn.title = RELEASE_NOTICE;
        return;
      }
      confirmBtn.disabled = selectedChains.size === 0;
      confirmBtn.textContent = 'Confirm and proceed';
    }

    let executing = false;
    let awaitingTx = false;
    function cleanup(result) {
      backdrop.remove();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => { if (!executing) cleanup(false); });
    closeBtn.addEventListener('click', () => {
      // Mid-flight the × dismisses the view without stopping anything — a broadcast transaction
      // cannot be un-sent, and executeClaim() runs to completion regardless.
      if (executing && awaitingTx) log('claim still running — closing this panel only stops watching it', 'info');
      cleanup(executing ? true : false);
    });

    updateLedger();
    rebuildStepList();

    /* ---------- execution ---------- */
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled || executing) return;
      /* Second enforcement point. The button is already disabled above, so arriving here in a
         gated build means something upstream failed; this refuses on its own authority rather
         than trusting a disabled attribute. Demo mode is exempt throughout. */
      if (!preview.__demo && claimBlocked(false)) {
        log(RELEASE_NOTICE, 'err');
        return;
      }
      executing = true;
      cancelBtn.hidden = true;
      confirmBtn.hidden = true;
      title.textContent = preview.__demo ? 'Simulating transactions…' : 'Sending transactions…';

      const steps = selectedSteps();
      rebuildStepList(); // final rebuild against the exact set about to run
      const execPreview = {
        ...preview,
        execSteps: steps,
        selectedChainIds: [...selectedChains],
        mainnetEnabled,
      };
      uiLog('velodrome-panel', 'execution start', {
        demo: !!preview.__demo,
        steps: steps.length,
        chains: selectedChains.size,
        mainnet: mainnetEnabled,
        claimedUsd: money(selectedClaimedUsd()),
      });

      try {
        await executeClaim(execPreview, (index, status) => {
          awaitingTx = status === 'active';
          const r = stepRows[index];
          if (!r) return;
          if (status === 'active') r.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          if (status === 'rejected') return new Promise((retry) => { r.setRejected(retry); });
          r.setStatus(status);
          const label = r.row.querySelector('.claim-exec-step-label')?.textContent?.trim();
          uiLog('velodrome-panel', 'step', { n: index + 1, of: stepRows.length, status, label });
          if (status === 'done' && index < stepRows.length - 1) {
            showTxStepToast({
              title: preview.__demo ? `Step ${index + 1} of ${stepRows.length} (simulated)` : `Step ${index + 1} of ${stepRows.length} confirmed`,
              sub: label,
            });
          }
          return undefined;
        });
        title.textContent = 'Claim complete';
        const destination = mainnetEnabled ? 'Ethereum mainnet' : 'Optimism';
        uiLog('velodrome-panel', 'complete', {
          demo: !!preview.__demo,
          steps: stepRows.length,
          destination,
          delivered: ledgerRows.delivered.value.textContent,
        });
        cleanup(true);
        showTxSuccessPopup({
          title: 'Claim complete — funds delivered',
          sub: preview.__demo
            ? `Simulated: ${ledgerRows.delivered.value.textContent} would now be in your wallet on ${destination}.`
            : `${ledgerRows.delivered.value.textContent} just landed in your wallet on ${destination}.`,
          details: [
            { k: ledgerRows.delivered.label.textContent, v: ledgerRows.delivered.value.textContent, hero: true },
            { k: 'Claimed', v: ledgerRows.claimed.value.textContent },
            { k: 'Chains', v: String(selectedChains.size) },
            { k: 'Transactions', v: String(stepRows.length) },
          ],
        });
      } catch (err) {
        // Where a multi-chain claim differs most from a single-chain one: funds may now be sitting
        // as VELO on a leaf, or as VELO on Optimism, rather than back where they started. The
        // panel STAYS OPEN showing exactly which numbered step broke and on which chain, and says
        // so in words. Vanishing here, or reporting a bare "claim failed", is the outcome
        // TASKS.md rules out explicitly.
        const failed = stepRows.findIndex((r) => r.row.dataset.status === 'error');
        const where = failed >= 0 ? stepRows[failed].step : null;
        const chainTxt = where?.chainId != null ? ` on ${chainLabel(where.chainId)}` : '';
        title.textContent = 'Claim stopped';
        const note = document.createElement('div');
        note.className = 'claim-preview-note claim-preview-note--warn';
        note.textContent = failed >= 0
          ? `Stopped at step ${failed + 1} of ${stepRows.length}${chainTxt}. Anything already claimed or swapped is still in your wallet${chainTxt} — nothing is lost, but it has not finished moving. Re-running the claim will pick up what is there.`
          : `Claim stopped before completing. Anything already claimed is still in your wallet.`;
        body.prepend(note);
        uiLog('velodrome-panel', 'failed', {
          demo: !!preview.__demo,
          step: failed >= 0 ? failed + 1 : null,
          of: stepRows.length,
          chain: where?.chainId != null ? chainLabel(where.chainId) : null,
          error: String(err?.message || err).slice(0, 120),
        });
        log(`Velodrome claim stopped${chainTxt}: ${err?.message || err}`, 'err');
        closeBtn.hidden = false;
        executing = false;
      }
    });

    updateConfirmGate();
  });
}
