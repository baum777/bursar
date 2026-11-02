import { CHAIN_ID } from '@/chain/rhc';
import { agentRegistryAbi, deploymentsForChain, endowmentFactoryAbi, escrowAbi, mandateAccountFactoryAbi, parseDeployment } from '@bursar/core';
import type { Deployment } from '@bursar/core';
import { encodeAbiParameters, encodeEventTopics, pad, toHex } from 'viem';
import type { Abi, AbiEvent, Address, Log } from 'viem';
import { describe, expect, it } from 'vitest';

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
} from '@/app/(app)/stats/aggregate';

const FLOOR = 69_564_399n;
const ESCROW_A = `0x${'a1'.repeat(20)}` as Address;
const ESCROW_B = `0x${'b2'.repeat(20)}` as Address;
const FACTORY = `0x${'f1'.repeat(20)}` as Address;
const payer = (n: number) => pad(toHex(0x1000 + n), { size: 20 }) as Address;
const payee = (n: number) => pad(toHex(0x2000 + n), { size: 20 }) as Address;
const USDG = (dollars: number) => BigInt(Math.round(dollars * 1e6));

let sequence = 0;

/** A log as the node returns it, encoded from the ABI the page decodes it with. */
function log(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, block: bigint): Log {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === eventName);
  if (event === undefined) throw new Error(`No event ${eventName}`);
  const plain = event.inputs.filter((input) => !input.indexed);
  sequence += 1;
  return {
    address,
    topics: encodeEventTopics({ abi: [event], eventName, args } as never) as never,
    data: encodeAbiParameters(plain, plain.map((input) => args[input.name as string])),
    blockNumber: block,
    blockHash: pad(toHex(block), { size: 32 }),
    logIndex: sequence,
    transactionHash: pad(toHex(sequence), { size: 32 }),
    transactionIndex: 0,
    removed: false,
  } as Log;
}

const locked = (escrow: Address, id: bigint, n: number, amount: bigint, block: bigint) =>
  log(escrow, escrowAbi, 'Locked', { id, payer: payer(n), payee: payee(n % 2), capabilityId: pad('0x01'), amount, deadline: 1_800_000_000n }, block);
const event = (escrow: Address, name: string, id: bigint, block: bigint, extra: Record<string, unknown> = {}) =>
  log(escrow, escrowAbi, name, { id, outputCommit: pad('0x02'), opener: payer(0), deadline: 1_800_000_000n, ...extra }, block);

/**
 * One escrow carrying every way a payment can end, and a second escrow whose ids start over.
 *
 *   A1 released             A2 timed out           A3 disputed, ruled 40% back
 *   A4 still held           A5 declined            A6 disputed, then reopened
 *   A7 released, then disputed by the payer        B1 released, same id as A1
 */
function escrowLogs(): Log[] {
  return [
    locked(ESCROW_A, 1n, 1, USDG(10), 100n),
    event(ESCROW_A, 'Released', 1n, 101n),
    locked(ESCROW_A, 2n, 2, USDG(2), 102n),
    event(ESCROW_A, 'TimedOut', 2n, 103n),
    locked(ESCROW_A, 3n, 3, USDG(5), 104n),
    event(ESCROW_A, 'Disputed', 3n, 105n),
    event(ESCROW_A, 'Resolved', 3n, 106n, { refundBps: 4000, refunded: USDG(2), paid: USDG(2.9) }),
    locked(ESCROW_A, 4n, 4, USDG(1.5), 107n),
    locked(ESCROW_A, 5n, 5, USDG(0.5), 108n),
    event(ESCROW_A, 'Cancelled', 5n, 109n),
    locked(ESCROW_A, 6n, 6, USDG(0.25), 110n),
    event(ESCROW_A, 'Disputed', 6n, 111n),
    event(ESCROW_A, 'DisputeReopened', 6n, 112n),
    locked(ESCROW_A, 7n, 1, USDG(3), 113n),
    event(ESCROW_A, 'Released', 7n, 114n),
    event(ESCROW_A, 'Disputed', 7n, 115n),
    locked(ESCROW_B, 1n, 8, USDG(4), 116n),
    event(ESCROW_B, 'Released', 1n, 117n),
  ];
}

describe('what the stats page scans', () => {
  const plan = scanPlan(deploymentsForChain(CHAIN_ID), FLOOR);

  it('scans each escrow once, though later records carry one over at the same address', () => {
    expect(plan.escrows.map((scan) => scan.address.toLowerCase()).sort()).toEqual(
      [
        '0x7d82ad9dc36734adcf5cf985295096b2b575c8c4',
        '0x4315f8be7c9661345710910577ec31cb867f3c20',
        '0x68d4ad683b5519c785dde9f0ee0ee09db2d40919',
        '0x11e73b5632837355e250fc236cfc2be03ad0845a',
      ].sort(),
    );
  });

  it('starts at the block a record names and never before the first Bursar deploy', () => {
    const from = new Map(plan.escrows.map((scan) => [scan.address.toLowerCase(), scan.fromBlock]));
    expect(from.get('0x11e73b5632837355e250fc236cfc2be03ad0845a')).toBe(77_686_776n);
    // The first two records name no block, and the third wrote the settlement chain's height.
    expect(from.get('0x7d82ad9dc36734adcf5cf985295096b2b575c8c4')).toBe(FLOOR);
    expect(from.get('0x68d4ad683b5519c785dde9f0ee0ee09db2d40919')).toBe(FLOOR);
  });

  it('reads private mandate factories and the endowment factory from their own blocks', () => {
    const factories = new Map(plan.mandateFactories.map((scan) => [scan.address.toLowerCase(), scan.fromBlock]));
    expect(factories.get('0x669366d0ae3c6b51fedcf451a01bf741fd2ed08d')).toBe(FLOOR);
    expect(factories.get('0xdbb3bd6172132d9049b2825c5dea18d0bb2a30d1')).toBe(75_627_494n);
    expect(plan.endowmentFactories).toEqual([
      { address: '0x3b1AF2d844C47913d90D6BDA278C6ccC92466326', fromBlock: 104_504_371n },
      { address: '0xE3efEd60E6c96dF216372654Bc1B5a7cF986a5b0', fromBlock: 104_119_583n },
      { address: '0x18a4961C3e5c201e76cdD580c22BB2a3cd3d3E6c', fromBlock: 95_410_861n },
    ]);
  });

  it('picks up a set that lands later without being told about it', () => {
    const [live] = deploymentsForChain(CHAIN_ID) as Deployment[];
    const next = parseDeployment({
      ...live,
      network: 'rhc-mainnet-v7',
      fromBlock: 104_000_000,
      contracts: { ...live!.contracts, Escrow: `0x${'7'.repeat(40)}`, AgentRegistry: `0x${'8'.repeat(40)}` },
    });
    const later = scanPlan([next, ...deploymentsForChain(CHAIN_ID)], FLOOR);
    expect(later.escrows).toContainEqual({ address: `0x${'7'.repeat(40)}`, fromBlock: 104_000_000n });
    expect(later.providerRegistries).toHaveLength(plan.providerRegistries.length + 1);
  });

  it('splits a range into inclusive spans the endpoint accepts', () => {
    expect(spans(10n, 34n, 10n)).toEqual([
      [10n, 19n],
      [20n, 29n],
      [30n, 34n],
    ]);
    expect(spans(10n, 10n, 10n)).toEqual([[10n, 10n]]);
  });
});

describe('payment totals', () => {
  const payments = readPayments(escrowLogs());
  const totals = paymentTotals(payments, new Set());

  it('keys a payment by escrow and id, so a second escrow counting from one again is its own payment', () => {
    expect(payments).toHaveLength(8);
  });

  it('counts released payments as settled, a dispute after release included', () => {
    expect(totals.settled).toEqual({ count: 3, volume: USDG(17) });
  });

  it('counts what escrow still holds, a reopened dispute included', () => {
    expect(totals.held).toEqual({ count: 2, amount: USDG(1.75) });
  });

  it('counts timeouts, declines and the refunded share of a ruling', () => {
    expect(totals.refunded).toEqual({ count: 3, amount: USDG(4.5) });
  });

  it('counts every dispute opened and the one ruled', () => {
    expect(totals.disputes).toEqual({ opened: 3, ruled: 1 });
  });

  it('counts each payee that received money once', () => {
    expect(totals.providersPaid).toBe(2);
  });

  it('leaves the share of Bursar’s own agents off when it names none', () => {
    expect(totals.operatedShare).toBeUndefined();
  });

  it('counts a mandate created for a listed agent key as Bursar’s own', () => {
    const agent = `0x${'99'.repeat(20)}` as Address;
    const mandates = readMandates([log(FACTORY, mandateAccountFactoryAbi, 'Created', { account: payer(1), principal: payer(0), agent, salt: pad('0x03') }, 90n)]);
    const share = paymentTotals(payments, operatedAccounts([agent], mandates)).operatedShare;
    // A1 and A7 were paid by that mandate; B1 was not.
    expect(share).toBeCloseTo(2 / 3);
  });

  it('lists the newest payments first', () => {
    expect(latestPayments(payments, 2).map((p) => [p.escrow, p.id])).toEqual([
      [ESCROW_B, 1n],
      [ESCROW_A, 7n],
    ]);
  });
});

describe('the daily series', () => {
  const payments = readPayments(escrowLogs());
  const day = 86_400;
  const now = 20_394 * day + 3_600;
  const times = new Map<bigint, number>([
    [101n, now - 2 * day],
    [114n, now - 2 * day + 60],
    [117n, now],
  ]);

  it('buckets settlements by UTC day and keeps empty days in the window', () => {
    const series = dailySeries(payments, times, { now, days: 3 });
    expect(series.map((d) => [d.day, d.payments, d.volume])).toEqual([
      ['2025-10-31', 2, USDG(13)],
      ['2025-11-01', 0, 0n],
      ['2025-11-02', 1, USDG(4)],
    ]);
  });

  it('leaves off a day it could not date in full rather than drawing it empty', () => {
    const series = dailySeries(payments, times, { now, days: 3, datedFrom: now - day });
    expect(series.map((d) => d.day)).toEqual(['2025-11-02']);
  });
});

describe('mandates, providers and endowments', () => {
  it('counts an account once whichever factory logged it', () => {
    const created = (account: Address, block: bigint) =>
      log(FACTORY, mandateAccountFactoryAbi, 'Created', { account, principal: payer(0), agent: payer(9), salt: pad('0x04') }, block);
    expect(readMandates([created(payer(1), 2n), created(payer(2), 3n), created(payer(1), 4n)])).toHaveLength(2);
  });

  it('counts a provider registered on two registries once', () => {
    const registered = (registry: Address, agent: Address) => log(registry, agentRegistryAbi, 'AgentRegistered', { agent, name: 'Summaries', stake: 10n }, 5n);
    expect(countProviders([registered(ESCROW_A, payee(0)), registered(ESCROW_B, payee(0)), registered(ESCROW_B, payee(1))])).toBe(2);
  });

  it('lists each endowment the factory created', () => {
    const endowment = `0x${'e1'.repeat(20)}` as Address;
    const created = log(FACTORY, endowmentFactoryAbi, 'Created', { endowment, agentId: 7n, settlor: payer(0), drawBps: 400, earnShareBps: 5000 }, 6n);
    expect(readEndowments([created, created]).map((address) => address.toLowerCase())).toEqual([endowment]);
  });
});
