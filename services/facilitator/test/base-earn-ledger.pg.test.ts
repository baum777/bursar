import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMicro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { PostgresEarnLedger } from '../src/base/earn-ledger.js';
import type { ReserveInput } from '../src/base/ports.js';
import type { Scratch } from './support/postgres.js';
import { TEST_DATABASE_URL, scratchDatabase } from './support/postgres.js';

/**
 * The earnings ledger against a real server: one row per authorization, the float check under the
 * advisory lock, a failed attempt taken up again, and the transitions the CHECK constraints allow.
 */

const FLOAT: Address = '0x239830833BE550B8CFD2C0D3c476743F94620246';
const BUYER: Address = '0x877c349EFb5926082C413833E8055F0991185c61';
const ENDOWMENT: Address = '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_TX: Hex = `0x${'ee'.repeat(32)}`;

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    network: 'eip155:8453',
    asset: USDC,
    float: FLOAT,
    payer: BUYER,
    nonce: `0x${'11'.repeat(32)}`,
    chainId: 4663,
    endowment: ENDOWMENT,
    resource: 'https://agent.example/answer',
    amountMicro: toMicro(10_000n),
    feeMicro: toMicro(2_000n),
    creditMicro: toMicro(8_000n),
    validBefore: 1_800_000_300n,
    baseBlock: 30_000_000n,
    ...overrides,
  };
}

const credit = (n: number) => ({ hash: `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex, nonce: n, raw: `0x02f8${'ab'.repeat(40)}` as Hex });

describe.skipIf(!TEST_DATABASE_URL)('the earnings ledger', () => {
  let scratch: Scratch;
  let ledger: PostgresEarnLedger;

  beforeAll(async () => {
    scratch = await scratchDatabase('bursar_base_earn_ledger_test');
    ledger = new PostgresEarnLedger(scratch.db);
  });
  beforeEach(() => scratch.db.query('DELETE FROM bursar_base_earnings'));
  afterAll(() => scratch.drop());

  it('reserves one row per authorization and counts what it owes against the float', async () => {
    const first = await ledger.reserve(input(), { balance: 20_000n });
    expect(first).toMatchObject({ reserved: true, earning: { status: 'pending', creditMicro: 8_000n, payer: BUYER.toLowerCase(), endowment: ENDOWMENT.toLowerCase() } });
    expect(await ledger.owed(FLOAT)).toBe(8_000n);

    const replay = await ledger.reserve(input({ endowment: '0x1111111111111111111111111111111111111111' }), { balance: 20_000n });
    expect(replay).toMatchObject({ reserved: false, reason: 'replay', earning: { endowment: ENDOWMENT.toLowerCase() } });

    const short = await ledger.reserve(input({ nonce: `0x${'22'.repeat(32)}` }), { balance: 15_999n });
    expect(short).toMatchObject({ reserved: false, reason: 'float', availableMicro: 7_999n });
    const fits = await ledger.reserve(input({ nonce: `0x${'22'.repeat(32)}` }), { balance: 16_000n });
    expect(fits.reserved).toBe(true);
  });

  it('lets only one of two sales racing for the last of the float through', async () => {
    const results = await Promise.all([
      ledger.reserve(input({ nonce: `0x${'31'.repeat(32)}` }), { balance: 12_000n }),
      ledger.reserve(input({ nonce: `0x${'32'.repeat(32)}` }), { balance: 12_000n }),
    ]);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(await ledger.owed(FLOAT)).toBe(8_000n);
  });

  it('takes up a failed attempt again under the new terms, and releases what it reserved', async () => {
    const first = await ledger.reserve(input(), { balance: 20_000n });
    const id = first.reserved ? first.earning.id : '';
    await ledger.fail(id, 'not sent');
    expect(await ledger.owed(FLOAT)).toBe(0n);
    const again = await ledger.reserve(input({ validBefore: 1_800_000_900n }), { balance: 20_000n });
    expect(again).toMatchObject({ reserved: true, earning: { id, status: 'pending', validBefore: 1_800_000_900n, lastError: null } });
  });

  it('moves a sale through received, crediting and credited, and refuses a second credit out', async () => {
    const reserved = await ledger.reserve(input(), { balance: 20_000n });
    const id = reserved.reserved ? reserved.earning.id : '';
    await ledger.receive(id, BASE_TX);
    expect(await ledger.findBaseTransaction(BASE_TX)).toMatchObject({ id, status: 'received', receivedAt: expect.any(Date) });

    await ledger.crediting(id, credit(7));
    await expect(ledger.crediting(id, credit(8))).rejects.toThrow(/no longer waiting/);
    expect(await ledger.find(id)).toMatchObject({ status: 'crediting', creditNonce: 7, attempts: 1 });

    await ledger.uncredit(id, 'replaced');
    expect(await ledger.find(id)).toMatchObject({ status: 'received', creditTransaction: null, creditRaw: null, lastError: 'replaced' });
    await ledger.crediting(id, credit(9));
    await ledger.credited(id, credit(9).hash);
    expect(await ledger.find(id)).toMatchObject({ status: 'credited', creditTransaction: credit(9).hash, attempts: 2, creditedAt: expect.any(Date) });
    expect(await ledger.owed(FLOAT)).toBe(0n);

    // Credited is final: a late receive or fail changes nothing.
    await ledger.receive(id, null);
    await ledger.fail(id, 'late');
    expect((await ledger.find(id))?.status).toBe('credited');
    expect(await ledger.findAuthorization('eip155:8453', USDC, BUYER, `0x${'11'.repeat(32)}`)).toMatchObject({ id });
  });

  it('refuses a row the schema cannot hold', async () => {
    await expect(ledger.reserve(input({ feeMicro: toMicro(1_000n) }), { balance: 20_000n })).rejects.toThrow(/chk_base_earnings_credit/);
    const reserved = await ledger.reserve(input(), { balance: 20_000n });
    const id = reserved.reserved ? reserved.earning.id : '';
    await expect(scratch.db.query(`UPDATE bursar_base_earnings SET status = 'crediting' WHERE id = $1::uuid`, [id])).rejects.toThrow(/chk_base_earnings_(received|crediting)/);
  });

  it('lists what is owed, oldest touch first, and totals the float', async () => {
    const a = await ledger.reserve(input({ nonce: `0x${'41'.repeat(32)}` }), { balance: 100_000n });
    const b = await ledger.reserve(input({ nonce: `0x${'42'.repeat(32)}` }), { balance: 100_000n });
    const c = await ledger.reserve(input({ nonce: `0x${'43'.repeat(32)}` }), { balance: 100_000n });
    const [ida, idb, idc] = [a, b, c].map((r) => (r.reserved ? r.earning.id : ''));
    await ledger.receive(ida as string, null);
    await ledger.crediting(ida as string, credit(1));
    await ledger.credited(ida as string, credit(1).hash);
    await ledger.receive(idb as string, BASE_TX);
    await ledger.note(idc as string, 'waiting on Base');

    expect((await ledger.listOpen(10)).map((row) => row.id)).toEqual([idb, idc]);
    const totals = await ledger.totals(FLOAT, new Date(Date.now() + 60_000));
    expect(totals).toEqual({ credited: 1, creditedMicro: 8_000n, feesMicro: 2_000n, owed: 1, owedMicro: 8_000n, late: 1, pending: 1 });
  });
});
