import { createRhcClient, deploymentsForChain, endowmentAbi, settlementAssetAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import type { Abi, Address, Hex, Log } from 'viem';
import { getBlock, getBlockNumber, getLogs, multicall } from 'viem/actions';

import { HISTORY_FLOOR } from '@/app/(app)/console/lib/chain-logs';
import { rhcClient } from '@/chain/client';
import { ADDRESSES, CHAIN_ID, MULTICALL3, RHC, rpcProviders } from '@/chain/rhc';
import { bursarOperated } from '@/site';
import {
  countProviders,
  dailySeries,
  latestPayments,
  operatedAccounts,
  paymentTotals,
  readEndowments,
  readMandates,
  readPayments,
  scanPlan,
  spans,
} from './aggregate';
import type { ContractScan, DayFigure, PaymentStatus, PaymentTotals } from './aggregate';

export type RecentPayment = {
  readonly amount: bigint;
  readonly payer: Address;
  readonly payee: Address;
  /** The payer is an account one of the mandate factories created, so the console can open it. */
  readonly payerIsMandate: boolean;
  readonly status: PaymentStatus;
  readonly tx: Hex;
  /** Unix seconds. */
  readonly at: number;
};

/**
 * What the stats page shows. A section that could not be read in full is absent, never a partial
 * total: a figure missing one escrow's logs would be wrong and would look right.
 */
export type Stats = {
  /** Unix milliseconds. */
  readonly readAt: number;
  readonly block: bigint;
  readonly payments?: PaymentTotals;
  readonly daily?: readonly DayFigure[];
  readonly recent?: readonly RecentPayment[];
  readonly mandates?: {
    readonly count: number;
    readonly held?: bigint;
    /** Set when there were more accounts than one read takes, to the number the balance covers. */
    readonly heldAcross?: number;
  };
  readonly providers?: { readonly registered: number };
  readonly endowments?: { readonly count: number; readonly principal?: bigint };
};

/** Five minutes. A visitor inside that is served the last read; after it, the read refreshes behind them. */
export const FRESH_MS = 5 * 60_000;
/** How soon a read that came back short is tried again. */
const RETRY_MS = 30_000;

/** `eth_getLogs` on Robinhood's endpoint takes ten million blocks for one address. */
const LOG_SPAN = 10_000_000n;
const CHART_DAYS = 30;
const RECENT = 8;
/** Accounts whose USDG one read sums. Beyond it the figure says how many it covers. */
const MAX_ACCOUNTS = 2_000;
const SLOTS_PER_CALL = 100;
/** Settlement blocks dated per read. Past it the chart starts at the first day it fully covers. */
const MAX_DATED = 1_500;
const DATE_BATCH = 25;

const store = globalThis as typeof globalThis & {
  __bursarStats?: { held?: Stats; pending?: Promise<Stats> };
};

/**
 * The last read while it is fresh, the last read with a refresh behind it once it is not, and a
 * read only when there has never been one. The server warms it at start (see instrumentation.ts),
 * so a visitor does not wait on a scan. Kept on `globalThis` because the page and the warm-up are
 * bundled apart and would otherwise hold a copy each.
 */
export async function loadStats(): Promise<Stats> {
  const cache = (store.__bursarStats ??= {});
  const held = cache.held;
  if (held !== undefined && Date.now() - held.readAt < (whole(held) ? FRESH_MS : RETRY_MS)) return held;

  cache.pending ??= readStats(held)
    .catch(() => held ?? { readAt: Date.now(), block: 0n })
    .then((next) => (cache.held = next))
    .finally(() => {
      cache.pending = undefined;
    });

  return cache.held ?? cache.pending;
}

function whole(stats: Stats): boolean {
  return [stats.payments, stats.daily, stats.recent, stats.mandates?.held, stats.providers, stats.endowments].every((part) => part !== undefined);
}

/**
 * One full read. Each section stands or falls on its own, and a section that falls keeps what the
 * previous read had for it, so a refused chunk costs freshness and never a figure.
 */
export async function readStats(previous?: Stats): Promise<Stats> {
  const readAt = Date.now();
  let head: bigint;
  try {
    head = await getBlockNumber(rhcClient(), { cacheTime: 0 });
  } catch {
    return previous ?? { readAt, block: 0n };
  }

  const plan = scanPlan(deploymentsForChain(CHAIN_ID), HISTORY_FLOOR[CHAIN_ID] ?? 0n);
  const [escrowLogs, factoryLogs, registryLogs, endowmentLogs] = await Promise.all(
    [plan.escrows, plan.mandateFactories, plan.providerRegistries, plan.endowmentFactories].map((scans) =>
      logsOf(scans, head).catch(() => undefined),
    ),
  );

  const mandates = factoryLogs === undefined ? undefined : readMandates(factoryLogs);
  const payments = escrowLogs === undefined ? undefined : readPayments(escrowLogs);
  // Without the mandates there is no telling which payers are Bursar's own agents, so the share is
  // left off rather than computed against the bare list.
  const operated = mandates === undefined ? new Set<string>() : operatedAccounts(bursarOperated(), mandates);
  const knownMandates = new Set(mandates?.map((m) => m.account.toLowerCase()));

  const [held, endowments, dated] = await Promise.all([
    mandates === undefined ? undefined : usdgHeld(mandates.map((m) => m.account).reverse()).catch(() => undefined),
    endowmentLogs === undefined ? undefined : endowmentFigures(readEndowments(endowmentLogs)).catch(() => undefined),
    payments === undefined ? undefined : datePayments(payments, readAt).catch(() => undefined),
  ]);

  const fresh: Stats = {
    readAt,
    block: head,
    ...(payments === undefined ? {} : { payments: paymentTotals(payments, operated) }),
    ...(payments === undefined || dated === undefined
      ? {}
      : {
          daily: dailySeries(payments, dated.times, { now: readAt / 1000, days: CHART_DAYS, ...(dated.from === undefined ? {} : { datedFrom: dated.from }) }),
          recent: latestPayments(payments, RECENT).flatMap((p) => {
            const at = dated.times.get(p.lockedBlock);
            if (at === undefined) return [];
            return [{ amount: p.amount, payer: p.payer, payee: p.payee, payerIsMandate: knownMandates.has(p.payer.toLowerCase()), status: p.status, tx: p.lockedTx, at }];
          }),
        }),
    ...(mandates === undefined ? {} : { mandates: { count: mandates.length, ...held } }),
    ...(registryLogs === undefined ? {} : { providers: { registered: countProviders(registryLogs) } }),
    ...(endowments === undefined ? {} : { endowments }),
  };

  if (previous === undefined) return fresh;
  const mandatesMerged = fresh.mandates !== undefined && previous.mandates !== undefined ? { mandates: { ...previous.mandates, ...fresh.mandates } } : {};
  return { ...previous, ...fresh, ...mandatesMerged };
}

let scanner: RhcPublicClient | undefined;

/**
 * The log scan goes to the primary endpoint alone, through a pool of its own. The fallback refuses
 * any `eth_getLogs` over ten thousand blocks, so failing a span over to it turns a 429 into a
 * refusal; a pool with one provider waits out the 429 and asks again. Few spans at a time, because
 * the endpoint meters a ten-million-block query well below its plain-call rate.
 */
function scanClient(): RhcPublicClient {
  const [primary] = rpcProviders();
  if (primary === undefined) throw new Error('No RPC endpoint is configured.');
  scanner ??= createRhcClient({
    chain: RHC,
    providers: [{ ...primary, maxConcurrent: 3 }],
    requireRedundancy: false,
    retry: { maxPasses: 6, baseDelayMs: 400, maxDelayMs: 4_000 },
  }).client;
  return scanner;
}

async function logsOf(scans: readonly ContractScan[], head: bigint): Promise<Log[]> {
  const pages = await Promise.all(
    scans.flatMap((scan) =>
      spans(scan.fromBlock, head, LOG_SPAN).map(([fromBlock, toBlock]) => getLogs(scanClient(), { address: scan.address, fromBlock, toBlock })),
    ),
  );
  return pages.flat();
}

async function usdgHeld(newestFirst: readonly Address[]): Promise<{ held: bigint; heldAcross?: number }> {
  const accounts = newestFirst.slice(0, MAX_ACCOUNTS);
  const balances = await multicallAll(
    accounts.map((account) => ({ address: ADDRESSES.usdg, abi: settlementAssetAbi as Abi, functionName: 'balanceOf', args: [account] })),
  );
  const held = (balances as bigint[]).reduce((total, balance) => total + balance, 0n);
  return newestFirst.length > MAX_ACCOUNTS ? { held, heldAcross: MAX_ACCOUNTS } : { held };
}

async function endowmentFigures(addresses: readonly Address[]): Promise<{ count: number; principal?: bigint }> {
  if (addresses.length === 0) return { count: 0 };
  const states = (await multicallAll(addresses.map((address) => ({ address, abi: endowmentAbi as Abi, functionName: 'state' })))) as {
    nav: bigint;
  }[];
  return { count: addresses.length, principal: states.reduce((total, state) => total + state.nav, 0n) };
}

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/** Every call must answer. A balance that reverted would make the sum smaller and look the same. */
async function multicallAll(calls: readonly Call[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += SLOTS_PER_CALL) {
    const answers = await multicall(rhcClient(), {
      multicallAddress: MULTICALL3,
      allowFailure: false,
      batchSize: 0,
      contracts: calls.slice(i, i + SLOTS_PER_CALL),
    });
    out.push(...answers);
  }
  return out;
}

/**
 * Block times for what the page dates: the newest payments, and every settlement inside the chart.
 *
 * The endpoint stamps its logs with a zero time, so each block is asked for. Settlements are dated
 * newest first and the walk stops at the first block older than the chart, so the cost follows
 * activity in the window and not the length of the history. `from` is set when the walk stopped
 * at its ceiling before reaching the start of the chart.
 */
async function datePayments(
  payments: ReturnType<typeof readPayments>,
  now: number,
): Promise<{ times: Map<bigint, number>; from?: number }> {
  const times = new Map<bigint, number>();
  const date = async (blocks: readonly bigint[]) => {
    const answers = await Promise.all(blocks.map((blockNumber) => getBlock(rhcClient(), { blockNumber })));
    for (const block of answers) times.set(block.number, Number(block.timestamp));
  };

  await date([...new Set(latestPayments(payments, RECENT).map((p) => p.lockedBlock))]);

  const start = (Math.floor(now / 1000 / 86_400) - CHART_DAYS + 1) * 86_400;
  const settled = [...new Set(payments.flatMap((p) => (p.settledBlock === undefined ? [] : [p.settledBlock])))].sort((a, b) => (a < b ? 1 : -1));

  for (let i = 0; i < settled.length; i += DATE_BATCH) {
    if (i >= MAX_DATED) {
      const oldest = Math.min(...settled.slice(0, i).map((block) => times.get(block) ?? Infinity));
      return { times, from: oldest };
    }
    const batch = settled.slice(i, i + DATE_BATCH).filter((block) => !times.has(block));
    await date(batch);
    const last = settled[Math.min(i + DATE_BATCH, settled.length) - 1];
    if (last !== undefined && (times.get(last) ?? Infinity) < start) break;
  }

  return { times };
}
