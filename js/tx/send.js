import { publicRpc } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { log } from '../core/utils.js';
import { rpc } from '../wallet-connect.js';

export async function waitForReceipt(txHash, chainId) {
  for (let i = 0; i < 60; i++) {
    const receipt = await publicRpc(chainId, 'eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`transaction ${txHash} reverted`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${txHash} to confirm`);
}

export async function sendAndWait(tx) {
  log(`${tx.label || 'transaction'}: sending...`, 'info');
  const txHash = await rpc('eth_sendTransaction', [{ from: state.account, to: tx.to, data: tx.data, value: tx.value ? '0x' + tx.value.toString(16) : undefined }]);
  log(`${tx.label || 'transaction'}: sent ${txHash}, waiting for confirmation...`, 'info');
  await waitForReceipt(txHash, tx.chainId);
  log(`${tx.label || 'transaction'}: confirmed`, 'ok');
  return txHash;
}

// EIP-5792 (Wallet Call API) capability check — asks the connected wallet whether it can
// execute a batch of calls on `chainIdHex` ATOMICALLY (all-or-nothing, same as a single
// transaction) rather than as several independent ones. This is the standard, wallet-native
// way to get one-signature batching (Base has official platform support; Rabby/MetaMask/Trust
// Wallet added EIP-7702-backed support in late 2025) — NOT the same thing this project's
// earlier session research ruled out (deploying a NEW contract to custody funds mid-route for
// the cross-chain bridge leg). Every call in a wallet_sendCalls batch still sends its own
// output straight to `state.account`, same as today's sequential calls — there is no
// intermediate custody introduced by batching, whether the wallet executes it atomically or not.
// Returns the capability's `status` string ('supported' | 'ready' | 'unsupported') or `null` if
// the wallet doesn't implement wallet_getCapabilities at all (an older wallet — EIP-5792
// predates broad adoption, so this is a real, expected case, not an error). Callers should use
// isAtomicCapable() below rather than comparing this against 'supported' directly — see its
// comment for why 'ready' also means "go ahead and try."
export async function walletAtomicCapability(chainIdHex) {
  try {
    const caps = await rpc('wallet_getCapabilities', [state.account, [chainIdHex]]);
    return caps?.[chainIdHex]?.atomic?.status || caps?.['0x0']?.atomic?.status || null;
  } catch (err) {
    log(`wallet_getCapabilities unsupported by this wallet — falling back to sequential transactions (${err.message})`, 'info');
    return null;
  }
}

// Whether it's worth attempting wallet_sendCalls at all. Per the EIP-5792 spec, 'ready' does NOT
// mean "not usable" — it means the wallet CAN provide atomic execution but the account needs a
// one-time upgrade first (e.g. an EIP-7702 delegation for a plain EOA that hasn't set one yet),
// and that upgrade happens transparently as part of the wallet's own wallet_sendCalls prompt, not
// as a separate step this app needs to orchestrate. Treating only the literal string 'supported'
// as usable was needlessly conservative: a fresh Rabby/MetaMask EOA that hasn't been upgraded yet
// reports 'ready', not 'supported', which meant this app was silently falling back to the full
// sequential flow for exactly the wallets/accounts EIP-5792 was built to speed up. Safe to loosen
// this rather than risky: sendBatchAndWait()'s `atomicRequired: true` is the real safety net — if
// a wallet claiming 'ready' genuinely can't deliver atomicity, the wallet itself rejects the whole
// batch up front rather than silently executing it non-atomically.
export function isAtomicCapable(status) {
  return status === 'supported' || status === 'ready';
}

// Sends a batch of calls as ONE wallet_sendCalls request and polls wallet_getCallsStatus for
// completion — the EIP-5792 equivalent of sendAndWait()/waitForReceipt() above, just for a
// call bundle instead of a single transaction hash. Only call this after
// walletAtomicCapability() has confirmed 'supported' for this chain — `atomicRequired: true`
// asks the wallet to reject the whole batch up front if it can't actually guarantee atomicity,
// which is the correct behavior here (a partially-applied claim+swap batch — e.g. claimed but
// not all swapped — would be worse than either fully succeeding or not starting at all).
// Status codes per the EIP: 100 pending, 200 confirmed, 400 offchain failure, 500 full revert,
// 600 partial revert (shouldn't be reachable with atomicRequired, but treated as a failure
// either way since a partial application here would be exactly the state this is meant to avoid).
export async function sendBatchAndWait(calls, chainIdHex, label) {
  log(`${label}: sending as one batched (atomic) transaction — ${calls.length} calls...`, 'info');
  const { id } = await rpc('wallet_sendCalls', [{
    version: '2.0.0',
    chainId: chainIdHex,
    atomicRequired: true,
    from: state.account,
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ? '0x' + c.value.toString(16) : undefined })),
  }]);
  log(`${label}: batch submitted (${id}), waiting for confirmation...`, 'info');
  for (let i = 0; i < 60; i++) {
    const status = await rpc('wallet_getCallsStatus', [id]);
    if (status.status === 200) {
      log(`${label}: batch confirmed (${status.receipts?.length ?? calls.length} calls)`, 'ok');
      return status;
    }
    if (status.status >= 400) {
      throw new Error(`${label} batch failed (status ${status.status})`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${label} batch to confirm`);
}

// Why a claimed token never makes it into the USDC consolidation. These are PERMANENT outcomes
// only — the network genuinely answered and the answer was "this can't be swapped". A token the
// network never answered for is not a skip at all; it goes to `preview.unresolved` and blocks
// Confirm instead (see buildAerodromeClaimPreview's `transientError` contract). Shared by the
// panel's consolidate list and its reconciliation subtotal so both describe a skip the same way.
// An unrecognised reason (a new one added later) still renders, just without the explanation.
export function isUserRejection(err) {
  return !!err && err.code === 4001;
}

// Sends the actual claim -> consolidate -> bridge transaction sequence. Extracted out of
// runAerodromeClaimFlow so showClaimPreviewPanel can call it directly and keep the panel open,
// rendering live per-transaction progress, instead of the panel closing on Confirm and the user
// losing visibility into a sequence that's often 3-8+ real signatures. `onStep(index, status)`
// — status one of 'active' | 'done' | 'error' | 'rejected' — is called around every REAL signed
// transaction, in the exact same structural order aerodromeExecutionLabels() enumerates, via the
// `track()` wrapper below: every actual sendAndWait()/sendBatchAndWait() call goes through it
// exactly once per ATTEMPT, so the index it reports can never desync from the label list built
// moments earlier from the SAME preview object (nothing about `preview` changes between the two
// — Confirm being clickable at all already means every token is resolved, see
// updateConfirmGate()). A rejected signature is NOT terminal: `track()` calls onStep with
// 'rejected' and awaits whatever it returns before trying the exact same call again — the panel
// uses that to show a retry affordance on the row and resolves once the user acts on it (see
// enterExecutionView()'s onStep). Every other kind of failure stays terminal, unchanged.
