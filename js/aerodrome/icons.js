import { AERODROME, AERODROME_CLAIM } from '../protocols/config.js';

// Built lazily (not as a module-load-time object literal) because AERODROME_CLAIM/AERODROME
// come from protocols/config.js, which sits in a large circular-import cluster with this file
// (config.js -> aerodrome/claim.js -> aerodrome/demo.js -> ... -> aerodrome/icons.js -> config.js,
// among others) — evaluating these computed keys at module scope raced config.js's own
// initialization and threw "Cannot access 'AERODROME_CLAIM' before initialization".
let _tokenIconAddr = null;
function tokenIconAddrMap() {
  if (!_tokenIconAddr) {
    _tokenIconAddr = {
      '0x4200000000000000000000000000000000000006': '0x4200000000000000000000000000000000000006', // WETH
      [AERODROME_CLAIM.usdc.toLowerCase()]: AERODROME_CLAIM.usdc, // USDC
      [AERODROME.token.toLowerCase()]: AERODROME.token, // AERO
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
    };
  }
  return _tokenIconAddr;
}

// 1inch's Base token list is keyed by lowercase-tolerant addresses and ships a ready-to-use
// logoURI per token — no checksum computation needed — so it covers far more tokens (cbBTC and
// most listed long-tail tokens included) than the hardcoded Trust Wallet map above. Fetched once
// and cached; anything still unresolved after that (unlisted/very-new tokens) legitimately has no
// icon rather than a guessed or fabricated URL.
export const AERODROME_DYNAMIC_ICON_CACHE = new Map(); // lowercase addr -> logoURI
export let aerodromeDynamicIconsPromise = null;
export const aerodromeIconRefreshCallbacks = [];

export function loadAerodromeDynamicIcons() {
  return loadTokenIconsForChain(8453);
}

/* The same 1inch list endpoint, for any chain id — `/v1.2/<chainId>`. Generalised because the
   Cash card's stablecoins are mostly ETHEREUM-MAINNET addresses, and this cache was previously
   Base-only, so every Cash row resolved to no icon at all while the Portfolio cards and both
   claim panels had them. Verified: none of Cash's five symbols (crvUSD, scrvUSD, USDC, USDT, DAI)
   appear in the Base list or in `ICONS`, which holds protocol logos only.
   One shared address->logoURI cache across chains rather than one per chain: a token's logo is a
   property of the token, and addresses do not collide meaningfully across chains here. Each chain
   is fetched at most once, and every in-flight refresh callback fires when any fetch settles, so
   a row built before its chain's list arrives still picks up an icon.
   `tokens.1inch.io` is already in the CSP's connect-src (this fetch) and img-src (the logoURI it
   returns) — adding a chain needs no CSP change, but a DIFFERENT host would. */
const chainIconPromises = new Map();

export function loadTokenIconsForChain(chainId) {
  const key = Number(chainId);
  if (!chainIconPromises.has(key)) {
    const p = fetch(`https://tokens.1inch.io/v1.2/${key}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        for (const addr of Object.keys(data || {})) {
          const url = data[addr]?.logoURI;
          if (url) AERODROME_DYNAMIC_ICON_CACHE.set(addr.toLowerCase(), url);
        }
      })
      .catch(() => {})
      .finally(() => {
        /* Re-queue callbacks that still cannot resolve, instead of draining them all. With one
           chain this was equivalent; with several it silently lost icons: the callbacks are shared,
           so whichever list settles FIRST consumed every pending retry, including rows whose own
           chain had not loaded yet — those rows then stayed iconless forever with nothing logged.
           That is exactly what kept every Cash row blank while the cache itself held the icons.
           trySet() returns false when the address is still unknown, which is the signal to wait
           for another chain's list rather than give up. */
        for (const cb of aerodromeIconRefreshCallbacks.splice(0)) {
          if (!cb()) aerodromeIconRefreshCallbacks.push(cb);
        }
      });
    chainIconPromises.set(key, p);
    // Preserved so existing readers of this binding (and the Base-only contract they assume)
    // keep working unchanged.
    if (key === 8453) aerodromeDynamicIconsPromise = p;
  }
  return chainIconPromises.get(key);
}

export function aerodromeTokenIconUrl(addr) {
  const key = String(addr).toLowerCase();
  const dynamic = AERODROME_DYNAMIC_ICON_CACHE.get(key);
  if (dynamic) return dynamic;
  const checksummed = tokenIconAddrMap()[key];
  return checksummed
    ? `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/${checksummed}/logo.png`
    : null;
}

// Sets an <img>'s icon for `addr` if already known; otherwise defers via the dynamic list fetch
// (kicked off lazily, shared across every caller) and retries once it resolves, so rows built
// before the fetch completes still pick up an icon rather than staying hidden forever.
export function applyTokenIcon(imgEl, addr) {
  const trySet = () => {
    const url = aerodromeTokenIconUrl(addr);
    if (url) {
      imgEl.src = url;
      imgEl.hidden = false;
      return true;
    }
    return false;
  };
  if (!trySet()) {
    aerodromeIconRefreshCallbacks.push(trySet);
    loadAerodromeDynamicIcons();
  }
  return trySet;
}

// EIP-1193's own error code for "the user declined to sign this in their wallet" — not a real
// failure of anything, just a changed mind or a misclick, and this app's own connect flow
// already carries the same 4001 convention (see connectWith()'s catch comment). Worth treating
// differently from every other error a transaction can throw: a revert or an RPC failure means
// something is actually wrong and blindly resending is a bad idea, but a rejection means nothing
// on-chain was attempted at all — there is nothing unsafe about just asking again.
