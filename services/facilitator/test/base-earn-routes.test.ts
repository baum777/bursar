import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';

import { BaseEarnings } from '../src/base/earn.js';
import { LaneLedger } from '../src/lanes/ledger.js';
import { TrustStore } from '../src/trust/store.js';
import { SettlementBudget } from '../src/x402/budget.js';
import { Facilitator } from '../src/x402/facilitator.js';
import { createRouter, errorResponse } from '../src/http/routes.js';
import type { ApiRequest, ApiResponse } from '../src/http/io.js';
import { FLOAT_ACCOUNT, USDC } from './support/base-doubles.js';
import { FakeLedger, RecordingDatabase, ScriptedScheme } from './support/doubles.js';
import { BUYER, ENDOWMENT, FakeCredit, FakeEarnLedger, FakeIntake, authorize } from './support/earn-doubles.js';

/** `/base/earn` as a seller's server reaches it: the reference shapes, the meter, and the switch. */

const NOW = 1_800_000_000;

function harness(options: { earn?: boolean; ratePerMinute?: number } = {}) {
  const db = new RecordingDatabase();
  const trust = new TrustStore({ topic: 'mandate.trust.v1' });
  const intake = new FakeIntake();
  intake.fund(BUYER.address, 1_000_000n);
  const credit = new FakeCredit();
  const earn = new BaseEarnings({ intake, credit, ledger: new FakeEarnLedger(), feeBps: 100, feeFloorMicro: toMicro(2_000n), maxPaymentMicro: toMicro(5_000_000n), now: () => NOW, receiptWaitMs: 1 });
  const facilitator = new Facilitator({
    budget: new SettlementBudget({ dailySettlements: 10, perPayerPerHour: 10 }),
    ledger: new FakeLedger(),
    treasury: '0x000000000000000000000000000000000000beef',
    feeBps: 100,
    feeFloorMicro: toMicro(1_900),
    scheme: new ScriptedScheme(),
    requireBinding: true,
  });
  const router = createRouter({
    db,
    facilitator,
    ledger: new LaneLedger({ db, trust, currency: 'USDG' }),
    trust,
    reservationTtlMs: 120_000,
    treasury: '0x000000000000000000000000000000000000beef',
    describe: () => ({}),
    ...(options.earn === false ? {} : { earn }),
    publicRatePerMinute: options.ratePerMinute ?? 120,
  });
  const call = async (request: ApiRequest): Promise<ApiResponse> => router(request).catch((error: unknown) => errorResponse(error));
  return { call, earn, credit, intake };
}

function request(method: string, path: string, body: unknown = {}): ApiRequest {
  return { method, path, query: new URLSearchParams(), headers: {}, body, bytes: new TextEncoder().encode(JSON.stringify(body)), remoteAddress: '203.0.113.9' };
}

async function body() {
  const paymentRequirements = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: USDC, payTo: FLOAT_ACCOUNT.address, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', endowment: ENDOWMENT } };
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: paymentRequirements, payload: await authorize(BUYER, {}, BigInt(NOW)) }, paymentRequirements };
}

describe('the earnings routes', () => {
  it('answer base_earn_off where earnings are not open', async () => {
    const { call } = harness({ earn: false });
    expect(await call(request('GET', '/base/earn/supported'))).toMatchObject({ status: 404, body: { error: 'base_earn_off' } });
    expect(await call(request('POST', '/base/earn/settle', await body()))).toMatchObject({ status: 404, body: { error: 'base_earn_off' } });
  });

  it('verify, settle and look up a sale in the shapes the reference client reads', async () => {
    const { call, earn } = harness();
    const supported = await call(request('GET', '/base/earn/supported'));
    expect(supported).toMatchObject({ status: 200, body: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 1 }], signers: { 'eip155:8453': [FLOAT_ACCOUNT.address] } } });

    const payment = await body();
    expect(await call(request('POST', '/base/earn/verify', payment))).toMatchObject({ status: 200, body: { isValid: true, payer: BUYER.address } });
    const settled = await call(request('POST', '/base/earn/settle', payment));
    expect(settled).toMatchObject({ status: 200, body: { success: true, network: 'eip155:8453', extra: { endowment: ENDOWMENT, creditMicro: '8000' } } });
    await earn.idle();

    const { transaction, extra } = settled.body as { transaction: string; extra: { earning: string } };
    expect(await call(request('GET', `/base/earn/earnings/${extra.earning}`))).toMatchObject({ status: 200, body: { status: 'credited', baseTransaction: transaction } });
    expect(await call(request('GET', `/base/earn/earnings/${transaction}`))).toMatchObject({ status: 200, body: { id: extra.earning } });
    expect(await call(request('GET', '/base/earn/earnings/not-an-id'))).toMatchObject({ status: 400, body: { error: 'field_invalid' } });
    expect(await call(request('GET', `/base/earn/earnings/0x${'00'.repeat(32)}`))).toMatchObject({ status: 404, body: { error: 'earning_not_found' } });
  });

  it('refuse a body that is not a payment with a 400, and meter each caller', async () => {
    const { call } = harness({ ratePerMinute: 2 });
    expect(await call(request('POST', '/base/earn/verify', { nothing: true }))).toMatchObject({ status: 400, body: { isValid: false, invalidReason: 'invalid_payload' } });
    expect(await call(request('POST', '/base/earn/settle', { nothing: true }))).toMatchObject({ status: 400, body: { success: false, broadcast: false } });
    expect(await call(request('POST', '/base/earn/settle', await body()))).toMatchObject({ status: 429, body: { success: false, broadcast: false, errorReason: 'rate_limited' } });
  });
});
