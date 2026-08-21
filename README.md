# The served app — `docs/js/`, demo mode and deployment

Moved out of `CLAUDE.md` by FA-597, verbatim, on the FA-118/FA-596 precedent. Why: that file is
loaded into context at the start of every session, and this describes how the app is BUILT and
deployed rather than a rule a session must obey before it can look one up. What stayed behind in
`CLAUDE.md` (the release gate, the shipping checklist's five obligations, the two module-graph
verification commands, and the publish rule) is exactly the subset where being wrong ships a live
claim flow with no signature gate, or 404s a script in production — read those there first.

Update this file in the same commit as any change to `docs/js/`, demo mode, or deployment,
exactly as `CLAUDE.md`'s own upkeep rule demands.

## Module structure — `docs/js/`

What used to be one 8,172-line `docs/app.js` is now native ES modules under `docs/js/`, loaded
via `<script type="module" src="./js/main.js">` — **still zero build step**: the browser resolves
`import`/`export` natively, no bundler, no TypeScript. The split was purely mechanical
(line-for-line, byte-exact for the `ICONS` data URIs); no runtime behavior changed.

- `js/core/` — `utils.js` (DOM/format/ABI helpers, the on-page `log()`), `chains.js` (chain ids,
  `CHAINS`, `CHAIN_PARAMS`), `state.js`, `prefs.js` (theme + privacy mask), `ui-debug.js`
  (opt-in UI console narration + `window.__ui.snapshot()`)
- `js/wallet-connect.js` — EIP-6963 discovery/connect/switch-chain
- `js/rpc-waterfall.js` — public-RPC waterfall, multicall, DefiLlama pricing. Endpoint choice is
  load-aware: one that rate-limits us (or drops the connection) is skipped as a STARTING point
  for `THROTTLE_COOLDOWN_MS`, and retry backoff applies only once the rotation wraps onto an
  already-tried endpoint. Both matter far more than they look — read the measured numbers in
  `endpointThrottledUntil`'s comment before changing either.
- `js/protocols/` — one file per protocol (`curve.js`, `vedex.js` for Aerodrome/Velodrome's
  shared veNFT scan, `velodrome.js`, `yieldbasis.js`, `clever.js`, `concentrator.js`, `cash.js`),
  plus `config.js` (addresses/selectors/`PROTOCOLS`) and `icon-data.js` (just the `ICONS` base64
  URIs — split out on purpose: ~26KB of image data a session editing protocol *logic* never needs
  to load. Only touch it when adding/replacing an icon.)
- `js/render/portfolio.js` — accordion/row/subsection rendering shared by every card
- `js/demo/data.js` — demo-mode data synthesis (non-Aerodrome)
- `js/aerodrome/` — `routing.js` (pool discovery/quoting), `icons.js` (token icon lookup),
  `claim.js` (preview + execution), `demo.js` (Aerodrome demo claim data)
- `js/tx/` — `feedback.js` (confetti, toasts), `send.js` (tx send/wait/batch)
- `js/claim/` — `ledger.js` (pricing/reconciliation), `generic-panel.js`
  (`showGenericClaimPanel` — THE panel, driven by a declarative preview; Curve and Velodrome are on
  it), `curve-preview.js` / `velodrome-preview.js` (their previews; the Velodrome one is a pure
  adapter over `velodrome/claim.js`), `panel.js` (`showClaimPreviewPanel` — Aerodrome only, one file,
  too interlinked to decompose safely, and the last one left to migrate), `orchestrate.js` (claim
  state machine)
- `js/main.js` — entry point: event wiring, boot, refresh orchestration

Cross-file mutable state (`state`, `portfolioResults`, `protocolNodes`, `preferWalletRpc`, the
Aerodrome full-scan cache) follows the ESM constraint that an imported binding is read-only to
the importer: each value is either mutated in place (properties on a shared object) or owned by
one module exposing a setter (`setPreferWalletRpc()`, `setPrivacyHidden()`) — never reassigned
from outside its owning file.

Genuine order-fragility does exist: a module-scope literal whose initializer reads across the
cycle. `STABLECOINS` in `cash.js` was one (it read `CURVE.crvUsd`); the fix is the lazy-function
pattern — `stablecoins()`, `tokenIconAddrMap()`, `demoAerodromeTokenPool()`. An audit of every
top-level declaration (2026-08-11) found no remaining cases: other load-time reads resolve to
`core/chains.js` or `protocols/icon-data.js` (which import nothing, so are never in a cycle) or
to hoisted `export function` declarations. Re-run that audit if you add a top-level literal.

**Exercising a real fetch path without a wallet**: drive the real modules from the browser
console against the dev server — `await import('/js/protocols/vedex.js')`, then call e.g.
`fetchPoolRewardsFullScan()`. Everything in `protocols/` reads public RPC only, so no wallet is
needed, and this runs shipped code in the real environment including the browser's per-origin
connection limits, which a Node benchmark does not model and which materially change RPC timing.
Wrap `window.fetch` first to count calls per endpoint. This is how the endpoint-cooldown numbers
were measured.

(The two required checks after any import/export change — `dry-run.mjs`, `verify-ui.mjs --claim`
— and why `dry-run` must enter at `main.js`, are in `CLAUDE.md`, not here: missing them ships a
broken module graph silently, which is the consequence test that keeps them in the always-loaded
file.)

## UI debug logging — `docs/js/core/ui-debug.js`

`log()` in `core/utils.js` narrates the NETWORK into the on-page panel. `ui-debug.js` is the
other half: a **console** narration of UI state, so reading it replaces reading the screen for
most functional questions ("did every card render?", "did privacy actually mask anything?", "how
far did the claim get?"). Full rationale is in the module header; the interface:

- **Off by default.** `?uidebug=1` (milestone) or `?uidebug=verbose` on the URL (persists to
  localStorage), or `window.__ui.on()` / `.verbose()` / `.off()`.
- **`milestone`** = the narrative (refresh start/complete, card settle, cash render, wallet,
  claim panel open, execution steps, success popup, privacy/theme). **`verbose`** adds
  per-component detail (accordion, individual toggles, progress text, toasts).
- **`window.__ui.snapshot()`** — structured read of current UI state (theme, privacy, cash,
  every card's rows/open-state/buttons, claim panel toggles and per-step statuses). Works with
  logging off. This is the committed replacement for ad-hoc DOM probing.
- Amounts/addresses go through `money()`/`addr()` and mask exactly as the UI does, so a pasted
  log leaks no more than a screenshot. `snapshot()` deliberately does not mask.

Conventions when adding events: log **after** the DOM write and count **off the DOM**, not off
the input data — a line must be evidence of what rendered, not a restatement of what was
requested; that divergence is the bug class this exists to catch. Carry counts, states and
outcomes, never bare "rendered" markers.

**The app has a mobile layout as of FA-100, and it is the ONLY width-based breakpoint in
`docs/styles.css`** (everything else in that file is `prefers-reduced-motion`). Two rules learned by
breaking them: a **nowrap flex row wider than the viewport does not merely clip** — the browser
widens the layout viewport and zooms the whole document out, so one unshrinkable row costs every
card and number on the page its scale; and **decoration positioned to bleed off the edge**
(`.hero-mesh` at `right: -24px`) becomes real horizontal scroll once there is no page margin left to
bleed into. `verify-ui.mjs` asserts both at 390px and 874px, testing whether an element can push the
DOCUMENT rather than whether it reaches past the viewport — the log and the claim panel contain very
wide children on purpose. `docs/claim.css` still has no phone layout: that is FA-102.

## Per-protocol claim-flow shapes

`CLAIM_TO_MAINNET_SUPPORTED` holds `aerodrome`, `curve`, `velodrome`, `yieldbasis` and `concentrator`.
Adding another id to that set is not the whole job — the shipping checklist's five obligations
(`CLAUDE.md`) all apply. The minimum a claim flow must narrate: started (with `demo` true/false), each
phase the user waits on, the tx broadcast, the confirmed receipt, the delivered amount, and the failure
path.

**Four of the five now share ONE panel.** `docs/js/claim/generic-panel.js` renders any protocol that
supplies a declarative *preview* — `groups`, `ledgerRows` + `ledger()`, `execSteps`, an optional
`destination` toggle — and computes nothing about money itself; the preview builder owns every
figure. Curve (`claim/curve-preview.js`), Velodrome (`claim/velodrome-preview.js`), Yield Basis
(`claim/yieldbasis-preview.js`) and Concentrator (`claim/concentrator-preview.js`) are on it;
**Aerodrome is the last one still on its own panel** (`claim/panel.js`), deliberately migrated last
because it is the only flow that has ever run in production. That is TASKS.md #3 (FA-003), and the
point of the whole exercise: adding a claim flow should mean writing a preview, not building a panel.
Read `generic-panel.js`'s header for the contract before adding a protocol to it.

The five existing flows are deliberately different shapes; a new one will resemble one:

- **Aerodrome** — multi-step pipeline: preview panel, per-token/step toggles, a 12-step execution
  list. Logging leans on `[ui:claim-panel] step` events plus the composition at `execution start`.
  The one protocol still on `claim/panel.js`, which DERIVES its own step labels separately from the
  sequence it executes — the failure mode the generic panel removes structurally.
- **Curve** — single-transaction, and the design target the generic panel was shaped against: one tx,
  one chain, no swap, no bridge, no destination choice, and a ledger where claimed and delivered are
  the same number. Everything optional in the panel's contract is optional *because Curve has none of
  it*. It renders a real review panel now (it had none before FA-003), degrading to a single step row
  with a plain group heading instead of a lone un-untickable checkbox. Its `[ui:claim]` phase
  milestones still matter — they cover the wallet-switch/broadcast/receipt beats the step row cannot.
- **Yield Basis** (`claim/yieldbasis-preview.js`) — single-transaction, single-chain, no swap, no
  bridge, same as Curve; the difference is the reward is a genuinely rotating multi-token BASKET rather
  than one fixed token. The token list is read from the contract's own `preview_claim()` return, not
  hardcoded, and delivered to the wallet as-is — no consolidation to crvUSD. `selectable: false` at the
  group level (one checkbox for the whole basket, since the underlying `claim()` takes no per-token
  routing), with each basket item rendered as its own row. First test of whether the generic panel's
  multi-token coverage holds.
- **Concentrator** (`claim/concentrator-preview.js`) — structurally identical to Curve: single
  transaction, single chain, no swap, no bridge, claimed and delivered are the same number. The one
  difference is that Curve's reward token is a constant (crvUSD) while Concentrator's is read LIVE via
  `veDistributor.token()` — governance can and has changed which token reaches veCTR holders — so the
  builder locates the `Claimable <symbol>` row by prefix and derives the symbol from what is left over,
  rather than matching a fixed key.

- **Velodrome** — multi-CHAIN pipeline, now also on the generic panel via
  (`docs/js/claim/velodrome-preview.js`, a pure adapter over the unchanged `velodrome/claim.js`).
  Rewards sit on up to 10 Superchain leaves; each
  participating leaf claims, swaps its rewards to VELO, and bridges XVELO to Optimism via
  Velodrome's own TokenBridge, where everything consolidates to USDC before an optional Across leg
  to crvUSD on mainnet. **VELO, not USDC, is the asset that crosses** — only 6 of 10 leaves have
  any USDC bridge route, while VELO is the emission token and bridges natively on all 10. Toggles
  are per CHAIN (the unit that costs money), and a leaf below `LEAF_DUST_USD` renders unchecked
  WITH its value and reason rather than being hidden. It logs under the shared `[ui:claim-panel]`
  scope now — the old `[ui:velodrome-panel]` scope died with `velodrome-panel.js`, so a check reading
  that stream must distinguish protocols by position, not by scope.
  **The panel takes its step labels FROM the preview** (`preview.execSteps`) and hands the executor
  that same array — unlike `panel.js`, which derives its own list. Keep that property in anything
  built on it: rows are addressed by index, so a labels/execution mismatch ticks the WRONG row
  instead of failing. It is the generic panel's rule, not an exception. Migrating Aerodrome onto it
  is the last remaining step of TASKS.md item 3.
  Each step also carries a machine-readable `kind` (`leaf-claim`, `leaf-swap`, `leaf-bridge`,
  `root-claim`, `root-swap`, `root-consolidate`, `mainnet-approve`, `mainnet-bridge`), so the
  executor acts on the same array the panel renders instead of re-deriving what to send. **One step
  is deliberately NOT one transaction** — a swap row is approve+swap, and a leaf claim row is one
  `getReward()` per Reward contract, because leaf contracts have no batching function at all.
  Transactions are built in `docs/js/velodrome/txs.js` — **leaf side only**: the Optimism ROOT legs
  reuse `aerodrome/routing.js`'s builders through a `venue`/`origin` argument, because Optimism's
  root Voter and Router answer the SAME selectors as Base's (confirmed in live bytecode). Two traps
  from that file are worth repeating here, since each costs a failed or ruinous transaction: the leaf
  Route has **three** fields where root/Base have four (different signature, different selector,
  bare revert), and the Hyperlane bridge fee must come from `Mailbox.quoteDispatch`'s
  **five-argument** overload with the bridge's own live `GAS_LIMIT()` — the three-argument form
  quotes default gas and under-funds by ~62%.
  Execution is gated by `core/release.js` only. The second, quoting-related refusal is **gone**,
  because the quoting it waited for now exists (every swap leg quoted stable-vs-volatile, the bridge
  fee from the Mailbox, the mainnet leg from Across + Curve). What replaced it is a **pre-flight**
  refusal: any token without a quote stops the run before the first signature, so a claim cannot
  strand itself half-swapped. Execution re-quotes and re-reads real balances at send time rather than
  trusting the preview, and consolidation **waits for the bridge to actually deliver** — a
  `sendToken` receipt confirms the send, not the arrival — naming where funds are in transit if it
  times out. `preview.estimated` is now computed, not hardcoded true: it reports whether any leg
  really fell back to the placeholder cost model.

Trap when testing either: `buildClaimMenu()` builds a `.claim-menu` dropdown that is deliberately
never opened — `.claim-btn` is wired straight to `claimToMainnet()`. Driving the hidden "Claim to
mainnet" item works from an in-page `.click()` (which bypasses visibility) but exercises a path
no user can reach. Click `.claim-btn`.

(The release gate itself — `RELEASE_TESTING`, the three enforcement points — is in `CLAUDE.md`,
not here: a session that misses it can ship a live claim flow with no confirmation withheld.)

## Deployment — private repo, PUBLIC mirror repo, Pages served from the mirror

**Live at `https://nseidm1.github.io/Family-Office/`** (HTTPS enforced; verified live 2026-08-12 —
site boots, six cards render, assets 200).

**This repo is PRIVATE. A second, PUBLIC repo — `nseidm1/Family-Office` — holds only the served
application**, and GitHub Pages serves it from `master:/`, meaning the contents of `docs/` sit at
THAT repo's root. The split exists so the site can be public while `TASKS.md`, the board's notes and
the tooling stay private. It replaced the old `nseidm1/Portfolio` Pages site, which died the moment
this repo went private: Pages needs a paid plan to serve from a private repo, and going private
DELETED the Pages configuration outright rather than pausing it.

Two consequences of the mirror having a DIFFERENT URL SHAPE than local, both already guarded:

- The site lives under a `/Family-Office/` subpath, so **an absolute `/js/...` asset path works
  locally and 404s in production**. Not catchable by local testing, so `publish-app.mjs` fails the
  publish on any absolute `src`/`href` in `index.html`. Keep every asset path relative.
- The mirror needs **`.nojekyll`**, or Pages runs Jekyll and silently drops `_headers` and anything
  else underscore-prefixed. The script recreates it if it goes missing.

`docs/_headers` exists for header-capable hosts (Cloudflare Pages, Netlify) and sends the
`frame-ancestors`/`X-Frame-Options` that Pages cannot. **It is inert on GitHub Pages — confirmed
live, zero matching headers on the response** — so `docs/js/framebust.js` plus the CSS suppression
remain the ONLY clickjacking defence on this deployment. Never weaken them on the strength of that
file.

Because code comments reference private-repo files (`TASKS.md`, `CLAUDE.md`, `tools/*.mjs`) and the
mirror copies them **byte-identically**, those references dangle publicly. That is deliberate and the
mirror's README says so: rewriting comments for the mirror would create two versions of the same
explanation that drift, and a dangling filename is a smaller problem than a comment that lies.

`LICENSE` (proprietary/all-rights-reserved) ships in the mirror and is the only real protection
available for client-side code; minification/obfuscation stays deliberately rejected — it would
contradict the zero-build-step architecture, is trivially reversed, and would hide the WHY-comments
that are the most valuable content here.

CSP lives in a `<meta>` tag because Pages cannot set response headers — which also means
`frame-ancestors`/`X-Frame-Options` are unavailable, so the HEADER-based clickjacking defence
needs a real host or proxy in front. In its place `docs/js/framebust.js` (a **classic**,
non-deferred `<script>` in `<head>` — a module would be deferred and run after first paint) marks
`<html data-framed>`, and `styles.css` `display: none`s the app, which removes it from hit testing
as well as paint. It also attempts a top-navigation breakout, but that is the defeatable layer:
`sandbox="allow-scripts"` blocks it, so the CSS suppression must never be made conditional on it.
`main.js` additionally refuses to boot when framed. `verify-ui.mjs` asserts all of this by really
framing the app in a sandboxed iframe. It is the one script outside `main.js`'s module graph, so
`dry-run.mjs` does not cover it. `script-src 'self'` with no `'unsafe-inline'` is the
load-bearing directive (one module script, zero inline handlers). `style-src` needs
`'unsafe-inline'` for the ~25 direct `element.style` writes. **`connect-src` enumerates every
host, so adding an RPC endpoint to `PUBLIC_RPCS` without adding it to the CSP silently blocks it
and looks like an endpoint failure** — `tools/verify-ui.mjs` asserts the two lists agree.

(The publish rule and the fresh-clone rule — `never edit the mirror`, `publish-app.mjs` is the
only path, asset paths relative, no hardcoded absolute paths — are in `CLAUDE.md`, not here.)

## Demo mode — read before touching anything claim-related

The disconnected/no-wallet state (`startDemoMode()` in `docs/js/demo/data.js`) is a **fully
interactive simulation**, not a mockup, and needs no wallet and no RPC waiting:

- Every card shows synthetic-but-realistic totals (`buildDemoResults()`).
- **Aerodrome's demo claim set is 5 REAL, currently-listed Base tokens** (AERO, USDC, WETH,
  USDbC, cbBTC — `demoAerodromeTokenPool()`), priced **live** through the same
  `priceTokensUsd()`/DefiLlama path a real claim uses, fetched once per page load and cached
  (`demoAerodromeTokens()`) so the card and the claim popup always agree.
- Clicking **Claim** on Aerodrome or Curve (`claimToMainnetDemo()`) runs the **exact same**
  pipeline a real claim does — busy popover, full review panel, simulated execution with per-step
  toasts, final confetti popup. Only the data source and the "sending" step are synthetic
  (`demoExecuteAerodromeClaim()` is a timed no-op standing in for `eth_sendTransaction`).
- The demo review panel carries a hard-to-miss "nothing here is real" watermark + banner
  (`claim-preview-panel--demo`), since it is otherwise visually identical to the real flow.
- Every demo outcome says in words that it's simulated — never implies a real signature happened.

**This is why demo mode is the default for any demo-video request**: no wallet mock, no
live-chain RPC waits (which genuinely stall for 10+ minutes under load), deterministic, and it
exercises real application code rather than a parallel demo-only rendering path.

Known quirk: the simulated step sequencer stalls while the tab is backgrounded and resumes when
fronted. **The cause is timer throttling, not a frame callback** — an earlier version of this note
said the latter and was wrong: `demoExecuteAerodromeClaim()` sleeps on plain `setTimeout` only, and
so does the real `waitForReceipt()`. Chrome clamps background `setTimeout` to ≥1s, and to ≥60s
once a tab has been hidden ~5 minutes, which is what turns a ~10s demo run into a visible stall.
The rAF dependencies that DID exist were in `tx/feedback.js` (the toast and success-popup
`is-open` transitions) and are now backed by timers like everything else. Budget for it when
driving demo mode; it is not a hang.

(Obligation 1 of the shipping checklist — "demo mode grows to cover it" — is in `CLAUDE.md`: the
one-line rule that binds every feature change, not just the design behind today's demo data.)
