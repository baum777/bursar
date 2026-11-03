import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/chain/client', () => ({ rhcClient: () => ({}) }));
const reads = vi.fn();
vi.mock('viem/actions', () => ({ readContract: (...args: unknown[]) => reads(...args) }));

const { GET } = await import('@/app/api/quotes/route');

const ask = (symbol: string, token?: string) =>
  GET(new Request(`https://app.bursar.world/api/quotes?symbol=${symbol}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}));

describe('the quotes back end', () => {
  beforeEach(() => {
    vi.stubEnv('BURSAR_QUOTES_TOKEN', 'quotes-token');
    reads.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers nothing without the token, and nothing at all when none is set', async () => {
    expect((await ask('NVDA')).status).toBe(404);
    expect((await ask('NVDA', 'wrong')).status).toBe(404);
    vi.stubEnv('BURSAR_QUOTES_TOKEN', '');
    expect((await ask('NVDA', '')).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });

  it('names the symbols it knows when asked for another', async () => {
    const response = await ask('NOPE', 'quotes-token');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { symbols: string[] }).symbols).toContain('SPCX');
  });

  it('reads the feed once and serves the same quote inside the window', async () => {
    reads.mockImplementation(async (_client: unknown, call: { functionName: string }) =>
      call.functionName === 'decimals' ? 8 : [1n, 14_128_055_000n, 0n, 1_793_725_069n, 1n],
    );
    const first = (await (await ask('spcx', 'quotes-token')).json()) as Record<string, string>;
    expect(first).toMatchObject({ symbol: 'SPCX', kind: 'stock', price: '141.28055', updatedAt: '2026-11-03T16:57:49.000Z' });
    await ask('SPCX', 'quotes-token');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('says the feed is unreadable rather than inventing a price', async () => {
    reads.mockRejectedValue(new Error('429'));
    const response = await ask('TSLA', 'quotes-token');
    expect(response.status).toBe(503);
  });
});
