import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const ESCROW_V4 = '0x11e73b5632837355e250fc236cfc2be03ad0845a';
const refused = new Set<string>();

vi.mock('@/chain/client', () => ({ rhcClient: () => ({}) }));
vi.mock('viem/actions', async (original) => ({
  ...(await original<typeof import('viem/actions')>()),
  getBlockNumber: async () => 104_000_000n,
  getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: 1_793_000_000n }),
  multicall: async () => [],
  getLogs: async (_client: unknown, { address }: { address: Address }) => {
    if (refused.has(address.toLowerCase())) throw new Error('429 Too Many Requests');
    return [];
  },
}));

const { readStats } = await import('@/app/(app)/stats/read');

describe('a read with a refused span', () => {
  it('leaves the payments out rather than totalling the escrows it could read', async () => {
    refused.add(ESCROW_V4);
    const stats = await readStats();
    expect(stats.payments).toBeUndefined();
    expect(stats.daily).toBeUndefined();
    expect(stats.recent).toBeUndefined();
    expect(stats.mandates).toEqual({ count: 0, held: 0n });
    expect(stats.providers).toEqual({ registered: 0 });
  });

  it('keeps the last good payments when a later read loses them', async () => {
    refused.clear();
    const good = await readStats();
    expect(good.payments?.settled).toEqual({ count: 0, volume: 0n });

    refused.add(ESCROW_V4);
    const next = await readStats(good);
    expect(next.payments).toBe(good.payments);
    expect(next.readAt).toBeGreaterThanOrEqual(good.readAt);
  });
});
