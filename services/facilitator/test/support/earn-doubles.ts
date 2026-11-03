import { settlementAssetAbi, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { SettlementNotSentError } from '@bursar/x402';
import type { AssetMeta, PaymentChain, SettlementCall } from '@bursar/x402';
import { decodeFunctionData, keccak256, toHex, verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { serial } from '../../src/base/viem.js';
import type { BaseIntake, EarnLedger, Earning, EarningTotals, EndowmentCredit, PreparedTransaction, ReserveInput, ReserveResult } from '../../src/base/ports.js';
import { FLOAT_ACCOUNT, TRANSFER_WITH_AUTHORIZATION_TYPES, USDC, USDC_DOMAIN, USDC_SEPARATOR } from './base-doubles.js';

/** Doubles for the earnings side: USDC on Base, the float's USDG and endowments on Robinhood Chain, the ledger. */

export const BUYER = privateKeyToAccount(`0x${'b0'.repeat(32)}`);
export const OTHER_BUYER = privateKeyToAccount(`0x${'b1'.repeat(32)}`);
export const ENDOWMENT: Address = '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a node says when a call reverts, as viem wraps it. */
export function revert(reason: string): Error {
  const error = new Error(`The contract function reverted: ${reason}`);
  error.name = 'ContractFunctionExecutionError';
  (error as Error & { cause: unknown }).cause = Object.assign(new Error(reason), { name: 'ContractFunctionRevertedError' });
  return error;
}

export const USDC_META: AssetMeta = {
  address: USDC,
  name: 'USD Coin',
  version: '2',
  decimals: 6,
  domainSeparator: USDC_SEPARATOR,
  methods: ['eip3009'],
};

export async function authorize(
  buyer: typeof BUYER,
  overrides: Partial<{ to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }> = {},
  now = 1_800_000_000n,
) {
  const authorization = {
    from: buyer.address,
    to: overrides.to ?? FLOAT_ACCOUNT.address,
    value: overrides.value ?? 10_000n,
    validAfter: overrides.validAfter ?? now - 600n,
    validBefore: overrides.validBefore ?? now + 300n,
    nonce: overrides.nonce ?? keccak256(toHex(`${buyer.address}:${Math.random()}`)),
  };
  const signature = await buyer.signTypedData({ domain: USDC_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
  return {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  };
}

export class FakeIntake implements BaseIntake {
  readonly network = 'eip155:8453';
  readonly asset = USDC;
  readonly address = FLOAT_ACCOUNT.address;
  readonly balances = new Map<string, bigint>();
  readonly used = new Map<string, Hex>();
  readonly sent: SettlementCall[] = [];
  readonly blacklisted = new Set<string>();
  gasWei = 10n ** 15n;
  neededWei = 10n ** 12n;
  /** What the next send does: lands, never leaves, leaves without an answer, or reverts. */
  mode: 'ok' | 'not-sent' | 'unclear' | 'reverts' | 'no-receipt' = 'ok';
  private count = 0;
  private receipts = new Map<string, 'success' | 'reverted'>();

  readonly chain: PaymentChain = {
    chainId: 8453,
    verifyTypedData: async (check) =>
      verifyTypedData({ address: check.address, domain: check.domain, types: check.types, primaryType: check.primaryType, message: check.message, signature: check.signature } as Parameters<typeof verifyTypedData>[0]),
    tokenIdentity: async () => ({ name: 'USD Coin', version: '2', decimals: 6, domainSeparator: USDC_SEPARATOR }),
    balanceOf: async (_token, owner) => this.balances.get(owner.toLowerCase()) ?? 0n,
    allowance: async () => 0n,
    issuerControls: async (token, parties) => ({
      asset: token,
      paused: { state: 'read', value: false },
      parties: parties.map((address) => ({ address, frozen: { state: 'read', value: this.blacklisted.has(address.toLowerCase()) } as const })),
    }),
    authorizationState: async (_token, authorizer, nonce) => this.used.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`),
    permitNonce: async () => 0n,
    nonceBitmap: async () => 0n,
    hasCode: async () => true,
    simulate: async (call) => {
      const { from, nonce } = this.decode(call);
      if (this.used.has(`${from.toLowerCase()}:${nonce.toLowerCase()}`)) throw revert('FiatTokenV2: authorization is used or canceled');
    },
    waitForReceipt: async () => ({ status: 'success', gasUsed: 70_000n }),
  };

  fund(who: Address, amount: bigint): void {
    this.balances.set(who.toLowerCase(), (this.balances.get(who.toLowerCase()) ?? 0n) + amount);
  }

  private decode(call: SettlementCall): { from: Address; to: Address; value: bigint; nonce: Hex } {
    const { args } = decodeFunctionData({ abi: settlementAssetAbi, data: call.data });
    const [from, to, value, , , nonce] = args as unknown as [Address, Address, bigint, bigint, bigint, Hex];
    return { from, to, value, nonce };
  }

  /** Spends the authorization as if somebody else had sent it. */
  spend(call: SettlementCall): Hex {
    const { from, to, value, nonce } = this.decode(call);
    const hash = keccak256(toHex(`base:${(this.count += 1)}`));
    this.used.set(`${from.toLowerCase()}:${nonce.toLowerCase()}`, hash);
    this.fund(from, -value);
    this.fund(to, value);
    return hash;
  }

  async token(): Promise<AssetMeta> {
    return USDC_META;
  }

  async gas() {
    return { balanceWei: this.gasWei, neededWei: this.neededWei };
  }

  async blockNumber(): Promise<bigint> {
    return 30_000_000n;
  }

  async send(call: SettlementCall): Promise<Hex> {
    this.sent.push(call);
    if (this.mode === 'not-sent') throw new SettlementNotSentError('fee estimation failed');
    if (this.mode === 'unclear') {
      this.spend(call);
      throw new Error('socket hang up');
    }
    if (this.mode === 'reverts') {
      const hash = keccak256(toHex(`reverted:${this.sent.length}`));
      this.receipts.set(hash, 'reverted');
      return hash;
    }
    const hash = this.spend(call);
    if (this.mode !== 'no-receipt') this.receipts.set(hash, 'success');
    return hash;
  }

  async wait(hash: Hex) {
    const status = this.receipts.get(hash);
    return status ? { status, blockNumber: 30_000_001n } : null;
  }

  async authorizationUsed(payer: Address, nonce: Hex): Promise<boolean> {
    return this.used.has(`${payer.toLowerCase()}:${nonce.toLowerCase()}`);
  }

  async authorizationTransaction(payer: Address, nonce: Hex): Promise<Hex | null> {
    return this.used.get(`${payer.toLowerCase()}:${nonce.toLowerCase()}`) ?? null;
  }
}

/** The float's USDG and the endowments it pays. Every `earn` that lands is recorded in `earned`. */
export class FakeCredit implements EndowmentCredit {
  readonly chainId = 4663;
  readonly address = FLOAT_ACCOUNT.address;
  readonly endowments = new Set<string>([ENDOWMENT.toLowerCase()]);
  readonly allowances = new Map<string, bigint>();
  readonly approvals: { endowment: Address; amount: bigint }[] = [];
  readonly earned: { endowment: Address; amount: bigint; hash: Hex }[] = [];
  readonly broadcasts: Hex[] = [];
  usdg = 5_000_000n;
  refuse: string | null = null;
  /** What happens to the next signed credit: lands, reverts, or disappears from the pool. */
  outcome: 'success' | 'reverted' | 'lost' = 'success';
  failBroadcast = false;
  mined = 0;
  private next = 0;
  private readonly signed = new Map<string, { endowment: Address; amount: bigint; nonce: number; outcome: 'success' | 'reverted' | 'lost' }>();
  private readonly receipts = new Map<string, 'success' | 'reverted'>();
  readonly exclusive = serial();

  async isEndowment(endowment: Address): Promise<boolean> {
    return this.endowments.has(endowment.toLowerCase());
  }

  async balance(): Promise<bigint> {
    return this.usdg;
  }

  async allowance(endowment: Address): Promise<bigint> {
    return this.allowances.get(endowment.toLowerCase()) ?? 0n;
  }

  async approve(endowment: Address, amount: bigint): Promise<Hex> {
    this.approvals.push({ endowment, amount });
    this.allowances.set(endowment.toLowerCase(), amount);
    this.next += 1;
    this.mined = this.next;
    return keccak256(toHex(`approve:${this.approvals.length}`));
  }

  async simulate(endowment: Address, amount: bigint): Promise<void> {
    if (this.refuse) throw revert(this.refuse);
    if ((await this.allowance(endowment)) < amount) throw revert('ERC20: insufficient allowance');
    if (this.usdg < amount) throw revert('ERC20: transfer amount exceeds balance');
  }

  async prepare(endowment: Address, amount: bigint): Promise<PreparedTransaction> {
    const nonce = this.next;
    this.next += 1;
    const raw = toHex(`earn:${endowment}:${amount}:${nonce}`);
    const hash = keccak256(raw);
    this.signed.set(raw, { endowment, amount, nonce, outcome: this.outcome });
    return { hash, nonce, raw };
  }

  async broadcast(raw: Hex): Promise<void> {
    this.broadcasts.push(raw);
    if (this.failBroadcast) throw new Error('connection reset');
    const tx = this.signed.get(raw);
    const hash = keccak256(raw);
    if (!tx || this.receipts.has(hash) || tx.outcome === 'lost') return;
    this.mined = Math.max(this.mined, tx.nonce + 1);
    if (tx.outcome === 'reverted') {
      this.receipts.set(hash, 'reverted');
      return;
    }
    this.receipts.set(hash, 'success');
    this.usdg -= tx.amount;
    this.allowances.set(tx.endowment.toLowerCase(), (this.allowances.get(tx.endowment.toLowerCase()) ?? 0n) - tx.amount);
    this.earned.push({ endowment: tx.endowment, amount: tx.amount, hash });
  }

  /** The lost transaction finds its way back into the pool, as it does after a restart's rebroadcast. */
  restore(raw: Hex): void {
    const tx = this.signed.get(raw);
    if (tx) this.signed.set(raw, { ...tx, outcome: 'success' });
  }

  /** Another transaction takes the nonce a lost credit was signed at. */
  replaceNonce(): void {
    this.next = Math.max(this.next, this.mined + 1);
    this.mined = this.next;
  }

  async receipt(hash: Hex): Promise<'success' | 'reverted' | null> {
    return this.receipts.get(hash) ?? null;
  }

  async wait(hash: Hex): Promise<'success' | 'reverted' | null> {
    return this.receipts.get(hash) ?? null;
  }

  async minedNonce(): Promise<number> {
    return this.mined;
  }
}

/** The ledger in memory, with the table's rules: one row per authorization, one float check under one lock. */
export class FakeEarnLedger implements EarnLedger {
  readonly rows: Earning[] = [];
  private next = 1;
  private lock: Promise<unknown> = Promise.resolve();

  async reserve(input: ReserveInput, float: { balance: bigint }): Promise<ReserveResult> {
    const run = this.lock.then(async (): Promise<ReserveResult> => {
      const existing = this.rows.find((row) => row.network === input.network && same(row.asset, input.asset) && same(row.payer, input.payer) && same(row.nonce, input.nonce));
      if (existing && existing.status !== 'failed') return { reserved: false, reason: 'replay', earning: existing };
      const available = toMicro(float.balance - (await this.owed(input.float)));
      if (available < input.creditMicro) return { reserved: false, reason: 'float', availableMicro: available };
      const earning: Earning = {
        ...input,
        id: existing?.id ?? `00000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}`,
        status: 'pending',
        baseTransaction: null,
        creditTransaction: null,
        creditNonce: null,
        creditRaw: null,
        attempts: existing?.attempts ?? 0,
        lastError: null,
        createdAt: existing?.createdAt ?? new Date(),
        receivedAt: null,
        creditedAt: null,
      };
      if (existing) this.rows[this.rows.indexOf(existing)] = earning;
      else this.rows.push(earning);
      return { reserved: true, earning };
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async owed(float: Address): Promise<Micro> {
    return toMicro(this.rows.filter((row) => same(row.float, float) && ['pending', 'received', 'crediting'].includes(row.status)).reduce((sum, row) => sum + row.creditMicro, 0n));
  }

  async find(id: string): Promise<Earning | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findAuthorization(network: string, asset: Address, payer: Address, nonce: Hex): Promise<Earning | null> {
    return this.rows.find((row) => row.network === network && same(row.asset, asset) && same(row.payer, payer) && same(row.nonce, nonce)) ?? null;
  }

  async findBaseTransaction(hash: Hex): Promise<Earning | null> {
    return this.rows.find((row) => row.baseTransaction !== null && same(row.baseTransaction, hash)) ?? null;
  }

  async receive(id: string, baseTransaction: Hex | null): Promise<void> {
    this.update(id, ['pending', 'failed'], (row) => ({ ...row, status: 'received', baseTransaction: baseTransaction ?? row.baseTransaction, receivedAt: new Date(), lastError: null }));
  }

  async fail(id: string, reason: string): Promise<void> {
    this.update(id, ['pending'], (row) => ({ ...row, status: 'failed', lastError: reason }));
  }

  async crediting(id: string, transaction: PreparedTransaction): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row?.status !== 'received') throw new Error(`earning ${id} is no longer waiting for its credit`);
    this.update(id, ['received'], (current) => ({ ...current, status: 'crediting', creditTransaction: transaction.hash, creditNonce: transaction.nonce, creditRaw: transaction.raw, attempts: current.attempts + 1 }));
  }

  async uncredit(id: string, reason: string): Promise<void> {
    this.update(id, ['crediting'], (row) => ({ ...row, status: 'received', creditTransaction: null, creditNonce: null, creditRaw: null, lastError: reason }));
  }

  async credited(id: string, transaction: Hex): Promise<void> {
    this.update(id, ['received', 'crediting'], (row) => ({ ...row, status: 'credited', creditTransaction: transaction, creditedAt: new Date(), lastError: null }));
  }

  async note(id: string, reason: string): Promise<void> {
    this.update(id, ['pending', 'received', 'crediting'], (row) => ({ ...row, lastError: reason }));
  }

  async listOpen(limit: number): Promise<Earning[]> {
    return this.rows.filter((row) => ['pending', 'received', 'crediting'].includes(row.status)).slice(0, limit);
  }

  async totals(float: Address, lateBefore: Date): Promise<EarningTotals> {
    const mine = this.rows.filter((row) => same(row.float, float));
    const credited = mine.filter((row) => row.status === 'credited');
    const owed = mine.filter((row) => row.status === 'received' || row.status === 'crediting');
    const sum = (rows: Earning[], pick: (row: Earning) => bigint) => toMicro(rows.reduce((total, row) => total + pick(row), 0n));
    return {
      credited: credited.length,
      creditedMicro: sum(credited, (row) => row.creditMicro),
      feesMicro: sum(credited, (row) => row.feeMicro),
      owed: owed.length,
      owedMicro: sum(owed, (row) => row.creditMicro),
      late: owed.filter((row) => row.receivedAt !== null && row.receivedAt < lateBefore).length,
      pending: mine.filter((row) => row.status === 'pending').length,
    };
  }

  private update(id: string, from: readonly Earning['status'][], change: (row: Earning) => Earning): void {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (row && from.includes(row.status)) this.rows[index] = change(row);
  }
}
