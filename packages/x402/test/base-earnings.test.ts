import { describe, expect, test } from 'vitest';
import { BASE_LANE } from '@bursar/core';

import { BASE_EARNINGS, baseEarnings, encodePayment } from '../src/index.js';
import { X402ConfigError } from '../src/errors.js';

const ENDOWMENT = '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';
const BUYER = '0x877c349EFb5926082C413833E8055F0991185c61';

type Call = { url: string; body: Record<string, unknown> };

function stub(answer: (call: Call) => { status?: number; body: unknown }): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const call = { url: String(input), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const header = (accepted: Record<string, unknown>) =>
  encodePayment({
    x402Version: 2,
    accepted,
    payload: { signature: `0x${'ab'.repeat(65)}`, authorization: { from: BUYER, to: BASE_LANE.float, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: `0x${'11'.repeat(32)}` } },
  });

describe('terms for selling on Base into an endowment', () => {
  test('price USDC on Base, pay the lane, and carry the endowment in extra', () => {
    const earnings = baseEarnings({ endowment: ENDOWMENT.toLowerCase(), price: '$0.01' });
    expect(earnings.requirements).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: BASE_LANE.float,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2', endowment: ENDOWMENT },
    });
    expect(earnings.route).toEqual({ scheme: 'exact', network: 'eip155:8453', price: '$0.01', payTo: BASE_LANE.float, maxTimeoutSeconds: 300, extra: { endowment: ENDOWMENT } });
    expect(earnings.facilitator).toBe('https://facilitator.bursar.world/base/earn');
    expect(BASE_EARNINGS.payTo).toBe(BASE_LANE.float);
  });

  test('a v2 402 lists the one entry in the header and the body', () => {
    const earnings = baseEarnings({ endowment: ENDOWMENT, price: 0.25 });
    const answer = earnings.paymentRequired({ resource: { url: 'https://agent.example/answer', description: 'One answer' } });
    const decoded = JSON.parse(Buffer.from(answer.headers['PAYMENT-REQUIRED'] ?? '', 'base64').toString('utf8')) as { accepts: { amount: string; extra: { endowment: string } }[]; resource: { url: string } };
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]).toMatchObject({ amount: '250000', extra: { endowment: ENDOWMENT } });
    expect(decoded.resource.url).toBe('https://agent.example/answer');
  });

  test('refuses an endowment that is not an address, a price USDC cannot carry, and a timeout past an hour', () => {
    expect(() => baseEarnings({ endowment: 'nobody', price: '0.01' })).toThrow(X402ConfigError);
    expect(() => baseEarnings({ endowment: ENDOWMENT, price: '0.0000001' })).toThrow(X402ConfigError);
    expect(() => baseEarnings({ endowment: ENDOWMENT, price: '0' })).toThrow(/above zero/);
    expect(() => baseEarnings({ endowment: ENDOWMENT, price: '0.01', maxTimeoutSeconds: 7_200 })).toThrow(X402ConfigError);
  });

  test('settles against the earnings surface and reads what the endowment was credited', async () => {
    const { fetchFn, calls } = stub(() => ({
      body: {
        success: true,
        settled: true,
        broadcast: true,
        payer: BUYER,
        transaction: `0x${'ee'.repeat(32)}`,
        network: 'eip155:8453',
        extra: { earning: '6a1f0c1e-0000-4000-8000-000000000001', endowment: ENDOWMENT, creditMicro: '8000', feeMicro: '2000', status: 'received' },
      },
    }));
    const earnings = baseEarnings({ endowment: ENDOWMENT, price: '0.01', facilitator: 'https://facilitator.test/base/earn/', fetchFn });
    const settled = await earnings.settle(header(earnings.requirements));
    expect(settled).toMatchObject({ success: true, transaction: `0x${'ee'.repeat(32)}`, credit: { endowment: ENDOWMENT, creditMicro: '8000', feeMicro: '2000', status: 'received' } });
    expect(calls[0]?.url).toBe('https://facilitator.test/base/earn/settle');
    expect(calls[0]?.body['paymentRequirements']).toMatchObject({ payTo: BASE_LANE.float, extra: { endowment: ENDOWMENT } });
  });

  test('a refusal carries the facilitator sentence in either spelling, and a garbled header never leaves the process', async () => {
    const { fetchFn, calls } = stub((call) =>
      call.url.endsWith('/verify')
        ? { body: { isValid: false, invalidReason: 'endowment_unknown', invalidMessage: 'not a Bursar endowment', payer: BUYER } }
        : { body: { success: false, settled: false, broadcast: false, errorReason: 'endowment_credit_unavailable', errorMessage: 'the lane is short', transaction: '', network: 'eip155:8453' } },
    );
    const earnings = baseEarnings({ endowment: ENDOWMENT, price: '0.01', fetchFn });
    expect(await earnings.verify(header(earnings.requirements))).toMatchObject({ isValid: false, invalidReason: 'endowment_unknown', detail: 'not a Bursar endowment' });
    expect(await earnings.settle(header(earnings.requirements))).toMatchObject({ success: false, broadcast: false, errorReason: 'endowment_credit_unavailable', detail: 'the lane is short' });
    expect(await earnings.settle('not base64 json')).toMatchObject({ success: false, broadcast: false, errorReason: 'invalid_payload' });
    expect(calls).toHaveLength(2);
  });
});
