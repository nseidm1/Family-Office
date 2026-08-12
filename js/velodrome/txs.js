/* Every transaction a Velodrome claim SENDS, built here and nowhere else.
 *
 * Split out from velodrome/claim.js on purpose: that file previews and orchestrates, this one only
 * encodes calldata. Encoding is where a mistake is silent and expensive — a wrong offset produces
 * a revert at best and a transfer to the wrong place at worst — so it is worth being able to read
 * all of it in one screenful, with its evidence, without the preview logic interleaved.
 *
 * EVERY selector below was derived with `node tools/selector.mjs` (which reproduces ~30 selectors
 * this repo verified on chain before it will answer — see its header) and then confirmed PRESENT in
 * the live dispatch table, via eth_getCode, of the exact deployed contract it is sent to. The
 * table of what was probed where is in VELODROME_CLAIM's comment in protocols/config.js. Neither
 * half of that is optional: deriving a selector proves the signature hashes to it, and probing the
 * bytecode proves the contract actually has that function. This repo has been bitten by skipping
 * the second half (a `voter()` selector recorded from a docs reading that reverts on the real
 * contract) and by skipping the first (a hand-rolled keccak that produced a wrong selector).
 *
 * WHAT IS DIFFERENT FROM AERODROME, and why this file is small:
 * the ROOT (Optimism) half of a Velodrome claim uses Aerodrome's exact selectors, so the root claim
 * and root swap are built by aerodrome/routing.js's own builders with a `venue` argument — not
 * reimplemented here. Only the four LEAF operations are genuinely new, and the leaf's Route struct
 * has THREE fields where Base/Optimism have four, which is a different signature and so a
 * different selector. That difference is the single most dangerous thing in this file: the
 * four-field encoding reverts against a leaf router with a bare "execution reverted" and no hint.
 */

import { VELODROME, VELODROME_CLAIM } from '../protocols/config.js';
import { OPTIMISM } from '../core/chains.js';
import { chainCall } from '../rpc-waterfall.js';
import { encodeAddress, encodeUint256, log, short, word } from '../core/utils.js';

/* ---------- leaf: claim fees and incentives ---------- */

/* One getReward() per Reward contract the veNFT has something to claim from.
 *
 * NOT Aerodrome's shape, in both directions — different contract AND different signature. Aerodrome
 * claims through the Voter, batching every pool into one claimFees(address[], address[][], uint256)
 * call. A leaf has no such function anywhere: `claimFees`/`claimBribes` are absent from the leaf
 * Voter's bytecode AND from both Reward contracts', while the leaf Reward contracts carry
 * `getReward(address _recipient, uint256 _tokenId, address[] _tokens)` — three arguments, including
 * an explicit recipient Aerodrome's version does not have.
 *
 * The consequence for the user is real and worth stating: because there is no batching function,
 * this is **one transaction per (veNFT, Reward contract)** rather than one per veNFT. A veNFT voting
 * on many leaf pools therefore produces many signatures. That is a property of Velodrome's leaf
 * contracts, not a choice made here, and it is why the step list is variable-length.
 *
 * `byVenft` is the map the shared reward scan already builds (see fetchPoolRewardsFullScan) —
 * venftId -> { fees: Map<contract, Map<token, amount>>, bribes: Map<...> }. On a leaf, the "bribe"
 * contract from RewardsSugar's Reward struct IS the IncentiveVotingReward ("incentive" is the
 * Superchain codebase's word for a bribe); both kinds are Reward contracts with the same getReward,
 * so the two groups are treated identically here rather than needing separate selectors. That also
 * means LeafVoter.gaugeToFees/gaugeToIncentive are NOT needed — the scan already carries the
 * addresses, so no extra lookup round trip is spent.
 */
export function buildLeafClaimTxs(chainId, byVenft, recipient) {
  const txs = [];
  for (const [venftId, entry] of byVenft) {
    for (const group of ['fees', 'bribes']) {
      for (const [contract, tokenMap] of entry[group]) {
        const tokens = [...tokenMap.keys()];
        if (!tokens.length) continue;
        /* getReward(address _recipient, uint256 _tokenId, address[] _tokens)
           Head is 3 words: recipient, tokenId, offset-to-tokens. The offset is 3*32 = 96, counted
           from the start of the ARGUMENTS (not including the selector) — the array's [length,
           elements...] block then follows the head. */
        const data = VELODROME_CLAIM.LEAF_GET_REWARD
          + encodeAddress(recipient)
          + encodeUint256(BigInt(venftId))
          + encodeUint256(96n)
          + encodeUint256(BigInt(tokens.length))
          + tokens.map((t) => encodeAddress(t)).join('');
        txs.push({
          label: `claim ${group === 'fees' ? 'fees' : 'incentives'} (veNFT #${venftId}, ${tokens.length} token${tokens.length === 1 ? '' : 's'})`,
          to: contract,
          data,
          chainId,
        });
      }
    }
  }
  return txs;
}

/* ---------- leaf: swap a reward token to XVELO ---------- */

/* approve() + Router.swapExactTokensForTokens with the leaf's THREE-field Route {from, to, stable}.
 * The write-side twin of quoteLeafToVelo(), and `stable` MUST be the flavour that quote actually
 * chose: Ink's WETH/XVELO pair exists as both stable and volatile, and the stable one holds no
 * liquidity, so sending the wrong flag either reverts or fills at a catastrophic rate. The caller
 * passes the quote's own `stable` value rather than this file guessing.
 *
 * `minOut` is the caller's responsibility (a live quote with slippage applied). This builder will
 * not default it — a zero minOut is a swap that can legally return nothing, which is exactly the
 * sandwich the second refusal in claim.js existed to prevent.
 */
export function buildLeafSwapTxs({ chainId, token, amount, minOut, stable, recipient, deadline }) {
  if (minOut == null || minOut <= 0n) {
    throw new Error(`refusing to build a leaf swap with no minimum output (token ${short(token)})`);
  }
  const { router, xVelo } = VELODROME_CLAIM.leaf;
  const approveTx = {
    label: `approve ${short(token)} → leaf router`,
    to: token,
    data: '0x095ea7b3' + encodeAddress(router) + encodeUint256(amount),
    chainId,
  };
  // swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to,
  // uint256 deadline) — 5 head words, so the Route[] offset is 5*32 = 160.
  const swapTx = {
    label: `swap ${short(token)} → VELO`,
    to: router,
    data: VELODROME_CLAIM.LEAF_SWAP
      + encodeUint256(amount)
      + encodeUint256(minOut)
      + encodeUint256(5n * 32n)
      + encodeAddress(recipient)
      + encodeUint256(deadline)
      + encodeUint256(1n) // Route[] length
      + encodeAddress(token) // from
      + encodeAddress(xVelo) // to
      + encodeUint256(stable ? 1n : 0n), // stable — NO factory field; see the file header
    chainId,
  };
  return [approveTx, swapTx];
}

/* ---------- leaf: bridge XVELO to Optimism ---------- */

/* What the bridge leg costs in native gas, quoted from the Hyperlane Mailbox the bridge itself
 * uses. This is not optional garnish — `sendToken` is payable and its msg.value IS the interchain
 * gas payment; underpay and the dispatch reverts.
 *
 * THE TRAP, measured live on Ink 2026-08-12. LeafTokenBridge has no quote function of its own
 * (`quoteTransfer` in either arity is absent from its bytecode), so the quote has to come from
 * `mailbox()` — which the bridge exposes, and which returns a real Mailbox. But the Mailbox has two
 * quoteDispatch overloads and they do not agree:
 *
 *   quoteDispatch(uint32,bytes32,bytes)                 -> 0.0000287 ETH   (default metadata)
 *   quoteDispatch(uint32,bytes32,bytes,bytes,address)   -> 0.0000465 ETH   (gasLimit 190,000)
 *
 * The three-argument form quotes DEFAULT destination gas and so under-funds the real dispatch by
 * ~62%, because the bridge sets its own gas limit in StandardHookMetadata. Quoting with the cheap
 * overload would produce a transaction that reverts every time. So this quotes the five-argument
 * form with the bridge's OWN gas limit, read live from its `GAS_LIMIT()` getter.
 *
 * That getter also corrected a recorded fact: it returns 190,000, where this repo's config had
 * 200,000 written down. It is read live rather than hardcoded precisely because it is a value the
 * deployment owns and can change — and because reading it costs one call on a chain we are already
 * talking to.
 *
 * Returns { fee, gasLimit, mailbox } with `fee` already padded by SAFETY_NUMERATOR. Over-funding is
 * safe and deliberate: the bridge's metadata sets refundAddress = msg.sender, so the Hyperlane IGP
 * returns the excess to the user rather than keeping it. Under-funding is not recoverable — it is a
 * failed transaction with gas spent — so the asymmetry justifies the padding.
 */
export const BRIDGE_FEE_SAFETY_NUMERATOR = 15n; // 1.5x the quote
export const BRIDGE_FEE_SAFETY_DENOMINATOR = 10n;

export async function quoteLeafBridgeFee(chainId, recipient, amount) {
  const { tokenBridge } = VELODROME_CLAIM.leaf;
  const mailbox = '0x' + (await chainCall(chainId, tokenBridge, VELODROME_CLAIM.MAILBOX)).slice(26);
  const gasLimit = word(await chainCall(chainId, tokenBridge, VELODROME_CLAIM.BRIDGE_GAS_LIMIT_GETTER), 0);

  const b32 = (addr) => String(addr).toLowerCase().replace('0x', '').padStart(64, '0');
  /* The message body the bridge dispatches is abi.encodePacked(recipient, amount) — 64 bytes. Only
     its LENGTH materially affects the quote (per-byte cost), so reproducing the exact payload is
     not required for a fee estimate, and the safety padding above absorbs the difference. */
  const body = b32(recipient) + encodeUint256(amount);
  const bytesArg = (hex) => encodeUint256(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  /* StandardHookMetadata, packed (NOT abi-encoded): variant(uint16) msgValue(uint256)
     gasLimit(uint256) refundAddress(address). */
  const metadata = '0001' + encodeUint256(0n) + encodeUint256(gasLimit) + String(recipient).toLowerCase().replace('0x', '');

  const bodyArg = bytesArg(body);
  const data = VELODROME_CLAIM.QUOTE_DISPATCH
    + encodeUint256(BigInt(Number(OPTIMISM))) // destinationDomain — Hyperlane uses the chain id (10)
    + b32(tokenBridge) // recipient: the root TokenBridge, same address on every chain
    + encodeUint256(160n) // offset to body (5 head words)
    + encodeUint256(160n + BigInt(bodyArg.length / 2)) // offset to metadata
    + encodeAddress('0x0000000000000000000000000000000000000000') // hook — zero means the default
    + bodyArg
    + bytesArg(metadata);

  const quoted = word(await chainCall(chainId, mailbox, data), 0);
  const fee = (quoted * BRIDGE_FEE_SAFETY_NUMERATOR) / BRIDGE_FEE_SAFETY_DENOMINATOR;
  log(`Velodrome bridge fee: quoted ${quoted} wei at gasLimit ${gasLimit}, sending ${fee} wei (excess is refunded)`, 'info');
  return { fee, quoted, gasLimit, mailbox };
}

/* approve() XVELO to the TokenBridge, then sendToken(recipient, amount, 10).
 *
 * The approve is required and easy to miss: sendToken pulls the XVELO from msg.sender, it is not a
 * push. `_chainid` is the DESTINATION as a plain chain id (10 for Optimism), not a Hyperlane domain
 * constant — they coincide for these chains, which is exactly why the distinction is worth a
 * comment rather than being left to look self-evident.
 */
export function buildLeafBridgeTxs({ chainId, amount, recipient, fee }) {
  const { tokenBridge, xVelo } = VELODROME_CLAIM.leaf;
  if (!fee || fee <= 0n) {
    throw new Error('refusing to build a bridge transaction with no interchain gas payment — it would revert');
  }
  return [
    {
      label: 'approve VELO → Velodrome TokenBridge',
      to: xVelo,
      data: '0x095ea7b3' + encodeAddress(tokenBridge) + encodeUint256(amount),
      chainId,
    },
    {
      label: 'bridge VELO → Optimism',
      to: tokenBridge,
      data: VELODROME_CLAIM.SEND_TOKEN
        + encodeAddress(recipient)
        + encodeUint256(amount)
        + encodeUint256(BigInt(Number(OPTIMISM))),
      value: fee,
      chainId,
    },
  ];
}

/* ---------- balances ---------- */

// One ERC20 balanceOf. Used to drive every dependent leg off a REAL post-transaction balance
// instead of the preview's estimate — the same rule executeAerodromeClaim() applies to its bridge
// leg, and it matters more here: an amount is swapped on a leaf, bridged across a message bus, and
// swapped again, so by the root swap the preview's figure is three estimates deep.
export async function erc20Balance(chainId, token, account) {
  return word(await chainCall(chainId, token, '0x70a08231' + encodeAddress(account)), 0);
}

// The XVELO/VELO balance the bridge leg should move. Deliberately reads the token's real balance
// rather than summing the swap outputs: a leaf may have held VELO already (VELO is itself one of the
// commonest leaf rewards, so a claim step alone can deliver it with no swap at all), and summing
// only the swaps would leave that behind on the leaf.
export const leafVeloBalance = (chainId, account) => erc20Balance(chainId, VELODROME_CLAIM.leaf.xVelo, account);
export const rootVeloBalance = (account) => erc20Balance(VELODROME.chainId, VELODROME_CLAIM.root.velo, account);
export const rootUsdcBalance = (account) => erc20Balance(VELODROME.chainId, VELODROME_CLAIM.root.usdc, account);
