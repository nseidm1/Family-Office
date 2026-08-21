/* THE generic claim review + execution panel — one panel for every protocol.
 *
 * WHY THIS EXISTS (TASKS.md FA-003). There were two panels: `panel.js` (Aerodrome) and
 * `velodrome-panel.js`. Both rendered the same visual language and duplicated the same execution
 * machinery, and neither could serve a protocol that claims in ONE transaction on mainnet — which is
 * four of the six protocols (Curve, Yield Basis, Clever, Concentrator). Adding a claim flow meant
 * building another panel; the point of this file is that it should mean writing a PREVIEW.
 * Curve, Velodrome, Yield Basis and Concentrator are migrated (see `curve-preview.js`,
 * `velodrome-preview.js`, `yieldbasis-preview.js`, `concentrator-preview.js`, and
 * `velodrome-panel.js` is deleted); `panel.js` (Aerodrome) is the one protocol still on its own
 * panel, and TASKS.md #3 tracks moving it here last, deliberately, as the riskiest of the five.
 *
 * DESIGNED AGAINST CURVE FIRST, DELIBERATELY. FA-003 absorbed FA-004 precisely because designing this
 * around the two existing multi-step flows would have produced a "generic" panel that was really just
 * those two, with Curve rediscovered afterwards and the abstraction redone. Curve is the sharpest
 * test: a single transaction, no swap, no bridge, one chain, no destination choice, and a ledger where
 * claimed and delivered are the same number. Everything below that reads as optional — group toggles,
 * the destination toggle, the ledger's intermediate rows, chain chips on steps — is optional BECAUSE
 * Curve has none of it, and the panel has to degrade to a single row without looking broken or
 * ceremonial.
 *
 * THE CONTRACT (preview): the panel renders what it is given and computes nothing about money.
 *
 *   {
 *     protocol:  'curve',                     // id, for logging
 *     title:     'Review claim — Curve',
 *     __demo?:   boolean,
 *     groups: [{                              // left column; ONE group renders without toggles
 *       id, label, usd,
 *       selectable?: boolean,                 // false => no checkbox at all (Curve)
 *       selected?:   boolean,                 // initial state; false renders unchecked WITH its reason
 *       note?, warn?: boolean,                // e.g. the dust explanation
 *       route?:  string,                      // "→ swap to VELO → bridge to Optimism"
 *       items: [{ addr, symbol, amount, decimals, usd }],
 *     }],
 *     execSteps: [{
 *       parts: [TXT|TOK], groupId?, chainLabel?, kind?, always?: boolean,
 *       when?(selectedIds, destinationEnabled) -> boolean,   // general form; see selectedSteps()
 *     }],
 *     ledgerRows: [{ key, label, total?: boolean }],
 *     ledger(selectedIds, destinationEnabled) -> { [key]: string },   // the BUILDER owns every figure
 *     ledgerLabel?(key, destinationEnabled) -> string,   // override a row's static label; see below
 *     destination?: { label, available, enabled },
 *     summary?: {
 *       destination: string | ((destinationEnabled) => string),      // wording for the success popup
 *       extraDetails?(selectedIds, destinationEnabled) -> [{k, v}],   // extra success-popup rows
 *     },
 *   }
 *
 * `ledgerLabel` and `summary.destination`-as-function exist because Velodrome is the first protocol
 * with a REAL destination toggle — Curve has none, so `ledger()`'s values were the only thing that
 * ever needed to react to a toggle. Velodrome's "Delivered" row reads "on Optimism" or "on Ethereum
 * mainnet" depending on it, and the success popup's destination wording must agree. Both are called
 * fresh at the moment they render (`ledgerLabel` on every `updateLedger()`, `summary.destination` and
 * `extraDetails` once at completion), so they always reflect what the user actually toggled rather
 * than what `showGenericClaimPanel()` was first called with.
 *
 * `execSteps` is THE ordered list: the rows are built from it and the executor is handed the very same
 * array, so index N means the same thing to both. That is `velodrome-panel.js`'s one architectural
 * advantage over `panel.js` (which derives labels separately from the sequence it runs, and because
 * rows are addressed by index, a disagreement ticks the WRONG row instead of failing loudly), and it
 * is kept here as the rule rather than the exception.
 *
 * Visual language is byte-for-byte the existing claim.css classes — this is the same product, not a
 * third design.
 */

import { applyTokenIcon } from '../aerodrome/icons.js';
import { execStepLabelKey } from './ledger.js';
import { refreshCash } from '../protocols/cash.js';
import { showTxStepToast, showTxSuccessPopup } from '../tx/feedback.js';
import { log, formatUnits, short, spinnerNode, usd } from '../core/utils.js';
import { RELEASE_BTN_LABEL, RELEASE_NOTICE, claimBlocked } from '../core/release.js';
import { money, uiLog } from '../core/ui-debug.js';

const SCOPE = 'claim-panel';

/* Returns a Promise<boolean> — true once every step confirmed, false on cancel/close.
   `executeClaim(execPreview, onStep)` matches the existing executors' signature exactly, so a
   protocol already driving one of the old panels can move over without touching its executor. */
export function showGenericClaimPanel(preview, executeClaim) {
  const groups = preview.groups || [];
  // Anything not selectable is permanently in the selection: a group the user cannot switch off must
  // never be filtered out of the steps or subtracted from the ledger.
  const selected = new Set(groups.filter((g) => g.selectable === false || g.selected !== false).map((g) => g.id));

  uiLog(SCOPE, 'open', {
    protocol: preview.protocol,
    demo: !!preview.__demo,
    groups: groups.length,
    items: groups.reduce((n, g) => n + (g.items?.length || 0), 0),
    steps: preview.execSteps?.length ?? 0,
    selectable: groups.some((g) => g.selectable !== false),
  });

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'claim-preview-backdrop';
    const panel = document.createElement('div');
    panel.className = 'claim-preview-panel claim-preview-panel--modal velo-claim-panel';
    if (preview.__demo) panel.classList.add('claim-preview-panel--demo');

    /* ---------- header ---------- */
    const header = document.createElement('div');
    header.className = 'claim-preview-header';
    const title = document.createElement('span');
    title.textContent = preview.title || 'Review claim';
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
      /* Tiled spans, not a bare word: claim.css styles `.claim-preview-demo-watermark span`, so the
         repeated spans ARE the effect — textContent alone matches no rule and renders invisible at
         0.09 opacity. Same 24 tiles and same prepend as both older panels (prepend matters with the
         watermark's negative z-index painting order), so every panel carries an identical wash. */
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

    /* ---------- left column: what gets claimed ---------- */
    const left = document.createElement('div');
    left.className = 'claim-preview-steps-col';

    for (const g of groups) {
      const section = document.createElement('div');
      section.className = 'claim-preview-step';

      /* A single non-selectable group gets a PLAIN heading, not a checkbox. A lone checkbox that
         cannot be unticked is the "ceremonial" failure FA-004 warned about: it implies a decision
         the user does not have. Curve claims all of it or none of it, and "none" is Cancel. */
      if (g.selectable === false) {
        const heading = document.createElement('div');
        heading.className = 'claim-preview-section-label';
        heading.textContent = g.usd != null ? `${g.label} — ${usd(g.usd)}` : g.label;
        section.appendChild(heading);
      } else {
        const label = document.createElement('label');
        label.className = 'velo-toggle-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'claim-token-toggle';
        cb.checked = selected.has(g.id);
        const labelText = document.createElement('span');
        labelText.textContent = g.usd != null ? `${g.label} — ${usd(g.usd)}` : g.label;
        label.append(cb, labelText);
        section.appendChild(label);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(g.id); else selected.delete(g.id);
          uiLog(SCOPE, 'group toggle', { group: g.label, on: cb.checked, selected: selected.size, of: groups.length });
          updateLedger();
          rebuildStepList();
        });
      }

      // Says the amount AND the reason. A skipped group with no figure is the silent omission this
      // flow is not allowed to make.
      if (g.note) {
        const note = document.createElement('div');
        note.className = 'claim-preview-step-note' + (g.warn ? ' claim-preview-note--warn' : '');
        note.textContent = g.note;
        section.appendChild(note);
      }

      const list = document.createElement('div');
      list.className = 'claim-preview-token-list';
      for (const t of g.items || []) {
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
        amt.textContent = t.amountText != null ? t.amountText : formatUnits(t.amount, t.decimals ?? 18, 4);
        const val = document.createElement('span');
        val.className = 'claim-preview-token-usd';
        val.textContent = t.usd != null ? usd(t.usd) : '—';
        row.append(img, sym, amt, val);
        list.appendChild(row);
      }
      section.appendChild(list);

      if (g.route) {
        const route = document.createElement('div');
        route.className = 'claim-preview-step-note';
        route.textContent = g.route;
        section.appendChild(route);
      }

      left.appendChild(section);
    }

    /* ---------- right column: ledger + the numbered transaction list ---------- */
    const right = document.createElement('div');
    right.className = 'claim-preview-steps-col velo-right-col';

    const ledger = document.createElement('div');
    const ledgerRows = {};
    for (const spec of preview.ledgerRows || []) {
      const row = document.createElement('div');
      row.className = 'claim-preview-ledger-row' + (spec.total ? ' claim-preview-ledger-row--total' : '');
      const l = document.createElement('span');
      l.className = 'claim-preview-ledger-label';
      l.textContent = spec.label;
      const v = document.createElement('span');
      v.className = 'claim-preview-ledger-value';
      v.textContent = '—';
      row.append(l, v);
      ledger.appendChild(row);
      ledgerRows[spec.key] = { row, label: l, value: v, total: !!spec.total };
    }
    right.appendChild(ledger);

    /* Destination toggle, only when the protocol actually offers a choice. Curve always pays crvUSD
       on mainnet, so it supplies no `destination` and no toggle is rendered — showing a disabled one
       would advertise an option that does not exist. */
    let destinationEnabled = !!preview.destination?.enabled;
    if (preview.destination) {
      const destLabel = document.createElement('label');
      destLabel.className = 'velo-toggle-row';
      const destCb = document.createElement('input');
      destCb.type = 'checkbox';
      destCb.className = 'claim-token-toggle';
      destCb.checked = destinationEnabled;
      destCb.disabled = preview.destination.available === false;
      const destText = document.createElement('span');
      destText.textContent = preview.destination.label;
      destLabel.append(destCb, destText);
      right.appendChild(destLabel);
      destCb.addEventListener('change', () => {
        destinationEnabled = destCb.checked;
        uiLog(SCOPE, 'destination toggle', { on: destinationEnabled });
        updateLedger();
        rebuildStepList();
      });
    }

    const stepsLabel = document.createElement('div');
    stepsLabel.className = 'claim-preview-section-label';
    right.appendChild(stepsLabel);
    // Only this box scrolls, so the figures being approved stay on screen while the active step
    // scrolls itself into view during execution.
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
    // Derived ONCE. The rows are built from this and the executor is handed the same array.
    /* `when` is the general form and every rule below it is a special case: a step's inclusion is a
       function of the selection. It exists because Velodrome has one step — consolidating the VELO
       the LEAVES bridged in — whose condition is "any LEAF is selected", which none of the fixed
       rules can express: it is not tied to one group, and "any group at all" wrongly keeps it when
       only the root chain is ticked and there is nothing arriving to consolidate (FA-034).
       Protocol knowledge belongs in the preview, so the preview gets to state the condition rather
       than the panel growing a special case per protocol. */
    function selectedSteps() {
      return (preview.execSteps || []).filter((s) => {
        if (s.when) return s.when([...selected], destinationEnabled);
        if (s.group === 'destination') return destinationEnabled;
        if (s.always) return true;
        if (s.groupId == null) return selected.size > 0;
        return selected.has(s.groupId);
      });
    }

    function updateLedger() {
      const values = preview.ledger ? preview.ledger([...selected], destinationEnabled) : {};
      for (const [key, cell] of Object.entries(ledgerRows)) {
        const v = values[key];
        // A row the builder has nothing to say about is HIDDEN, not shown as "—". On Curve that is
        // what collapses a six-row multi-chain ledger to "Claimed / Delivered" without leaving
        // blanks implying missing data.
        cell.row.hidden = v == null;
        cell.value.textContent = v == null ? '—' : v;
        // Only Velodrome supplies this today — its "Delivered" row reads "on Optimism" or "on
        // Ethereum mainnet" depending on the destination toggle, which a static spec.label cannot.
        if (preview.ledgerLabel) {
          const label = preview.ledgerLabel(key, destinationEnabled);
          if (label != null) cell.label.textContent = label;
        }
      }
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
      /* The chain chip is opt-in per step. On a multi-chain flow it is the difference between
         "step 7 failed" and "step 7 failed on Celo, and your funds are sitting on Celo"; on a
         single-chain flow it is noise, so a preview that does not set it gets no chip. */
      if (step.chainLabel) {
        const chip = document.createElement('span');
        chip.className = 'claim-exec-token claim-exec-token--chain';
        chip.textContent = step.chainLabel;
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
      // A rejected signature is not terminal — same retry affordance and classes as both older panels.
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
    // Gates EXECUTION, not review: everything above builds and displays in full on a real wallet.
    // Applied last on every update so it outranks anything else that touches the button.
    function updateConfirmGate() {
      if (preview.__demo) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm and proceed'; return; }
      if (claimBlocked(false)) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = RELEASE_BTN_LABEL;
        confirmBtn.title = RELEASE_NOTICE;
        return;
      }
      confirmBtn.disabled = selected.size === 0;
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
      /* Refuses on its own authority rather than trusting a disabled attribute layers away — the
         third enforcement point described in release.js. Demo mode is exempt throughout. */
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
      const execPreview = { ...preview, execSteps: steps, selectedGroupIds: [...selected], destinationEnabled };
      uiLog(SCOPE, 'execution start', {
        protocol: preview.protocol,
        demo: !!preview.__demo,
        steps: steps.length,
        groups: selected.size,
        destination: destinationEnabled,
      });

      try {
        await executeClaim(execPreview, (index, status) => {
          awaitingTx = status === 'active';
          const r = stepRows[index];
          if (!r) return undefined;
          if (status === 'active') r.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          if (status === 'rejected') return new Promise((retry) => { r.setRejected(retry); });
          r.setStatus(status);
          const label = r.row.querySelector('.claim-exec-step-label')?.textContent?.trim();
          uiLog(SCOPE, 'step', { n: index + 1, of: stepRows.length, status, label });
          // No "step 1 of 1 confirmed" toast on a single-step flow — the success popup is one beat
          // behind it and saying the same thing twice is the ceremony a one-tx claim must avoid.
          if (status === 'done' && index < stepRows.length - 1) {
            showTxStepToast({
              title: preview.__demo ? `Step ${index + 1} of ${stepRows.length} (simulated)` : `Step ${index + 1} of ${stepRows.length} confirmed`,
              sub: label,
            });
          }
          return undefined;
        });
        title.textContent = 'Claim complete';
        const destination = (typeof preview.summary?.destination === 'function'
          ? preview.summary.destination(destinationEnabled)
          : preview.summary?.destination) || 'your wallet';
        const totalCell = Object.values(ledgerRows).find((c) => c.total);
        const delivered = totalCell?.value.textContent || '';
        uiLog(SCOPE, 'complete', {
          protocol: preview.protocol,
          demo: !!preview.__demo,
          steps: stepRows.length,
          destination,
          delivered: money(delivered),
        });
        cleanup(true);
        // Funds just landed — the Cash card still shows the pre-claim read until someone hits its
        // own Refresh button, so kick it here rather than leaving that stale. Fire-and-forget:
        // refreshCash() has its own in-flight guard and demo-path handling, and nothing in this
        // flow depends on the Cash read finishing.
        refreshCash();
        showTxSuccessPopup({
          title: 'Claim complete — funds delivered',
          sub: preview.__demo
            ? `Simulated: ${delivered} would now be in your wallet on ${destination}.`
            : `${delivered} just landed in your wallet on ${destination}.`,
          details: [
            ...(totalCell ? [{ k: totalCell.label.textContent, v: delivered, hero: true }] : []),
            ...(ledgerRows.claimed ? [{ k: 'Claimed', v: ledgerRows.claimed.value.textContent }] : []),
            ...(preview.summary?.extraDetails ? preview.summary.extraDetails([...selected], destinationEnabled) : []),
            { k: 'Transactions', v: String(stepRows.length) },
          ],
        });
      } catch (err) {
        /* The panel STAYS OPEN showing which numbered step broke, and says in words where the money
           is. Vanishing, or reporting a bare "claim failed", is ruled out explicitly in TASKS.md. */
        const failed = stepRows.findIndex((r) => r.row.dataset.status === 'error');
        const where = failed >= 0 ? stepRows[failed].step : null;
        const chainTxt = where?.chainLabel ? ` on ${where.chainLabel}` : '';
        title.textContent = 'Claim stopped';
        const note = document.createElement('div');
        note.className = 'claim-preview-note claim-preview-note--warn';
        note.textContent = failed >= 0
          ? `Stopped at step ${failed + 1} of ${stepRows.length}${chainTxt}. Anything already claimed is still in your wallet${chainTxt} — nothing is lost, but it has not finished moving. Re-running the claim will pick up what is there.`
          : 'Claim stopped before completing. Anything already claimed is still in your wallet.';
        body.prepend(note);
        uiLog(SCOPE, 'failed', {
          protocol: preview.protocol,
          demo: !!preview.__demo,
          step: failed >= 0 ? failed + 1 : null,
          of: stepRows.length,
          error: String(err?.message || err).slice(0, 120),
        });
        log(`${preview.protocol} claim stopped${chainTxt}: ${err?.message || err}`, 'err');
        closeBtn.hidden = false;
        executing = false;
      }
    });

    updateConfirmGate();
  });
}
