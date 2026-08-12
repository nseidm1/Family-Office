/* Clickjacking guard — the JS half of a defence the CSP cannot provide here.
 *
 * WHY THIS EXISTS AT ALL. The real answer to clickjacking is a `frame-ancestors 'none'` CSP
 * directive (or the legacy `X-Frame-Options` header). Both are RESPONSE HEADERS, and GitHub
 * Pages cannot set response headers — the app's CSP therefore lives in a <meta> tag, and
 * meta-delivered CSP explicitly IGNORES `frame-ancestors` (it is one of the directives the spec
 * lists as header-only, alongside `report-uri` and `sandbox`). So the header defence is simply
 * unavailable until this is served from a real host or behind a proxy. That is still the right
 * long-term fix; this file is the mitigation that IS available on Pages today.
 *
 * WHY IT MATTERS MORE HERE THAN ON A BROCHURE SITE. This is not a read-only dashboard any more:
 * the Claim buttons open a wallet and move real funds. The classic attack — frame the page,
 * overlay it with something innocuous, and let the victim's click land on a button they cannot
 * see — is squarely in scope for a "Confirm and proceed" button.
 *
 * WHY A CLASSIC SCRIPT IN <head>, NOT PART OF THE MODULE GRAPH. `js/main.js` is a module, and
 * modules are deferred: they run AFTER the document is parsed, which means a framed page would
 * render fully — buttons and all — before any module code could react. A classic, non-deferred
 * <script src> in <head> executes synchronously at parse time, before <body> exists, so the
 * `data-framed` attribute is on <html> before the first paint and the CSS rules in styles.css
 * suppress the UI without it ever having been visible. This is also why the file imports
 * nothing: it must not be a module, so it cannot use `import`, and it must not depend on
 * anything that has not loaded yet. It is deliberately the only script in the repo outside
 * `docs/js/`'s module graph — `tools/dry-run.mjs` walks that graph from main.js and will not
 * see this file, so changes here are not covered by it.
 *
 * CSP-COMPATIBLE BY CONSTRUCTION: a same-origin `<script src>` satisfies `script-src 'self'`,
 * so this needs no 'unsafe-inline' and does not weaken the policy's load-bearing line.
 *
 * TWO LAYERS, BECAUSE THE FIRST ONE IS DEFEATABLE:
 *   1. Attempt to break out by navigating the top window to our own URL. This is the classic
 *      frame-buster and it works against a plain <iframe> — but an attacker only has to add
 *      `sandbox="allow-scripts"` (without `allow-top-navigation`) to make the assignment throw,
 *      which is why it is wrapped in try/catch and why it is NOT the defence, just the nicety
 *      that recovers gracefully in the honest case.
 *   2. Suppress the UI regardless of whether (1) succeeded. `display: none` removes an element
 *      from hit testing as well as from paint, so the buttons are not merely invisible — they
 *      are unclickable. THIS is the layer that actually holds under sandboxing, and it must
 *      never be made conditional on the breakout attempt's result.
 * A notice replaces the app rather than leaving a blank page, so a user who arrives through a
 * legitimate embed is told what happened and given a way to open the real site.
 */
(function () {
  // window.top !== window.self is true whenever this document is not the top-level browsing
  // context. Reading `window.top` across origins is itself allowed (it is `location` that is
  // restricted), so this check works against a cross-origin framer — which is the only kind
  // that matters — without throwing. Guarded anyway: a hostile embedder can make almost any
  // window property access misbehave, and this script must never be the reason the page fails
  // to load in the normal, unframed case.
  var framed;
  try {
    framed = window.top !== window.self;
  } catch (e) {
    // A throw here means the access was blocked, which itself only happens inside a frame.
    framed = true;
  }
  if (!framed) return;

  document.documentElement.setAttribute('data-framed', '1');

  // Layer 1 — see the header. Expected to throw under `sandbox="allow-scripts"`; that is not an
  // error condition, it is the case layer 2 exists for.
  try {
    window.top.location = window.self.location.href;
  } catch (e) { /* sandboxed frame — layer 2 is the real defence */ }

  // Layer 2's visible half. The suppression itself is pure CSS (see styles.css) and is already
  // in force by now; this only adds the explanation, which needs a <body> to attach to.
  function showNotice() {
    if (document.querySelector('.framebust-notice')) return;
    var box = document.createElement('div');
    box.className = 'framebust-notice';
    var h = document.createElement('h1');
    h.textContent = 'This page cannot be displayed in a frame';
    var p = document.createElement('p');
    p.textContent =
      'Family Office was loaded inside another site. Because this app can move real funds, it '
      + 'refuses to run in an embedded frame — a framed page can be overlaid so that a click '
      + 'lands on a button you cannot see. Open it directly instead.';
    var a = document.createElement('a');
    a.className = 'framebust-link';
    a.href = window.self.location.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open Family Office in a new tab';
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(a);
    document.body.appendChild(box);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showNotice);
  } else {
    showNotice();
  }
}());
