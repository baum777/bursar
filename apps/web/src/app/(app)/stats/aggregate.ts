import { agentRegistryAbi, endowmentFactoryAbi, escrowAbi, mandateAccountFactoryAbi } from '@bursar/core';
import type { Deployment } from '@bursar/core';
import { parseEventLogs } from 'viem';
import type { Address, Hex, Log } from 'viem';

/**
 * The usage figures, worked out from event logs and nothing else, so every number on the stats page
 * can be checked against a fixture. Reading the chain is read.ts; this file never touches it.
 */

/** One contract to scan, from the first block it can have logged anything. */
export type ContractScan = { readonly address: Address; readonly fromBlock: bigint };

export type ScanPlan = {
  readonly escrows: readonly ContractScan[];
  /** Standard and private mandate factories. Both emit the same `Created`. */
  readonly mandateFactories: readonly ContractScan[];
  readonly providerRegistries: readonly ContractScan[];
  readonly endowmentFactories: readonly ContractScan[];
};

/**
 * Every contract the records name, each once. Later records carry contracts over at the same
 * address, so an address keeps the earliest block any record gives it. No block is earlier than
 * `floor`: one record wrote the settlement chain's height in place of this chain's, and a record
 * that names no block at all is read from the floor.
 */
export function scanPlan(records: readonly Deployment[], floor: bigint): ScanPlan {
  const groups: Record<keyof ScanPlan, Map<string, ContractScan>> = {
    escrows: new Map(),
    mandateFactories: new Map(),
    providerRegistries: new Map(),
    endowmentFactories: new Map(),
  };

  const add = (group: keyof ScanPlan, address: Address | undefined, from: number | undefined) => {
    if (address === undefined) return;
    const fromBlock = from === undefined || BigInt(from) < floor ? floor : BigInt(from);
    const key = address.toLowerCase();
    const known = groups[group].get(key);
    if (known === undefined || fromBlock < known.fromBlock) groups[group].set(key, { address, fromBlock });
  };

  for (const d of records) {
    add('escrows', d.contracts.Escrow, d.fromBlock);
    add('mandateFactories', d.contracts.MandateAccountFactory, d.fromBlock);
    add('mandateFactories', d.rwa?.MandateAccountFactoryV21, d.fromBlock);
    add('mandateFactories', d.privacy?.CommittedMandateFactory, d.privacy?.fromBlock);
    add('mandateFactories', d.privacy?.CommittedMandateFactoryV1Escrow, d.privacy?.fromBlock);
    add('providerRegistries', d.contracts.AgentRegistry, d.fromBlock);
    add('endowmentFactories', d.endowments?.EndowmentFactory, d.endowments?.fromBlock);
    add('endowmentFactories', d.endowmentsV2?.EndowmentFactory, d.endowmentsV2?.fromBlock);
    add('endowmentFactories', d.endowmentsV1?.EndowmentFactory, d.endowmentsV1?.fromBlock);
  }

  return {
    escrows: [...groups.escrows.values()],
    mandateFactories: [...groups.mandateFactories.values()],
    providerRegistries: [...groups.providerRegistries.values()],
    endowmentFactories: [...groups.endowmentFactories.values()],
  };
}

/** Inclusive block ranges of at most `size` blocks, from `from` to `head`. */
export function spans(from: bigint, head: bigint, size: bigint): readonly (readonly [bigint, bigint])[] {
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= head; start += size) {
    const end = start + size - 1n;
    out.push([start, end > head ? head : end]);
  }
  return out;
}

export type PaymentStatus = 'held' | 'disputed' | 'settled' | 'refunded' | 'ruled';

/** One payment into an escrow, as its events leave it. */
export type Payment = {
  readonly escrow: Address;
  readonly id: bigint;
  readonly payer: Address;
  readonly payee: Address;
  readonly amount: bigint;
  readonly lockedBlock: bigint;
  readonly lockedTx: Hex;
  readonly status: PaymentStatus;
  /** The block it was released to the payee in, for a settled payment. */
  readonly settledBlock?: bigint;
  /** What went back to the payer: all of it on a timeout or a decline, the ruled share after a dispute. */
  readonly refunded: bigint;
  /** What a ruling paid the payee. Zero unless a dispute was ruled. */
  readonly ruledPaid: bigint;
  /** Times the payment was disputed, before or after release. */
  readonly disputes: number;
};

const LOCK_EVENTS = ['Locked', 'Released', 'TimedOut', 'Cancelled', 'Disputed', 'DisputeReopened', 'Resolved'] as const;

function chronological(logs: readonly Log[]): Log[] {
  return logs
    .filter((log) => !log.removed)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1,
    );
}

/**
 * Every payment the escrows hold a record of, with where it stands now.
 *
 * Lock ids count from zero on each escrow, so a payment is keyed by both. A dispute raised after
 * release changes nothing about the money: the payee was paid in the release and stays paid.
 */
export function readPayments(logs: readonly Log[]): readonly Payment[] {
  const payments = new Map<string, Payment>();
  const events = parseEventLogs({ abi: escrowAbi, logs: chronological(logs), eventName: [...LOCK_EVENTS] });

  for (const event of events) {
    const key = `${event.address.toLowerCase()}:${event.args.id}`;
    if (event.eventName === 'Locked') {
      payments.set(key, {
        escrow: event.address,
        id: event.args.id,
        payer: event.args.payer,
        payee: event.args.payee,
        amount: event.args.amount,
        lockedBlock: event.blockNumber,
        lockedTx: event.transactionHash,
        status: 'held',
        refunded: 0n,
        ruledPaid: 0n,
        disputes: 0,
      });
      continue;
    }

    const payment = payments.get(key);
    if (payment === undefined) continue;

    switch (event.eventName) {
      case 'Released':
        payments.set(key, { ...payment, status: 'settled', settledBlock: event.blockNumber });
        break;
      case 'TimedOut':
      case 'Cancelled':
        payments.set(key, { ...payment, status: 'refunded', refunded: payment.amount });
        break;
      case 'Disputed':
        payments.set(key, { ...payment, status: payment.status === 'held' ? 'disputed' : payment.status, disputes: payment.disputes + 1 });
        break;
      case 'DisputeReopened':
        payments.set(key, { ...payment, status: 'held' });
        break;
      case 'Resolved':
        payments.set(key, { ...payment, status: 'ruled', refunded: event.args.refunded, ruledPaid: event.args.paid });
        break;
    }
  }

  return [...payments.values()];
}

export type PaymentTotals = {
  readonly settled: { readonly count: number; readonly volume: bigint };
  readonly held: { readonly count: number; readonly amount: bigint };
  readonly refunded: { readonly count: number; readonly amount: bigint };
  readonly disputes: { readonly opened: number; readonly ruled: number };
  /** Distinct payees that received money, by release or by a ruling. */
  readonly providersPaid: number;
  /** The share of settled payments made by accounts Bursar runs, 0 to 1. Absent when it names none. */
  readonly operatedShare?: number;
};

export function paymentTotals(payments: readonly Payment[], operated: ReadonlySet<string>): PaymentTotals {
  const settled = payments.filter((p) => p.status === 'settled');
  const held = payments.filter((p) => p.status === 'held' || p.status === 'disputed');
  const refunded = payments.filter((p) => p.refunded > 0n);
  const paid = new Set(payments.filter((p) => p.status === 'settled' || p.ruledPaid > 0n).map((p) => p.payee.toLowerCase()));

  const totals: PaymentTotals = {
    settled: { count: settled.length, volume: sum(settled.map((p) => p.amount)) },
    held: { count: held.length, amount: sum(held.map((p) => p.amount)) },
    refunded: { count: refunded.length, amount: sum(refunded.map((p) => p.refunded)) },
    disputes: { opened: payments.reduce((n, p) => n + p.disputes, 0), ruled: payments.filter((p) => p.status === 'ruled').length },
    providersPaid: paid.size,
  };

  if (operated.size === 0) return totals;
  const ours = settled.filter((p) => operated.has(p.payer.toLowerCase())).length;
  return { ...totals, operatedShare: settled.length === 0 ? 0 : ours / settled.length };
}

export type Mandate = { readonly account: Address; readonly agent: Address };

/** Every account the factories created, oldest first, each once. */
export function readMandates(logs: readonly Log[]): readonly Mandate[] {
  const seen = new Map<string, Mandate>();
  for (const event of parseEventLogs({ abi: mandateAccountFactoryAbi, logs: chronological(logs), eventName: 'Created' })) {
    const key = event.args.account.toLowerCase();
    if (!seen.has(key)) seen.set(key, { account: event.args.account, agent: event.args.agent });
  }
  return [...seen.values()];
}

/**
 * The accounts whose payments count as Bursar's own: any address on the list, and every mandate
 * created for an agent key on it.
 */
export function operatedAccounts(listed: readonly Address[], mandates: readonly Mandate[]): ReadonlySet<string> {
  const keys = new Set(listed.map((address) => address.toLowerCase()));
  const accounts = new Set(keys);
  for (const mandate of mandates) if (keys.has(mandate.agent.toLowerCase())) accounts.add(mandate.account.toLowerCase());
  return accounts;
}

/** Distinct addresses that have registered as providers, on any registry. */
export function countProviders(logs: readonly Log[]): number {
  const events = parseEventLogs({ abi: agentRegistryAbi, logs: chronological(logs), eventName: 'AgentRegistered' });
  return new Set(events.map((event) => event.args.agent.toLowerCase())).size;
}

export function readEndowments(logs: readonly Log[]): readonly Address[] {
  const events = parseEventLogs({ abi: endowmentFactoryAbi, logs: chronological(logs), eventName: 'Created' });
  return [...new Map(events.map((event) => [event.args.endowment.toLowerCase(), event.args.endowment])).values()];
}

export type DayFigure = {
  /** The UTC day, as YYYY-MM-DD. */
  readonly day: string;
  readonly payments: number;
  readonly volume: bigint;
};

const DAY_SECONDS = 86_400;

/**
 * Settled payments per UTC day, for the `days` days ending on the one `now` falls in.
 *
 * `datedFrom` is the earliest moment every settlement has a time for. A day that starts before it
 * is left off, so a day whose payments were never dated is not drawn as a day with none.
 */
export function dailySeries(
  payments: readonly Payment[],
  times: ReadonlyMap<bigint, number>,
  options: { readonly now: number; readonly days: number; readonly datedFrom?: number },
): readonly DayFigure[] {
  const today = Math.floor(options.now / DAY_SECONDS);
  const first = today - options.days + 1;
  const series = new Map<number, { payments: number; volume: bigint }>();
  for (let day = first; day <= today; day += 1) {
    if (options.datedFrom === undefined || day * DAY_SECONDS >= options.datedFrom) series.set(day, { payments: 0, volume: 0n });
  }

  for (const payment of payments) {
    if (payment.status !== 'settled' || payment.settledBlock === undefined) continue;
    const at = times.get(payment.settledBlock);
    if (at === undefined) continue;
    const bucket = series.get(Math.floor(at / DAY_SECONDS));
    if (bucket === undefined) continue;
    bucket.payments += 1;
    bucket.volume += payment.amount;
  }

  return [...series].map(([day, figure]) => ({ day: new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10), ...figure }));
}

/** The newest payments into escrow, newest first. */
export function latestPayments(payments: readonly Payment[], count: number): readonly Payment[] {
  return [...payments].sort((a, b) => (a.lockedBlock === b.lockedBlock ? Number(b.id - a.id) : a.lockedBlock < b.lockedBlock ? 1 : -1)).slice(0, count);
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
