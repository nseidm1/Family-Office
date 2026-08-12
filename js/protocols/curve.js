import { CURVE, GAUGE_CONTROLLER, LAPOSTE_NATIVE_TOKEN_OF, LAPOSTE_TOKEN_FACTORY, LAST_USER_VOTE, MAX_EPOCHS_BACK, VOTEMARKET, VOTE_USER_SLOPES, WEEK } from './config.js';
import { ETH_MAINNET } from '../core/chains.js';
import { chainCall, chainGetLogs, multicall, priceTokensUsd } from '../rpc-waterfall.js';
import { state } from '../core/state.js';
import { addrAt, encodeAddress, encodeUint256, formatUnits, formatUnlock, log, logErr, toSigned, usd, word } from '../core/utils.js';

export async function fetchCurveVeCrv() {
  const arg = encodeAddress(state.account);
  const [locked, claimable] = await Promise.allSettled([
    chainCall(ETH_MAINNET, CURVE.votingEscrow, CURVE.LOCKED + arg),
    chainCall(ETH_MAINNET, CURVE.feeDistributor, CURVE.CLAIM + arg),
  ]);

  const rows = [];
  if (locked.status === 'fulfilled') {
    const amount = toSigned(word(locked.value, 0));
    const end = Number(word(locked.value, 1));
    rows.push({ k: 'CRV locked', v: `${formatUnits(amount, 18, 4)} CRV` });
    rows.push({ k: 'Locked until', v: formatUnlock(end), sensitive: false });
  } else {
    logErr('veCRV locked() failed', locked.reason);
    rows.push({ k: 'CRV locked', v: 'error', sensitive: false }, { k: 'Locked until', v: 'error', sensitive: false });
  }

  let claimSummary = usd(0);
  let claimUsd = 0;
  if (claimable.status === 'fulfilled') {
    const amount = word(claimable.value, 0);
    const native = `${formatUnits(amount, 18, 4)} crvUSD`;
    // Collapsed view shows $, expanded shows the native token — price it even
    // though crvUSD is a stablecoin, rather than silently assuming a 1:1 peg.
    const priced = await priceTokensUsd([CURVE.crvUsd], 'ethereum');
    const price = priced[CURVE.crvUsd]?.price;
    if (price != null) {
      claimUsd = (Number(amount) / 1e18) * price;
      claimSummary = usd(claimUsd);
    } else {
      claimSummary = native;
    }
    rows.push({ k: 'Claimable crvUSD', v: native });
  } else {
    logErr('FeeDistributor claim() failed', claimable.reason);
    rows.push({ k: 'Claimable crvUSD', v: 'error', sensitive: false });
    // A failed claim-preview read is NOT "genuinely nothing claimable" — returning status:'ok'
    // here would show a confident, green $0.00 indistinguishable from a real zero balance,
    // silently hiding whatever the real (possibly nonzero) claimable amount actually is. The
    // row needs to say "we don't know" (status:'error', which renders as a clickable retry —
    // see setClaimStatusRetry()), not a wrong, confident answer.
    return { status: 'error', message: 'failed to read claimable crvUSD', claimUsd: 0, rows };
  }

  return { status: 'ok', claimSummary, claimUsd, rows };
}

// StakeDAO Votemarket v2 — the other of Curve's two nested Portfolio subsections.
// See the big VOTEMARKET comment above for the mechanism and the live verification
// this is built on. Structured like fetchVeDex (multi-token claimList) since a
// voter can be owed bribes in several different reward tokens from several
// different campaigns at once.
export async function fetchVotemarket() {
  const account = state.account;
  const encAccount = encodeAddress(account);

  let currentEpoch;
  try {
    currentEpoch = word(await chainCall(VOTEMARKET.chainId, VOTEMARKET.platforms[0], VOTEMARKET.CURRENT_EPOCH), 0);
  } catch (err) {
    logErr('Votemarket currentEpoch() failed', err);
    return { status: 'error', message: 'failed to read the active Votemarket epoch', claimUsd: 0 };
  }

  // Every campaign ever created, on both platforms. CampaignCreated logs carry
  // gauge/manager/rewardToken inline, so this alone is enough to index campaigns
  // by gauge — no per-campaign getCampaign() call needed just to build the map.
  let campaigns;
  try {
    const logsByPlatform = await Promise.all(
      VOTEMARKET.platforms.map((platform) =>
        chainGetLogs(VOTEMARKET.chainId, { address: platform, topics: [VOTEMARKET.CAMPAIGN_CREATED], fromBlock: '0x0', toBlock: 'latest' })
      )
    );
    campaigns = [];
    logsByPlatform.forEach((logs, i) => {
      const platform = VOTEMARKET.platforms[i];
      for (const entry of logs) {
        campaigns.push({
          platform,
          campaignId: word(entry.data, 0),
          gauge: addrAt(entry.data, 1).toLowerCase(),
          manager: addrAt(entry.data, 2),
          rewardToken: addrAt(entry.data, 3).toLowerCase(),
        });
      }
    });
  } catch (err) {
    logErr('Votemarket CampaignCreated log scan failed', err);
    return { status: 'error', message: 'failed to enumerate Votemarket campaigns', claimUsd: 0 };
  }

  const gauges = [...new Set(campaigns.map((c) => c.gauge))];
  const epochDate = new Date(Number(currentEpoch) * 1000).toISOString().slice(0, 10);
  log(`Votemarket: ${campaigns.length} campaign(s) across ${gauges.length} gauge(s) ever bribed on Curve — checking this account's vote for each, current epoch back to ${MAX_EPOCHS_BACK} week(s)`);

  // Vote eligibility per (gauge, epoch) comes from Arbitrum's Oracle relay,
  // with Ethereum mainnet's GaugeController as a per-epoch fallback when the
  // Oracle has nothing at all. Neither source alone is correct — confirmed
  // live against two different real accounts:
  //
  // - Oracle-only (the original design) missed real money: account
  //   the test account cast a standing vote for
  //   gauge 0x22804B0F...96944 on 2025-12-24 that hasn't changed since, but
  //   NO ONE had relayed a fresh Oracle proof for that gauge/account in the
  //   ~24 weeks since — the Oracle scan found nothing there even though the
  //   vote was live and real the whole time, silently hiding three genuinely
  //   unclaimed rewards the official Votemarket UI shows as claimable right
  //   now: WFRAX ($2,163.57), YB ($4,556.06), frxUSD ($324.09). Votemarket's
  //   own claim flow apparently relays a fresh proof as part of claiming,
  //   which a pure-read app like this one never does — GaugeController's
  //   vote_user_slopes()/last_user_vote() read the same (slope, end,
  //   lastVote) triple directly from mainnet instead, with no relay lag.
  // - GaugeController-only is ALSO wrong, the other direction: it only ever
  //   reflects a gauge's CURRENT vote, so an account that has since moved its
  //   vote to a different gauge loses that old gauge's history entirely, even
  //   though a relayed Oracle proof for the OLD epoch still proves the
  //   historical vote (and its reward) was real. Confirmed live: using
  //   GaugeController alone under-reported a frequent-reallocator whale
  //   account (0xf147b8125D2eF93Fb6965Db97D6746952a133934) — $18,475
  //   (Oracle-only) down to $256 (GaugeController-only). The Oracle scan is
  //   what actually has that account's history.
  //
  // Checking the Oracle first and falling back to GaugeController only on
  // epochs it has zero data for (not unconditionally — see the comment
  // inside the loop below) is what got both real accounts right.
  const slopeCalls = gauges.flatMap((gauge) => [
    { target: GAUGE_CONTROLLER, callData: VOTE_USER_SLOPES + encAccount + encodeAddress(gauge) },
    { target: GAUGE_CONTROLLER, callData: LAST_USER_VOTE + encAccount + encodeAddress(gauge) },
  ]);
  const slopeResults = await multicall(ETH_MAINNET, slopeCalls);
  // Every call in the batch failing is a strong signal the RPC read itself failed, not that
  // every single one of these `gauges` genuinely has a zero vote — these gauges were only
  // included BECAUSE they've had real campaigns. Treating a totally-failed batch the same as
  // "checked, no votes" would report a confident $0.00 for an unknown answer — same distinction
  // findAerodromePoolRoute() already makes for Aerodrome's route lookups, for the same reason.
  if (slopeCalls.length && slopeResults.every((r) => !r.success)) {
    logErr('Votemarket: GaugeController vote-slope multicall failed for every gauge', new Error('total batch failure'));
    return { status: 'error', message: 'failed to read vote history from GaugeController', claimUsd: 0 };
  }

  const gaugeVotes = new Map(); // gauge -> { slope, end, lastVote }
  gauges.forEach((gauge, idx) => {
    const slopeResult = slopeResults[idx * 2];
    const lastVoteResult = slopeResults[idx * 2 + 1];
    if (!slopeResult.success || !lastVoteResult.success) return;
    const slope = word(slopeResult.returnData, 0);
    const end = word(slopeResult.returnData, 2);
    const lastVote = word(lastVoteResult.returnData, 0);
    if (slope === 0n) return;
    gaugeVotes.set(gauge, { slope, end, lastVote });
  });

  // Every epoch's Oracle check is now independent (no early-stop decides
  // whether the next one is worth fetching, unlike the original design), so
  // all MAX_EPOCHS_BACK+1 epochs fire their multicall batches in parallel via
  // Promise.all rather than sequentially awaiting one at a time — a real
  // speedup with no correctness cost, since ordering doesn't matter below.
  const epochList = Array.from({ length: MAX_EPOCHS_BACK + 1 }, (_, i) => currentEpoch - BigInt(i) * WEEK);
  const oracleResultsByEpoch = await Promise.all(
    epochList.map((epoch) =>
      multicall(
        VOTEMARKET.chainId,
        gauges.map((gauge) => ({ target: VOTEMARKET.oracle, callData: VOTEMARKET.VOTED_SLOPE + encAccount + encodeAddress(gauge) + encodeUint256(epoch) }))
      ).then((results) => ({ epoch, results }))
    )
  );

  const eligibleByEpoch = []; // [{ epoch, eligibleGauges: Map<gauge, accountVote> }]
  const epochsChecked = epochList.length;
  // Distinct from `oracleHadAnyData` below (which means "at least one RELAYED PROOF this
  // epoch" — a real, legitimate zero-data state) — this means "the RPC call itself succeeded
  // at least once, anywhere", regardless of what it returned. If this stays false across
  // every epoch and every gauge, the Oracle relay was never actually reached, which is a
  // different situation from "reached, and it has nothing for us."
  let anyOracleCallSucceeded = false;
  for (const { epoch, results } of oracleResultsByEpoch) {
    const eligibleGauges = new Map(); // gauge -> accountVote (bigint)

    // Primary: Arbitrum's relayed Oracle snapshot for this specific epoch —
    // authoritative for exactly this epoch when it has data, regardless of
    // what the account's vote looks like now.
    let oracleHadAnyData = false;
    results.forEach((r, idx) => {
      if (!r.success) return;
      anyOracleCallSucceeded = true;
      const slope = word(r.returnData, 0);
      const end = word(r.returnData, 1);
      const lastVote = word(r.returnData, 2);
      const lastUpdate = word(r.returnData, 3);
      if (lastUpdate === 0n) return; // no proof relayed for this voter/gauge/epoch
      oracleHadAnyData = true;
      if (slope === 0n || epoch >= end || epoch <= lastVote) return;
      eligibleGauges.set(gauges[idx], slope * (end - epoch));
    });

    // Fallback: GaugeController's current-state, closed-form (no chain call —
    // gaugeVotes was already fetched once, above) — ONLY consulted when the
    // Oracle relay found literally nothing for this epoch across every gauge.
    // Applying it unconditionally to every epoch was tried and reverted: a
    // standing vote is analytically "eligible" across its ENTIRE multi-year
    // lock duration, so doing that for every gauge on every one of
    // MAX_EPOCHS_BACK epochs blew up claimJobs combinatorially (confirmed
    // live: one real account's scan went from ~30s to still running after
    // 3+ minutes). Gating it on "the relay was completely silent this epoch"
    // bounds the extra work to exactly the bug case this exists for (a real
    // vote with no relayed proof at all for a stretch of epochs) without
    // paying that cost on every normal, actively-relayed epoch.
    if (!oracleHadAnyData) {
      gaugeVotes.forEach(({ slope, end, lastVote }, gauge) => {
        if (epoch >= end || epoch <= lastVote) return; // mirrors OracleLens.isVoteValid
        eligibleGauges.set(gauge, slope * (end - epoch));
      });
    }

    if (eligibleGauges.size) eligibleByEpoch.push({ epoch, eligibleGauges });
  }

  const rows = [
    { k: 'Active epoch', v: epochDate, sensitive: false },
    { k: 'Campaigns scanned', v: `${campaigns.length} across ${gauges.length} gauges`, sensitive: false },
    {
      k: 'Claim window checked',
      v: `${epochsChecked} epoch${epochsChecked > 1 ? 's' : ''} back to ${new Date(Number(currentEpoch - BigInt(epochsChecked - 1) * WEEK) * 1000).toISOString().slice(0, 10)}`,
      sensitive: false,
    },
  ];

  if (!eligibleByEpoch.length) {
    // `anyOracleCallSucceeded` distinguishes "the Oracle relay legitimately has no proof for
    // this account" (a real eth_call success returning lastUpdate:0 — plenty of real accounts
    // rely entirely on the GaugeController fallback and never have one) from "every single
    // read across every epoch/gauge failed at the RPC level" — never getting even one real
    // answer back is a network failure, not evidence this account voted for nothing.
    if (gauges.length && !anyOracleCallSucceeded) {
      logErr('Votemarket: Oracle relay multicall never succeeded across any epoch/gauge', new Error('total batch failure'));
      return { status: 'error', message: 'failed to read the Votemarket Oracle relay', claimUsd: 0, rows };
    }
    return { status: 'ok', claimSummary: usd(0), claimUsd: 0, rows, claimList: [] };
  }

  // (epoch, campaign) pairs actually worth a getPeriodPerCampaign/totalClaimedByAccount
  // check — only campaigns whose gauge this account had an eligible vote for in that epoch.
  const claimJobs = [];
  for (const { epoch, eligibleGauges } of eligibleByEpoch) {
    for (const c of campaigns) {
      if (eligibleGauges.has(c.gauge)) claimJobs.push({ epoch, campaign: c, accountVote: eligibleGauges.get(c.gauge) });
    }
  }

  const feeByPlatform = new Map();
  await Promise.all(VOTEMARKET.platforms.map(async (platform) => {
    try {
      feeByPlatform.set(platform, word(await chainCall(VOTEMARKET.chainId, platform, VOTEMARKET.FEE), 0));
    } catch (err) {
      logErr('Votemarket fee() failed', err);
      feeByPlatform.set(platform, 40000000000000000n); // fall back to the documented 4% default
    }
  }));

  // customFeeByManager(manager) doesn't vary by epoch, so dedupe to one call per
  // (platform, manager) instead of one per claimJob — the same campaign can now
  // show up across many epochs. Batched via multicall() same as the two fan-outs
  // below, rather than one eth_call per unique manager.
  const uniqueManagers = [...new Map(claimJobs.map((j) => [`${j.campaign.platform}:${j.campaign.manager}`, j.campaign])).values()];
  const customFeeResults = await multicall(
    VOTEMARKET.chainId,
    uniqueManagers.map((c) => ({ target: c.platform, callData: VOTEMARKET.CUSTOM_FEE + encodeAddress(c.manager) }))
  );
  const customFeeCache = new Map(); // "platform:manager" -> bigint
  uniqueManagers.forEach((c, i) => {
    const r = customFeeResults[i];
    customFeeCache.set(`${c.platform}:${c.manager}`, r.success ? word(r.returnData, 0) : 0n);
  });

  // getPeriodPerCampaign/totalClaimedByAccount are genuinely epoch-dependent (a
  // campaign's rewardPerVote and this account's claimed amount both vary per
  // epoch), so — unlike customFeeByManager above — there's nothing to dedupe
  // here; every (epoch, campaign) pair is real, necessary work. What's NOT
  // necessary is one HTTP round-trip per call: batch both calls for every
  // claimJob into a single multicall() pass (2 calls per job, same order every
  // time so results can be matched back by index).
  const periodAndClaimedCalls = claimJobs.flatMap((job) => [
    { target: job.campaign.platform, callData: VOTEMARKET.GET_PERIOD + encodeUint256(job.campaign.campaignId) + encodeUint256(job.epoch) },
    { target: job.campaign.platform, callData: VOTEMARKET.TOTAL_CLAIMED + encodeUint256(job.campaign.campaignId) + encodeUint256(job.epoch) + encAccount },
  ]);
  const periodAndClaimedResults = await multicall(VOTEMARKET.chainId, periodAndClaimedCalls);

  const perClaim = claimJobs.map((job, i) => {
    const { campaign: c, accountVote } = job;
    const periodResult = periodAndClaimedResults[i * 2];
    const claimedResult = periodAndClaimedResults[i * 2 + 1];
    if (!periodResult.success || !claimedResult.success) return null;

    const rewardPerVote = word(periodResult.returnData, 1);
    const alreadyClaimed = word(claimedResult.returnData, 0) > 0n;
    if (rewardPerVote === 0n || alreadyClaimed) return null;

    const gross = (accountVote * rewardPerVote) / 10n ** 18n;
    if (gross === 0n) return null;

    const customFee = customFeeCache.get(`${c.platform}:${c.manager}`) || 0n;
    const feeBps = customFee > 0n ? customFee : feeByPlatform.get(c.platform);
    const net = gross - (gross * feeBps) / 10n ** 18n;
    return { token: c.rewardToken, amount: net };
  });

  const totals = new Map();
  perClaim.forEach((r) => {
    if (!r) return;
    totals.set(r.token, (totals.get(r.token) || 0n) + r.amount);
  });

  const tokens = [...totals.keys()];
  if (!tokens.length) {
    return { status: 'ok', claimSummary: usd(0), claimUsd: 0, rows, claimList: [] };
  }

  const priced = await priceTokensUsd(tokens, VOTEMARKET.priceChain);

  // Resolve any LaPoste-wrapped reward tokens back to their real mainnet
  // token and re-price using that (see the LAPOSTE_TOKEN_FACTORY comment
  // above) — merged in as a price override only, so symbol/decimals still
  // come from the wrapped token itself (its decimals always match the
  // native token's, since LaPoste's mint() carries the origin metadata).
  const nativeLookup = await multicall(
    VOTEMARKET.chainId,
    tokens.map((t) => ({ target: LAPOSTE_TOKEN_FACTORY, callData: LAPOSTE_NATIVE_TOKEN_OF + encodeAddress(t) }))
  );
  const nativeByWrapped = new Map();
  nativeLookup.forEach((r, i) => {
    if (!r.success) return;
    const native = addrAt(r.returnData, 0);
    if (native !== '0x0000000000000000000000000000000000000000') nativeByWrapped.set(tokens[i], native);
  });
  if (nativeByWrapped.size) {
    const nativePriced = await priceTokensUsd([...new Set(nativeByWrapped.values())], 'ethereum');
    nativeByWrapped.forEach((nativeAddr, wrapped) => {
      const p = nativePriced[nativeAddr]?.price;
      if (p != null) priced[wrapped].price = p;
    });
  }

  let totalUsd = 0;
  let missingPrice = false;
  const claimList = tokens.map((addr) => {
    const meta = priced[addr];
    const amount = totals.get(addr);
    const usdValue = meta.price != null ? (Number(amount) / 10 ** meta.decimals) * meta.price : null;
    if (usdValue != null) totalUsd += usdValue;
    else missingPrice = true;
    return { symbol: meta.symbol, amount: formatUnits(amount, meta.decimals, 4), usd: usdValue };
  });

  if (missingPrice) log('one or more Votemarket reward tokens have no listed USD price — excluded from the total', 'info');

  return { status: 'ok', claimSummary: usd(totalUsd), claimUsd: totalUsd, rows, claimList };
}

/* Pool count above which a full-pool RewardsSugar.rewards() scan (see fetchPoolRewardsFullScan
   below) is skipped entirely, falling back to the vote-based-only cheap path. Sized from live
   LpSugar.count() reads taken while building this feature: Velodrome's Optimism root has 1,525
   pools (comfortably inside this cap, paginated below); Aerodrome's Base root has 34,707 — even at
   FULL_SCAN_PAGE_SIZE that's ~232 sequential/parallel eth_calls PER REFRESH, PER veNFT, which risks
   both a minutes-long refresh and getting rate-limited/banned by the free public RPC, so it's
   judged not worth attempting rather than shipping something that silently times out or hammers
   the endpoint. This is the honest tradeoff called out in this fix's task: Aerodrome keeps today's
   vote-based-only behavior (still correct for currently-voted pools, just blind to historical ones
   the way Velodrome used to be) until there's a cheaper way to narrow Base's pool set (an indexer/
   subgraph, the same kind of thing the official dashboards almost certainly run behind the scenes
   and this app deliberately doesn't have). 3000 leaves headroom above Optimism's current 1,525
   without opening the door to Base. */
