// FA-15127: nothing reaches the wallet's signature prompt until its call targets and approval spenders are KNOWN_TARGETS.
// Pure: no DOM, no network. The wallet stays the security boundary; this decides only what it is shown.
import { KNOWN_TARGETS } from './targets.js';
export const REFUSED = 'FA-15127: refused before the wallet prompt: ';
const GRANTS = ['0x095ea7b3', '0x39509351', '0xa22cb465']; // approve, increaseAllowance, setApprovalForAll: arg 0 is the spender
const PAYS_RECIPIENT = '0xa44d113f'; // Reward.getReward(recipient, tokenId, tokens) on a Sugar-listed reward contract
const low = (a) => String(a || '').toLowerCase();
const known = (chainId, a) => (KNOWN_TARGETS[Number(chainId)] || []).includes(low(a));
const selectorOf = (call) => low(call.data).slice(0, 10);
const argOf = (call, i) => '0x' + low(call.data).slice(34 + i * 64, 74 + i * 64);
const hasValue = (call) => BigInt(call.value || 0) > 0n;
const paysCaller = (call, from) => selectorOf(call) === PAYS_RECIPIENT && !hasValue(call) && argOf(call, 0) === low(from);
const grantFault = (chainId, call) => (known(chainId, argOf(call, 0)) && !hasValue(call) ? null : 'unknown spender ' + argOf(call, 0));
const callFault = (chainId, call, from) => (known(chainId, call.to) || paysCaller(call, from) ? null : 'unknown call target ' + low(call.to));
export const targetFault = (chainId, call, from) => (GRANTS.includes(selectorOf(call)) ? grantFault(chainId, call) : callFault(chainId, call, from));
const firstFault = (chainId, calls, from) => calls.map((c) => targetFault(chainId, c, from)).find(Boolean) || null;
export const checkTargets = (chainId, calls, from) => { const f = firstFault(chainId, calls, from); if (f) throw new Error(REFUSED + f + ' on chain ' + Number(chainId)); };
const SIGNING = { eth_sendTransaction: (p) => [p[0]], wallet_sendCalls: (p) => p[0].calls };
const chainOf = (method, params, chainId) => (method === 'wallet_sendCalls' ? params[0].chainId : chainId);
export const guardRequest = (method, params, chainId) => (SIGNING[method] ? checkTargets(chainOf(method, params, chainId), SIGNING[method](params), params[0].from) : undefined);
// The simulation half: eth_simulateV1 with traceTransfers; the account's net Transfer deltas must match the preview.
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const topicAddr = (t) => '0x' + low(t).slice(26);
const isTransfer = (log) => (log.topics || []).length === 3 && low(log.topics[0]) === TRANSFER;
const addDelta = (d, token, n) => { d[token] = (d[token] || 0n) + n; return d; };
const signOf = (log, who) => (topicAddr(log.topics[2]) === who ? 1n : 0n) - (topicAddr(log.topics[1]) === who ? 1n : 0n);
const onLog = (who) => (d, log) => (isTransfer(log) ? addDelta(d, low(log.address), signOf(log, who) * BigInt(log.data)) : d);
const callsOf = (sim) => (sim || []).flatMap((b) => b.calls || []);
export const deltasOf = (sim, account) => callsOf(sim).flatMap((c) => c.logs || []).reduce(onLog(low(account)), {});
const reverted = (sim) => callsOf(sim).some((c) => c.status === '0x0');
const lossOf = (d) => Object.keys(d).find((t) => d[t] < 0n);
const shortOf = (d, expect) => Object.keys(expect).find((t) => (d[low(t)] || 0n) * 100n < BigInt(expect[t]) * 99n);
const deltaFault = (d, expect) => (lossOf(d) ? 'the simulation takes ' + lossOf(d) : shortOf(d, expect) ? 'the simulation pays less ' + shortOf(d, expect) + ' than the preview shows' : null);
export const simulationFault = (expect, sim, account) => (!sim ? null : reverted(sim) ? 'the simulation reverted' : deltaFault(deltasOf(sim, account), expect));
export const checkSimulation = (expect, sim, account) => { const f = simulationFault(expect, sim, account); if (f) throw new Error(REFUSED + f); };
const sumInto = (e, [t, n]) => addDelta(e, low(t), BigInt(n));
export const expectOf = (maps) => [...maps].flatMap((m) => [...m.entries()]).reduce(sumInto, {});