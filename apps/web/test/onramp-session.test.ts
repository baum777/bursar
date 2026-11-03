import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CDP_KEY_ID_ENV, CDP_KEY_SECRET_ENV } from '@/app/api/onramp/cdp-jwt';

/**
 * The route opens one Coinbase session per gift, bound to the Relay deposit address that pays the
 * endowment, and hands the page the URL and the request to follow. Coinbase's key stays here.
 */
vi.mock('@/chain/client', () => ({
  rhcClient: () => ({
    // `isEndowment` on the factory answers true for the known endowment and false otherwise.
    call: async ({ data }: { data: `0x${string}` }) => ({
      data: data.toLowerCase().includes(ENDOWMENT.slice(2).toLowerCase()) ? `0x${'0'.repeat(63)}1` : `0x${'0'.repeat(64)}`,
    }),
  }),
}));

const ENDOWMENT = '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';
const DEPOSIT = '0x93d956d742f8321de0bf210af6329adf21656551';
const REQUEST_ID = `0x${'17'.repeat(32)}`;

type Call = { readonly url: string; readonly init: RequestInit | undefined };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

function upstreamAnswering(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, init: init as RequestInit | undefined });
    if (url.endsWith('/quote')) {
      return new Response(
        JSON.stringify({
          requestId: REQUEST_ID,
          steps: [{ id: 'deposit', description: 'Send USDC', depositAddress: DEPOSIT, items: [] }],
          fees: { relayer: { amountUsd: '0.03' }, gas: { amountUsd: '0.001' }, app: { amountUsd: '0' } },
          details: {
            currencyIn: { currency: { chainId: 8453, symbol: 'USDC', decimals: 6 }, amount: '25000000', amountFormatted: '25.0' },
            currencyOut: { currency: { chainId: 4663, symbol: 'USDG', decimals: 6 }, amount: '24850000', amountFormatted: '24.85', minimumAmount: '24700000' },
            timeEstimate: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('api.developer.coinbase.com/onramp/v1/token')) {
      return new Response(JSON.stringify({ token: 'session-token-1', channel_id: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not expected', { status: 500 });
  }) as typeof fetch;
}

function ask(payload: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): Promise<Response> {
  return import('@/app/api/onramp/session/route').then(({ POST }) =>
    POST(
      new Request('https://bursar.example/api/onramp/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    ),
  );
}

beforeEach(() => {
  calls = [];
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  process.env[CDP_KEY_ID_ENV] = 'key-1';
  process.env[CDP_KEY_SECRET_ENV] = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64');
  upstreamAnswering();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[CDP_KEY_ID_ENV];
  delete process.env[CDP_KEY_SECRET_ENV];
});

describe('a gift by card', () => {
  it('opens a Coinbase session bound to the Relay deposit address that pays the endowment', async () => {
    const answer = await ask({ endowment: ENDOWMENT, dollars: 25 });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { url: string; requestId: string; depositAddress: string; sends: string; expected: string };
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.depositAddress).toBe(DEPOSIT);
    expect(body.sends).toBe('25000000');
    expect(body.expected).toBe('24850000');

    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe('https://pay.coinbase.com/buy/select-asset');
    expect(url.searchParams.get('sessionToken')).toBe('session-token-1');
    expect(url.searchParams.get('defaultAsset')).toBe('USDC');
    expect(url.searchParams.get('defaultNetwork')).toBe('base');
    expect(url.searchParams.get('presetFiatAmount')).toBe('25');
    expect(url.searchParams.get('redirectUrl')).toBe(`https://bursar.example/endowments/${ENDOWMENT}?relay=${REQUEST_ID}&from=base`);

    const quote = calls.find((c) => c.url.endsWith('/quote'));
    const quoted = JSON.parse(String(quote?.init?.body)) as Record<string, unknown>;
    expect(quoted).toMatchObject({ recipient: ENDOWMENT, originChainId: 8453, destinationChainId: 4663, amount: '25000000', tradeType: 'EXACT_INPUT', useDepositAddress: true });

    const token = calls.find((c) => c.url.includes('/onramp/v1/token'));
    expect(String((token?.init?.headers as Record<string, string>)?.['authorization'])).toMatch(/^Bearer ey/);
    const bound = JSON.parse(String(token?.init?.body)) as { addresses: { address: string; blockchains: string[] }[]; assets: string[] };
    expect(bound.addresses).toEqual([{ address: DEPOSIT, blockchains: ['base'] }]);
    expect(bound.assets).toEqual(['USDC']);
  });

  it('sends the reader back to the configured site, not the listener behind the proxy', async () => {
    process.env['NEXT_PUBLIC_SITE_URL'] = 'https://app.bursar.world/';
    try {
      const answer = await ask({ endowment: ENDOWMENT, dollars: 10 });
      const body = (await answer.json()) as { url: string };
      expect(new URL(body.url).searchParams.get('redirectUrl')).toBe(`https://app.bursar.world/endowments/${ENDOWMENT}?relay=${REQUEST_ID}&from=base`);
    } finally {
      delete process.env['NEXT_PUBLIC_SITE_URL'];
    }
  });

  it('refuses an address that is not an endowment, a bad amount and another site', async () => {
    expect((await ask({ endowment: '0x5210D8df060A9D5ce4c1305045ED5c9548fca374', dollars: 25 })).status).toBe(404);
    expect((await ask({ endowment: ENDOWMENT, dollars: 2 })).status).toBe(400);
    expect((await ask({ endowment: ENDOWMENT, dollars: 25.5 })).status).toBe(400);
    expect((await ask({ endowment: ENDOWMENT, dollars: 25 }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(calls.filter((c) => c.url.includes('coinbase'))).toHaveLength(0);
  });

  it('says so when the deployment has no Coinbase key', async () => {
    delete process.env[CDP_KEY_ID_ENV];
    const answer = await ask({ endowment: ENDOWMENT, dollars: 25 });
    expect(answer.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
