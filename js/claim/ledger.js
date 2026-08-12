import { AERODROME, AERODROME_CLAIM, CURVE } from '../protocols/config.js';
import { portfolioResults } from '../main.js';
import { priceTokensUsd } from '../rpc-waterfall.js';
import { isAtomicCapable } from '../tx/send.js';
import { short, usd } from '../core/utils.js';

export const SKIP_REASON_TEXT = {
  'no-route': 'no USDC route found (direct or via WETH/AERO/USDbC) — will not be swapped',
  'quote-failed': 'price quote failed — will not be swapped',
};

// This panel is only ever opened from the Aerodrome claim flow; named so the cross-check against
// the portfolio card below reads as a lookup rather than a magic string.
export const CLAIM_PREVIEW_PROTOCOL_ID = 'aerodrome';

// The portfolio card's OWN reduction of the same on-chain rewards, as currently rendered in the
// expanded protocol row. Used purely to cross-check this panel against what the user is already
// looking at — the panel still derives every figure it displays itself, for two reasons:
//
//   * claimList entries carry no token address and no decimals, only a symbol, a lossy
//     already-rounded `amount` STRING and a USD value — so they can't be keyed back to the
//     plan's raw per-token bigints, and the string is never usable for arithmetic.
//   * The card's USD values were priced at the last portfolio refresh; this panel's swap/bridge
//     quotes are priced now. Mixing the two snapshots would make the reconciliation stop adding
//     up (refresh-to-preview price drift would masquerade as swap price impact), so the ledger
//     uses one consistent snapshot and the DIFFERENCE against the card is surfaced explicitly
//     instead — see the cross-check in applyLedger().
//
// Returns null (never throws) before the first refresh, when the protocol has no entry, or when
// its fetch failed — `portfolioResults` is `{}` at boot and a failed protocol has no claimList.
export function toClaimSnapshot(r) {
  if (!r || r.status !== 'ok') return null;
  const list = Array.isArray(r.claimList) ? r.claimList : [];
  return {
    claimUsd: typeof r.claimUsd === 'number' ? r.claimUsd : null,
    symbols: new Set(list.map((c) => c.symbol)),
  };
}

export function cardClaimSnapshot(protoId) {
  return toClaimSnapshot(portfolioResults?.[protoId]);
}

// Duck-typed rather than `instanceof Map` — the check is only about "can this be iterated as
// token -> amount", and a plain instanceof would also silently fail for a Map-like built
// elsewhere. Returns an empty Map (never throws) when the field is missing or the wrong shape.
export function claimTokenTotals(preview) {
  const m = preview?.plan?.tokenTotals;
  return (m && typeof m.get === 'function' && typeof m.entries === 'function') ? m : new Map();
}

// Prices a claim preview and reduces it to the single ledger that BOTH of the panel's
// value-bearing sections read from: the per-token "what am I actually claiming" list, and the
// claimed → consolidated → bridged → delivered reconciliation that explains why the crvUSD
// landing on mainnet is less than the dollar figure on the Aerodrome card.
//
// Rules this function is built around:
//   * Every figure is DERIVED from `preview`. Nothing is assumed, defaulted, or back-filled.
//   * A figure that genuinely isn't available (a quote that failed, a token DefiLlama has no
//     price for) comes back as `null`, never 0 — a misleading zero in a money ledger is worse
//     than an honest "unavailable", and the panel renders nulls as a reason, not a number.
//   * Every USD figure comes from ONE price snapshot taken here, so the ledger's lines actually
//     add up (see cardClaimSnapshot() for why the card's older per-token values aren't mixed in).
//   * Amounts are converted with each token's OWN decimals as reported by priceTokensUsd().
//     This is the cbBTC case specifically: 8 decimals, and assuming 18 once rendered a real
//     $386 balance as "0.0000". When decimals are unknown (the metadata read itself failed)
//     the amount is reported as unavailable rather than guessed.
//   * Never rejects — a total pricing outage yields an all-null ledger so the user can still
//     read the transaction structure and Confirm or Cancel.
//
// Written defensively against `preview` gaining/losing fields (it's built by a different part
// of this file and is actively changing): every field is probed, never destructured blindly.
export async function priceClaimPreview(preview) {
  const totals = claimTokenTotals(preview);
  const usdcAddr = AERODROME_CLAIM.usdc.toLowerCase();
  // USDC is always priced even when it isn't one of the claimed tokens — every leg from the
  // swap output onwards is denominated in it.
  const priceList = [...new Set([...totals.keys()].map((t) => String(t).toLowerCase()).concat(usdcAddr))];

  // buildAerodromeClaimPreview() already ran this exact batched lookup, for this exact token
  // set, moments ago (see its own `pricedTokens` comment) — reused here rather than re-fetched:
  // one fewer network round trip on top of everything the busy dialog already did, and it means
  // the ledger isn't pricing the SAME tokens from TWO different snapshots taken seconds apart.
  // Only trusted when it actually covers every token this ledger needs; falls back to fetching
  // fresh (exactly as before) for an older preview shape or a failed early fetch.
  const reusablePricing = preview?.pricedTokens && priceList.every((addr) => addr in preview.pricedTokens);

  // Two independent lookups (Base reward tokens, mainnet crvUSD) fired together — allSettled,
  // not all, so one failing can't blank out the half of the ledger the other would have filled.
  const [baseRes, crvRes] = await Promise.allSettled([
    reusablePricing ? Promise.resolve(preview.pricedTokens) : priceTokensUsd(priceList, AERODROME.priceChain),
    priceTokensUsd([CURVE.crvUsd], 'ethereum'),
  ]);
  const priced = baseRes.status === 'fulfilled' ? baseRes.value : {};
  const crvMeta = crvRes.status === 'fulfilled' ? crvRes.value[CURVE.crvUsd] : null;

  const meta = (addr) => (addr ? priced[String(addr).toLowerCase()] : null) || null;
  // null (not 0) whenever we lack a price OR real decimals for the token — see the header.
  const usdOf = (addr, raw) => {
    const m = meta(addr);
    if (!m || m.price == null || m.decimals == null || raw == null) return null;
    return (Number(raw) / 10 ** m.decimals) * m.price;
  };

  const usdcMeta = meta(usdcAddr);
  // Both the Base-side and mainnet-side USDC legs are valued with this one price. They are the
  // same asset either side of the bridge, so a second cross-chain lookup would only introduce
  // feed noise into a leg whose entire point is that it's 1:1 — the bridge fee below is taken
  // from Across's own quoted input/output amounts, not inferred from a price difference.
  const usdcUsd = (raw) => (usdcMeta?.price == null || usdcMeta?.decimals == null || raw == null
    ? null
    : (Number(raw) / 10 ** usdcMeta.decimals) * usdcMeta.price);

  // --- claimed ---------------------------------------------------------------------------
  const tokens = [...totals.entries()].map(([addr, amount]) => {
    const m = meta(addr);
    return {
      addr: String(addr).toLowerCase(),
      symbol: m?.symbol || short(addr),
      decimals: m?.decimals ?? null,
      amount,
      usd: usdOf(addr, amount),
    };
  });
  // Largest position first; anything we couldn't price sorts to the bottom (USD values are
  // never negative, so -1 is a safe "unknown" sentinel and keeps the comparator NaN-free).
  tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const claimedUnpriced = tokens.filter((t) => t.usd == null).length;
  // A partial sum when claimedUnpriced > 0 — the panel labels it as such rather than passing
  // it off as the whole total.
  const claimedUsd = tokens.length ? tokens.reduce((sum, t) => sum + (t.usd ?? 0), 0) : null;

  // --- skipped (claimed, but never swapped or bridged) ------------------------------------
  const skipped = Array.isArray(preview?.skipped) ? preview.skipped : [];
  const skippedRows = skipped.map((s) => {
    const addr = String(s.token).toLowerCase();
    const m = meta(addr);
    const amount = totals.get(addr) ?? null;
    return { ...s, addr, symbol: m?.symbol || short(addr), decimals: m?.decimals ?? null, amount, usd: usdOf(addr, amount) };
  });
  const skippedUnpriced = skippedRows.filter((r) => r.usd == null).length;
  const skippedUsd = skippedRows.length ? skippedRows.reduce((sum, r) => sum + (r.usd ?? 0), 0) : null;

  // --- consolidated to USDC ---------------------------------------------------------------
  const swapSteps = Array.isArray(preview?.swapSteps) ? preview.swapSteps : [];
  const swapRows = swapSteps.map((s) => {
    const addr = String(s.token).toLowerCase();
    const m = meta(addr);
    return { step: s, addr, symbol: m?.symbol || short(addr), usd: usdOf(addr, s.amount) };
  });
  const directUsdc = preview?.directUsdc ?? 0n;
  const directUsdcUsd = directUsdc > 0n ? usdcUsd(directUsdc) : 0;
  // Spot (DefiLlama) value of everything that DOES go into the consolidation — the baseline the
  // quoted swap output is compared against to isolate price impact.
  const consolidatedUnpriced = swapRows.filter((r) => r.usd == null).length + (directUsdcUsd == null ? 1 : 0);
  const consolidatedInUsd = consolidatedUnpriced
    ? null
    : swapRows.reduce((sum, r) => sum + r.usd, directUsdcUsd);

  // preview.estimatedUsdc already includes directUsdc (see buildAerodromeClaimPreview).
  const quotedUsdcOutUsd = usdcUsd(preview?.estimatedUsdc ?? null);
  const swapImpactUsd = (quotedUsdcOutUsd != null && consolidatedInUsd != null)
    ? quotedUsdcOutUsd - consolidatedInUsd
    : null;

  // --- bridge -------------------------------------------------------------------------------
  const aq = preview?.acrossQuote || null;
  const bridgeFeeRaw = (aq && aq.inputAmount != null && aq.outputAmount != null)
    ? aq.inputAmount - aq.outputAmount
    : null;
  const bridgeFeeUsd = bridgeFeeRaw == null ? null : usdcUsd(bridgeFeeRaw);
  const usdcOnMainnetUsd = aq ? usdcUsd(aq.outputAmount) : null;

  // --- delivered ----------------------------------------------------------------------------
  const deliveredRaw = preview?.curveQuote ?? null;
  const deliveredUsd = (deliveredRaw == null || crvMeta?.price == null || crvMeta?.decimals == null)
    ? null
    : (Number(deliveredRaw) / 10 ** crvMeta.decimals) * crvMeta.price;
  const curveDeltaUsd = (deliveredUsd != null && usdcOnMainnetUsd != null) ? deliveredUsd - usdcOnMainnetUsd : null;

  // Only meaningful as "the whole gap" when the claimed side is fully priced — otherwise it
  // would silently understate the difference by the value of the tokens we couldn't price.
  const netUsd = (deliveredUsd != null && claimedUsd != null && !claimedUnpriced) ? deliveredUsd - claimedUsd : null;
  const netPct = (netUsd != null && claimedUsd > 0) ? (netUsd / claimedUsd) * 100 : null;

  return {
    tokens, claimedUsd, claimedUnpriced,
    skippedRows, skippedUsd, skippedUnpriced,
    swapRows, consolidatedInUsd, quotedUsdcOutUsd, swapImpactUsd,
    bridgeFeeRaw, bridgeFeeUsd, usdcOnMainnetUsd,
    deliveredRaw, deliveredDecimals: crvMeta?.decimals ?? null, deliveredUsd, curveDeltaUsd,
    netUsd, netPct,
    usdcDecimals: usdcMeta?.decimals ?? null,
  };
}

// The ordered list of labels for every transaction executeAerodromeClaim() will actually send,
// used by showClaimPreviewPanel to render the numbered execution list the MOMENT Confirm is
// clicked — before any transaction is sent — and structurally mirrors executeAerodromeClaim()'s
// own control flow exactly (same atomic-vs-sequential branch, same per-swap-step/per-leg
// nesting) so the step COUNT and ORDER can never drift from what actually runs: change one,
// change the other the same way. A step's exact on-chain AMOUNT can still move between this
// label and execution (a multi-hop leg's second half is re-quoted live, the bridge amount is
// re-derived from the real post-swap balance) — that's fine, the label only needs to name WHICH
// transaction is coming, not its final number.
// Each label is `{ parts }` — text interleaved with token references — rather than a plain
// string, so showClaimPreviewPanel can render every token as a name + icon instead of a raw
// address (see buildExecutionStepRow()). `{ t: 'token', addr }` for a token reference, `{ t:
// 'text', v }` for everything else; joined in order they reconstruct the exact same sentence
// the old plain-string version produced.
export const TXT = (v) => ({ t: 'text', v });
export const TOK = (addr) => ({ t: 'token', addr });

// Stable identity key for one execution-list label — used by rebuildTransactionsList() (inside
// showClaimPreviewPanel) to diff the previous and next label sets so a checkbox toggle only adds/
// removes the rows that actually changed, instead of tearing down and rebuilding the whole list.
// Built from the label's own content (text + token addresses), not its position, since position
// is exactly what's allowed to change — a step shifting up when an earlier one is removed isn't
// "a different transaction", it's the same one at a new index.
export function execStepLabelKey(label) {
  return label.parts.map((p) => (p.t === 'text' ? `T:${p.v}` : `K:${p.addr.toLowerCase()}`)).join('|');
}

export function aerodromeExecutionLabels(preview) {
  const labels = [];
  if (isAtomicCapable(preview.atomicClaimSwap) && preview.swapSteps.length) {
    labels.push({ parts: [TXT('Claim + consolidate to USDC (1 batched transaction)')] });
  } else {
    for (const tx of preview.claimTxs) labels.push({ parts: [TXT(tx.label || 'claim')] });
    for (const step of preview.swapSteps) {
      for (const leg of step.legs) {
        labels.push({ parts: [TXT('Approve '), TOK(leg.tokenIn)] });
        labels.push({ parts: [TXT('Swap '), TOK(leg.tokenIn), TXT(' → '), TOK(leg.tokenOut)] });
      }
    }
  }
  if (preview.estimatedUsdc > 0n) {
    labels.push({ parts: [TXT('Approve '), TOK(AERODROME_CLAIM.usdc), TXT(' → Across bridge')] });
    labels.push({ parts: [TXT('Bridge to Ethereum mainnet + swap to crvUSD')] });
  }
  return labels;
}

// Trust Wallet's asset CDN requires the EIP-55 CHECKSUMMED address in the URL path — confirmed
// live that an all-lowercase address 404s even though on-chain address comparisons are
// case-insensitive — and this app deliberately does not ship a Keccak-256 implementation just to
// compute that checksum generally (see this file's standing "no crypto library, no ethers ships
// to the browser" convention). It only covers this small hardcoded set as a result.
