import { describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Address } from 'viem';

import { BaseEarnings, EARN_REASON } from '../src/base/earn.js';
import { FLOAT_ACCOUNT, USDC } from './support/base-doubles.js';
import { BUYER, ENDOWMENT, FakeCredit, FakeEarnLedger, FakeIntake, OTHER_BUYER, authorize } from './support/earn-doubles.js';

/**
 * Earnings on Base against doubles: USDC that checks a real signature, the float's USDG and one
 * endowment on Robinhood Chain, and the ledger in memory.
 *
 * What the suite holds the lane to: nothing moves on Base unless the endowment is real, the float's
 * USDG covers the credit beyond what is already promised, `earn` would run and Base gas is there; one
 * authorization moves once and credits once; a credit that was sent is found again rather than sent
 * twice; and a sale whose Base transfer never happened releases what it reserved.
 */

const NOW = 1_800_000_000;
const MAX = 5_000_000n;

function harness(options: { usdg?: bigint; feeBps?: number; floor?: bigint; max?: bigint } = {}) {
  const intake = new FakeIntake();
  intake.fund(BUYER.address, 1_000_000n);
  intake.fund(OTHER_BUYER.address, 1_000_000n);
  const credit = new FakeCredit();
  credit.usdg = options.usdg ?? 5_000_000n;
  const ledger = new FakeEarnLedger();
  const log: string[] = [];
  let now = NOW;
  const earn = new BaseEarnings({
    intake,
    credit,
    ledger,
    feeBps: options.feeBps ?? 100,
    feeFloorMicro: toMicro(options.floor ?? 2_000n),
    maxPaymentMicro: toMicro(options.max ?? MAX),
    log: (line) => log.push(line),
    now: () => now,
    receiptWaitMs: 1,
    recheckMs: 1,
  });
  return { earn, intake, credit, ledger, log, tick: (seconds: number) => (now += seconds) };
}

const terms = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '10000',
  asset: USDC,
  payTo: FLOAT_ACCOUNT.address,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', endowment: ENDOWMENT, ...extra },
  ...overrides,
});

async function sale(buyer = BUYER, requirements = terms(), overrides: Parameters<typeof authorize>[1] = {}) {
  const payload = { x402Version: 2, accepted: requirements, resource: { url: 'https://agent.example/answer' }, payload: await authorize(buyer, overrides, BigInt(NOW)) };
  return { payload, requirements };
}

describe('price', () => {
  it('takes the lane fee, never under its floor, and credits the rest', () => {
    const { earn } = harness();
    expect(earn.price(toMicro(10_000n))).toEqual({ feeMicro: 2_000n, creditMicro: 8_000n });
    expect(earn.price(toMicro(1_000_000n))).toEqual({ feeMicro: 10_000n, creditMicro: 990_000n });
    expect(earn.price(toMicro(1_500n))).toEqual({ feeMicro: 2_000n, creditMicro: -500n });
  });
});

describe('verify', () => {
  it('passes a buyer paying the float for a Bursar endowment, and writes nothing', async () => {
    const { earn, credit, intake, ledger } = harness();
    credit.allowances.set(ENDOWMENT.toLowerCase(), MAX);
    const { payload, requirements } = await sale();
    expect(await earn.verify(payload, requirements)).toEqual({ isValid: true, payer: BUYER.address });
    expect(intake.sent).toHaveLength(0);
    expect(credit.approvals).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it('refuses terms that do not pay the float or name no endowment, before reading a chain', async () => {
    const { earn } = harness();
    const elsewhere = await sale(BUYER, terms({ payTo: BUYER.address }));
    expect(await earn.verify(elsewhere.payload, elsewhere.requirements)).toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements', invalidMessage: expect.stringContaining(FLOAT_ACCOUNT.address) });
    const nameless = await sale(BUYER, terms({}, { endowment: undefined }));
    expect(await earn.verify(nameless.payload, nameless.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.endowment });
    const ethereum = await sale(BUYER, terms({ network: 'eip155:1' }));
    expect(await earn.verify(ethereum.payload, ethereum.requirements)).toMatchObject({ isValid: false, invalidReason: 'invalid_network' });
    const v1 = await sale(BUYER, terms({ network: 'base' }));
    expect(await earn.verify({ ...v1.payload, x402Version: 1 }, v1.requirements)).toMatchObject({ isValid: true });
  });

  it('refuses an address no Bursar factory created', async () => {
    const { earn } = harness();
    const stranger: Address = '0x1111111111111111111111111111111111111111';
    const { payload, requirements } = await sale(BUYER, terms({}, { endowment: stranger }));
    expect(await earn.verify({ ...payload, accepted: requirements }, requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.unknown, payer: BUYER.address });
  });

  it('refuses a buyer who accepted terms for another endowment', async () => {
    const { earn } = harness();
    const { payload, requirements } = await sale();
    const accepted = { ...requirements, extra: { ...requirements.extra, endowment: '0x2222222222222222222222222222222222222222' } };
    expect(await earn.verify({ ...payload, accepted }, requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.terms });
  });

  it('caps one sale, and refuses one too small to cover the fee', async () => {
    const { earn } = harness({ max: 20_000n });
    const large = await sale(BUYER, terms({ amount: '20001' }), { value: 20_001n });
    expect(await earn.verify(large.payload, large.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.tooLarge });
    const small = await sale(BUYER, terms({ amount: '2000' }), { value: 2_000n });
    expect(await earn.verify(small.payload, small.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.tooSmall });
  });

  it('holds the authorization to the reference checks: the float as recipient, the amount, the signature', async () => {
    const { earn, intake } = harness();
    const wrongTo = await sale(BUYER, terms(), { to: BUYER.address });
    expect(await earn.verify(wrongTo.payload, wrongTo.requirements)).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_payload_recipient_mismatch' });
    const wrongValue = await sale(BUYER, terms(), { value: 9_999n });
    expect(await earn.verify(wrongValue.payload, wrongValue.requirements)).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch' });
    const forged = await sale();
    const signature = `0x${'00'.repeat(65)}`;
    expect(await earn.verify({ ...forged.payload, payload: { ...forged.payload.payload, signature } }, forged.requirements)).toMatchObject({ isValid: false });
    intake.blacklisted.add(BUYER.address.toLowerCase());
    const frozen = await sale();
    expect(await earn.verify(frozen.payload, frozen.requirements)).toMatchObject({ isValid: false, invalidReason: 'payer_frozen' });
  });

  it('refuses when the float cannot pay the endowment, when earn would revert, and when Base gas is short', async () => {
    const short = harness({ usdg: 7_999n });
    const first = await sale();
    expect(await short.earn.verify(first.payload, first.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.float });

    const refusing = harness();
    refusing.credit.allowances.set(ENDOWMENT.toLowerCase(), MAX);
    refusing.credit.refuse = 'NotSettlementAsset';
    const second = await sale();
    expect(await refusing.earn.verify(second.payload, second.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.refused });

    const dry = harness();
    dry.intake.gasWei = 0n;
    const third = await sale();
    expect(await dry.earn.verify(third.payload, third.requirements)).toMatchObject({ isValid: false, invalidReason: EARN_REASON.gas });
  });

  it('answers facilitator_unavailable when a chain does not answer, not a verdict on the buyer', async () => {
    const { earn, credit } = harness();
    credit.isEndowment = async () => {
      throw new Error('fetch failed');
    };
    const { payload, requirements } = await sale();
    expect(await earn.verify(payload, requirements)).toMatchObject({ isValid: false, invalidReason: 'facilitator_unavailable' });
  });
});

describe('settle', () => {
  it('moves the USDC on Base once, pays the endowment once, and refuses the same payment presented again', async () => {
    const { earn, intake, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    const settled = await earn.settle(payload, requirements);
    expect(settled).toMatchObject({
      success: true,
      settled: true,
      payer: BUYER.address,
      network: 'eip155:8453',
      amount: '10000',
      extra: { endowment: ENDOWMENT, creditMicro: '8000', feeMicro: '2000', status: 'received' },
    });
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(intake.balances.get(FLOAT_ACCOUNT.address.toLowerCase())).toBe(10_000n);
    expect(credit.approvals).toEqual([{ endowment: ENDOWMENT, amount: MAX }]);

    await earn.idle();
    expect(credit.earned).toEqual([{ endowment: ENDOWMENT, amount: 8_000n, hash: expect.any(String) }]);
    expect(ledger.rows[0]).toMatchObject({ status: 'credited', creditMicro: 8_000n, baseTransaction: settled.transaction });
    expect(await earn.earning(settled.transaction)).toMatchObject({ status: 'credited', creditTransaction: credit.earned[0]?.hash });

    // The header is public once it settles: its signature is in the Base transaction.
    const again = await earn.settle(payload, requirements);
    expect(again).toMatchObject({ success: false, broadcast: false, errorReason: EARN_REASON.replay, transaction: '', errorMessage: expect.stringContaining(settled.transaction) });
    expect(await earn.verify(payload, requirements)).toMatchObject({ isValid: false, invalidReason: 'invalid_transaction_state' });
    expect(intake.sent).toHaveLength(1);
    await earn.idle();
    expect(credit.earned).toHaveLength(1);
  });

  it('counts credits already promised against the float, so the last of it goes to one sale', async () => {
    const { earn, intake, credit } = harness({ usdg: 12_000n });
    const first = await sale(BUYER);
    const second = await sale(OTHER_BUYER);
    intake.mode = 'no-receipt';
    expect(await earn.settle(first.payload, first.requirements)).toMatchObject({ success: false, settled: null, broadcast: true, errorReason: 'settlement_unconfirmed' });
    intake.mode = 'ok';
    expect(await earn.settle(second.payload, second.requirements)).toMatchObject({ success: false, broadcast: false, errorReason: EARN_REASON.float });
    expect(intake.sent).toHaveLength(1);
    expect(credit.earned).toHaveLength(0);
  });

  it('releases what a transfer that never left reserved, and takes the same payment again', async () => {
    const { earn, intake, ledger } = harness();
    const { payload, requirements } = await sale();
    intake.mode = 'not-sent';
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: false, broadcast: false, errorReason: 'facilitator_unavailable' });
    expect(ledger.rows[0]).toMatchObject({ status: 'failed' });
    intake.mode = 'ok';
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: true });
    expect(ledger.rows).toHaveLength(1);
    await earn.idle();
    expect(ledger.rows[0]?.status).toBe('credited');
  });

  it('leaves an unclear send to the token, which the next pass reads and pays', async () => {
    const { earn, intake, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    intake.mode = 'unclear';
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: false, settled: null, broadcast: true, errorReason: 'settlement_unconfirmed' });
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: false, errorReason: EARN_REASON.pending });
    expect(await earn.reconcile()).toMatchObject({ checked: 1, received: 1, credited: 1 });
    expect(credit.earned).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ status: 'credited', baseTransaction: expect.stringMatching(/^0x/) });
  });

  it('releases a reservation whose authorization ran out unused', async () => {
    const { earn, intake, ledger, tick } = harness();
    const { payload, requirements } = await sale();
    intake.mode = 'unclear';
    intake.spend = () => '0x' as `0x${string}`;
    await earn.settle(payload, requirements);
    expect(await earn.reconcile()).toMatchObject({ pending: 1 });
    tick(300 + 61);
    expect(await earn.reconcile()).toMatchObject({ failed: 1 });
    expect(ledger.rows[0]?.status).toBe('failed');
    expect(await ledger.owed(FLOAT_ACCOUNT.address)).toBe(0n);
  });

  it('counts a reverted send as a sale when somebody else spent the authorization to the float first', async () => {
    const { earn, intake, credit } = harness();
    const { payload, requirements } = await sale();
    intake.mode = 'reverts';
    const original = intake.send.bind(intake);
    intake.send = async (call) => {
      intake.spend(call);
      return original(call);
    };
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: true, extra: { status: 'received' } });
    await earn.idle();
    expect(credit.earned).toHaveLength(1);
  });

  it('says a reverted transfer moved nothing and releases it', async () => {
    const { earn, intake, ledger } = harness();
    const { payload, requirements } = await sale();
    intake.mode = 'reverts';
    expect(await earn.settle(payload, requirements)).toMatchObject({ success: false, settled: false, broadcast: true, errorReason: 'invalid_transaction_state' });
    expect(ledger.rows[0]?.status).toBe('failed');
  });
});

describe('the credit', () => {
  it('keeps a sale owed while the endowment refuses, and pays it once it takes it', async () => {
    const { earn, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    await earn.settle(payload, requirements);
    credit.refuse = 'IsFrozen';
    await earn.idle();
    expect(ledger.rows[0]).toMatchObject({ status: 'received', lastError: expect.stringContaining('IsFrozen') });
    expect((await earn.status()).owed).toBe(1);
    credit.refuse = null;
    expect(await earn.reconcile()).toMatchObject({ credited: 1 });
    expect(credit.earned).toHaveLength(1);
  });

  it('finds a credit that was sent and lost, sends the same bytes again, and never signs a second one', async () => {
    const { earn, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    credit.outcome = 'lost';
    await earn.settle(payload, requirements);
    await earn.idle();
    const row = ledger.rows[0];
    expect(row).toMatchObject({ status: 'crediting', creditNonce: expect.any(Number) });
    credit.restore(row?.creditRaw as `0x${string}`);
    expect(await earn.reconcile()).toMatchObject({ credited: 1 });
    expect(credit.earned).toEqual([{ endowment: ENDOWMENT, amount: 8_000n, hash: row?.creditTransaction }]);
    expect(credit.broadcasts.filter((raw) => raw === row?.creditRaw)).toHaveLength(2);
  });

  it('signs a new credit only once the lost one can no longer land', async () => {
    const { earn, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    credit.outcome = 'lost';
    await earn.settle(payload, requirements);
    await earn.idle();
    const lost = ledger.rows[0]?.creditTransaction;
    credit.replaceNonce();
    credit.outcome = 'success';
    expect(await earn.reconcile()).toMatchObject({ credited: 1 });
    expect(credit.earned).toHaveLength(1);
    expect(ledger.rows[0]?.creditTransaction).not.toBe(lost);
  });

  it('marks a landed credit paid without sending anything when the process lost track of it', async () => {
    const { earn, credit, ledger } = harness();
    const { payload, requirements } = await sale();
    credit.failBroadcast = true;
    await earn.settle(payload, requirements);
    await earn.idle();
    expect(ledger.rows[0]?.status).toBe('crediting');
    credit.failBroadcast = false;
    await credit.broadcast(ledger.rows[0]?.creditRaw as `0x${string}`);
    const sent = credit.broadcasts.length;
    expect(await earn.reconcile()).toMatchObject({ credited: 1 });
    expect(credit.broadcasts).toHaveLength(sent);
    expect(credit.earned).toHaveLength(1);
  });

  it('reports what was credited, what is owed and what the float can still pay', async () => {
    const { earn } = harness({ usdg: 100_000n });
    for (const buyer of [BUYER, OTHER_BUYER]) {
      const { payload, requirements } = await sale(buyer);
      await earn.settle(payload, requirements);
    }
    await earn.idle();
    expect(await earn.status()).toMatchObject({
      on: true,
      payTo: FLOAT_ACCOUNT.address,
      endowmentsOn: 4663,
      credited: 2,
      creditedMicro: '16000',
      feesMicro: '4000',
      owed: 0,
      usdgMicro: '84000',
      availableMicro: '84000',
      healthy: true,
    });
  });
});

describe('supported', () => {
  it('advertises exact on Base in USDC at the float, under both protocol spellings', async () => {
    const { earn } = harness();
    const answer = (await earn.supported()) as { kinds: { x402Version: number; network: string; extra: { payTo: string } }[] };
    expect(answer.kinds.map((kind) => [kind.x402Version, kind.network])).toEqual([
      [2, 'eip155:8453'],
      [1, 'base'],
    ]);
    expect(answer.kinds[0]?.extra.payTo).toBe(FLOAT_ACCOUNT.address);
  });
});

