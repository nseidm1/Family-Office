import { AGGREGATE3_SELECTOR } from '../protocols/config.js';

export const $ = (sel) => document.querySelector(sel);

/* ---------- theme ---------- */
// Applied immediately (right here, before anything else runs) to keep the
// window between "CSS paints its default dark :root" and "we correct it" as
// short as possible. Explicit user choice lives in localStorage under
// THEME_KEY; absent that, we follow the OS's prefers-color-scheme and keep
// following it live (see the matchMedia listener wired near privacy-toggle
// below) until the user makes an explicit choice, matching the "OS default
// until overridden" behavior the eye/privacy toggle doesn't need but this
// one does.

export function iconSvg(letter, color, fontSize) {
  const size = fontSize || (letter.length > 1 ? 10 : 13);
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${color}"/><text x="12" y="16" font-family="ui-monospace,monospace" font-size="${size}" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  );
}

// Real protocol logos, sourced from DefiLlama's icon CDN (icons.llamao.fi —
// this app already talks to DefiLlama for pricing, so this is the same trust
// boundary) and re-encoded as small (48x48 or less) inline base64 PNG data
// URIs so nothing external loads at runtime and both usage sites (protocol
// card rows via PROTOCOLS[].icon/buildProtocolNode(), and the header's
// bouncing alpha icons via renderAlphaIcons()) render identically from this
// single source of truth. Cross-checked each icon against an independent
// second source before embedding: curve's icon matches curve.fi's own
// favicon.ico exactly (the rainbow 3D-surface mark is genuinely Curve's
// brand, not a placeholder); yieldbasis/clever/concentrator match the same
// project's CoinGecko coin-image listing (yield-basis, clever-token, CTR);
// aerodrome/velodrome are Sugar-codebase sibling protocols whose DefiLlama
// marks match their known brand swoosh/infinity marks. All six PNGs total
// ~16KB raw / ~22KB base64 — negligible for this static page.
export const LOG_MAX_LINES = 500;

/* Per-line character cap. Batching alone (above) was necessary but NOT sufficient: a single
   Multicall3 request line stringifies the whole encoded aggregate3 payload, which for
   Votemarket's 260-gauge fan-out measured ~146KB for ONE line — at LOG_MAX_LINES that's ~72MB
   of text nodes in the log element, which wrecks layout and starves the main thread all over
   again no matter how few times it's flushed. Truncating at the single choke point in log()
   covers every caller (publicRpc's request/response lines, rpc()'s JSON.stringify(result),
   anything added later) rather than needing each call site to remember. The retained head keeps
   what's actually diagnostic — chain, method, selector, and the start of the params — and the
   suffix states the real length so a truncated line is never mistaken for a short payload. */
export const LOG_MAX_CHARS = 400;
export let logQueue = [];
export let logFlushScheduled = false;
export let logFlushRaf = 0;
export let logFlushTimer = 0;

export function flushLog() {
  logFlushScheduled = false;
  cancelAnimationFrame(logFlushRaf);
  clearTimeout(logFlushTimer);
  const el = $('#log');
  if (!el || !logQueue.length) { logQueue = []; return; }
  // One layout read for the whole batch, taken BEFORE inserting anything.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  // Only the lines that will actually survive the cap are worth building/formatting — a burst
  // bigger than LOG_MAX_LINES would otherwise pay to create nodes that are removed moments later.
  const pending = logQueue.length > LOG_MAX_LINES ? logQueue.slice(-LOG_MAX_LINES) : logQueue;
  logQueue = [];

  const frag = document.createDocumentFragment();
  let lastSecond = -1;
  let lastStamp = '';
  for (const { msg, kind, at } of pending) {
    const line = document.createElement('div');
    line.className = 'line';
    const t = document.createElement('span');
    t.className = 't';
    // toLocaleTimeString is comparatively expensive and only has 1-second resolution, so reuse
    // the previous stamp for every line landing within the same second (the common case in a
    // burst of hundreds of RPC log lines).
    const sec = Math.floor(at / 1000);
    if (sec !== lastSecond) {
      lastSecond = sec;
      lastStamp = new Date(at).toLocaleTimeString('en-US', { hour12: false });
    }
    t.textContent = lastStamp;
    const body = document.createElement('span');
    body.className = kind;
    body.textContent = msg;
    line.append(t, body);
    frag.appendChild(line);
  }
  el.appendChild(frag);

  // Unbounded growth is what made each reflow progressively worse; keep the newest lines only.
  while (el.childElementCount > LOG_MAX_LINES) el.removeChild(el.firstElementChild);

  if (atBottom) el.scrollTop = el.scrollHeight;
}

export function log(msg, kind = 'info') {
  // Deliberately does no DOM work and no date formatting — see flushLog(). This runs on the
  // hot path of every single RPC request/response. Truncation happens HERE rather than in
  // flushLog so an oversized string is dropped before it can sit in the queue holding memory.
  const text = msg.length > LOG_MAX_CHARS
    ? `${msg.slice(0, LOG_MAX_CHARS)}… [+${msg.length - LOG_MAX_CHARS} chars]`
    : msg;
  logQueue.push({ msg: text, kind, at: Date.now() });
  // A backgrounded/hidden tab never fires requestAnimationFrame, so the queue would grow
  // without bound and nothing would ever paint — the same "don't rely on a frame/animation
  // callback alone" lesson this file already learned with Animation.onfinish in
  // setAccordionOpen(). Trim to the cap here (the tail is all that could survive flushLog
  // anyway) and back rAF with a timer that DOES fire while hidden.
  if (logQueue.length > LOG_MAX_LINES) logQueue = logQueue.slice(-LOG_MAX_LINES);
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  logFlushRaf = requestAnimationFrame(flushLog);
  logFlushTimer = setTimeout(flushLog, 250);
}

export function logErr(prefix, err) {
  // EIP-1193 errors carry a numeric code; surface it, it's the useful part.
  const code = err && err.code !== undefined ? ` [code ${err.code}]` : '';
  log(`${prefix}: ${(err && err.message) || err}${code}`, 'err');
}

/* ---------- formatting ---------- */

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
export function formatUnits(value, decimals = 18, places = 4) {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, places);
  return `${(v / base).toLocaleString('en-US')}.${frac}`;
}

export const formatEther = (hexWei) => `${formatUnits(hexWei, 18, 6)} ETH`;

export function formatUnlock(end) {
  if (!end) return 'no active lock';
  const iso = new Date(end * 1000).toISOString().slice(0, 10);
  const days = Math.round((end * 1000 - Date.now()) / 86_400_000);
  return days > 0 ? `${iso} · ${days}d left` : `${iso} · expired`;
}

/* ---------- privacy ---------- */

export function fadeInSwap(el, updateFn) {
  el.classList.remove('value-fade-in');
  void el.offsetWidth; // eslint-disable-line no-unused-expressions
  updateFn();
  el.classList.add('value-fade-in');
}

export const encodeAddress = (addr) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// int128 comes back sign-extended across the full 256-bit word.
export function toSigned(v) {
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export function wordHex(data, i) {
  const hex = data.slice(2 + i * 64, 2 + (i + 1) * 64);
  if (hex.length < 64) throw new Error(`short return: expected word ${i}, got "${data}"`);
  return hex;
}

export const word = (data, i) => BigInt('0x' + wordHex(data, i));
export const addrAt = (data, i) => '0x' + wordHex(data, i).slice(24);
export const encodeUint256 = (n) => BigInt(n).toString(16).padStart(64, '0');

// Decodes a plain ERC20 symbol()/name() ABI string return.
export function decodeString(data) {
  try {
    const offsetWords = Number(word(data, 0)) / 32;
    const len = Number(word(data, offsetWords));
    const start = 2 + (offsetWords + 1) * 64;
    const bytes = data.slice(start, start + len * 2).match(/.{2}/g) || [];
    return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
  } catch {
    return null;
  }
}

/* Decodes VeSugar.byAccount()'s `VeNFT[]` return. VeNFT is a dynamic-size tuple
   (it contains a nested `votes` array), so each array element is reached via an
   offset rather than sitting inline — see the ABI spec's head/tail rules for
   dynamic tuples. Field layout and offsets verified against raw chain bytes,
   cross-checked byte-for-byte against ethers' decoder before shipping. */
export function decodeVeNFTArray(data) {
  const arrayStart = Number(word(data, 0)) / 32;
  const len = Number(word(data, arrayStart));
  const elementsBase = arrayStart + 1;
  const out = [];

  for (let i = 0; i < len; i++) {
    const elemStart = elementsBase + Number(word(data, elementsBase + i)) / 32;
    // Fields: id, account, decimals, amount, voting_amount, governance_amount,
    // rebase_amount, expires_at, voted_at, votes(dynamic), token, permanent, delegate_id, managed_id
    const votesStart = elemStart + Number(word(data, elemStart + 9)) / 32;
    const votesLen = Number(word(data, votesStart));
    const votes = [];
    for (let v = 0; v < votesLen; v++) {
      const base = votesStart + 1 + v * 2; // LpVotes{lp, weight} is static -> inline
      votes.push({ lp: addrAt(data, base), weight: word(data, base + 1) });
    }

    out.push({
      id: word(data, elemStart),
      amount: word(data, elemStart + 3), // uint128, zero-extended — safe to read as unsigned
      rebaseAmount: word(data, elemStart + 6),
      expiresAt: Number(word(data, elemStart + 7)),
      permanent: word(data, elemStart + 11) !== 0n,
      votes,
    });
  }
  return out;
}

// Decodes RewardsSugar's `Reward[]` return — shared by rewardsByAddress() (vote-filtered) and
// rewards() (full-pool-enumeration, see the POOL_REWARDS comment above). Reward is an
// all-static-fields tuple (struct Reward: venft_id: uint256, lp: address, amount: uint256,
// token: address, fee: address, bribe: address — confirmed against RewardsSugar.vy fetched fresh
// from velodrome-finance/sugar), so elements sit inline after the length word — no per-element
// offsets needed. Verified against raw chain bytes the same way. `venftId`/`fee`/`bribe` are
// included alongside `lp`/`amount`/`token` (not originally needed when this only fed read-only $
// totals) so claim-transaction construction (see buildAerodromeClaimPlan()) can group claimable
// rewards by exactly which Fee/Bribe contract + veNFT they need to be claimed through — those are
// the same contract addresses Voter.claimFees()/claimBribes() take directly.
export function decodeRewardArray(data) {
  const arrayStart = Number(word(data, 0)) / 32;
  const len = Number(word(data, arrayStart));
  const out = [];
  for (let i = 0; i < len; i++) {
    const base = arrayStart + 1 + i * 6; // venft_id, lp, amount, token, fee, bribe
    out.push({
      venftId: word(data, base + 0),
      lp: addrAt(data, base + 1),
      amount: word(data, base + 2),
      token: addrAt(data, base + 3),
      fee: addrAt(data, base + 4),
      bribe: addrAt(data, base + 5),
    });
  }
  return out;
}

// Decodes FeeDistributor.preview_claim()'s `(address[] tokens, uint256[] amounts)`
// return — two independent dynamic arrays, so two head words (offsets) each
// pointing to their own [length, elements...] block; elements are addresses/
// uint256s, both static, so they sit inline. Verified byte-for-byte against
// ethers' AbiCoder.decode(['address[]','uint256[]'], ...) on a live response.
export function decodePreviewClaim(data) {
  const tokensStart = Number(word(data, 0)) / 32;
  const amountsStart = Number(word(data, 1)) / 32;
  const len = Number(word(data, tokensStart));
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push({ token: addrAt(data, tokensStart + 1 + i), amount: word(data, amountsStart + 1 + i) });
  }
  return out;
}

// Encodes Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
// by hand, same convention as every other encoder in this file. Call3 is a dynamic
// tuple (it contains a dynamic `bytes` field), so per the ABI spec each array element
// is reached via its own offset rather than sitting inline — same shape as
// decodeVeNFTArray's `votes`, just on the encode side.
// allowFailure is always hardcoded true: multicall itself must never revert just
// because one sub-call does (matches the old per-call Promise.allSettled behavior
// this replaces — see multicall() below). Verified byte-for-byte against
// ethers.Interface.encodeFunctionData('aggregate3', ...) in a scratchpad across
// empty/exact-32-byte/unaligned/260-call/2000-call inputs, and live against
// Arbitrum's real Multicall3 deployment (see MULTICALL3 above).
export function encodeAggregate3(calls) {
  const n = calls.length;
  let out = encodeUint256(32) + encodeUint256(n); // single dynamic arg -> offset 0x20, then array length
  const tupleWords = calls.map((c) => {
    const cd = c.callData.replace(/^0x/, '');
    const lenBytes = cd.length / 2;
    const paddedWords = Math.ceil(lenBytes / 32) || 0;
    const dataPadded = cd.padEnd(paddedWords * 64, '0');
    // tuple head (3 words: target, allowFailure, offset-to-bytes=0x60) + bytes tail (length + padded data)
    return encodeAddress(c.target) + encodeUint256(1) + encodeUint256(96) + encodeUint256(lenBytes) + dataPadded;
  });
  let offsetWords = n; // offsets are relative to the start of the elements area, right after the n offset words
  let offsetsHex = '';
  for (const tw of tupleWords) {
    offsetsHex += encodeUint256(offsetWords * 32);
    offsetWords += tw.length / 64;
  }
  return '0x' + AGGREGATE3_SELECTOR + out + offsetsHex + tupleWords.join('');
}

// Decodes aggregate3's `(bool success, bytes returnData)[]` return — mirror image of
// encodeAggregate3 above (Result is also a dynamic tuple, elements reached via
// offset). Verified byte-for-byte against ethers.AbiCoder.decode() on fabricated
// multi-element returns (mixed success/failure, varying returnData lengths) and live
// against a real Arbitrum aggregate3 response.
export function decodeAggregate3(data) {
  const arrayStart = Number(word(data, 0)) / 32;
  const len = Number(word(data, arrayStart));
  const elementsBase = arrayStart + 1;
  const out = [];
  for (let i = 0; i < len; i++) {
    const elemStart = elementsBase + Number(word(data, elementsBase + i)) / 32;
    const success = word(data, elemStart) !== 0n;
    const bytesStart = elemStart + Number(word(data, elemStart + 1)) / 32;
    const byteLen = Number(word(data, bytesStart));
    const start = 2 + (bytesStart + 1) * 64;
    out.push({ success, returnData: '0x' + data.slice(start, start + byteLen * 2) });
  }
  return out;
}

/* ---------- EIP-6963 discovery ---------- */

export const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Each chain maps to an ORDERED LIST of endpoints, not a single URL — publicRpc()
// below rotates to the next one in the list on every retry (network failure or a
// 429), instead of hammering the same rate-limited endpoint 3x in a row. This is
// what actually fixed Votemarket's real live failure mode: its ~25-epoch scan
// fires enough back-to-back Multicall3 batches that arb1.arbitrum.io/rpc alone
// starts 429ing mid-scan, and a same-endpoint retry just gets 429'd again,
// tripping the "two consecutive empty epochs" early-stop on a false negative
// (confirmed live: a run truncated at 3 epochs during heavy concurrent load,
// where a direct un-batched sweep of the same epochs showed real touched-gauge
// data throughout — see the 429-retry comment in publicRpc() below for the
// original single-endpoint fix this builds on). Every fallback here was
// confirmed live via eth_chainId returning the expected chain ID before being
// added — a dead fallback would make things worse, not better. Single-entry
// lists (Lisk, Metal L2, Mode, Superseed, Swellchain) are chains where no
// second free public endpoint could be found working at the time of writing.
// Each chain's fallback list is deliberately wider than the minimum needed on a quiet day —
// widened 2026-08-09 after live testing surfaced Base's public RPC 429-ing under the burst of
// concurrent eth_calls the Aerodrome claim-preview's route-finding fires (see
// findAerodromeUsdcRoute()/findAerodromeMultiHopRoute()'s retry comment for the actual bug this
// exposed: a rate-limited multicall batch was silently indistinguishable from "no pool exists").
// Every URL below was confirmed live via a direct eth_chainId call (matching the chain's real ID)
// AND a real eth_call (Aerodrome's PoolFactory.getPool() for the drpc.org/blastapi.io additions)
// before being added — a dead or method-restricted fallback would make the rotation worse, not
// better. Confirmed NOT to work and deliberately excluded: rpc.ankr.com/* (needs an API key on
// every chain tried except Swellchain, see below), base.llamarpc.com (521), base.meowrpc.com
// (empty response), optimism-mainnet.public.blastapi.io (that provider killed Optimism support
// specifically — other chains' blastapi.io endpoints above are unaffected and still live).
//
// Re-audited 2026-08-10: every list below re-verified live (eth_chainId, 4 requests per URL) and
// REORDERED so the fastest/most consistently successful endpoint leads the rotation, not just
// whichever was added first — publicRpc() always tries index 0 first, so list order is real
// priority, not a flat set. 1rpc.io was, without exception, the slowest endpoint on every chain it
// appears on (293-690ms vs 60-175ms for everything else in the same test run) — kept as a
// fallback (it does work) but moved toward the end everywhere. blastapi.io passed this run's
// direct test cleanly but is independently confirmed flaky under real load (its own error message
// on an isolated 429 during this same audit cited Alchemy-backed "compute units per second"
// throttling — a hard ceiling that bites even light traffic, not a transient blip) — kept, but
// deliberately ranked below endpoints with no such known ceiling. Newly added below: a second
// endpoint for every chain that previously had only one (Lisk, Metal L2, Mode, Superseed) plus a
// second for Swellchain — drpc.org turned out to support all four single-entry chains (previously
// assumed not to, per the original comment's "no second free public endpoint could be found
// working at the time of writing" — re-checking found it works now), and thirdweb.rpc.com's
// per-chain-ID gateway (https://<chainId-decimal>.rpc.thirdweb.com) covers Swellchain, which
// neither drpc.org nor publicnode.com serve.
export function spinnerNode(sizePx = 14) {
  const el = document.createElement('span');
  el.className = 'spinner';
  el.style.setProperty('--spinner-size', `${sizePx}px`);
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'loading');
  for (let i = 0; i < 8; i++) {
    const blade = document.createElement('span');
    blade.className = 'spinner-blade';
    blade.style.transform = `rotate(${i * 45}deg)`;
    blade.style.animationDelay = `${(i - 8) / 8}s`;
    el.appendChild(blade);
  }
  return el;
}

// figure the way claimUsd always is.
