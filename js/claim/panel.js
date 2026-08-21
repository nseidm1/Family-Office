import { applyTokenIcon } from '../aerodrome/icons.js';
import { fetchAerodromeTokenDecimals, quoteAerodromeBridgeLeg, resolveAerodromeToken, usdValueOfSwapStep } from '../aerodrome/routing.js';
import { AERODROME, AERODROME_CLAIM } from '../protocols/config.js';
import { refreshCash } from '../protocols/cash.js';
import { ICONS } from '../protocols/icon-data.js';
import { MODE } from '../core/chains.js';
import { showTxStepToast, showTxSuccessPopup } from '../tx/feedback.js';
import { CLAIM_PREVIEW_PROTOCOL_ID, SKIP_REASON_TEXT, TOK, TXT, cardClaimSnapshot, claimTokenTotals, execStepLabelKey, priceClaimPreview } from './ledger.js';
import { portfolioResults, protocolNodes } from '../main.js';
import { setClaimAvailable } from './orchestrate.js';
import { setSensitiveText } from '../core/prefs.js';
import { collapseAndRemoveExecStepRow, expandExecStepRow, renderAlphaIcons, renderPortfolioTotal, renderProtocolResult } from '../render/portfolio.js';
import { priceTokensUsd } from '../rpc-waterfall.js';
import { isAtomicCapable } from '../tx/send.js';
import { fadeInSwap, formatUnits, log, logErr, short, spinnerNode, usd, word } from '../core/utils.js';
import { RELEASE_BTN_LABEL, RELEASE_NOTICE, claimBlocked } from '../core/release.js';
import { money, uiLog, uiTrace } from '../core/ui-debug.js';

export function showClaimPreviewPanel(preview, executeClaim) {
  // Opening is the moment the preview stops being data and becomes something the user can act
  // on, so it is worth a milestone line. `demo` in particular: a demo panel is visually
  // identical to a real one apart from its watermark, and "which mode was that screenshot from?"
  // is a question this answers unambiguously.
  uiLog('claim-panel', 'open', {
    demo: !!preview.__demo,
    claimTxs: preview.claimTxs?.length ?? 0,
    swaps: preview.swapSteps?.length ?? 0,
    skipped: preview.skipped?.length ?? 0,
    unresolved: preview.unresolved?.length ?? 0,
    // acrossQuote is what actually decides whether a bridge leg exists and is priced — an
    // earlier version of this line guessed at a `preview.bridge` field that has never existed
    // and so reported `hasBridge: false` on every claim, bridge or not.
    bridgeQuoted: !!preview.acrossQuote,
    crvUsdQuoted: !!preview.curveQuote,
  });
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'claim-preview-backdrop';

    const panel = document.createElement('div');
    panel.className = 'claim-preview-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Claim to mainnet — review');

    const header = document.createElement('div');
    header.className = 'claim-preview-header';
    const title = document.createElement('h3');
    title.textContent = 'Review claim to mainnet';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'claim-preview-close';
    closeBtn.setAttribute('aria-label', 'Cancel');
    closeBtn.textContent = '×';
    // Shown briefly (see closeBtn's click handler below) when × is clicked WHILE a real
    // transaction is actively out for signing/confirmation — closing is blocked only in that
    // exact window, and silently doing nothing read as broken, so this says why instead.
    const closeBlockedNote = document.createElement('div');
    closeBlockedNote.className = 'claim-preview-close-blocked';
    closeBlockedNote.textContent = "Waiting on a pending transaction — can't close yet";
    closeBlockedNote.hidden = true;
    header.append(title, closeBtn, closeBlockedNote);

    const body = document.createElement('div');
    body.className = 'claim-preview-body';

    // Holds the numbered transaction list (see the "numbered transaction list" block below) —
    // laid out beside `body` rather than stacked under it, via .claim-preview-columns, so the
    // list of what's about to execute is visible at a glance alongside the review the whole time,
    // not scrolled past at the bottom.
    const stepsCol = document.createElement('div');
    stepsCol.className = 'claim-preview-steps-col';

    const section = (label) => {
      const h = document.createElement('div');
      h.className = 'claim-preview-section-label';
      h.textContent = label;
      body.appendChild(h);
    };

    const step = (text, note) => {
      const row = document.createElement('div');
      row.className = 'claim-preview-step';
      const t = document.createElement('span');
      t.textContent = text;
      row.appendChild(t);
      if (note) {
        const n = document.createElement('span');
        n.className = 'claim-preview-step-note';
        n.textContent = note;
        row.appendChild(n);
      }
      return row;
    };

    // Same shape as step(), but with a leading checkbox — used for the two optional legs of the
    // mainnet delivery (bridge, then the crvUSD swap) so the user can opt either one out and see
    // every other section (ledger, transactions list) adjust accordingly.
    const stepToggle = (text, noteText, checked, onChange) => {
      const row = document.createElement('div');
      row.className = 'claim-preview-step';
      row.style.alignItems = 'center';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'claim-token-toggle';
      toggle.checked = checked;
      toggle.addEventListener('change', () => onChange(toggle.checked));
      row.appendChild(toggle);
      const t = document.createElement('span');
      t.style.cssText = 'flex:1 1 auto;min-width:0;overflow-wrap:break-word;';
      t.textContent = text;
      row.appendChild(t);
      if (noteText) {
        const n = document.createElement('span');
        n.className = 'claim-preview-step-note';
        n.textContent = noteText;
        row.appendChild(n);
      }
      return { row, toggle };
    };

    // Full-width muted aside — reasons, caveats, the list of transactions being signed.
    const note = (text, variant) => {
      const n = document.createElement('div');
      n.className = 'claim-preview-note' + (variant ? ` claim-preview-note--${variant}` : '');
      n.textContent = text;
      return n;
    };

    // symbol | amount | USD. Amount and USD start as spinners and are filled in by applyLedger()
    // once pricing resolves — the panel must never wait on a network call to appear.
    const tokenRow = (fallbackLabel, addr, isZero) => {
      const row = document.createElement('div');
      row.className = 'claim-preview-token-row';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'claim-token-toggle';
      toggle.checked = !isZero; // unchecked if $0, checked otherwise
      toggle.dataset.tokenAddr = String(addr).toLowerCase();
      const sym = document.createElement('span');
      sym.className = 'claim-preview-token-symbol';
      const symIcon = document.createElement('img');
      symIcon.className = 'claim-preview-token-icon';
      symIcon.alt = '';
      symIcon.hidden = true;
      symIcon.addEventListener('error', () => symIcon.remove(), { once: true });
      const symText = document.createElement('span');
      symText.textContent = fallbackLabel;
      sym.append(symIcon, symText);
      const amount = document.createElement('span');
      amount.className = 'claim-preview-token-amount';
      amount.appendChild(spinnerNode(11));
      const usdEl = document.createElement('span');
      usdEl.className = 'claim-preview-token-usd';
      usdEl.appendChild(spinnerNode(11));
      row.append(toggle, sym, amount, usdEl);
      return { row, toggle, sym, symIcon, symText, amount, usd: usdEl };
    };

    // One line of the reconciliation ledger: label (with optional second line) on the left, a
    // single value on the right that is either money or an honest reason it isn't available.
    const ledgerRow = (labelText, variant) => {
      const row = document.createElement('div');
      row.className = 'claim-preview-ledger-row' + (variant ? ` claim-preview-ledger-row--${variant}` : '');
      const label = document.createElement('span');
      label.className = 'claim-preview-ledger-label';
      const name = document.createElement('span');
      name.textContent = labelText;
      const sub = document.createElement('span');
      sub.className = 'claim-preview-ledger-sub';
      sub.hidden = true;
      label.append(name, sub);
      const value = document.createElement('span');
      value.className = 'claim-preview-ledger-value';
      value.appendChild(spinnerNode(11));
      row.append(label, value);
      return { row, name, sub, value };
    };

    // Money is sensitive (privacy toggle must mask it, exactly like every other amount in this
    // app); a reason string is status text and deliberately is NOT — masking "not quoted" would
    // hide the explanation rather than a number. Mirrors setSensitiveText()'s own convention.
    const setMoney = (el, text) => fadeInSwap(el, () => {
      el.classList.remove('claim-preview-value-na');
      setSensitiveText(el, text); // replaces the spinner and registers the element with the privacy toggle
    });
    const setReason = (el, text) => fadeInSwap(el, () => {
      el.classList.add('claim-preview-value-na');
      delete el.dataset.real; // so applyPrivacyMode() stops treating this cell as a maskable amount
      el.textContent = text;
    });
    const signedUsd = (n) => `${n < 0 ? '-' : '+'}${usd(Math.abs(n))}`;

    // When the wallet supports EIP-5792 atomic batching (see walletAtomicCapability(), checked
    // by the caller before this panel is shown), claim + every swap leg are sent as ONE signed
    // transaction — a wallet's own pre-sign simulation (e.g. Rabby) will show that batch's net
    // effect (claimed tokens in, USDC out) rather than each call simulated separately. Reflected
    // here so the user knows what to expect before signing, not just after.
    const isAtomicClaimSwap = isAtomicCapable(preview.atomicClaimSwap) && (preview.swapSteps?.length ?? 0) > 0;

    const claimTxs = Array.isArray(preview.claimTxs) ? preview.claimTxs : [];
    const swapSteps = Array.isArray(preview.swapSteps) ? preview.swapSteps : [];
    const skippedList = Array.isArray(preview.skipped) ? preview.skipped : [];
    const unresolvedList = Array.isArray(preview.unresolved) ? preview.unresolved : [];
    const claimedEntries = [...claimTokenTotals(preview).keys()];

    // The Claim section used to list nothing but the raw transaction labels ("claimFees",
    // "claimBribes"), which says nothing about what is actually being collected. The tokens are
    // the substance; the transactions are still shown (the user signs each one) but as a
    // footnote to them rather than as the whole section.
    section(isAtomicClaimSwap
      ? 'Claim + consolidate to USDC'
      : 'Claim');

    // Track sections for cascading fade-in after panel is shown
    const cascadeSections = [];

    const tokenList = document.createElement('div');
    tokenList.className = 'claim-preview-token-list';
    const tokenRows = new Map(); // lowercase address -> row handles, filled in by applyLedger()
    const tokenMetadata = new Map(); // lowercase address -> { usd: number, amount: bigint }
    const selectedTokens = new Set(claimedEntries.map(a => String(a).toLowerCase())); // track selection
    // Both default on (the existing behavior). Unchecking bridgeEnabled also forces
    // curveSwapEnabled off — there's nothing on mainnet to swap if nothing was bridged there.
    let bridgeEnabled = true;
    let curveSwapEnabled = true;
    for (const addr of claimedEntries) {
      const r = tokenRow(short(addr), addr, false); // isZero determined later after pricing
      tokenRows.set(String(addr).toLowerCase(), r);
      r.toggle.addEventListener('change', () => {
        const addrKey = String(addr).toLowerCase();
        if (r.toggle.checked) {
          selectedTokens.add(addrKey);
        } else {
          selectedTokens.delete(addrKey);
        }
        // Verbose, not milestone: a user comparing options can flip these a dozen times, and the
        // set that actually matters is logged once at 'execution start'. Useful here only when
        // the question is specifically "did my click register / did the ledger re-price?".
        uiTrace('claim-panel', 'token toggled', { token: short(addr), on: r.toggle.checked, selected: selectedTokens.size });
        rebuildClaimPreviewForSelection();
      });
      tokenList.appendChild(r.row);
    }
    body.appendChild(tokenList);
    if (!claimedEntries.length) body.appendChild(note('no reward tokens found in this claim'));

    const claimedTotal = ledgerRow('Total claimed', 'total');
    body.appendChild(claimedTotal.row);
    cascadeSections.push(tokenList);

    // Cross-check against the figure the Aerodrome portfolio card is showing right now. These
    // are two independent reductions of the same on-chain rewards, so they SHOULD agree; a
    // disagreement is real signal (something claimable is being counted on one side and not the
    // other) and is surfaced rather than smoothed over. Some drift is expected and tolerated —
    // the card was priced at refresh time and this panel re-prices at preview time.
    const cardNote = note('');
    cardNote.hidden = true;
    body.appendChild(cardNote);


    const swapLabels = new Map(); // lowercase address -> the <span> holding that swap row's path text
    const skipLabels = new Map();
    const unresolvedLabels = new Map();
    let consolidateSection = null; // will hold the section header and rows container
    let consolidateRowsContainer = null;
    if (swapSteps.length || skippedList.length) {
      consolidateSection = document.createElement('div');
      consolidateRowsContainer = document.createElement('div');
      body.appendChild(consolidateSection);
      body.appendChild(consolidateRowsContainer);
      cascadeSections.push(consolidateSection, consolidateRowsContainer);
    }

    const bridgeSection = document.createElement('div');
    const bridgeSectionLabel = document.createElement('div');
    bridgeSectionLabel.className = 'claim-preview-section-label';
    bridgeSectionLabel.textContent = 'Bridge to Ethereum mainnet → crvUSD';
    bridgeSection.appendChild(bridgeSectionLabel);
    body.appendChild(bridgeSection);
    cascadeSections.push(bridgeSection);

    // A container (not a bare append) so renderBridgeRowsWith() can be called again —
    // retryUnresolvedRow() does exactly that after a row-level Retry changes how much USDC
    // there is to bridge, and rebuildClaimPreviewForSelection() does it on every token/leg
    // toggle — clear+rebuild just these rows in place, the same reason the reconciliation
    // ledger below reads live from `preview` via applyLedger() rather than being fixed at
    // panel-build time.
    const bridgeRows = document.createElement('div');
    body.appendChild(bridgeRows);
    // Shared by the initial render and every rebuild (selection changes, retries) so the two
    // optional-leg checkboxes (bridge, then crvUSD swap) and their gating logic — unchecking
    // bridge forces the crvUSD leg off too, since nothing reaches mainnet to swap — live in one
    // place. `usdcAmount`/`curveAmount` let callers pass either the full preview totals (initial
    // render) or the selection-filtered totals (rebuildClaimPreviewForSelection). Returns the
    // bridge step row so the caller can apply highlight animations.
    function renderBridgeRowsWith(usdcAmount, curveAmount, curveKnown) {
      bridgeRows.innerHTML = '';
      const bridgeStep = stepToggle(
        `${formatUnits(usdcAmount, 6, 2)} USDC (estimated) via Across`,
        null,
        bridgeEnabled,
        (checked) => {
          bridgeEnabled = checked;
          if (!checked) curveSwapEnabled = false;
          // Logged together because disabling the bridge force-disables the crvUSD swap — seeing
          // only "bridge off" would leave the second state change looking like it came from
          // nowhere.
          uiTrace('claim-panel', 'bridge toggled', { bridge: bridgeEnabled, crvUsdSwap: curveSwapEnabled });
          rebuildClaimPreviewForSelection();
        }
      );
      const acrossBadge = document.createElement('img');
      acrossBadge.className = 'claim-preview-across-badge';
      acrossBadge.src = ICONS.across;
      acrossBadge.alt = 'Across Protocol';
      acrossBadge.title = 'Bridged via Across Protocol';
      bridgeStep.row.insertBefore(acrossBadge, bridgeStep.row.children[1]);
      bridgeRows.appendChild(bridgeStep.row);

      if (!bridgeEnabled) {
        bridgeRows.appendChild(step('USDC stays on Base — bridging disabled', ''));
        return bridgeStep.row;
      }

      if (curveKnown && curveAmount > 0n) {
        const curveText = curveSwapEnabled
          ? `≈ ${formatUnits(curveAmount, 18, 2)} crvUSD delivered on Ethereum mainnet`
          : `${formatUnits(usdcAmount, 6, 2)} USDC delivered on Ethereum mainnet`;
        const curveNoteText = curveSwapEnabled ? 'via Curve crvUSD/USDC pool' : 'Curve swap skipped';
        bridgeRows.appendChild(stepToggle(curveText, curveNoteText, curveSwapEnabled, (checked) => {
          curveSwapEnabled = checked;
          uiTrace('claim-panel', 'crvUSD swap toggled', { crvUsdSwap: curveSwapEnabled });
          rebuildClaimPreviewForSelection();
        }).row);
      } else if (usdcAmount > 0n) {
        const curveText = curveSwapEnabled
          ? 'bridge quote unavailable — will be re-quoted at send time'
          : `${formatUnits(usdcAmount, 6, 2)} USDC delivered on Ethereum mainnet`;
        const curveNoteText = curveSwapEnabled ? '' : 'Curve swap skipped';
        bridgeRows.appendChild(stepToggle(curveText, curveNoteText, curveSwapEnabled, (checked) => {
          curveSwapEnabled = checked;
          uiTrace('claim-panel', 'crvUSD swap toggled', { crvUsdSwap: curveSwapEnabled });
          rebuildClaimPreviewForSelection();
        }).row);
      } else {
        bridgeRows.appendChild(step('nothing to bridge', ''));
      }
      return bridgeStep.row;
    }
    function renderBridgeRows() {
      renderBridgeRowsWith(preview.estimatedUsdc, preview.curveQuote ?? 0n, preview.curveQuote != null);
    }
    renderBridgeRows();

    // Rebuild consolidate section for selected tokens only
    const rebuildConsolidateSection = () => {
      if (!consolidateRowsContainer) return;
      consolidateRowsContainer.innerHTML = '';

      const selectedSwaps = swapSteps.filter(s => selectedTokens.has(String(s.token).toLowerCase()));
      consolidateSection.innerHTML = '';
      consolidateSection.appendChild(document.createTextNode(isAtomicClaimSwap
        ? 'Consolidate to USDC on Base (batched with claim above)'
        : `Consolidate to USDC on Base (${selectedSwaps.length} swap${selectedSwaps.length === 1 ? '' : 's'})`));
      consolidateSection.className = 'claim-preview-section-label';

      for (const s of selectedSwaps) {
        const row = document.createElement('div');
        row.className = 'claim-preview-step';
        const textSpan = document.createElement('span');
        textSpan.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
        const tokenRow = tokenRows.get(String(s.token).toLowerCase());
        const img = document.createElement('img');
        img.className = 'claim-preview-token-icon';
        img.alt = '';
        img.hidden = true;
        img.addEventListener('error', () => img.remove(), { once: true });
        textSpan.appendChild(img);
        applyTokenIcon(img, s.token);
        const symSpan = document.createElement('span');
        symSpan.style.fontWeight = '600';
        symSpan.textContent = tokenRow?.symText?.textContent || short(s.token);
        textSpan.appendChild(symSpan);
        const pathStr = s.legs.length > 1
          ? ` ${formatUnits(s.amount, s.decimals ?? 18, 4)} → ${s.legs.map((leg) => short(leg.tokenOut)).join(' → ')}`
          : ` ${formatUnits(s.amount, s.decimals ?? 18, 4)} → USDC`;
        textSpan.appendChild(document.createTextNode(pathStr));
        row.appendChild(textSpan);
        const noteEl = document.createElement('span');
        noteEl.className = 'claim-preview-step-note';
        noteEl.textContent = `min out ${formatUnits(s.legs[s.legs.length - 1].minOut, 6, 2)} USDC`;
        row.appendChild(noteEl);
        swapLabels.set(String(s.token).toLowerCase(), symSpan);
        consolidateRowsContainer.appendChild(row);
      }
    };

    // The priced ledger from priceClaimPreview(), captured by applyLedger() below. Every USD
    // figure in the "Where the value goes" section that isn't a plain sum of the selected tokens
    // — the swap impact, the Across fee, the Curve delta — is computed THERE, not on `preview`.
    // updateLedgerForSelection() used to read them off `preview` (preview.swapImpactUsd etc.),
    // which never had those properties at all: buildAerodromeClaimPreview() returns
    // { plan, claimTxs, swapSteps, skipped, unresolved, directUsdc, estimatedUsdc, acrossQuote,
    // curveQuote, pricedTokens } and nothing else. Each read was `undefined`, each `|| 0` turned
    // that into a hard zero, and all three rows displayed +$0.00 no matter what the real quotes
    // said — visible even when the Across row's own sub-line was correctly showing a 0.35 USDC
    // fee right underneath the $0.00. It also made "Delivered" identical to "Claimed" (claimed
    // − 0 − 0 + 0) and "Difference from claimed" a permanent +$0.00 (+0.0%).
    // Null until pricing resolves — the rows below say "not quoted" in that window rather than
    // showing a zero that would read as "this leg is free".
    let baseLedger = null;

    // Update reconciliation ledger based on selected tokens — also highlights the bridge row
    // and delivered row with pulse animations so changes are visually prominent.
    const updateLedgerForSelection = (selectedUsdcOut, selectedCurveOut, bridgeStepRow) => {
      let selectedClaimedUsd = 0;
      for (const [addr, meta] of tokenMetadata) {
        if (selectedTokens.has(addr)) {
          selectedClaimedUsd += meta.usd || 0;
        }
      }

      // Update claimed line
      setMoney(recon.claimed.value, selectedClaimedUsd > 0 ? usd(selectedClaimedUsd) : '$0.00');

      // Update skipped line. Two DIFFERENT things end up here, and both belong: tokens the user
      // unchecked (claimable, but deliberately left behind), and tokens that are checked but have
      // no usable swap route (claimed to the wallet on Base, never consolidated — applyLedger()
      // renders these from led.skippedRows). This function runs on every selection change and so
      // writes the row last; accounting for only the unchecked half here would silently erase the
      // unroutable half that applyLedger() had just put there.
      // Deliberately no $ figure on this row (see the hidden `value` cell below) — "skipped"
      // covers two things with different meanings (a deliberate opt-out vs. a route that doesn't
      // exist), summing their USD into one number reads as a single coherent cost when it isn't
      // one, and it invited exactly the kind of "why is this $0.00" confusion this row now avoids
      // entirely by only ever naming WHICH tokens and WHY, never a dollar amount.
      const unchecked = [];
      for (const [addr] of tokenMetadata) {
        if (selectedTokens.has(addr)) continue;
        const row = tokenRows.get(addr);
        if (row?.symText.textContent) unchecked.push(row.symText.textContent);
      }
      const unroutable = (baseLedger?.skippedRows || []).filter((r) => selectedTokens.has(String(r.addr).toLowerCase()));

      if (unchecked.length || unroutable.length) {
        recon.skipped.row.hidden = false;
        recon.skipped.value.hidden = true;
        const parts = [];
        if (unchecked.length) parts.push(`${unchecked.join(', ')} — unchecked above`);
        if (unroutable.length) parts.push(`${unroutable.map((r) => r.symbol).join(', ')} — claimed to your wallet on Base, never swapped or bridged`);
        recon.skipped.sub.hidden = false;
        recon.skipped.sub.textContent = parts.join('; ');
      } else {
        recon.skipped.row.hidden = true;
      }

      // Calculate ledger values based on selection
      let selectedImpactUsd = 0;
      let selectedBridgeFeeUsd = 0;
      let selectedCurveDeltaUsd = 0;
      let selectedDeliveredUsd = selectedClaimedUsd;

      // Update impact (swap fee difference, proportional to USDC)
      const selectedSwaps = swapSteps.filter(s => selectedTokens.has(String(s.token).toLowerCase()));
      if (selectedSwaps.length === 0) {
        recon.impact.row.hidden = true;
      } else if (preview.estimatedUsdc > 0n && selectedUsdcOut > 0n && baseLedger?.swapImpactUsd != null) {
        const impactRatio = Number(selectedUsdcOut) / Number(preview.estimatedUsdc);
        selectedImpactUsd = baseLedger.swapImpactUsd * impactRatio;
        recon.impact.row.hidden = false;
        setMoney(recon.impact.value, signedUsd(selectedImpactUsd));
      } else if (selectedSwaps.length > 0) {
        recon.impact.row.hidden = false;
        setReason(recon.impact.value, 'not quoted — re-quoted at send time');
      }

      // Update bridge fee (proportional to USDC) — or, if the user opted out of bridging
      // entirely, the row just names that instead of a fee (there's nothing to charge).
      // Always update to ensure the row reflects the current state rather than stale values.
      if (!bridgeEnabled) {
        setReason(recon.bridge.value, 'skipped — USDC stays on Base');
        recon.bridge.sub.hidden = true;
      } else if (selectedUsdcOut <= 0n) {
        setReason(recon.bridge.value, 'nothing to bridge');
      } else if (preview.acrossQuote && preview.estimatedUsdc > 0n && baseLedger?.bridgeFeeUsd != null) {
        const bridgeRatio = Number(selectedUsdcOut) / Number(preview.estimatedUsdc);
        selectedBridgeFeeUsd = baseLedger.bridgeFeeUsd * bridgeRatio;
        setMoney(recon.bridge.value, signedUsd(-selectedBridgeFeeUsd));
      } else {
        setReason(recon.bridge.value, 'not quoted — re-quoted at send time');
      }

      // The Curve leg only exists at all if something was bridged to mainnet first — hide it
      // entirely rather than show a meaningless "skipped" reason when bridging itself is off.
      recon.curve.row.hidden = !bridgeEnabled;
      if (bridgeEnabled) {
        if (!curveSwapEnabled) {
          setReason(recon.curve.value, 'skipped — USDC delivered on mainnet');
        } else if (preview.curveQuote != null && selectedCurveOut > 0n && preview.curveQuote > 0n && baseLedger?.curveDeltaUsd != null) {
          const curveRatio = Number(selectedCurveOut) / Number(preview.curveQuote);
          selectedCurveDeltaUsd = baseLedger.curveDeltaUsd * curveRatio;
          setMoney(recon.curve.value, signedUsd(selectedCurveDeltaUsd));
        } else if (selectedCurveOut > 0n) {
          setReason(recon.curve.value, 'not quoted');
        } else {
          setReason(recon.curve.value, 'nothing to convert');
        }
      }

      // Calculate delivered: claimed + impact - bridge (if any) + curve (only if both the
      // bridge AND the crvUSD swap actually happen — otherwise the delivered figure is exactly
      // what was consolidated on Base, or exactly the bridged USDC, with no Curve delta to add).
      //
      // Sign conventions, which differ per term and must be matched exactly (see
      // priceClaimPreview): swapImpactUsd is a SIGNED delta (quotedUsdcOutUsd − consolidatedInUsd,
      // so negative whenever the swap loses value, which is the normal case) and is therefore
      // ADDED; curveDeltaUsd is likewise a signed delta and is added; bridgeFeeUsd alone is a
      // positive MAGNITUDE and is the only term subtracted. This line previously subtracted the
      // impact, which is inverted — harmless only because selectedImpactUsd was hardcoded to zero
      // by the `preview.swapImpactUsd` bug above, so `- 0` and `+ 0` were indistinguishable. With
      // real numbers flowing it would have moved delivered UP by the size of the swap loss
      // (≈ $3,405 → ≈ $4,819 on the account this was found with, instead of ≈ $1,985).
      const curveApplies = bridgeEnabled && curveSwapEnabled;
      selectedDeliveredUsd = selectedClaimedUsd + selectedImpactUsd
        - (bridgeEnabled ? selectedBridgeFeeUsd : 0)
        + (curveApplies ? selectedCurveDeltaUsd : 0);

      recon.delivered.name.textContent = bridgeEnabled ? 'Delivered on mainnet' : 'Delivered on Base';
      if (!bridgeEnabled) {
        recon.delivered.sub.hidden = true;
      } else if (curveApplies && selectedCurveOut > 0n) {
        recon.delivered.sub.hidden = false;
        recon.delivered.sub.textContent = `${formatUnits(selectedCurveOut, 18, 4)} crvUSD`;
      } else if (!curveSwapEnabled && selectedUsdcOut > 0n) {
        recon.delivered.sub.hidden = false;
        recon.delivered.sub.textContent = `${formatUnits(selectedUsdcOut, 6, 2)} USDC`;
      } else {
        recon.delivered.sub.hidden = true;
      }

      // Update delivered (final amount, whatever currency it ends up in) — highlight the row
      // with a pulse animation so the user's eye catches the result of their bridge/curve toggle
      if (selectedUsdcOut > 0n) {
        setMoney(recon.delivered.value, usd(Math.max(0, selectedDeliveredUsd)));
      } else {
        setReason(recon.delivered.value, 'no selection');
      }
      recon.delivered.row.classList.remove('claim-preview-ledger-row--delivered-pulse');
      void recon.delivered.row.offsetHeight; // force reflow to restart animation
      recon.delivered.row.classList.add('claim-preview-ledger-row--delivered-pulse');

      // Also highlight the bridge row (via Across line) when it changes
      if (bridgeStepRow) {
        bridgeStepRow.classList.remove('claim-preview-ledger-row--delivered-pulse');
        void bridgeStepRow.offsetHeight; // force reflow to restart animation
        bridgeStepRow.classList.add('claim-preview-ledger-row--delivered-pulse');
      }

      // Update net difference: delivered - claimed
      if (selectedClaimedUsd > 0) {
        const netUsd = selectedDeliveredUsd - selectedClaimedUsd;
        const netPct = (netUsd / selectedClaimedUsd) * 100;
        setMoney(recon.net.value, `${signedUsd(netUsd)} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(1)}%)`);
        recon.net.row.classList.remove('claim-preview-ledger-row--down', 'claim-preview-ledger-row--up');
        recon.net.row.classList.add(netUsd < 0 ? 'claim-preview-ledger-row--down' : 'claim-preview-ledger-row--up');
      } else {
        setReason(recon.net.value, 'no selection');
      }
    };

    // Recalculate totals and display based on selected tokens
    const rebuildClaimPreviewForSelection = () => {
      let selectedTotal = 0;
      let selectedUsdcOut = 0n;
      let selectedCurveOut = 0n;

      // Sum selected tokens' USD values and USDC swap outputs. `quotedUsdcOut` (the whole step's
      // quoted output), NOT the final leg's `minOut` (a slippage floor) — every ratio below
      // divides this by preview.estimatedUsdc, which is itself built from quotedUsdcOut, so
      // mixing the two would compare a floor against a quote and understate every fee.
      for (const [addr, meta] of tokenMetadata) {
        if (selectedTokens.has(addr)) {
          selectedTotal += meta.usd || 0;
          for (const s of swapSteps) {
            if (String(s.token).toLowerCase() === addr) {
              selectedUsdcOut += s.quotedUsdcOut || 0n;
            }
          }
        }
      }
      // USDC claimed directly as a reward token has no swap step to find above, but it IS part of
      // preview.estimatedUsdc (see buildAerodromeClaimPreview: estimatedUsdc reduces the swap
      // steps ONTO directUsdc as the seed). Leaving it out of the numerator while it sits in the
      // denominator understates every proportional fee below — badly, since USDC is often the
      // single largest claimable line ($1,419 of $3,404 on the account this was found with).
      if (selectedTokens.has(AERODROME_CLAIM.usdc.toLowerCase())) selectedUsdcOut += preview.directUsdc || 0n;

      // Calculate proportional Curve output
      if (preview.curveQuote != null && preview.estimatedUsdc > 0n && selectedUsdcOut > 0n) {
        selectedCurveOut = (preview.curveQuote * selectedUsdcOut) / preview.estimatedUsdc;
      }

      // Update total claimed display
      claimedTotal.value.textContent = selectedTotal > 0 ? usd(selectedTotal) : '$0.00';

      // Rebuild consolidate section
      rebuildConsolidateSection();

      // Update transactions list count
      rebuildTransactionsList();

      // Update bridge/Curve rows based on selected USDC (and the bridge/curve toggle state)
      const bridgeStepRow = renderBridgeRowsWith(selectedUsdcOut, selectedCurveOut, preview.curveQuote != null);

      // Update reconciliation ledger (and highlight both bridge and delivered rows)
      updateLedgerForSelection(selectedUsdcOut, selectedCurveOut, bridgeStepRow);
    };

    // Build consolidate section initially
    if (consolidateRowsContainer) rebuildConsolidateSection();

    /* ---------- reconciliation: claimed value -> delivered crvUSD ---------- */

    // The dollar figure on the Aerodrome card is the SPOT value of the reward tokens sitting in
    // the fee/bribe contracts. What actually lands on mainnet is crvUSD, several conversions
    // later, and it is materially less. Every one of those conversions is legitimate and
    // individually small-sounding, which is exactly why the difference is confusing without
    // this ledger: the panel now names each one and attributes a dollar amount to it, so the
    // total gap is accounted for line by line rather than left as an unexplained shortfall.
    const reconSection = document.createElement('div');
    const reconSectionLabel = document.createElement('div');
    reconSectionLabel.className = 'claim-preview-section-label';
    reconSectionLabel.textContent = 'Where the value goes';
    reconSection.appendChild(reconSectionLabel);
    body.appendChild(reconSection);
    cascadeSections.push(reconSection);

    const recon = {
      claimed: ledgerRow('Claimed on Base'),
      skipped: ledgerRow('Skipped — not consolidated'),
      impact: ledgerRow('Swap price impact & pool fees'),
      bridge: ledgerRow('Across bridge fee'),
      curve: ledgerRow('Curve USDC → crvUSD'),
      delivered: ledgerRow('Delivered on mainnet', 'total'),
      net: ledgerRow('Difference from claimed', 'net'),
    };
    recon.skipped.row.hidden = true; // shown only when something actually was skipped
    for (const key of ['claimed', 'skipped', 'impact', 'bridge', 'curve', 'delivered', 'net']) {
      body.appendChild(recon[key].row);
    }
    const reconNote = note('');
    reconNote.hidden = true;
    body.appendChild(reconNote);

    /* ---------- async pricing ---------- */

    // The panel is already fully built and interactive at this point. Pricing is a network call,
    // so it fills the value cells in afterwards (spinner -> value, the app's existing idiom) and
    // can never delay the panel appearing, nor block Confirm/Cancel if it fails.
    let closed = false;

    /* ---------- numbered transaction list ---------- */

    // Shown as part of the review, not only after Confirm — the user should see exactly what's
    // about to execute, numbered, before they ever sign anything, not have it appear as a second
    // view once they've already committed. Every row starts 'pending' (buildExecutionStepRow()'s
    // own default); enterExecutionView() below reuses these same row objects to flip their status
    // live rather than rebuilding the list, so what was reviewed and what is executing are
    // literally the same DOM, not two renders that could drift apart.
    //
    // Rows aren't appended until their token symbols have resolved (or there's nothing to
    // resolve) — the first thing the user sees is real names, not addresses that visibly rewrite
    // themselves a moment later — then reveal in a quick top-to-bottom cascade rather than every
    // row appearing in one flat instant (see expandExecStepRow()).
    const stepsLabel = document.createElement('div');
    stepsLabel.className = 'claim-preview-section-label';
    stepsLabel.textContent = 'Transactions';
    stepsCol.appendChild(stepsLabel);
    const CASCADE_STEP_DELAY_MS = 45;
    let stepRows = [];
    // Guards against a race between this initial cascade and rebuildClaimPreviewForSelection()
    // (called moments later, once pricing/applyLedger() resolves and may auto-uncheck $0 tokens):
    // any rebuildTransactionsList() call that lands before the cascade itself has painted is a
    // no-op (nothing to diff against yet) rather than racing it to populate stepsCol twice. Once
    // the cascade DOES land it reads `selectedTokens` fresh (via aerodromeExecutionLabelsForSelection()
    // below), so it always reflects whatever selection state exists by then — no stale unfiltered
    // list is ever left on screen even if a rebuild was skipped while the cascade was in flight.
    let initialRevealDone = false;

    function symbolsFor(rows) {
      return [...new Set(rows.flatMap((r) => r.tokenNodes.map((t) => t.addr.toLowerCase())))];
    }
    function applySymbols(rows, priced) {
      for (const r of rows) {
        for (const { addr, nameSpan } of r.tokenNodes) {
          const sym = priced[addr.toLowerCase()]?.symbol;
          if (sym) nameSpan.textContent = sym;
        }
      }
    }

    // Builds the same { parts: [TXT(...), TOK(...), ...] } structure aerodromeExecutionLabels()
    // produces, but filtered to only the currently-selected tokens — buildExecutionStepRow()
    // requires this exact shape (plain strings throw inside its `for (const part of label.parts)`
    // loop, since a string has no `.parts`).
    function aerodromeExecutionLabelsForSelection() {
      const labels = [];
      const isAtomic = isAtomicCapable(preview.atomicClaimSwap) && selectedSwapsFor(preview).length;
      if (isAtomic) {
        labels.push({ parts: [TXT('Claim + consolidate to USDC (1 batched transaction)')] });
      } else {
        for (const tx of claimTxs) labels.push({ parts: [TXT(tx.label || 'claim')] });
        // Plain array order — preview.swapSteps is already sorted largest-value-first at build
        // time (see buildAerodromeClaimPreview). Deliberately NOT re-sorted here: these labels
        // are mapped onto execution progress positionally, so they must walk the same array in
        // the same order executeAerodromeClaim() does.
        for (const s of selectedSwapsFor(preview)) {
          for (const leg of s.legs) {
            labels.push({ parts: [TXT('Approve '), TOK(leg.tokenIn)] });
            labels.push({ parts: [TXT('Swap '), TOK(leg.tokenIn), TXT(' → '), TOK(leg.tokenOut)] });
          }
        }
      }
      if (bridgeEnabled && selectedTokens.size > 0 && selectedSwapsFor(preview).length) {
        labels.push({ parts: [TXT('Approve '), TOK(AERODROME_CLAIM.usdc), TXT(' → Across bridge')] });
        labels.push({ parts: [TXT(curveSwapEnabled ? 'Bridge to Ethereum mainnet + swap to crvUSD' : 'Bridge to Ethereum mainnet (USDC)')] });
      }
      return labels;
    }
    function selectedSwapsFor() {
      return swapSteps.filter(s => selectedTokens.has(String(s.token).toLowerCase()));
    }

    const revealInitialStepRows = (labels, priced) => {
      if (closed) return;
      initialRevealDone = true;
      stepRows = labels.map((label, i) => buildExecutionStepRow(i + 1, label));
      applySymbols(stepRows, priced);
      stepsLabel.textContent = `Transactions (${stepRows.length})`;
      stepRows.forEach((r, i) => {
        stepsCol.appendChild(r.row);
        expandExecStepRow(r.row, i * CASCADE_STEP_DELAY_MS);
      });
    };
    {
      // aerodromeExecutionLabelsForSelection(), not the raw unfiltered aerodromeExecutionLabels()
      // — selectedTokens starts with every claimed token selected, so before applyLedger() has
      // had a chance to auto-uncheck any $0 token these two calls return the same thing; reading
      // selectedTokens live (rather than baking in the unfiltered set) is what keeps this correct
      // if that auto-uncheck happens to land before this cascade's own pricing lookup resolves.
      const initialLabels = aerodromeExecutionLabelsForSelection();
      const addrs = symbolsFor(initialLabels.map((label) => ({ tokenNodes: label.parts.filter((p) => p.t === 'token').map((p) => ({ addr: p.addr })) })));
      if (addrs.length) {
        priceTokensUsd(addrs, AERODROME.priceChain)
          .then((priced) => revealInitialStepRows(aerodromeExecutionLabelsForSelection(), priced))
          .catch((err) => {
            logErr('token symbol lookup for execution list failed', err);
            revealInitialStepRows(aerodromeExecutionLabelsForSelection(), {});
          });
      } else {
        revealInitialStepRows(initialLabels, {});
      }
    }

    // Diffs the current stepRows against the labels the new selection produces, by content key
    // (execStepLabelKey()) rather than position — a row whose transaction is still happening,
    // just at a different index, is REUSED (renumbered in place via setNumber(), DOM untouched);
    // only rows whose transaction actually dropped out of or entered the selection are removed or
    // inserted. This is what lets removal/addition animate as a single row growing/shrinking
    // (expandExecStepRow()/collapseAndRemoveExecStepRow()) with the rest of the list reflowing
    // smoothly around it through ordinary layout, instead of a full list rebuild that has nothing
    // to animate at all (old DOM gone, new DOM appears already at its final size).
    const rebuildTransactionsList = () => {
      if (!initialRevealDone) return; // cascade hasn't landed yet — it'll read selectedTokens fresh itself
      const labels = aerodromeExecutionLabelsForSelection();
      const nextKeys = labels.map(execStepLabelKey);
      const byKey = new Map(stepRows.map((r) => [r.key, r]));

      const nextRows = [];
      const newlyAdded = [];
      nextKeys.forEach((key, i) => {
        let r = byKey.get(key);
        if (r) {
          byKey.delete(key); // consumed — anything left in byKey after this loop is being removed
        } else {
          r = buildExecutionStepRow(i + 1, labels[i]);
          newlyAdded.push(r);
        }
        r.setNumber(i + 1);
        nextRows.push(r);
      });

      // Anything still in byKey wasn't matched by any next-label key — its transaction dropped
      // out of the current selection, so its row animates away and is removed.
      for (const leaving of byKey.values()) collapseAndRemoveExecStepRow(leaving.row);

      // Re-insert nextRows into stepsCol in the new order, but ONLY move rows that actually
      // changed position. Multiple appendChild() calls trigger multiple reflows, which can cause
      // visual glitches when rows are simultaneously animating away (shrinking). Instead, find
      // the first DOM position that's wrong and insertBefore from there — rows above the change
      // never move, and only the changed rows (+ what follows) shift, avoiding artifacts.
      // Reconcile from the END, inserting each row before the row that should follow it, and
      // only when it isn't already sitting there. Rows already in the right relative position
      // are never touched, so the no-op case still causes no reflow.
      //
      // The previous version captured a SINGLE fixed `anchor` (the existing child at the first
      // wrong index) and inserted every subsequent row before it. That anchor is itself almost
      // always one of the rows being repositioned, and inserting a node before itself is a
      // no-op — so the anchor stayed put while every row after it was inserted ahead of it,
      // leaving it dangling at the end. Live symptom: the numbered list read 1,2,3,4,5,7,8,9,10
      // with "6 Swap cbBTC → USDC" rendered last, below the bridge step. It also compared
      // against stepsCol.children directly, which still contains rows mid-collapse on their way
      // out, so every index after a leaving row was off by one.
      let ref = null;
      for (let i = nextRows.length - 1; i >= 0; i--) {
        const row = nextRows[i].row;
        if (row.parentNode !== stepsCol || row.nextSibling !== ref) {
          stepsCol.insertBefore(row, ref);
        }
        ref = row;
      }
      for (const r of newlyAdded) expandExecStepRow(r.row);

      stepRows = nextRows;
      stepsLabel.textContent = `Transactions (${stepRows.length})`;

      // Re-price symbols for any newly-added row's tokens (existing rows already have theirs).
      const newAddrs = symbolsFor(newlyAdded);
      if (newAddrs.length) {
        priceTokensUsd(newAddrs, AERODROME.priceChain).then((priced) => {
          if (closed) return;
          applySymbols(newlyAdded, priced);
        }).catch((err) => logErr('token symbol lookup for execution list failed', err));
      }
    };

    // Always the token's OWN decimals — never an assumed 18. A sub-unit balance gets the full
    // precision its decimals allow (capped at 8), which is what stops a real 0.00593863 cbBTC
    // position from being displayed as "0.0000"; anything at or above one whole unit reads
    // better at this app's usual 4 places.
    const amountText = (raw, decimals) => {
      const text = formatUnits(raw, decimals, raw < 10n ** BigInt(decimals) ? Math.min(decimals, 8) : Math.min(decimals, 4));
      // Last line of defence: a genuinely non-zero balance that still renders as all zeros means
      // the decimals we were handed are wrong — priceTokensUsd() falls back to a hardcoded 18
      // when a token's metadata read fails, which is indistinguishable from a real 18-decimal
      // token here. "0.0000" against a live cbBTC position is the precise regression this panel
      // exists to avoid, so fall back to the unambiguous raw base-unit count instead of a zero
      // that reads as "nothing to claim".
      if (raw > 0n && !/[1-9]/.test(text)) return `${raw.toLocaleString('en-US')} base units`;
      return text;
    };

    function applyLedger(led) {
      // Hand the priced figures to updateLedgerForSelection() — see baseLedger's comment. Set
      // FIRST, before anything below can trigger a selection rebuild, so the impact/bridge/curve
      // rows never get computed against a null ledger once real numbers are in hand.
      baseLedger = led;

      // --- claimed tokens ---
      for (const t of led.tokens) {
        const r = tokenRows.get(t.addr);
        if (!r) continue;
        r.symText.textContent = t.symbol;
        applyTokenIcon(r.symIcon, t.addr);
        if (t.decimals == null) setReason(r.amount, 'amount unavailable');
        else setMoney(r.amount, amountText(t.amount, t.decimals));
        if (t.usd == null) setReason(r.usd, 'no price');
        else setMoney(r.usd, usd(t.usd));
        tokenList.appendChild(r.row); // led.tokens is sorted by value, so this reorders largest-first
        // Store metadata for quote recalculation and uncheck $0 tokens
        const addrKey = t.addr.toLowerCase();
        tokenMetadata.set(addrKey, { usd: t.usd || 0, amount: t.amount });
        // Below half a cent rounds to the "$0.00" the row actually displays (see usd()'s 2-decimal
        // rounding) — `<= 0` alone missed dust amounts like $0.00004 that are nonzero in the raw
        // number but read as exactly $0.00 on screen, which is why some $0.00 rows stayed checked.
        if (t.usd == null || t.usd < 0.005) {
          r.toggle.checked = false;
          selectedTokens.delete(addrKey);
        }
      }

      const claimedPartial = led.claimedUnpriced > 0;
      const noTokens = !led.tokens.length;
      if (led.claimedUsd == null) setReason(claimedTotal.value, noTokens ? 'nothing claimable' : 'unavailable');
      else setMoney(claimedTotal.value, `${claimedPartial ? '≥ ' : ''}${usd(led.claimedUsd)}`);
      if (claimedPartial) {
        claimedTotal.sub.hidden = false;
        claimedTotal.sub.textContent = `excludes ${led.claimedUnpriced} token${led.claimedUnpriced === 1 ? '' : 's'} with no listed price`;
      }

      // --- portfolio-card cross-check ---
      // Compared against whatever the on-screen card showed as of the LAST portfolio refresh
      // (cardClaimSnapshot — cheap, no RPC). This plan and that card are two reductions of the
      // same on-chain rewards computed at two different TIMES, so some drift is expected and
      // tolerated; a divergence beyond that is real signal — something claimable is counted on
      // one side and not the other — and is named here (both figures, and which tokens differ).
      // This used to also fetch a second "fresh card" via an entirely independent full-pool scan
      // run in parallel with plan-building, specifically so this comparison wouldn't be fooled by
      // ordinary staleness — but running that scan twice at once doubled this dialog's RPC load
      // and, under that load, made a page far more likely to fail in ONE of the two scans and not
      // the other (that's what caused tokens like DRV/LMTS to show up on only one side despite
      // both reductions supposedly being "fresh"). Removed — see buildAerodromeClaimPreview().
      // Skipped entirely when the portfolio hasn't been refreshed yet.
      const card = cardClaimSnapshot(CLAIM_PREVIEW_PROTOCOL_ID);
      if (card) {
        const planSymbols = new Set(led.tokens.map((t) => t.symbol));
        const onlyOnCard = [...card.symbols].filter((s) => !planSymbols.has(s));
        const onlyInPlan = [...planSymbols].filter((s) => !card.symbols.has(s));
        // Some drift is expected purely from re-pricing between the last refresh and now.
        const totalsComparable = card.claimUsd != null && led.claimedUsd != null && !claimedPartial;
        const drift = totalsComparable ? card.claimUsd - led.claimedUsd : null;
        const tolerance = totalsComparable ? Math.max(1, Math.abs(card.claimUsd) * 0.01) : 0;
        const totalsAgree = totalsComparable && Math.abs(drift) <= tolerance;

        // Only ever shown when there is an actual divergence to report. The former
        // "Matches the Aerodrome card ($X)." confirmation was removed: agreement is the expected
        // state and the panel saying so on every open was diagnostic noise, not information.
        const hasDifference = (drift != null && !totalsAgree) || onlyOnCard.length > 0 || onlyInPlan.length > 0;
        cardNote.hidden = !hasDifference;
        if (hasDifference) {
          const parts = [];
          if (drift != null && !totalsAgree) {
            parts.push(`The Aerodrome card shows ${usd(card.claimUsd)} — ${usd(Math.abs(drift))} ${drift > 0 ? 'more' : 'less'} than this claim.`);
          } else if (card.claimUsd != null) {
            parts.push(`The Aerodrome card shows ${usd(card.claimUsd)}.`);
          }
          if (onlyOnCard.length) parts.push(`On the card but not claimed here: ${onlyOnCard.join(', ')}.`);
          if (onlyInPlan.length) parts.push(`Claimed here but not on the card: ${onlyInPlan.join(', ')}.`);
          cardNote.className = 'claim-preview-note claim-preview-note--warn';
          cardNote.textContent = parts.join(' ');
        }
      }

      // --- feed this plan's fresh numbers back into the on-screen card ---
      // This panel just ran a full-pool scan for this account's Aerodrome rewards; push its
      // results into the cached card immediately rather than waiting for the next portfolio
      // refresh. Correlates the two displays without any further RPC, and means a divergence
      // found here is real (not merely stale).
      //
      // Unlike the earlier gate that used `!claimedPartial` (pricing completeness) — which
      // silently no-op'd whenever any claimed token happened to be unpriced, leaving the card
      // stuck on stale numbers for accounts holding several obscure reward tokens — this now
      // syncs unconditionally whenever a plan is available. Reasoning:
      //
      // * Even a partial scan (some pages failed, others succeeded) has found real tokens and
      //   has fresher timestamps than a card that was last refreshed minutes ago. Blocking the
      //   sync until every page succeeds means accounts with intermittent RPC issues stay stuck
      //   on stale data indefinitely.
      // * `claimedPartial` (displayed as "≥" prefix) already flags pricing gaps. A pricing gap
      //   doesn't mean the on-chain scan was incomplete — it means we found tokens but can't
      //   price them. The '≥' correctly indicates the total is a floor.
      // * The only downside is that a fresh but incomplete scan (page failures + fewer tokens
      //   found than last refresh) could overwrite a stale but complete scan. But that's still
      //   better than silently staying stale forever. And within the 3-minute full-scan cache
      //   window, both card and claim-panel scans use the same cached result anyway, so this
      //   scenario only happens after the cache expires and the network state actually changed.
      if (led.claimedUsd != null) {
        // Sync back into whatever the card currently has — including an 'error' status (the
        // card's own initial fetchVeDex() can fail entirely under RPC rate-limiting even though
        // this panel's own, separately-timed scan succeeds — see buildAerodromeClaimPlan()) or no
        // entry at all (portfolio hasn't finished its first refresh yet). Requiring status==='ok'
        // here meant an account whose card-load hit a 429 storm stayed stuck showing "error" (or
        // stale/incomplete rows) forever, even after this panel proved fresher, complete data was
        // available — the exact "claimables missing from the card, present in the popup" bug.
        // `rows` (the non-claim informational lines, e.g. "AERO locked") is preserved from
        // whatever was already cached, or left empty for a from-scratch entry — this sync only
        // ever owns the claim-related fields, never invents position-summary rows it doesn't have.
        const cached = portfolioResults[CLAIM_PREVIEW_PROTOCOL_ID] || { status: 'ok', rows: [] };
        cached.status = 'ok';
        cached.claimUsd = led.claimedUsd;
        cached.claimSummary = `${claimedPartial ? '≥ ' : ''}${usd(led.claimedUsd)}`;
        cached.claimList = led.tokens.map((t) => ({
          symbol: t.symbol,
          amount: t.decimals != null ? formatUnits(t.amount, t.decimals, 4) : '—',
          usd: t.usd,
        }));
        portfolioResults[CLAIM_PREVIEW_PROTOCOL_ID] = cached;
        const node = protocolNodes[CLAIM_PREVIEW_PROTOCOL_ID];
        if (node) {
          const claimEl = node.summary.querySelector('.protocol-claim');
          if (claimEl) setSensitiveText(claimEl, cached.claimSummary);
          setClaimAvailable(node.summary, cached.claimUsd > 0);
          // The card body was rendered with the old claimList (from the last portfolio refresh) —
          // or with an error note if that refresh failed outright. Now that the claim panel has
          // scanned fresh and found historical tokens, rebuild the card's body via
          // renderProtocolResult so what's on screen matches what was just found.
          renderProtocolResult(node.details, node.summary, node.body, cached);
        }
        renderPortfolioTotal(portfolioResults);
        // The header "alpha" icon strip is derived from claimUsd > 0 per protocol, so it goes
        // stale for exactly the case this sync exists to repair: a card that was showing an
        // error (or nothing) now has a real nonzero total, but its icon stayed missing until the
        // next full refresh. Same snapshot the total above is rendered from.
        renderAlphaIcons(portfolioResults);
      }

      // --- consolidate rows: shortened addresses -> real symbols ---
      // One map over every address we resolved a symbol for, so a multi-hop route's INTERMEDIATE
      // token gets named too when we happen to know it (it's usually WETH or AERO, which are
      // typically also claimed). Anything still unknown keeps its shortened address — honest,
      // rather than labelled with a guess.
      const symbolByShort = new Map();
      for (const t of [...led.tokens, ...led.swapRows, ...led.skippedRows]) {
        if (t.symbol && t.symbol !== short(t.addr)) symbolByShort.set(short(t.addr), t.symbol);
      }
      for (const el of swapLabels.values()) {
        fadeInSwap(el, () => {
          let text = el.textContent;
          for (const [addrShort, symbol] of symbolByShort) text = text.replaceAll(addrShort, symbol);
          el.textContent = text;
        });
      }
      for (const r of led.skippedRows) {
        const el = skipLabels.get(r.addr);
        if (!el) continue;
        const amt = (r.amount != null && r.decimals != null) ? `${amountText(r.amount, r.decimals)} ` : '';
        const usdText = r.usd != null ? ` (${usd(r.usd)})` : '';
        fadeInSwap(el, () => { el.textContent = `${amt}${r.symbol}${usdText}`; });
      }

      // --- ledger ---
      if (led.claimedUsd == null) setReason(recon.claimed.value, noTokens ? 'nothing claimable' : 'prices unavailable');
      else setMoney(recon.claimed.value, `${claimedPartial ? '≥ ' : ''}${usd(led.claimedUsd)}`);

      if (led.skippedRows.length) {
        recon.skipped.row.hidden = false;
        recon.skipped.sub.hidden = false;
        const unpricedNote = led.skippedUnpriced
          ? ` (${led.skippedUnpriced} with no listed price, not included above)`
          : '';
        recon.skipped.sub.textContent = `${led.skippedRows.map((r) => r.symbol).join(', ')} — claimed to your wallet on Base, never swapped or bridged${unpricedNote}`;
        // Deliberately no $ figure here (see updateLedgerForSelection's matching comment) — the
        // value cell stays empty, the sub-text alone names what was skipped and why.
        recon.skipped.value.hidden = true;
      }

      // Nothing was swapped at all (everything claimable was already USDC) — there is no price
      // impact to report, so the line is removed rather than shown as an empty or zero figure.
      if (!led.swapRows.length) {
        recon.impact.row.hidden = true;
      } else if (led.swapImpactUsd == null) {
        setReason(recon.impact.value, led.quotedUsdcOutUsd == null ? 'no swap quote' : 'spot value unavailable');
      } else {
        setMoney(recon.impact.value, signedUsd(led.swapImpactUsd));
        recon.impact.sub.hidden = false;
        recon.impact.sub.textContent = 'quoted USDC out vs. DefiLlama spot value of the tokens swapped';
      }

      if (led.bridgeFeeUsd == null) {
        setReason(recon.bridge.value, preview.acrossQuote ? 'value unavailable' : 'not quoted — re-quoted at send time');
      } else {
        setMoney(recon.bridge.value, signedUsd(-led.bridgeFeeUsd));
        if (led.bridgeFeeRaw != null && led.usdcDecimals != null) {
          recon.bridge.sub.hidden = false;
          recon.bridge.sub.textContent = `${formatUnits(led.bridgeFeeRaw, led.usdcDecimals, 2)} USDC relayer + LP fee`;
        }
      }

      if (led.curveDeltaUsd == null) setReason(recon.curve.value, preview.curveQuote == null ? 'not quoted' : 'value unavailable');
      else setMoney(recon.curve.value, signedUsd(led.curveDeltaUsd));

      if (led.deliveredUsd == null) {
        setReason(recon.delivered.value, 'unavailable until quoted');
      } else {
        setMoney(recon.delivered.value, usd(led.deliveredUsd));
        if (led.deliveredRaw != null && led.deliveredDecimals != null) {
          recon.delivered.sub.hidden = false;
          recon.delivered.sub.textContent = `${formatUnits(led.deliveredRaw, led.deliveredDecimals, 4)} crvUSD`;
        }
      }

      if (led.netUsd == null) {
        setReason(recon.net.value, 'needs a full quote on both sides');
      } else {
        setMoney(recon.net.value, `${signedUsd(led.netUsd)}${led.netPct != null ? ` (${led.netPct >= 0 ? '+' : ''}${led.netPct.toFixed(1)}%)` : ''}`);
        recon.net.row.classList.add(led.netUsd < 0 ? 'claim-preview-ledger-row--down' : 'claim-preview-ledger-row--up');
      }

      // Anything above that couldn't be quoted means the lines don't add up on their own — say
      // so, rather than letting the user assume the ledger is complete when it isn't.
      const gaps = [];
      if (claimedPartial) gaps.push('some claimed tokens have no listed price');
      if (led.swapRows.length && led.swapImpactUsd == null) gaps.push('the swap quote is incomplete');
      if (!preview.acrossQuote) gaps.push('the bridge was not quoted');
      else if (preview.curveQuote == null) gaps.push('the Curve swap was not quoted');
      reconNote.hidden = false;
      reconNote.textContent = gaps.length
        ? `These lines do not fully add up: ${gaps.join('; ')}. Quotes are refreshed against live balances at send time.`
        : 'Quoted now — the bridge leg is re-quoted against your real post-swap USDC balance at send time, so the delivered amount can move slightly.';
    }

    function markPricingUnavailable() {
      for (const c of [claimedTotal, ...Object.values(recon)]) setReason(c.value, 'prices unavailable');
      for (const r of tokenRows.values()) {
        setReason(r.amount, 'unavailable');
        setReason(r.usd, '—');
      }
      reconNote.hidden = false;
      reconNote.textContent = 'Token prices could not be loaded, so the value breakdown is unavailable. The transactions above are unaffected.';
    }

    priceClaimPreview(preview)
      .then((led) => {
        if (closed) return;
        applyLedger(led);
        // applyLedger() just auto-unchecked any $0-value token — every section derived from
        // `selectedTokens` (totals, consolidate list, bridge amount, ledger, transactions) needs
        // to catch up with that change now, not wait for the user to happen to toggle something
        // else first.
        rebuildClaimPreviewForSelection();
      })
      .catch((err) => {
        logErr('claim preview pricing failed — showing the transaction plan without USD values', err);
        if (!closed) markPricingUnavailable();
      });

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
    /* Release gate. claimToMainnet() already refuses before this panel can open on a real claim,
       so this is the visible half of the same rule rather than the enforcement — but it is the
       half that matters to a person: a panel that reviews a claim and then silently does nothing
       on click reads as broken. Demo mode is explicitly exempt (`preview.__demo`), since its
       whole purpose is running this flow to completion with nothing at stake. */
    if (claimBlocked(!!preview.__demo)) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = RELEASE_BTN_LABEL;
      confirmBtn.title = RELEASE_NOTICE;
    }
    footer.append(cancelBtn, confirmBtn);

    // Reverted: an earlier version of this panel auto-started execution the instant every token
    // resolved (no manual click at all), reasoning that the numbered transaction list itself was
    // review enough. Live use showed two real problems with that: retrying an unresolved token
    // could silently kick off real sending with no explicit user action, and the header × being
    // disabled the instant that happened (correct once actually sending — see enterExecutionView)
    // read as "the close button is broken," since nothing the user did asked for sending to
    // start. Explicit Confirm and proceed restores a clear, single, unambiguous moment the user
    // chooses to proceed — separate from and in addition to each individual wallet signature.
    //
    // Signing is blocked while any claimable token is unresolved for a network reason — the
    // portfolio card is already telling the user that value is claimable, so confirming now
    // would claim it and then leave it sitting unswapped on Base, delivering less than was
    // promised. The retry ACTION lives inline on each unresolved row (see the consolidate-section
    // loop above); this just tracks whether it's safe to enable Confirm yet. A single persistent
    // note element (created once, toggled/rewritten) explains why, when it isn't.
    const blockNote = note('');
    blockNote.classList.add('claim-preview-note--warn');
    blockNote.hidden = true;
    body.appendChild(blockNote);
    // `unresolvedList` is the SAME array as preview.unresolved (see its declaration above), so a
    // row-level retry's splice() is already reflected here — this just needs to re-read .length.
    function updateConfirmGate() {
      const n = unresolvedList.length;
      /* The release gate outranks the unresolved-token gate and must not be undone by it: this
         function runs on every retry/toggle and would otherwise re-enable the button the moment
         the last unresolved token resolved. Return early rather than OR-ing the two conditions
         so the release label and tooltip set above survive untouched. */
      if (claimBlocked(!!preview.__demo)) {
        confirmBtn.disabled = true;
        blockNote.hidden = n === 0;
        return;
      }
      confirmBtn.disabled = n > 0;
      if (n === 0) {
        confirmBtn.title = '';
        blockNote.hidden = true;
        return;
      }
      confirmBtn.title = `${n} claimable token${n === 1 ? '' : 's'} could not be resolved — retry before signing`;
      const plural = n !== 1;
      blockNote.textContent =
        `Can't sign yet: ${n} claimable token${plural ? 's' : ''} `
        + `(${unresolvedList.map((u) => short(u.token)).join(', ')}) couldn't be resolved because the network `
        + `didn't respond. Signing now would claim ${plural ? 'them' : 'it'} but leave ${plural ? 'them' : 'it'} `
        + `unswapped on Base. Retry above to resolve ${plural ? 'them' : 'it'}.`;
      blockNote.hidden = false;
    }
    updateConfirmGate();

    // Re-resolves ONE unresolved token's row in place, without touching any other row —
    // resolveAerodromeToken() is genuinely single-token-scoped, so a retry click here only ever
    // repeats the lookup+quote work for THIS token. Whatever it resolves to changes how much
    // there is to bridge and what the claimed total is, so everything downstream that reads
    // live from `preview` is refreshed afterward: the bridge quote (re-fetched — more or less
    // USDC changes both the Across fee and the Curve output), Confirm's gate, and the
    // reconciliation ledger (via the same priceClaimPreview()/applyLedger() pipeline the initial
    // async pricing pass already uses). Declared here as a hoisted function so the click
    // listeners attached earlier in the consolidate-section loop can reference it.
    async function retryUnresolvedRow(u, row, noteEl, retryBtn) {
      if (retryBtn.disabled) return;
      retryBtn.disabled = true;
      noteEl.hidden = true;
      const spinner = spinnerNode(13);
      spinner.classList.add('claim-preview-row-spinner');
      row.appendChild(spinner);

      const result = await resolveAerodromeToken(u.token, u.amount, 'panel retry');
      // The user could have cancelled/confirmed while this was in flight — a closed panel's DOM
      // is detached, so there's nothing left to update (see the pricing-callback guard below,
      // which follows the exact same "closed" convention already established for that path).
      if (closed) return;

      spinner.remove();
      const idx = unresolvedList.indexOf(u);
      if (idx !== -1) unresolvedList.splice(idx, 1);

      if (result.kind === 'unresolved') {
        // Still no answer — restore the row exactly as it was so it can be retried again.
        retryBtn.disabled = false;
        noteEl.hidden = false;
        return;
      }

      if (result.kind === 'resolved') {
        result.step.decimals = await fetchAerodromeTokenDecimals(u.token);
        if (closed) return;
        preview.swapSteps.push(result.step);
        // Re-sort so a token rescued by a row-level Retry lands in its value-ranked position
        // rather than always at the end — same ordering contract as the initial build, and it
        // keeps the label list and executeAerodromeClaim() walking one identical array order.
        preview.swapSteps.sort((a, b) => usdValueOfSwapStep(b, preview.pricedTokens) - usdValueOfSwapStep(a, preview.pricedTokens));
        const path = result.step.legs.length > 1
          ? [short(result.step.token), ...result.step.legs.map((leg) => short(leg.tokenOut))].join(' → ')
          : `${short(result.step.token)} → USDC`;
        const newRow = step(
          `${formatUnits(result.step.amount, result.step.decimals ?? 18, 4)} ${path}`,
          `min out ${formatUnits(result.step.legs[result.step.legs.length - 1].minOut, 6, 2)} USDC`
        );
        swapLabels.set(String(result.step.token).toLowerCase(), newRow.querySelector('span'));
        row.replaceWith(newRow);
      } else {
        preview.skipped.push({ token: u.token, reason: result.reason, detail: result.detail });
        const newRow = step(short(u.token), SKIP_REASON_TEXT[result.reason] || 'will not be swapped');
        skipLabels.set(String(u.token).toLowerCase(), newRow.querySelector('span'));
        row.replaceWith(newRow);
      }

      // This token reaching a terminal state changed both whether Confirm can unlock and how
      // much USDC there is to consolidate/bridge — refresh every section derived from that.
      updateConfirmGate();
      // A newly-resolved token is newly claimable via swap, so it should be selected by default —
      // same "checked unless $0" rule every other token got when the panel first opened.
      if (result.kind === 'resolved') selectedTokens.add(String(u.token).toLowerCase());
      preview.estimatedUsdc = preview.swapSteps.reduce((sum, s) => sum + s.quotedUsdcOut, preview.directUsdc);
      const { acrossQuote, curveQuote } = await quoteAerodromeBridgeLeg(preview.estimatedUsdc);
      if (closed) return;
      preview.acrossQuote = acrossQuote;
      preview.curveQuote = curveQuote;
      priceClaimPreview(preview).then((led) => {
        if (closed) return;
        applyLedger(led);
        rebuildClaimPreviewForSelection(); // syncs totals/consolidate/bridge/ledger/transactions
      }).catch((err) => {
        logErr('re-pricing claim preview after row retry failed', err);
        rebuildClaimPreviewForSelection(); // still reflect the newly-resolved token's swap route
      });
    }

    const columns = document.createElement('div');
    columns.className = 'claim-preview-columns';
    columns.append(body, stepsCol);

    // Add stepsCol and footer to cascade sections (body sections already added above)
    cascadeSections.push(stepsCol, footer);

    panel.append(header, columns, footer);

    // Demo mode's own claim-to-mainnet flow (see buildDemoAerodromeClaimPreview's `__demo` flag)
    // opens this EXACT panel — same numbers-look-real, same "Confirm and proceed" button — so
    // without something explicit here, nothing on screen actually tells the user nothing they're
    // about to click can move real funds. A repeating background watermark (behind all content,
    // never intercepting clicks) plus a persistent banner at the very top of the review (the
    // FIRST thing read, ahead of any dollar figure) both say so, so the safety fact is legible at
    // a glance AND stated in words, not just implied by the "DEMO PORTFOLIO" badge on the page
    // behind this modal, which is easy to have already stopped noticing by the time Claim is
    // clicked several screens later.
    if (preview.__demo) {
      panel.classList.add('claim-preview-panel--demo');
      const watermark = document.createElement('div');
      watermark.className = 'claim-preview-demo-watermark';
      watermark.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 24; i++) {
        const word = document.createElement('span');
        word.textContent = 'DEMO MODE';
        watermark.appendChild(word);
      }
      panel.prepend(watermark);

      const demoBanner = document.createElement('div');
      demoBanner.className = 'claim-preview-demo-banner';
      demoBanner.innerHTML =
        '<strong>Demo mode — nothing here is real.</strong> Every figure is live-priced but ' +
        'simulated; no wallet is connected and no transaction can be sent. Confirm and proceed ' +
        'is completely safe to click.';
      header.after(demoBanner);
    }

    // Used to dock beside the Portfolio card on wide viewports instead of opening as a centered
    // modal, back when the panel was a single narrow (400px) column. Now that it's a two-column
    // 720px layout (see .claim-preview-columns), there is no realistic viewport where docking
    // beside the card still fits without clipping or overlapping it — always modal now.
    panel.classList.add('claim-preview-panel--modal');
    backdrop.classList.add('claim-preview-backdrop--dim');

    // Cascade fade-in the main sections after the panel is shown in the DOM
    const SECTION_CASCADE_DELAY_MS = 50;
    const cascadeInSections = () => {
      cascadeSections.forEach((section, i) => {
        expandExecStepRow(section, i * SECTION_CASCADE_DELAY_MS);
      });
    };

    function cleanup(result) {
      closed = true; // a late-resolving price lookup must not write into a detached panel
      backdrop.remove();
      resolve(result);
    }

    // Set the instant Confirm is clicked and never unset — used to decide whether Cancel/Confirm
    // are still the relevant controls (they're hidden for the rest of the panel's life once this
    // is true) or the execution view is. Distinct from `awaitingTx` below, which governs whether
    // DISMISSING the panel is allowed right now — that's a narrower, moment-to-moment question,
    // not "has sending started at all".
    let executing = false;
    // True only while a real transaction is actively out for signing/confirmation (set by the
    // onStep callback passed to executeClaim(), see enterExecutionView()) — closing the panel
    // is fine at any OTHER point once execution has started (between steps, or while paused on a
    // rejected signature waiting for Retry), since executeClaim() keeps running in the background
    // regardless of whether this view is open; only walking away mid-signature is blocked.
    let awaitingTx = false;

    // Builds one row of the execution view: a number badge, the transaction's label, and a
    // status icon that starts empty and is filled in by setStatus() as executeClaim() reports
    // progress. data-status drives the icon/color via CSS rather than swapping classes here.
    // Builds one execution-list row from a label's `{ parts }` (see aerodromeExecutionLabels()):
    // text parts render as plain text, token parts render as a name + icon badge. Every token
    // badge starts showing its short address (the same fallback the review section's swap rows
    // already use) — enterExecutionView() resolves real symbols for the whole list in one shared
    // lookup afterward, rather than each row doing its own.
    function buildExecutionStepRow(number, label) {
      const row = document.createElement('div');
      row.className = 'claim-exec-step';
      row.dataset.status = 'pending';
      const num = document.createElement('span');
      num.className = 'claim-exec-step-num';
      num.textContent = String(number);
      const text = document.createElement('span');
      text.className = 'claim-exec-step-label';
      const tokenNodes = []; // { addr, nameSpan } — filled in by the symbol-resolution pass below
      for (const part of label.parts) {
        if (part.t === 'text') {
          text.appendChild(document.createTextNode(part.v));
          continue;
        }
        const badge = document.createElement('span');
        badge.className = 'claim-exec-token';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = short(part.addr);
        badge.appendChild(nameSpan);
        const img = document.createElement('img');
        img.className = 'claim-exec-token-icon';
        img.alt = '';
        img.hidden = true;
        // No icon known for most tokens (see aerodromeTokenIconUrl()'s comment) — a load
        // failure just removes the element rather than leaving a broken-image glyph.
        img.addEventListener('error', () => img.remove(), { once: true });
        badge.appendChild(img);
        applyTokenIcon(img, part.addr);
        text.appendChild(badge);
        tokenNodes.push({ addr: part.addr, nameSpan });
      }
      const icon = document.createElement('span');
      icon.className = 'claim-exec-step-icon';
      row.append(num, text, icon);
      // Lets rebuildTransactionsList() renumber a row it's KEEPING (an earlier step removed by a
      // checkbox toggle shifts every later step up one) without tearing down and recreating that
      // row's whole DOM subtree — the row's identity, tokenNodes, and any in-flight icon lookup
      // all stay exactly as they were, only the visible number changes.
      function setNumber(n) { num.textContent = String(n); }
      function setStatus(status) {
        row.dataset.status = status;
        icon.innerHTML = '';
        if (status === 'active') icon.appendChild(spinnerNode(14));
        else if (status === 'done') icon.textContent = '✓';
        else if (status === 'error') icon.textContent = '✕';
      }
      // A rejected signature (see isUserRejection()) is not terminal — this puts a branded retry
      // button where the status icon would go, reusing the exact same retry treatment (and CSS
      // classes) already established for an unresolved token's row in the review section, so the
      // two "click to try this specific thing again" affordances in this panel look identical.
      function setRejected(onRetry) {
        row.dataset.status = 'rejected';
        icon.innerHTML = '';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'claim-preview-retry-btn claim-preview-retry-btn--sm';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => onRetry(), { once: true });
        icon.appendChild(retryBtn);
      }
      return { row, setStatus, setRejected, setNumber, tokenNodes, key: execStepLabelKey(label) };
    }

    // Runs executeClaim() against the numbered transaction list already visible in the review
    // above (see the "numbered transaction list" block earlier in this closure) — called once,
    // from the Confirm handler below.
    //
    // Deliberately does NOT execute against the raw `preview` object: `preview.swapSteps` and
    // `preview.estimatedUsdc` reflect EVERY claimable token, not just the ones still checked —
    // executing against `preview` directly would swap and bridge deselected tokens the user
    // unchecked specifically to keep unswapped, silently defeating the whole point of the
    // per-token toggles. `execPreview` below is a shallow copy with swapSteps/directUsdc/
    // estimatedUsdc recomputed from `selectedTokens` right before sending, and `stepRows` is
    // rebuilt from that SAME filtered set one last time so onStep's index always lines up with
    // what executeAerodromeClaim() actually iterates (claimTxs, then only the selected swap
    // legs, then the bridge leg) — a stale, pre-toggle stepRows list here would desync the
    // status icons from the real in-flight step the moment any token had been deselected.
    async function enterExecutionView() {
      executing = true;
      // Cancel/Confirm are gone (there's nothing left to confirm — sending has started), but the
      // header × stays enabled and DISMISSES the panel rather than stopping anything: an
      // already-broadcast transaction can't be un-sent, and executeClaim() keeps running to
      // completion in the background regardless of whether this view is open — closing just
      // stops watching it (the log panel still shows progress). See closeBtn's click handler
      // below for the corresponding message change.
      cancelBtn.hidden = true;
      confirmBtn.hidden = true;
      title.textContent = preview.__demo ? 'Simulating transactions…' : 'Sending transactions…';

      const selectedSwaps = swapSteps.filter((s) => selectedTokens.has(String(s.token).toLowerCase()));
      const usdcAddr = AERODROME_CLAIM.usdc.toLowerCase();
      const selectedDirectUsdc = selectedTokens.has(usdcAddr) ? (preview.directUsdc || 0n) : 0n;
      const selectedEstimatedUsdc = selectedSwaps.reduce((sum, s) => sum + s.quotedUsdcOut, selectedDirectUsdc);
      const execPreview = {
        ...preview,
        swapSteps: selectedSwaps,
        directUsdc: selectedDirectUsdc,
        estimatedUsdc: selectedEstimatedUsdc,
        bridgeEnabled,
        skipCrvUsdSwap: !curveSwapEnabled,
      };

      // Final rebuild against the exact set about to execute — guarantees stepRows[index] and
      // executeAerodromeClaim()'s own step sequence describe the same list, even if the user's
      // last action was something other than a checkbox toggle (e.g. Confirm right after the
      // initial pricing pass auto-unchecked a $0 token).
      rebuildTransactionsList();
      stepRows[0]?.row.scrollIntoView({ block: 'nearest' });
      // The composition actually about to execute, after every toggle the user touched. Logged
      // once here rather than reconstructed from the individual toggle events, because THIS is
      // the set that matters and the toggles are only how it got here.
      uiLog('claim-panel', 'execution start', {
        demo: !!preview.__demo,
        steps: stepRows.length,
        tokens: selectedTokens.size,
        swaps: selectedSwaps.length,
        bridge: bridgeEnabled,
        crvUsdSwap: curveSwapEnabled,
        estimatedUsdc: money(String(selectedEstimatedUsdc)),
      });

      try {
        await executeClaim(execPreview, (index, status) => {
          // 'active' is the ONLY status where a real transaction is actually out for signing/
          // confirmation — closeBtn's click handler checks this to decide whether closing right
          // now would mean walking away mid-signature. 'rejected' deliberately does NOT count:
          // nothing is pending there, the flow is just waiting on the user to click Retry (or
          // walk away), which closing is perfectly safe to do.
          awaitingTx = status === 'active';
          const r = stepRows[index];
          if (!r) return;
          // Keep the currently-executing step visible as execution proceeds. Before this, only
          // the FIRST row was ever scrolled into view (right before execution starts, above) —
          // with up to 12 steps in a 260px column that only fits a handful at once, everything
          // past whatever was on screen at the start ran invisibly off the bottom, unwatched,
          // until the final popup appeared with no visible progress in between. `nearest` only
          // moves the column when the row isn't already visible, so a step that's already in
          // view (most of them, once scrolled) causes no jitter.
          if (status === 'active') {
            r.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          // Only 'rejected' needs the caller (executeAerodromeClaim's track()) to WAIT for a
          // user action before retrying — every other status is fire-and-forget.
          if (status === 'rejected') {
            return new Promise((resolveRetry) => { r.setRejected(resolveRetry); });
          }
          r.setStatus(status);
          // One line per step transition — the console equivalent of watching the checkmarks
          // march down the column, and the only way to see how far a claim got if the panel was
          // closed (which is explicitly allowed mid-flight) or the tab was backgrounded.
          // Label is read off the rendered row (the same source the toast below uses) rather
          // than any field on `r` — stepRows entries expose `key`, not a display label, and a
          // step number with no name is far weaker evidence when reading this back later.
          uiLog('claim-panel', 'step', {
            n: index + 1,
            of: stepRows.length,
            status,
            label: r.row.querySelector('.claim-exec-step-label')?.textContent?.trim(),
          });
          // A toast for every confirmed step EXCEPT the last — the last one is folded into the
          // big "Claim complete" modal fired right after executeClaim() resolves below, so
          // showing a toast for it too would be an unnecessary "one more thing" the user has to
          // notice and dismiss in the half-second before the real celebration replaces it.
          if (status === 'done' && index < stepRows.length - 1) {
            const label = r.row.querySelector('.claim-exec-step-label')?.textContent?.trim();
            const stepTitle = preview.__demo
              ? `Step ${index + 1} of ${stepRows.length} (simulated)`
              : `Step ${index + 1} of ${stepRows.length} confirmed`;
            showTxStepToast({ title: stepTitle, sub: label });
          }
        });
        title.textContent = 'Claim complete';
        // executeClaim() above only resolves once every selected step has SENT AND CONFIRMED
        // (each leg goes through sendAndWait -> waitForReceipt) — this is genuinely "done", not
        // "sent", so the popup is safe to show here rather than the panel closing on its own.
        // Reads the same DOM text the ledger rows already show rather than recomputing: those
        // were scaled to this exact selection by updateLedgerForSelection() moments before
        // Confirm was clicked, so re-deriving them here risks a second, possibly-diverging
        // calculation of a number the user already saw and approved.
        const claimedSymbols = [...selectedTokens]
          .map((addr) => tokenRows.get(addr)?.symText?.textContent)
          .filter(Boolean);
        // recon.delivered.name is 'Delivered on mainnet' or 'Delivered on Base' (set by
        // updateLedgerForSelection() from `bridgeEnabled`) and .sub is the NATIVE amount+symbol —
        // "1,760.1382 crvUSD" if the crvUSD swap was left on, "78.49 USDC" if it was toggled off,
        // or absent entirely if bridging itself was toggled off (delivery stays on Base). This is
        // exactly "the respective form selected during confirmation": read from the two, not
        // hardcoded, so the sentence is always true to whatever this specific user chose.
        const destination = /mainnet/i.test(recon.delivered.name.textContent || '') ? 'Ethereum mainnet' : 'Base';
        const nativeDelivered = (!recon.delivered.sub.hidden && recon.delivered.sub.textContent)
          || recon.claimed.value.textContent || 'your claim';
        const successDetails = [
          { k: recon.delivered.name.textContent || 'Delivered', v: recon.delivered.value.textContent || '—', hero: true },
        ];
        if (!recon.delivered.sub.hidden && recon.delivered.sub.textContent) {
          successDetails.push({ k: 'Amount', v: recon.delivered.sub.textContent });
        }
        successDetails.push({ k: 'Claimed', v: recon.claimed.value.textContent || '—' });
        if (claimedSymbols.length) {
          successDetails.push({ k: 'Tokens', v: claimedSymbols.join(', ') });
        }
        successDetails.push({ k: 'Transactions', v: String(stepRows.length) });
        cleanup(true);
        // Funds just landed — the Cash card still shows the pre-claim read until someone hits its
        // own Refresh button, so kick it here rather than leaving that stale. Fire-and-forget:
        // refreshCash() has its own in-flight guard and demo-path handling, and nothing in this
        // flow depends on the Cash read finishing.
        refreshCash();
        showTxSuccessPopup({
          title: 'Claim complete — funds delivered',
          sub: preview.__demo
            ? `Simulated: ${nativeDelivered} would now be in your wallet on ${destination}.`
            : `${nativeDelivered} just landed in your wallet on ${destination}.`,
          details: successDetails,
        });
      } catch (err) {
        logErr('Aerodrome claim-to-mainnet flow failed partway through', err);
        // The whole header (title text + ×) is removed here rather than relabeled — the bottom
        // Close button (below) is the one and only way to dismiss a failed claim, so a second,
        // redundant dismiss control up top is just noise. closeBtn was never actually disabled
        // (see awaitingTx/tryDismiss above) by the time any error reaches here regardless — the
        // onStep callback already reported 'error' or the bridge-amount check reported it
        // directly, both of which set awaitingTx back to false first — but hiding it here removes
        // the ambiguity entirely rather than relying on that.
        header.hidden = true;
        const errNote = note(`${err.message || err}`);
        errNote.classList.add('claim-preview-note--warn');
        body.appendChild(errNote);
        const closeFooterBtn = document.createElement('button');
        closeFooterBtn.type = 'button';
        closeFooterBtn.className = 'btn-secondary';
        closeFooterBtn.textContent = 'Close';
        closeFooterBtn.addEventListener('click', () => cleanup(false));
        footer.innerHTML = '';
        footer.appendChild(closeFooterBtn);
      }
    }

    // A dismissal DURING execution (between transactions, or paused on a rejected signature) is
    // not a cancellation — executeClaim() keeps running to completion in the background either
    // way, this just stops watching it — so it gets its own, more accurate log line instead of
    // reusing 'claim cancelled', which describes the pre-execution Cancel/× paths below.
    let closeBlockedTimer = 0;
    function tryDismiss() {
      if (awaitingTx) {
        // Silently doing nothing here is exactly what read as "the × doesn't work" before —
        // say why instead, and only for as long as it's actually true.
        closeBlockedNote.hidden = false;
        clearTimeout(closeBlockedTimer);
        closeBlockedTimer = setTimeout(() => { closeBlockedNote.hidden = true; }, 2500);
        return;
      }
      log(executing ? 'claim panel dismissed — remaining transactions keep sending in the background' : 'claim cancelled', 'info');
      cleanup(false);
    }
    closeBtn.addEventListener('click', tryDismiss);
    cancelBtn.addEventListener('click', () => { log('claim cancelled', 'info'); cleanup(false); });
    confirmBtn.addEventListener('click', () => { if (!confirmBtn.disabled) enterExecutionView(); });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) tryDismiss();
    });

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    cascadeInSections();
  });
}

// Full Aerodrome "claim to mainnet" flow: build the plan, show it in a preview panel and wait
// for the user's explicit confirmation, then execute claim → consolidate → bridge. The
// claim+consolidate leg (everything on Base) is sent as ONE atomic wallet_sendCalls batch when
// the connected wallet advertises atomic support for Base (see walletAtomicCapability()) — this
// is what makes the wallet's own pre-sign simulation (e.g. Rabby) show a single net "+USDC"
// result instead of the claimed tokens landing raw and each swap appearing as its own separate
// simulated transaction. Falls back to the original sequential per-tx flow (each step
// wallet-signed and confirmed before the next) on any wallet that doesn't support it — this
// remains fully correct there, just multiple signatures instead of one. The bridge leg (a
// separate cross-chain hop, which EIP-5792 batches can't span) is always re-quoted against the
// REAL post-consolidation USDC balance right before sending it, not the preview's estimate,
// since actual swap output can differ slightly from the pre-trade quote.
