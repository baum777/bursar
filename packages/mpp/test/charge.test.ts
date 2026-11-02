import { describe, expect, it } from 'vitest';
import { Mppx } from 'mppx/server';
import { Fetch } from 'mppx/client';
import { privateKeyToAccount } from 'viem/accounts';
import { RHC_MAINNET, RHC_MAINNET_USDG_DOMAIN_SEPARATOR } from '@bursar/core';
import { hashDomain } from 'viem';

import { FACILITATOR, NETWORK, USDG } from '../src/index.js';
import { usdgCharge } from '../src/server.js';
import { usdgPayer } from '../src/client.js';

const RECIPIENT = '0x5210000000000000000000000000000000000000' as const;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const payer = privateKeyToAccount(PAYER_KEY);

type Seen = { paymentPayload: Record<string, any>; paymentRequirements: Record<string, any> };

/** A facilitator double in the shape `mppx` calls: what reached it is what the test reads. */
function facilitatorDouble() {
  const verified: Seen[] = [];
  const settled: Seen[] = [];
  return {
    verified,
    settled,
    facilitator: {
      async verify(paymentPayload: any, paymentRequirements: any) {
        verified.push({ paymentPayload, paymentRequirements });
        return { isValid: true, payer: paymentPayload.payload.authorization.from };
      },
      async settle(paymentPayload: any, paymentRequirements: any) {
        settled.push({ paymentPayload, paymentRequirements });
        return { success: true, transaction: '0xabc', network: paymentRequirements.network, payer: paymentPayload.payload.authorization.from };
      },
    },
  };
}

function server(facilitator: ReturnType<typeof facilitatorDouble>['facilitator']) {
  const mppx = Mppx.create({
    methods: [usdgCharge({ recipient: RECIPIENT, x402: { facilitator } })],
    secretKey: 'test-secret-key-that-is-long-enough-for-hmac-use',
  });
  const route = mppx.evm.charge({ amount: '0.01', description: 'one quote' });
  return async (request: Request): Promise<Response> => {
    const result = await route(request);
    if (result.status === 402) return result.challenge;
    return result.withReceipt(Response.json({ ok: true }));
  };
}

describe('USDG on Robinhood Chain for mppx', () => {
  it('is the token and the domain the chain publishes', () => {
    expect(USDG.address).toBe(RHC_MAINNET.usdg);
    expect(USDG.decimals).toBe(6);
    expect(USDG.network).toBe(`eip155:${RHC_MAINNET.chainId}`);
    expect(USDG.transfer).toEqual({ type: 'eip3009', name: 'Global Dollar', version: '1' });
    expect(
      hashDomain({
        domain: { name: 'Global Dollar', version: '1', chainId: BigInt(RHC_MAINNET.chainId), verifyingContract: RHC_MAINNET.usdg },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      }),
    ).toBe(RHC_MAINNET_USDG_DOMAIN_SEPARATOR);
    expect(FACILITATOR).toBe('https://facilitator.bursar.world/x402');
  });

  it('answers a 402 with an MPP challenge and an x402 one, both in USDG on Robinhood Chain', async () => {
    const handle = server(facilitatorDouble().facilitator);
    const response = await handle(new Request('https://api.example.test/quote'));
    expect(response.status).toBe(402);

    const mpp = response.headers.get('www-authenticate') ?? '';
    expect(mpp.startsWith('Payment ')).toBe(true);
    expect(mpp).toContain('evm');

    const x402 = response.headers.get('payment-required');
    expect(x402).not.toBeNull();
    const required = JSON.parse(Buffer.from(x402!, 'base64').toString('utf8'));
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: NETWORK,
      asset: RHC_MAINNET.usdg,
      amount: '10000',
      payTo: RECIPIENT,
      extra: { name: 'Global Dollar', version: '1' },
    });
  });

  it('takes a native MPP credential and settles it through the facilitator in the x402 shape', async () => {
    const double = facilitatorDouble();
    const handle = server(double.facilitator);
    const fetchWithPayment = Fetch.from({
      methods: [usdgPayer({ account: payer, maxAmount: '1.00' })],
      fetch: (async (input: any, init?: any) => handle(new Request(input, init))) as typeof fetch,
    });

    const response = await fetchWithPayment('https://api.example.test/quote');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('payment-receipt')).toBeTruthy();

    expect(double.settled).toHaveLength(1);
    const { paymentPayload, paymentRequirements } = double.settled[0]!;
    expect(paymentRequirements).toMatchObject({
      scheme: 'exact',
      network: NETWORK,
      asset: RHC_MAINNET.usdg,
      amount: '10000',
      payTo: RECIPIENT,
      extra: { name: 'Global Dollar', version: '1' },
    });
    expect(paymentPayload.x402Version).toBe(2);
    expect(paymentPayload.payload.authorization).toMatchObject({ from: payer.address, to: RECIPIENT, value: '10000' });
    expect(paymentPayload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('refuses to sign more than the client allows', async () => {
    const double = facilitatorDouble();
    const handle = server(double.facilitator);
    const fetchWithPayment = Fetch.from({
      methods: [usdgPayer({ account: payer, maxAmount: '0.001' })],
      fetch: (async (input: any, init?: any) => handle(new Request(input, init))) as typeof fetch,
    });
    await expect(fetchWithPayment('https://api.example.test/quote')).rejects.toThrow(/exceeds maxAmount/);
    expect(double.settled).toHaveLength(0);
  });
});
