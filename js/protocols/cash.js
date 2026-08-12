import { applyTokenIcon, loadTokenIconsForChain } from '../aerodrome/icons.js';
import { CURVE } from './config.js';
import { ARBITRUM, BASE_MAINNET, ETH_MAINNET, OPTIMISM } from '../core/chains.js';
import { buildDemoCashResult } from '../demo/data.js';
import { setSensitiveText } from '../core/prefs.js';
import { chainCall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { $, encodeAddress, logErr, spinnerNode, usd, word } from '../core/utils.js';
import { money, uiLog } from '../core/ui-debug.js';

// Built lazily (not as a module-load-time array literal) for the same reason
// tokenIconAddrMap()/demoAerodromeTokenPool() are: CURVE comes from protocols/config.js, which
// sits in a circular-import cluster with this file (config.js -> clever.js/vedex.js/... ->
// demo/data.js -> cash.js -> config.js). Reading CURVE.crvUsd at module scope only worked
// because main.js happened to import cash.js first, which forced config.js to finish evaluating
// beforehand; entering the graph from any other module threw "Cannot access 'CURVE' before
// initialization". First call builds it, every later call reuses the same array.
let _stablecoins = null;
export function stablecoins() {
  if (!_stablecoins) {
    _stablecoins = [
      { symbol: 'crvUSD', hero: true, chains: [{ chainId: ETH_MAINNET, priceChain: 'ethereum', chainName: 'Ethereum', addr: CURVE.crvUsd, decimals: 18 }] },
      { symbol: 'scrvUSD', chains: [{ chainId: ETH_MAINNET, priceChain: 'ethereum', chainName: 'Ethereum', addr: '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367', decimals: 18 }] },
      {
        symbol: 'USDC',
        chains: [
          { chainId: ETH_MAINNET, priceChain: 'ethereum', chainName: 'Ethereum', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
          { chainId: BASE_MAINNET, priceChain: 'base', chainName: 'Base', addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
          { chainId: OPTIMISM, priceChain: 'optimism', chainName: 'Optimism', addr: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
          { chainId: ARBITRUM, priceChain: 'arbitrum', chainName: 'Arbitrum', addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
        ],
      },
      { symbol: 'USDT', chains: [{ chainId: ETH_MAINNET, priceChain: 'ethereum', chainName: 'Ethereum', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 }] },
      { symbol: 'DAI', chains: [{ chainId: ETH_MAINNET, priceChain: 'ethereum', chainName: 'Ethereum', addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 }] },
    ];
  }
  return _stablecoins;
}

// Reads every (symbol, chain) balance for `account` in parallel, prices the nonzero ones, and
// returns one entry per symbol (crvUSD/hero first, then by total USD value) with a `chains`
// array of every chain that symbol was actually found on (sorted by USD value, mainnet or not —
// no assumed priority once you're inside a single token's own breakdown). Zero balances are
// dropped entirely at every level — a symbol with nothing on any chain gets no row, a chain with
// nothing under a held symbol gets no sub-row — "no empty-state clutter", the same rule this app
// already applies everywhere else (a protocol with nothing claimable renders no row either).
export async function fetchCashBalances(account) {
  const jobs = stablecoins().flatMap((t) => t.chains.map((c) => ({ symbol: t.symbol, hero: t.hero, ...c })));
  const results = await Promise.allSettled(jobs.map(async (j) => {
    const raw = await chainCall(j.chainId, j.addr, '0x70a08231' + encodeAddress(account));
    return { ...j, amount: word(raw, 0) };
  }));
  const held = results.filter((r) => r.status === 'fulfilled' && r.value.amount > 0n).map((r) => r.value);
  if (!held.length) return { status: 'ok', totalUsd: 0, tokens: [] };

  // One priceTokensUsd() call per distinct priceChain among what's actually held, not per job —
  // avoids pricing the same chain's tokens in multiple redundant calls if several were held there.
  const byPriceChain = new Map();
  held.forEach((h) => { if (!byPriceChain.has(h.priceChain)) byPriceChain.set(h.priceChain, []); byPriceChain.get(h.priceChain).push(h); });
  const priced = {};
  await Promise.all([...byPriceChain.entries()].map(async ([priceChain, items]) => {
    const result = await priceTokensUsd(items.map((t) => t.addr), priceChain);
    Object.assign(priced, result);
  }));

  let totalUsd = 0;
  const withUsd = held.map((h) => {
    // Every one of these is a $1-pegged stable by construction — a momentary price-feed miss
    // (rather than an actual depeg) falls back to the peg instead of showing "unavailable" for
    // an asset whose value is, for all practical purposes, never actually in question.
    const price = priced[h.addr.toLowerCase()]?.price ?? 1;
    const usd = (Number(h.amount) / 10 ** h.decimals) * price;
    totalUsd += usd;
    return { ...h, usd };
  });

  const bySymbol = new Map();
  withUsd.forEach((h) => {
    if (!bySymbol.has(h.symbol)) bySymbol.set(h.symbol, { symbol: h.symbol, hero: h.hero, usd: 0, chains: [] });
    const entry = bySymbol.get(h.symbol);
    entry.usd += h.usd;
    entry.chains.push(h);
  });
  const tokens = [...bySymbol.values()];
  tokens.forEach((t) => t.chains.sort((a, b) => b.usd - a.usd));
  tokens.sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0) || b.usd - a.usd);
  return { status: 'ok', totalUsd, tokens };
}

// Renders fetchCashBalances()'s (or the demo equivalent's) result into the Cash card —
// #cash-total in the card's own summary row, #cash-list for the per-token rows. One
// `<details class="cash-token">` per symbol actually held (crvUSD/hero first), its own summary
// showing the symbol and its TOTAL across every chain; expanding it reveals one row per chain
// that symbol was found on — same accordion pattern .protocol-sub already uses elsewhere in this
// app, not a new one invented for this card. Amounts route through setSensitiveText() like every
// other real balance in this app, so privacy mode masks them the same way it masks everything else.
export function renderCash(result) {
  const totalEl = $('#cash-total');
  const listEl = $('#cash-list');
  if (!totalEl || !listEl) return;
  listEl.innerHTML = '';

  const hasAny = result.status === 'ok' && result.tokens.length;
  if (!hasAny) {
    // An empty Cash card is ambiguous on screen — "no balances" and "the read failed" render
    // near-identically. `status` disambiguates them in one line.
    uiLog('cash', 'render (empty)', { status: result.status, symbols: result.tokens?.length ?? 0 });
    totalEl.textContent = usd(0);
    totalEl.classList.remove('is-ready');
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no stablecoin balance found on any tracked chain';
    listEl.appendChild(empty);
    return;
  }

  // setSensitiveText, not textContent: this is a real wallet balance, so privacy mode has to mask
  // it like every other one. It used to be a plain assignment, which meant switching privacy on
  // masked all the per-symbol rows below but left the card's headline TOTAL — the single most
  // sensitive number on the card — sitting there in the clear. Portfolio's equivalent headline
  // (renderPortfolioTotal) always routed through here; this one just never did.
  setSensitiveText(totalEl, usd(result.totalUsd));
  totalEl.classList.add('is-ready');
  uiLog('cash', 'render', {
    status: result.status,
    symbols: result.tokens.length,
    chainRows: result.tokens.reduce((n, t) => n + (t.chains?.length ?? 0), 0),
    total: money(usd(result.totalUsd)),
  });

  result.tokens.forEach((t) => {
    const details = document.createElement('details');
    details.className = 'cash-token' + (t.hero ? ' cash-token--hero' : '');

    const summary = document.createElement('summary');
    /* Token icon, so Cash reads as the same product as the Portfolio cards and both claim panels,
       which have carried icons all along. Uses the SAME applyTokenIcon() they do rather than a
       second lookup, so a symbol with no known icon shows no image instead of a broken one.
       Keyed off the FIRST chain's address because a symbol row aggregates one asset across chains
       (this card's whole per-symbol/per-chain premise) and the logo belongs to the asset. The
       chain's 1inch list is requested first: this cache used to be Base-only, so every Cash row —
       mostly mainnet addresses — resolved to nothing. */
    const firstChain = t.chains?.[0];
    if (firstChain?.chainId) loadTokenIconsForChain(Number(firstChain.chainId));
    const icon = document.createElement('img');
    icon.className = 'cash-token-icon';
    icon.alt = '';
    icon.hidden = true;
    icon.addEventListener('error', () => icon.remove(), { once: true });
    if (firstChain?.addr) applyTokenIcon(icon, firstChain.addr);
    const sym = document.createElement('span');
    sym.className = 'cash-symbol';
    sym.textContent = t.symbol;
    const amt = document.createElement('span');
    // crvUSD/scrvUSD get a decorative fire-emoji suffix (1 and 2 respectively) — purely
    // cosmetic flourish for this app's own two crvUSD-denominated positions, no other meaning.
    // scrvUSD's figure additionally gets a subtle animated flame glow behind it (see
    // .cash-amount--flame) — the two together read as "this one's actively earning".
    amt.className = 'cash-amount' + (t.symbol === 'scrvUSD' ? ' cash-amount--flame' : '');
    const fire = t.symbol === 'crvUSD' ? ' 🔥' : t.symbol === 'scrvUSD' ? ' 🔥🔥' : '';
    setSensitiveText(amt, usd(t.usd) + fire);
    const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    caret.setAttribute('class', 'caret-xs');
    caret.setAttribute('viewBox', '0 0 24 24');
    caret.innerHTML = '<path d="M6 9l6 6 6-6" />';
    summary.append(icon, sym, amt, caret);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'cash-token-body';
    t.chains.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'cash-chain-row';
      const chainSym = document.createElement('span');
      chainSym.className = 'cash-chain-name';
      chainSym.textContent = c.chainName;
      const chainAmt = document.createElement('span');
      chainAmt.className = 'cash-chain-amount';
      setSensitiveText(chainAmt, usd(c.usd));
      row.append(chainSym, chainAmt);
      body.appendChild(row);
    });
    details.appendChild(body);
    listEl.appendChild(details);
  });
}

/* StakeDAO Votemarket v2 — bribes paid to veCRV voters for gauge votes
   (votemarket.stakedao.org/curve/claim). Campaign accounting lives on ARBITRUM even
   though the vote itself happens on Curve's GaugeController on Ethereum: an Oracle
   contract mirrors each voter's GaugeController "slope" onto Arbitrum via a
   storage-proof relay (see docs.stakedao.org/vm_overview/votemarket and
   github.com/stake-dao/votemarket-v2). Claiming for real needs that proof to already
   be inserted — but reading it back, once inserted, is three PLAIN PUBLIC VIEW calls,
   no proof needed from us:
     - Votemarket.currentEpoch() -> the active weekly epoch (unix timestamp)
     - Oracle.votedSlopeByEpoch(account, gauge, epoch) -> {slope, end, lastVote,
       lastUpdate} — lastUpdate is 0 if no proof has been relayed yet for that
       voter/gauge/epoch, exactly mirroring OracleLens.isVoteValid()'s own checks
     - Votemarket.getPeriodPerCampaign(campaignId, epoch).rewardPerVote
   accountVote = slope * (end - epoch); reward = accountVote * rewardPerVote / 1e18,
   minus the platform fee (customFeeByManager(manager) || fee()). This was verified
   byte-for-byte against a real on-chain Claim event before shipping: campaignId 95,
   epoch 1785974400, account 0xf147b8125D2eF93Fb6965Db97D6746952a133934 — computed
   net 39064.402435347279335921 == the event's `amount`, computed fee
   1627.683434806136638996 == the event's `fee`, both exact to the last wei.
   There is no on-chain (or indexed-event) reverse lookup from "voter" to "gauges
   they voted for" — Curve's GaugeController emits VoteForGauge with no indexed
   fields at all, so even a log filter can't narrow it server-side, and Votemarket's
   own dashboard covers this gap with a private backend/subgraph. Lacking that, this
   fans out over every gauge that has EVER had a Votemarket campaign (found via
   CampaignCreated logs — two platform contracts, ~260 unique gauges as of writing)
   rather than only the handful the connected account actually voted for, the way
   fetchVeDex narrows to just the pools a veNFT voted for. That's a real, slowly
   growing per-refresh cost (one eth_call per historical gauge, not per relevant
   one) — collapsed via Multicall3 batching (see below) rather than avoided, since
   there's no cheaper way to know in advance which of the ~260 gauges matter.
     Scope: Votemarket.sol's own claim gate (_canClaim's withinClaimDeadline) keeps
   a campaign claimable until CLAIM_WINDOW_LENGTH (24 weeks, on-chain constant)
   after that CAMPAIGN's endTimestamp — so in principle an old, still-running
   campaign's very first epoch can remain claimable indefinitely. fetchVotemarket()
   approximates this with a flat walk of up to 24 weekly epochs back from
   currentEpoch(), which is exactly right for the common case (a ended-or-ending
   campaign) and only under-covers the rare very-long-running-campaign edge case —
   a real bound is necessary since the naive approach multiplies the ~260-gauge
   fan-out by up to 25x. To keep that affordable, the epoch walk stops after two
   consecutive fully-empty epochs (no relayed vote for ANY gauge that week, not
   just no *eligible* one): a Curve gauge vote is a standing weight, not re-cast
   weekly, so once relayed it keeps recurring across the same small handful of
   gauges — confirmed live against the account below, which had a relayed vote
   for 2-13 gauges in EVERY one of the 21+ most recent weekly epochs checked. An
   account with no Votemarket history at all still costs exactly one epoch's
   worth of calls, same as before this scope was added.
     This past-epoch scan was what caught the original bug: fetchVotemarket()
   originally checked ONLY the current epoch, so a real unclaimed reward sitting
   in a past epoch (well within the 24-week window) silently showed as "none".
   Verified live against the same account as the Claim-event check above —
   0xf147b8125D2eF93Fb6965Db97D6746952a133934 had THREE genuinely unclaimed
   rewards (totalClaimedByAccount == 0) sitting in epoch 1773273600 (2026-03-12,
   21 weeks before the then-current epoch), invisible to the old code and now
   correctly surfaced: campaign 1197 (pWFRAX) net 1442.065814, campaign 1225
   (pASF) net 12417.329055, campaign 1227 (popASF) net 33112.877481 — all on
   platform 0x8c2c5A29...D14D9, all fee-adjusted at the platform's 4% default.
     PERFORMANCE: the 24-epoch scan above is real necessary work for an active
   voter, but it made the ~260-gauge votedSlopeByEpoch fan-out up to 25x bigger
   (up to ~6,500 individual eth_calls) — confirmed live as a severe regression:
   against the same whale account below, the scan was still issuing new
   requests after several minutes and the tab became unresponsive (a plain
   document.body.innerText read timed out at 30s). Fixed by routing every
   fan-out in this function (the votedSlopeByEpoch check, getPeriodPerCampaign/
   totalClaimedByAccount for eligible claim jobs, and customFeeByManager) through
   multicall() — Multicall3's aggregate3, batching up to MULTICALL_CHUNK_SIZE
   calls into a single eth_call (see the MULTICALL3 comment above `const
   MULTICALL3` for the encode/decode verification). This turns each epoch's
   260-gauge check into ONE request instead of 260, so the whole 25-epoch walk
   costs on the order of 25 requests for the slope phase, not up to 6,500. The
   epoch loop itself is intentionally left sequential (unbatched across epochs)
   — the two-consecutive-empty-epoch early stop needs each epoch's result
   before deciding whether the next one is worth fetching, so batching WIDENED
   each step instead of trying to collapse the STEPS, which would have required
   giving up the early-stop optimization entirely.
     Verified: encodeAggregate3/decodeAggregate3 cross-checked byte-for-byte
   against ethers.Interface.encodeFunctionData/AbiCoder.decode in a scratchpad
   (empty/exact-32-byte/unaligned/260-call/2000-call inputs), and Multicall3
   itself confirmed live on Arbitrum (eth_getCode returns real bytecode at
   0xcA11bde05977b3631167028862bE2a173976CA11; a live aggregate3 batch of 260
   real votedSlopeByEpoch calls for the whale account below decoded to results
   byte-identical to the same calls made individually). End-to-end: the shipped
   fetchVotemarket(), run live in the Browser pane against
   0xf147b8125D2eF93Fb6965Db97D6746952a133934, completed the full un-short-
   circuited 25-epoch scan (1987 campaigns / 260 gauges, no early stop — this
   account has relayed votes most weeks) and reproduced the exact pASF/popASF
   net amounts documented above (12,417.3290 / 33,112.8774) on repeated runs,
   confirming the batching changed nothing but speed. Steady-state cost per
   epoch: a single 260-call votedSlopeByEpoch multicall batch measured
   130-550ms live against Arbitrum's public RPC in isolation (vs. 260 separate
   round-trips before) — the one full end-to-end browser run's wall-clock time
   came out much higher than that because this session ran inside a heavily
   shared, multi-agent RPC/browser environment (visible 429s and retries in the
   log) and isn't a clean single-user baseline; the per-request collapse from
   up to ~6,500 down to roughly 30 is the number that actually matters and
   holds regardless of ambient network conditions. One correctness gap found
   and fixed
   along the way: publicRpc() only retried on network-level fetch failures, not
   on a 429 JSON-RPC error response — harmless before (a dropped individual
   gauge call), but now a single unretried 429 on an epoch's multicall zeroes
   out that WHOLE epoch's touched-gauge count at once, risking a false early
   stop. Caught via a direct comparison against an independent ground-truth
   script (individual per-gauge calls) that disagreed with one batched test
   run; publicRpc() now retries 429s the same way it already retried dropped
   fetches (see publicRpc() below), and a follow-up run reproduced the
   ground-truth touched-gauge counts exactly (34-43 of 260 per epoch, zero
   failures). */
export function resetCash() {
  const totalEl = $('#cash-total');
  const listEl = $('#cash-list');
  if (!totalEl || !listEl) return;
  totalEl.classList.remove('is-ready');
  totalEl.innerHTML = '';
  totalEl.appendChild(spinnerNode(14));
  listEl.innerHTML = '';
}

// The Cash card's own Refresh button — independent of #refresh-portfolio, since Cash is a
// completely separate read (wallet stablecoin balances, not protocol claims; see
// fetchCashBalances()'s own comment) that shouldn't need a full portfolio refresh just to
// re-check. A plain in-flight guard (not the myGen/refreshGeneration machinery
// renderPortfolio() uses) is enough here: there's no multi-protocol fan-out to cancel
// mid-flight, just one read that either finishes or doesn't.
export let cashRefreshInFlight = false;
export async function refreshCash() {
  if (cashRefreshInFlight) return;
  cashRefreshInFlight = true;
  resetCash();
  try {
    const result = state.account ? await fetchCashBalances(state.account) : buildDemoCashResult();
    renderCash(result);
  } catch (err) {
    logErr('cash balance refresh failed', err);
    renderCash({ status: 'error', totalUsd: 0, tokens: [] });
  } finally {
    cashRefreshInFlight = false;
  }
}

// Header "alpha" icon strip (#alpha-icons, index.html, between .brand and
// .header-actions) — one icon per protocol currently carrying a nonzero
// claimUsd ("alpha" = something worth claiming), reusing the exact same
// ICONS/proto.icon assets each protocol row already renders (no new icon
// assets). Wired in right alongside renderPortfolioTotal(results) in both
// renderPortfolio() and startDemoMode() — same "final snapshot once every
// protocol has settled" pattern, not an incremental per-protocol update.
// Icons are logos, not sensitive text, so they intentionally do NOT route through
// setSensitiveText()/privacy mode — the existing convention only masks real addresses/amounts.
// Judgment call worth noting: which protocols currently have *something* claimable is technically
// a sliver of information privacy mode could be read as intending to hide, but it reveals no
// amounts, addresses, or holdings (a zero-claim protocol renders no icon at all, privacy mode or
// not) — closer to a status indicator than sensitive data.
