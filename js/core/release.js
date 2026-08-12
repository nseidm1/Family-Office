/* Release gate — the single switch that decides whether this build may send real transactions.
 *
 * WHY A DEDICATED MODULE FOR ONE BOOLEAN. This app constructs and signs irreversible on-chain
 * transactions that move real money. It is deployed to a public URL (GitHub Pages) where anyone
 * can connect a wallet, including people who have never read a line of this code. Shipping the
 * signing path enabled by default and relying on reviewers to remember to re-disable it is the
 * wrong default for that combination. So the gate is one obvious, greppable file rather than a
 * flag buried next to the logic it governs.
 *
 * WHAT IT GATES, AND WHAT IT DELIBERATELY DOES NOT. It blocks EXECUTION, not review. On a real
 * wallet the Aerodrome preview panel still opens and builds completely — real positions, real
 * rewards, real swap routes, real bridge quotes — because none of that signs anything and it is
 * precisely what wants exercising during a beta. Only the final "Confirm and proceed" is
 * withheld. An earlier version refused in claimToMainnet() before any of that, which also meant
 * the panel never opened at all; that threw away the most useful part of the beta and was wrong.
 *
 * Three enforcement points, because they cover genuinely different paths:
 *   1. showClaimPreviewPanel() — disables and relabels "Confirm and proceed" (the visible half,
 *      and it must outrank updateConfirmGate(), which re-runs on every toggle).
 *   2. claimToMainnet()'s Curve branch — Curve has NO preview panel, so its claim button IS the
 *      confirmation; gated there, before switchChain(), so the beta never moves the user's
 *      wallet to mainnet for a transaction it will refuse to send.
 *   3. executeAerodromeClaim() — last resort. It broadcasts irreversible, money-moving
 *      transactions, so it refuses on its own authority rather than trusting a disabled
 *      attribute several layers away.
 *
 * Demo mode is untouched throughout — it sends nothing, signs nothing, needs no wallet, and is
 * the entire point of the public URL. Gating it would disable the only thing most visitors can
 * actually use.
 *
 * TO GO LIVE: set RELEASE_TESTING to false. That is the whole change. Everything that reads it
 * imports from here, so there is no second place to remember.
 *
 * Leaf module by design — imports nothing, so it can never participate in the docs/js import
 * cycle and is safe to read at module scope anywhere (see CLAUDE.md on order-fragility).
 */

// The switch. `true` = public-preview build, real signing disabled.
export const RELEASE_TESTING = true;

// Short badge text. "Beta" is the conventional label for "publicly usable, not yet warranted",
// which is exactly this build's status — the read-only portfolio side is complete and accurate,
// the transactional side is withheld pending sign-off.
export const RELEASE_LABEL = 'Beta';

// Shown on the disabled confirm/claim control itself.
export const RELEASE_BTN_LABEL = 'Disabled in beta';

// The explanation. Deliberately says what IS working and why the rest is held back, rather than
// just refusing — a bare disabled button reads as broken, which is the same failure the
// "Coming soon" relabel already fixed for unbuilt protocols (see buildClaimMenu).
export const RELEASE_NOTICE =
  'Public beta — portfolio and Cash figures are live and real, but sending transactions is '
  + 'disabled in this build while the claim flows finish release testing. Demo mode runs the '
  + 'complete claim walkthrough end to end, safely.';

// True when a real signing action should be refused. Callers pass whether they are in demo mode;
// demo never gates. Kept as a function so call sites read as intent ("is this blocked?") rather
// than re-deriving the same `RELEASE_TESTING && !demo` condition and eventually getting it wrong.
export const claimBlocked = (isDemo) => RELEASE_TESTING && !isDemo;
