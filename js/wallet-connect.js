import { CHAIN_PARAMS, chainName } from './core/chains.js';
import { renderPortfolio } from './main.js';
import { closeAllClaimMenus } from './claim/orchestrate.js';
import { privacyHidden, setSensitiveText } from './core/prefs.js';
import { state } from './core/state.js';
import { $, formatEther, log, logErr } from './core/utils.js';
import { addr, uiLog } from './core/ui-debug.js';

export const discovered = new Map(); // rdns -> { info, provider }

window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider } = event.detail;
  const isNew = !discovered.has(info.rdns);
  discovered.set(info.rdns, { info, provider });
  if (isNew) log(`EIP-6963 announce: ${info.name} (${info.rdns})`, 'evt');
  renderEnv();
});

export function requestProviders() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/* ---------- rendering ---------- */

export function renderEnv() {
  const eth = window.ethereum;
  $('#v-injected').textContent = eth ? 'present' : 'absent';
  $('#v-6963').textContent = String(discovered.size);
  $('#v-mm').textContent = eth ? String(!!eth.isMetaMask) : '—';
  $('#v-multi').textContent =
    eth && Array.isArray(eth.providers) ? `yes (${eth.providers.length})` : 'no';
  $('#v-origin').textContent = location.origin;
}

export function renderConnection() {
  const connected = !!state.account;
  // Chain is the field worth having on every one of these: most "the card shows nothing"
  // reports turn out to be a wallet sitting on the wrong network, and this makes that visible
  // without asking anyone to open their extension and read it back.
  uiLog('wallet', connected ? 'connected' : 'disconnected', {
    wallet: state.info?.name ?? (state.provider ? 'injected' : null),
    chain: chainName(state.chainId),
    account: addr(state.account),
  });
  $('#v-status').textContent = connected ? 'connected' : 'disconnected';
  $('#v-wallet').textContent = state.info ? state.info.name : state.provider ? 'injected' : '—';
  if (connected) setSensitiveText($('#v-account'), state.account);
  else $('#v-account').textContent = '—';
  $('#v-chain').textContent = chainName(state.chainId);
  if (!connected) {
    $('#v-balance').textContent = '—';
    renderPortfolio();
  }

  // Connected state is just "Disconnect" in red — no address, no dropdown (switch
  // network/account, previously here, is gone; use the wallet extension's own UI for that).
  // The button itself IS the disconnect action now — see onConnectClick().
  const btn = $('#connect');
  if (connected) {
    btn.dataset.state = 'connected';
    btn.textContent = 'Disconnect';
    btn.title = privacyHidden ? '' : state.account;
  } else {
    delete btn.dataset.state;
    btn.textContent = 'Connect';
    btn.title = '';
  }
}

/* ---------- provider events ---------- */

export function attachListeners(provider) {
  detachListeners();

  const onAccountsChanged = (accounts) => {
    log(`event accountsChanged: ${JSON.stringify(accounts)}`, 'evt');
    state.account = accounts[0] || null;
    if (!state.account) {
      log('wallet reports no authorized accounts — treating as disconnected', 'info');
      teardown();
    }
    renderConnection();
    if (state.account) {
      refreshBalance();
      renderPortfolio();
    }
  };

  const onChainChanged = (chainId) => {
    log(`event chainChanged: ${chainName(chainId)}`, 'evt');
    state.chainId = chainId;
    renderConnection();
    refreshBalance();
    // Portfolio data reads go through public chain RPCs, not the wallet's active
    // network (see chainCall() below) — a wallet-side chain switch doesn't change
    // what the portfolio should show, so there's nothing to re-fetch here.
  };

  const onConnect = (info) => log(`event connect: ${JSON.stringify(info)}`, 'evt');

  const onDisconnect = (err) => {
    log(`event disconnect: ${(err && err.message) || 'no reason given'}`, 'evt');
    teardown();
    renderConnection();
  };

  provider.on('accountsChanged', onAccountsChanged);
  provider.on('chainChanged', onChainChanged);
  provider.on('connect', onConnect);
  provider.on('disconnect', onDisconnect);

  state.listeners = () => {
    provider.removeListener('accountsChanged', onAccountsChanged);
    provider.removeListener('chainChanged', onChainChanged);
    provider.removeListener('connect', onConnect);
    provider.removeListener('disconnect', onDisconnect);
  };
}

export function detachListeners() {
  if (state.listeners) {
    state.listeners();
    state.listeners = null;
  }
}

export function teardown() {
  detachListeners();
  state.provider = null;
  state.info = null;
  state.account = null;
  state.chainId = null;
}

/* ---------- RPC helper ---------- */

export async function rpc(method, params = []) {
  if (!state.provider) throw new Error('no provider');
  log(`→ ${method} ${params.length ? JSON.stringify(params) : ''}`.trim());
  const started = performance.now();
  const result = await state.provider.request({ method, params });
  const ms = Math.round(performance.now() - started);
  log(`← ${method} (${ms}ms) ${JSON.stringify(result)}`, 'ok');
  return result;
}

/* ---------- connect flow ---------- */

export async function connectWith(provider, info) {
  state.provider = provider;
  state.info = info || null;
  attachListeners(provider);

  try {
    const accounts = await rpc('eth_requestAccounts');
    if (!accounts.length) throw new Error('wallet returned zero accounts');
    state.account = accounts[0];
    state.chainId = await rpc('eth_chainId');
    log(`connected to ${info ? info.name : 'injected wallet'} as ${state.account}`, 'ok');
    renderConnection();
    refreshBalance();
    renderPortfolio();
  } catch (err) {
    // 4001 = user rejected; anything else is worth flagging louder.
    logErr('connect failed', err);
    teardown();
    renderConnection();
  }
}

export function openPicker(options) {
  const body = $('#picker-body');
  body.innerHTML = '';
  options.forEach(({ info, provider }) => {
    const btn = document.createElement('button');
    btn.className = 'wallet-btn';
    const img = document.createElement('img');
    img.src = info.icon;
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = info.name;
    btn.append(img, name);
    btn.addEventListener('click', () => {
      $('#picker').close();
      connectWith(provider, info);
    });
    body.appendChild(btn);
  });
  $('#picker').showModal();
}

// Add-chain fallback metadata for wallet_addEthereumChain (code 4902 means the
// wallet has never had this network configured). Ethereum mainnet never needs
// this — every wallet ships with it built in.
export async function switchChain(targetChainId) {
  try {
    await rpc('wallet_switchEthereumChain', [{ chainId: targetChainId }]);
  } catch (err) {
    if (err && err.code === 4902 && CHAIN_PARAMS[targetChainId]) {
      await rpc('wallet_addEthereumChain', [CHAIN_PARAMS[targetChainId]]);
    } else {
      throw err;
    }
  }
  state.chainId = targetChainId; // optimistic — the wallet's own chainChanged event confirms it
  renderConnection();
  refreshBalance();
}

export async function disconnectWallet() {
  try {
    await rpc('wallet_revokePermissions', [{ eth_accounts: {} }]);
  } catch (err) {
    log(`wallet_revokePermissions unsupported (${(err && err.message) || err}) — clearing locally`, 'info');
  }
  teardown();
  renderConnection();
  renderPortfolio();
  log('disconnected locally; revoke in the wallet UI to fully reset', 'ok');
}

export async function onConnectClick(e) {
  if (state.account) {
    e.stopPropagation();
    disconnectWallet();
    return;
  }

  requestProviders(); // late-injecting wallets may answer synchronously

  const options = [...discovered.values()];
  if (options.length > 1) {
    log(`${options.length} injected wallets found — prompting for selection`);
    openPicker(options);
    return;
  }
  if (options.length === 1) {
    connectWith(options[0].provider, options[0].info);
    return;
  }

  // No EIP-6963 wallets: fall back to legacy injection.
  const eth = window.ethereum;
  if (!eth) {
    log('no injected wallet found — install a browser wallet extension', 'err');
    return;
  }
  if (Array.isArray(eth.providers) && eth.providers.length > 1) {
    log(`window.ethereum.providers has ${eth.providers.length} entries — using the first`, 'info');
    connectWith(eth.providers[0], null);
    return;
  }
  log('using legacy window.ethereum injection', 'info');
  connectWith(eth, null);
}

/* ---------- portfolio ---------- */

export async function refreshBalance() {
  if (!state.account) return;
  try {
    const wei = await rpc('eth_getBalance', [state.account, 'latest']);
    setSensitiveText($('#v-balance'), formatEther(wei));
  } catch (err) {
    logErr('eth_getBalance failed', err);
    $('#v-balance').textContent = 'error';
  }
}

/* ---------- wiring ---------- */

$('#connect').addEventListener('click', onConnectClick);

// Inline "connect" in the demo banner does exactly what the header's Connect
// button does — same handler, not a redirect/scroll to the real button, so
// it behaves identically (wallet picker, legacy injection fallback, etc.)
// with no duplicated logic.
$('#demo-badge-connect').addEventListener('click', onConnectClick);

// Switch network / switch account / disconnect-as-a-menu-item all used to live in a dropdown
// here (#connect-menu, #switch-account-btn, #disconnect-btn, .dropdown-item[data-chain] —
// removed from index.html). The connect button IS the disconnect action now (see
// onConnectClick()); switching network/account is left to the wallet extension's own UI.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.claim-menu-wrap')) closeAllClaimMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllClaimMenus();
});

