import { money, uiLog, uiTrace } from '../core/ui-debug.js';

export function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.className = 'tx-success-confetti';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#7c5cff', '#22d3ee', '#34d399', '#0052ff', '#eab308', '#ec4899'];
  // Two corner cannons firing UP and INWARD, not one burst centered on the card. A center-origin
  // burst starts its particles right on top of the card's own title text before gravity has had
  // any time to carry them clear of it — legible for maybe one frame, then a mess of dots over
  // "Claim complete" for the next several. Firing from the bottom corners keeps the first
  // second of flight entirely in the margins around the card, which is where the celebration
  // reads as backdrop rather than an occlusion of the thing it's celebrating.
  const n = 70;
  const cannons = [
    { x: 0, vx: 1 },                 // bottom-left, biased rightward/inward
    { x: window.innerWidth, vx: -1 }, // bottom-right, biased leftward/inward
  ];
  const particles = cannons.flatMap((cannon) => Array.from({ length: n }, () => ({
    x: cannon.x + (Math.random() - 0.5) * 60,
    y: canvas.height + 10,
    vx: cannon.vx * (Math.random() * 6 + 3) + (Math.random() - 0.5) * 2,
    vy: -Math.random() * 15 - 10,
    size: Math.random() * 6 + 4,
    color: colors[(Math.random() * colors.length) | 0],
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.3,
    shape: Math.random() < 0.5 ? 'rect' : 'circle',
    life: 1,
  })));
  const gravity = 0.32;
  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      if (elapsed > 900) p.life -= 0.02;
      if (p.life <= 0) continue;
      p.vy += gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      if (p.y < canvas.height + 40) alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (alive && elapsed < 4000) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// Generic "a transaction was sent AND confirmed" celebration, used by both Curve's single-tx
// claim and the last leg of Aerodrome's claim-to-mainnet flow — see the two call sites for what
// `details` looks like in each case. Deliberately fires only after a real confirmed receipt
// (see waitForReceipt), never on broadcast alone: a signed-but-unconfirmed tx can still revert,
// and celebrating that would be a false promise the ledger might immediately contradict.
// `details` is an ordered array of { k, v, mono? } rows — plain data, no DOM — so both call
// sites stay simple string-building rather than each hand-rolling row elements.
export function showTxSuccessPopup({ title, sub, details = [], ctaLabel = 'Done' }) {
  // The terminal outcome of a claim, and the one screen that reconciles claimed-vs-delivered.
  // Logging the detail rows verbatim means the final numbers survive the popup being dismissed,
  // which is otherwise the only place they are ever shown.
  uiLog('tx', 'success popup', {
    title,
    sub,
    details: Object.fromEntries(details.map((d) => [d.k, money(d.v)])),
  });
  const backdrop = document.createElement('div');
  backdrop.className = 'tx-success-backdrop';

  const card = document.createElement('div');
  card.className = 'tx-success-card';

  const icon = document.createElement('div');
  icon.className = 'tx-success-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6"/></svg>';
  card.appendChild(icon);

  const h = document.createElement('p');
  h.className = 'tx-success-title';
  h.textContent = title || 'Claim complete';
  card.appendChild(h);

  if (sub) {
    const s = document.createElement('p');
    s.className = 'tx-success-sub';
    s.textContent = sub;
    card.appendChild(s);
  }

  if (details.length) {
    const box = document.createElement('div');
    box.className = 'tx-success-details';
    details.forEach((d) => {
      const row = document.createElement('div');
      // `hero` (the delivered-amount row, always listed first by every call site) reads as the
      // headline fact of the popup rather than one line among equals — see each call site's own
      // comment on why the delivered amount specifically is what this popup exists to announce.
      row.className = 'tx-success-row' + (d.hero ? ' tx-success-row--hero' : '');
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = d.k;
      const v = document.createElement('span');
      v.className = 'v' + (d.mono ? ' mono' : '');
      v.textContent = d.v;
      row.append(k, v);
      box.appendChild(row);
    });
    card.appendChild(box);
  }

  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'tx-success-cta';
  cta.textContent = ctaLabel;
  card.appendChild(cta);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // rAF here is only to get the `is-open` transition to actually animate (the class has to land
  // in a LATER frame than the node's insertion, or the browser coalesces both into one style
  // resolution and the element simply appears). But a hidden tab never fires rAF at all — the
  // same trap log() in core/utils.js and setAccordionOpen() in render/portfolio.js each document
  // and guard against, and this was the last place in the codebase still relying on rAF alone.
  // It matters most precisely HERE: this is the "Claim complete" modal, and a claim finishing
  // while the user is on another tab is the normal case, not an edge case — multi-step claims
  // take minutes and people switch away. Without the timer the modal sits in the DOM fully built
  // but never opened, so the user comes back to what looks like a flow that silently did nothing.
  // (It does self-heal when the tab is fronted and rAF finally fires; the timer removes the
  // dependency on that entirely.) `openOnce` keeps it exactly-once so whichever fires first wins
  // and confetti cannot launch twice.
  let opened = false;
  const openOnce = () => {
    if (opened) return;
    opened = true;
    backdrop.classList.add('is-open');
    if (!reduceMotion) launchConfetti();
  };
  requestAnimationFrame(openOnce);
  setTimeout(openOnce, 100);

  function dismiss() {
    backdrop.classList.remove('is-open');
    setTimeout(() => backdrop.remove(), 240);
  }
  cta.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  const onKey = (e) => { if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  cta.focus();
}

// Active toasts, oldest first — each new one stacks ABOVE the ones already showing (translateY
// upward per slot) rather than overlapping them, since a fast-moving flow (demo mode's simulated
// confirmations land much faster than real wallet round trips) can easily have two or three
// alive at once.
export const activeToasts = [];

// The brief, non-blocking sibling of showTxSuccessPopup() — see its own call sites for exactly
// when each is used: this fires for every confirmed transaction EXCEPT the last one in a
// multi-step flow, where the full modal takes over instead. Auto-dismisses on its own; never
// blocks input, never requires a click.
export function showTxStepToast({ title, sub }) {
  // Verbose: the claim-panel 'step' milestones already carry the same progression, and toasts
  // are transient decoration on top of it. Useful only when the question is about the toast
  // stacking/dismissal itself.
  uiTrace('tx', 'step toast', { title, sub });
  const toast = document.createElement('div');
  toast.className = 'tx-toast';
  toast.style.bottom = `${20 + activeToasts.length * 64}px`;
  toast.innerHTML =
    '<span class="tx-toast-icon"><svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6"/></svg></span>' +
    '<span class="tx-toast-text"></span>';
  const textEl = toast.querySelector('.tx-toast-text');
  const h = document.createElement('div');
  h.className = 'tx-toast-title';
  h.textContent = title;
  textEl.appendChild(h);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'tx-toast-sub';
    s.textContent = sub;
    textEl.appendChild(s);
  }
  document.body.appendChild(toast);
  activeToasts.push(toast);

  // Same rAF-plus-timer pattern as showTxSuccessPopup() above, and the failure it prevents is
  // worse here than a late animation: `remove()` below is on a plain setTimeout, which DOES fire
  // in a hidden tab (throttled, but it fires), while the rAF that opens the toast does not. So
  // without the timer a toast created while backgrounded is added, never opened, and then removed
  // on schedule — it never becomes visible at all, even after the user returns. The step it was
  // reporting is simply never announced.
  let shown = false;
  const showOnce = () => { if (shown) return; shown = true; toast.classList.add('is-open'); };
  requestAnimationFrame(showOnce);
  setTimeout(showOnce, 100);

  function remove() {
    const i = activeToasts.indexOf(toast);
    if (i === -1) return; // already removed (e.g. a second timer fired)
    activeToasts.splice(i, 1);
    toast.classList.remove('is-open');
    setTimeout(() => {
      toast.remove();
      // Every toast still above this one's slot shifts down to close the gap — same "stack,
      // don't overlap" contract the push above establishes.
      activeToasts.forEach((t, idx) => { t.style.bottom = `${20 + idx * 64}px`; });
    }, 240);
  }
  setTimeout(remove, 2200);
}

