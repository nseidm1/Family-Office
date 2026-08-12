import { buildDemoAerodromeCardResult, demoAerodromeTokens } from '../aerodrome/demo.js';
import { buildDemoVelodromeCardResult, demoVelodromeChains } from '../velodrome/claim.js';
import { renderCash, stablecoins } from '../protocols/cash.js';
import { PROTOCOLS } from '../protocols/config.js';
import { chainName } from '../core/chains.js';
import { buildProtocolNode, renderAlphaIcons, renderPortfolioTotal, renderProtocolResult, setAccordionOpen } from '../render/portfolio.js';
import { $, formatUnlock, usd } from '../core/utils.js';
import { uiLog } from '../core/ui-debug.js';

export const demoUnlock = (daysFromNow) => formatUnlock(Math.floor(Date.now() / 1000) + daysFromNow * 86_400);

// Same {status, totalUsd, tokens: [{symbol, hero, usd, chains: [{chainName, usd}]}]} shape
// fetchCashBalances() returns, fed through the exact same renderCash() — no parallel rendering
// path. Static sample amounts (unlike Aerodrome's demo tokens, these are ~$1-pegged stables, so
// "live-priced" wouldn't show anything a fixed number doesn't already show just as honestly) —
// purely illustrative sample data clearly inside demo mode. USDC is deliberately split across two
// chains here specifically to demonstrate the per-token/per-chain accordion with more than one
// row inside it, not just the single-chain case every other demo token happens to have.
export function buildDemoCashResult() {
  /* Chain entries carry `addr`/`chainId` looked up from stablecoins() — the same table the REAL
     Cash read uses — rather than being written out again here. Without them the demo rows were
     symbol+amount only, so the token icons resolved to nothing in demo mode while working with a
     wallet connected: a demo-only blind spot in exactly the mode every screenshot and the demo
     video are taken from. Looked up rather than duplicated so a chain added to stablecoins() is
     reflected here automatically. */
  const real = stablecoins();
  const meta = (symbol, chainName) => {
    const entry = real.find((r) => r.symbol === symbol)?.chains.find((c) => c.chainName === chainName);
    return entry ? { chainId: entry.chainId, addr: entry.addr } : {};
  };
  const tokens = [
    { symbol: 'crvUSD', hero: true, usd: 1240.50, chains: [{ chainName: 'Ethereum', usd: 1240.50, ...meta('crvUSD', 'Ethereum') }] },
    { symbol: 'scrvUSD', usd: 912.40, chains: [{ chainName: 'Ethereum', usd: 912.40, ...meta('scrvUSD', 'Ethereum') }] },
    { symbol: 'USDC', usd: 3612.50, chains: [{ chainName: 'Ethereum', usd: 3200.00, ...meta('USDC', 'Ethereum') }, { chainName: 'Base', usd: 412.50, ...meta('USDC', 'Base') }] },
    { symbol: 'USDT', usd: 850.25, chains: [{ chainName: 'Ethereum', usd: 850.25, ...meta('USDT', 'Ethereum') }] },
  ];
  const totalUsd = tokens.reduce((sum, t) => sum + t.usd, 0);
  return { status: 'ok', totalUsd, tokens };
}

// Synthetic result objects in the EXACT shape fetchCurve()/fetchVeDex()/
// fetchYieldBasis() return ({status, claimSummary, rows, claimList} or, for
// Curve, {status, claimSummary, subsections}) — built fresh per call so the
// unlock countdowns stay accurate, then fed through the same
// renderProtocolResult()/renderSubsection()/renderRowsAndClaims()/buildRow()
// pipeline real data uses. No parallel rendering path, no hardcoded HTML.
export function buildDemoResults() {
  const veCrv = {
    status: 'ok',
    claimSummary: usd(38.42),
    claimUsd: 38.42,
    rows: [
      { k: 'CRV locked', v: '12,480.0000 CRV' },
      { k: 'Locked until', v: demoUnlock(540), sensitive: false },
      { k: 'Claimable crvUSD', v: '38.4200 crvUSD' },
    ],
  };
  const votemarket = {
    status: 'ok',
    claimSummary: usd(22.90),
    claimUsd: 22.90,
    rows: [
      { k: 'Active epoch', v: new Date().toISOString().slice(0, 10), sensitive: false },
      { k: 'Campaigns scanned', v: '3 across 2 gauges', sensitive: false },
    ],
    claimList: [
      { symbol: 'CRV', amount: '22.1000', usd: 17.90 },
      { symbol: 'USDC', amount: '5.0000', usd: 5.00 },
    ],
  };
  const curveSubsections = [
    { id: 'vecrv', name: 'veCRV', ...veCrv },
    { id: 'votemarket', name: 'Votemarket', ...votemarket },
  ];
  const curveTotalUsd = curveSubsections.reduce((sum, s) => sum + (s.claimUsd || 0), 0);

  return {
    curve: { status: 'ok', claimSummary: usd(curveTotalUsd), claimUsd: curveTotalUsd, subsections: curveSubsections },
    aerodrome: {
      status: 'ok',
      claimSummary: usd(22.20),
      claimUsd: 22.20,
      rows: [
        { k: 'AERO locked', v: '3,240.0000 AERO · 2 locks' },
        { k: 'Locked until', v: `${demoUnlock(210)} (+1 permanent lock)`, sensitive: false },
      ],
      claimList: [
        { symbol: 'AERO', amount: '15.3200', usd: 9.80 },
        { symbol: 'USDC', amount: '12.4000', usd: 12.40 },
      ],
    },
    velodrome: {
      status: 'ok',
      claimSummary: usd(15.40),
      claimUsd: 15.40,
      rows: [
        { k: 'VELO locked', v: '5,600.0000 VELO · 2 locks' },
        { k: 'Locked until', v: demoUnlock(365), sensitive: false },
        // Matches the veNFT row the real card carries (fetchVeDex) and the one
        // buildDemoVelodromeCardResult swaps in once live prices resolve — this is the FIRST
        // paint, so omitting it here left the card briefly missing metadata Aerodrome's had.
        { k: 'veNFTs', v: '#3117 · #9042', sensitive: true },
      ],
      claimList: [
        { symbol: 'VELO', amount: '9.7500', usd: 3.10 },
        { symbol: 'OP', amount: '2.0000', usd: 3.60 },
        { symbol: 'USDC', amount: '8.7000', usd: 8.70 },
      ],
    },
    yieldbasis: {
      status: 'ok',
      claimSummary: usd(66.90),
      claimUsd: 66.90,
      rows: [
        { k: 'YB locked', v: '890.0000 YB' },
        { k: 'Locked until', v: demoUnlock(680), sensitive: false },
      ],
      claimList: [
        { symbol: 'yb-cbBTC', amount: '0.0005', usd: 42.30 },
        { symbol: 'yb-WETH', amount: '0.0092', usd: 24.60 },
      ],
    },
    // Clever (veCLEV) and Concentrator (veCTR) are being added as real
    // PROTOCOLS entries by sibling agents on their own branches — these fake
    // entries are a forward-reference so buildDemoResults()/startDemoMode()
    // need no further changes once PROTOCOLS grows to include 'clever'/
    // 'concentrator' ids. Clever's fee distributor pays out in CVX+FRAX (its
    // clevCVX/clevFRAX vault rewards); Concentrator's actual reward-token
    // shape is still being finalized by its own agent, so a single plausible
    // ETH claim stands in as a reasonable default.
    clever: {
      status: 'ok',
      claimSummary: usd(28.60),
      claimUsd: 28.60,
      rows: [
        { k: 'CLEV locked', v: '1,850.0000 CLEV' },
        { k: 'Locked until', v: demoUnlock(420), sensitive: false },
      ],
      claimList: [
        { symbol: 'CVX', amount: '3.2000', usd: 18.40 },
        { symbol: 'FRAX', amount: '10.2000', usd: 10.20 },
      ],
    },
    concentrator: {
      status: 'ok',
      claimSummary: usd(19.75),
      claimUsd: 19.75,
      rows: [
        { k: 'CTR locked', v: '4,100.0000 CTR' },
        { k: 'Locked until', v: demoUnlock(300), sensitive: false },
      ],
      claimList: [
        { symbol: 'ETH', amount: '0.0082', usd: 19.75 },
      ],
    },
  };
}

// Total claimable across every protocol, shown next to the "Portfolio" card's
// own title (#portfolio-total in index.html). Shared by both the real
// renderPortfolio() fetch path and demo mode below — same results-object
// shape either way ({ [protocolId]: { claimUsd, ... } }), so one function
// covers both without a separate "demo total" code path. Reads `claimUsd`
// (a raw number each fetch*() function now returns alongside its formatted
// `claimSummary` string) rather than parsing claimSummary back apart — some
// protocols fall back to a native-token string there (e.g. fetchCurveVeCrv
// when crvUSD has no listed price), so claimSummary isn't reliably a dollar
// iOS-style indeterminate spinner (the classic radiating-blade activity
// indicator) — used anywhere this app previously showed literal "loading…"
// text. Pure CSS animation (see .spinner/.spinner-blade/@keyframes
// spinner-fade in styles.css), sized via a CSS custom property so callers
// can scale it inline without new classes. Uses currentColor so it always
// matches whatever text color it's replacing (claim badge green, header
// total color, etc.) in both themes with no extra wiring.
export const DEMO_CYCLE_MS = 4000;
export let demoTimer = null;
export let demoDetailsEls = [];
export let demoIndex = -1;

// Opens demoDetailsEls[demoIndex] and closes every other one — only one
// protocol section open at a time, same rule the real cards never enforced
// explicitly because a human only clicks one at a time. Goes through the
// exact same setAccordionOpen() a user's own click on <summary> uses, so
// the cycling animates smoothly too — no parallel expand/collapse machinery.
export function showDemoIndex() {
  demoDetailsEls.forEach(({ details, body }, i) => setAccordionOpen(details, body, i === demoIndex));
}

export function startDemoMode() {
  if (demoTimer) return; // already running — avoid restarting the cycle/flicker on redundant calls

  const badge = $('#demo-badge');
  if (badge) badge.hidden = false;

  const list = $('#protocol-list');
  list.innerHTML = '';
  const allResults = buildDemoResults();
  // Only total the protocols actually rendered below — buildDemoResults() can
  // carry fake entries (e.g. clever/concentrator, ahead of PROTOCOLS growing
  // to include those ids) that PROTOCOLS doesn't list yet, and the header
  // total must always match the sum of what's visibly on screen.
  const shownResults = {};
  demoDetailsEls = PROTOCOLS.map((proto) => {
    const { details, summary, body } = buildProtocolNode(list, proto);
    const result = allResults[proto.id];
    shownResults[proto.id] = result;
    renderProtocolResult(details, summary, body, result);
    return { details, body };
  });
  renderPortfolioTotal(shownResults);
  renderAlphaIcons(shownResults);
  renderCash(buildDemoCashResult());
  // Demo mode is visually near-identical to the real thing, so "which mode am I looking at?" is
  // a genuine question when reading a log or a bug report. This line answers it once, at the
  // top of every demo session, rather than leaving it to be inferred from the data.
  uiLog('demo', 'started', { cards: demoDetailsEls.length, total: $('#portfolio-total')?.textContent?.trim() });

  // Aerodrome's card starts with buildDemoResults()'s static 2-token placeholder (above) so the
  // page never waits on a network call to paint — then, once the live price lookup for the
  // 5-token bribe pool resolves, this swaps it in place for the real thing: the same live-priced
  // tokens/amounts the claim-to-mainnet popup will use if Claim is clicked (see
  // buildDemoAerodromeCardResult's comment on why that's one shared source, not two numbers that
  // happen to usually agree). Guarded on `demoTimer` still being set and this still being the
  // SAME demo session (aerodromeNode still the one currently in the DOM) — a fast disconnect ->
  // reconnect while the price lookup is in flight must not paint a stale demo card over real data.
  const aerodromeIdx = PROTOCOLS.findIndex((p) => p.id === 'aerodrome');
  const aerodromeNode = aerodromeIdx !== -1 ? demoDetailsEls[aerodromeIdx] : null;
  if (aerodromeNode) {
    demoAerodromeTokens().then((tokens) => {
      if (!tokens || !demoTimer || !aerodromeNode.details.isConnected) return;
      const live = buildDemoAerodromeCardResult(tokens);
      shownResults.aerodrome = live;
      const summary = aerodromeNode.details.querySelector(':scope > summary');
      renderProtocolResult(aerodromeNode.details, summary, aerodromeNode.body, live);
      renderPortfolioTotal(shownResults);
      renderAlphaIcons(shownResults);
    });
  }

  // Same swap-in-place for Velodrome, and for the same reason: its demo card was a hardcoded
  // figure while the claim panel synthesised its own live-priced chains, so the card and the panel
  // disagreed outright. Both now derive from demoVelodromeChains().
  const velodromeIdx = PROTOCOLS.findIndex((p) => p.id === 'velodrome');
  const velodromeNode = velodromeIdx !== -1 ? demoDetailsEls[velodromeIdx] : null;
  if (velodromeNode) {
    demoVelodromeChains().then((chains) => {
      if (!chains || !demoTimer || !velodromeNode.details.isConnected) return;
      const live = buildDemoVelodromeCardResult(chains);
      shownResults.velodrome = live;
      const summary = velodromeNode.details.querySelector(':scope > summary');
      renderProtocolResult(velodromeNode.details, summary, velodromeNode.body, live);
      renderPortfolioTotal(shownResults);
      renderAlphaIcons(shownResults);
    });
  }

  demoIndex = 0;
  showDemoIndex();
  demoTimer = setInterval(() => {
    demoIndex = (demoIndex + 1) % demoDetailsEls.length;
    showDemoIndex();
  }, DEMO_CYCLE_MS);
}

// Torn down the moment a real wallet connects (called from renderPortfolio()
// before it ever touches #protocol-list for real data) and re-entered the
// moment it disconnects — see renderPortfolio()'s `if (!state.account)` branch.
export function stopDemoMode() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  demoDetailsEls = [];
  demoIndex = -1;
  const badge = $('#demo-badge');
  if (badge) badge.hidden = true;
  uiLog('demo', 'stopped');
}

