import { canonicalNetwork, mulBps, sameNetwork, toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import { REASON, RECEIPT_WAIT_MS, eip3009Path, isNotSent, isRevert, isSupportedVersion, readAuthorization } from '@bursar/x402';
import type { SettlementCall } from '@bursar/x402';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';

import { requiredAmount } from '../x402/contract.js';
import type { PaymentPayload, PaymentRequirements } from '../x402/contract.js';
import type { BaseIntake, EarnLedger, Earning, EndowmentCredit } from './ports.js';

/**
 * Earnings on Base, paid into endowments on Robinhood Chain.
 *
 * The Base lane run the other way. A buyer anywhere on Base pays USDC with a standard `exact`
 * authorization to the lane's float; the seller's terms name an endowment in `extra.endowment`.
 * The facilitator settles the authorization on Base from the float, then calls `earn` on the
 * endowment from the same address's USDG on Robinhood Chain, less the lane's fee. USDC piles up on
 * Base where the outgoing lane spends it, and USDG leaves Robinhood Chain where the outgoing lane
 * collects it, so the two directions fund each other and no payment waits on a bridge.
 *
 * Everything that can refuse is asked before Base is touched: the endowment is one Bursar's
 * factories created, the float's USDG covers the credit and every credit already promised, `earn`
 * would not revert, and the float can pay Base's gas. Once the USDC has moved, the endowment is
 * owed, and the ledger keeps it owed until a credit is on chain.
 */

export const EARN_REASON = {
  off: 'base_earn_off',
  endowment: 'endowment_not_named',
  unknown: 'endowment_unknown',
  refused: 'endowment_refused_credit',
  float: 'endowment_credit_unavailable',
  tooLarge: 'amount_too_large',
  tooSmall: 'amount_below_fee',
  gas: 'base_float_gas_low',
  terms: 'accepted_terms_mismatch',
  pending: 'settlement_pending',
  replay: 'payment_already_used',
  notFound: 'earning_not_found',
} as const;

/** The standard profile's margin: an authorization has to stay valid this long past the check. */
const EXPIRY_MARGIN_SECONDS = 6;
const MAX_TIMEOUT_SECONDS = 3_600;
/** How long past its window an unused authorization is given before its reservation is released. */
const EXPIRY_GRACE_SECONDS = 60;
/** A credit owed longer than this is late, and the lane reports itself unhealthy. */
const LATE_SECONDS = 600;
const RECONCILE_BATCH = 50;
/** Before calling a credit replaced, a second look for its receipt after the node has caught up. */
const RECEIPT_RECHECK_MS = 3_000;

export type EarnOptions = {
  readonly intake: BaseIntake;
  readonly credit: EndowmentCredit;
  readonly ledger: EarnLedger;
  readonly feeBps: number;
  readonly feeFloorMicro: Micro;
  readonly maxPaymentMicro: Micro;
  readonly log?: (line: string) => void;
  /** Unix seconds. */
  readonly now?: () => number;
  readonly receiptWaitMs?: number;
  readonly recheckMs?: number;
};

export type EarnTerms = {
  readonly payer: Address;
  readonly endowment: Address;
  readonly amountMicro: Micro;
  readonly feeMicro: Micro;
  readonly creditMicro: Micro;
  readonly nonce: Hex;
  readonly validBefore: bigint;
  readonly resource: string;
  readonly call: SettlementCall;
};

type Refused = { readonly ok: false; readonly reason: string; readonly detail?: string; readonly payer?: Address };
type Checked = { readonly ok: true; readonly terms: EarnTerms };

export type EarnVerifyBody =
  | { readonly isValid: true; readonly payer: Address }
  | { readonly isValid: false; readonly invalidReason: string; readonly invalidMessage?: string; readonly payer?: Address };

export type EarnSettleBody = {
  readonly success: boolean;
  readonly settled: boolean | null;
  readonly broadcast: boolean;
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly payer?: Address;
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
  readonly extra?: EarningExtra;
};

export type EarningExtra = {
  readonly earning: string;
  readonly endowment: Address;
  readonly creditMicro: string;
  readonly feeMicro: string;
  readonly status: string;
};

export type EarningView = {
  readonly id: string;
  readonly status: Earning['status'];
  readonly payer: Address;
  readonly endowment: Address;
  readonly chainId: number;
  readonly amountMicro: string;
  readonly feeMicro: string;
  readonly creditMicro: string;
  readonly baseTransaction: Hex | null;
  readonly creditTransaction: Hex | null;
  readonly createdAt: string;
  readonly receivedAt: string | null;
  readonly creditedAt: string | null;
};

export type EarnStatus = {
  readonly on: true;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly endowmentsOn: number;
  readonly feeBps: number;
  readonly feeFloorMicro: string;
  readonly maxPaymentMicro: string;
  readonly usdgMicro: string;
  readonly owedMicro: string;
  readonly availableMicro: string;
  readonly credited: number;
  readonly creditedMicro: string;
  readonly feesMicro: string;
  readonly owed: number;
  readonly late: number;
  readonly pending: number;
  readonly baseGas: { readonly balanceWei: string; readonly neededWei: string; readonly healthy: boolean } | { readonly healthy: false; readonly detail: string };
  readonly healthy: boolean;
};

export type EarnPass = {
  readonly checked: number;
  readonly received: number;
  readonly credited: number;
  readonly failed: number;
  readonly pending: number;
  readonly errors: number;
};

type CreditStep = 'credited' | 'pending' | 'refused' | 'skipped';

const HASH = /^0x[0-9a-fA-F]{64}$/;

function refused(reason: string, detail?: string, payer?: Address): Refused {
  return { ok: false, reason, ...(detail === undefined ? {} : { detail }), ...(payer === undefined ? {} : { payer }) };
}

function readAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function same(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

/** Base under both protocol spellings: `eip155:8453`, and `base` from version one. */
function isBase(network: unknown, canonical: string): boolean {
  return sameNetwork(network, canonical) || canonicalNetwork(network) === 'base';
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === 'string' && short !== '') return short;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return String(error);
}

export class BaseEarnings {
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly endowments = new Set<string>();
  /** Settles waiting on Base, which a pass must not decide for. */
  private readonly settling = new Set<string>();
  private readonly credits = new Map<string, Promise<CreditStep>>();

  constructor(private readonly options: EarnOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get payTo(): Address {
    return this.options.intake.address;
  }

  /** The fee and the credit for a sale of `amountMicro`: the lane's fee, never under its floor. */
  price(amountMicro: Micro): { feeMicro: Micro; creditMicro: Micro } {
    const fee = mulBps(amountMicro, this.options.feeBps);
    const feeMicro = fee < this.options.feeFloorMicro ? this.options.feeFloorMicro : fee;
    return { feeMicro, creditMicro: toMicro(amountMicro - feeMicro) };
  }

  async supported(): Promise<Record<string, unknown>> {
    const { intake } = this.options;
    const token = await intake.token().catch(() => null);
    const asset = { address: intake.asset, name: token?.name ?? 'USD Coin', version: token?.version ?? '2', decimals: 6, methods: ['eip3009'] };
    const extra = {
      assetTransferMethod: 'eip3009',
      assetTransferMethods: ['eip3009'],
      assets: [asset],
      payTo: intake.address,
      endowmentsOn: `eip155:${this.options.credit.chainId}`,
    };
    return {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: intake.network, extra },
        { x402Version: 1, scheme: 'exact', network: 'base', extra },
      ],
      extensions: [],
      signers: { [intake.network]: [intake.address] },
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<EarnVerifyBody> {
    const checked = await this.guard(() => this.check(payload, requirements));
    if (!checked.ok) return invalid(checked);
    const { terms } = checked;
    const ready = await this.guard(async () => {
      const { credit, ledger } = this.options;
      const [balance, owed, allowance] = await Promise.all([credit.balance(), ledger.owed(credit.address), credit.allowance(terms.endowment)]);
      const short = this.short(balance - owed, terms);
      if (short) return short;
      // A verdict writes nothing, so a missing allowance is left for settle to grant, and `earn`
      // is simulated only where it can already run.
      if (allowance >= terms.creditMicro) {
        const simulated = await this.simulate(terms);
        if (simulated) return simulated;
      }
      return (await this.gasShort()) ?? { ok: true as const, terms };
    });
    return ready.ok ? { isValid: true, payer: terms.payer } : invalid(ready);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<EarnSettleBody> {
    const { intake, ledger, credit } = this.options;
    const network = intake.network;
    const unsent = (reason: string, detail?: string, payer?: Address): EarnSettleBody => ({
      success: false,
      settled: false,
      broadcast: false,
      errorReason: reason,
      ...(detail === undefined ? {} : { errorMessage: detail }),
      ...(payer === undefined ? {} : { payer }),
      transaction: '',
      network,
    });

    // An authorization this facilitator has already taken is never taken again, and never answered
    // as a success: its signature is public in the Base transaction, and a seller told "paid" a
    // second time would serve whoever copied it.
    const presented = readAuthorization(payload.payload?.authorization);
    if (presented !== null) {
      const known = await ledger.findAuthorization(network, intake.asset, presented.from, presented.nonce);
      if (known && known.status !== 'failed') return this.replayed(known);
    }

    const checked = await this.guard(() => this.check(payload, requirements));
    if (!checked.ok) return unsent(checked.reason, checked.detail, checked.payer);
    const { terms } = checked;
    const gas = await this.guard(async () => (await this.gasShort()) ?? { ok: true as const, terms });
    if (!gas.ok) return unsent(gas.reason, gas.detail, terms.payer);

    // Readied alone among the float's writes on Robinhood Chain, so a credit running at the same
    // time cannot spend the allowance this sale was simulated against.
    const ready = await this.guard(() =>
      credit.exclusive(async () => {
        const [balance, owed, allowance] = await Promise.all([credit.balance(), ledger.owed(credit.address), credit.allowance(terms.endowment)]);
        const short = this.short(balance - owed, terms);
        if (short) return short;
        if (allowance < terms.creditMicro) await this.approve(terms.endowment, terms.creditMicro);
        return (await this.simulate(terms)) ?? { ok: true as const, terms };
      }),
    );
    if (!ready.ok) return unsent(ready.reason, ready.detail, terms.payer);

    let earning: Earning;
    try {
      const [baseBlock, balance] = await Promise.all([intake.blockNumber(), credit.balance()]);
      const reserved = await ledger.reserve(
        {
          network,
          asset: intake.asset,
          float: credit.address,
          payer: terms.payer,
          nonce: terms.nonce,
          chainId: credit.chainId,
          endowment: terms.endowment,
          resource: terms.resource,
          amountMicro: terms.amountMicro,
          feeMicro: terms.feeMicro,
          creditMicro: terms.creditMicro,
          validBefore: terms.validBefore,
          baseBlock,
        },
        { balance },
      );
      if (!reserved.reserved) {
        if (reserved.reason === 'replay') return this.replayed(reserved.earning);
        return unsent(EARN_REASON.float, this.shortDetail(reserved.availableMicro, terms.creditMicro), terms.payer);
      }
      earning = reserved.earning;
    } catch (error) {
      this.log(`base earn reserve failed payer=${terms.payer} reason=${describe(error)}`);
      return unsent(REASON.facilitator, 'the sale could not be written down, so nothing was sent; present it again', terms.payer);
    }

    this.settling.add(earning.id);
    try {
      return await this.collect(earning, terms);
    } finally {
      this.settling.delete(earning.id);
    }
  }

  /** Sends the buyer's authorization from the float and reads what Base did with it. */
  private async collect(earning: Earning, terms: EarnTerms): Promise<EarnSettleBody> {
    const { intake, ledger } = this.options;
    const network = intake.network;
    const base = { payer: terms.payer, network, amount: terms.amountMicro.toString() };

    let hash: Hex;
    try {
      hash = await intake.send(terms.call);
    } catch (error) {
      if (isNotSent(error)) {
        await ledger.fail(earning.id, `not sent: ${describe(error)}`);
        return { ...base, success: false, settled: false, broadcast: false, errorReason: REASON.facilitator, errorMessage: describe(error), transaction: '' };
      }
      // Possibly broadcast. The token decides on the next pass: a spent nonce is a sale received.
      this.log(`base earn send unclear earning=${earning.id} reason=${describe(error)}`);
      return { ...base, success: false, settled: null, broadcast: true, errorReason: REASON.unconfirmed, errorMessage: describe(error), transaction: '' };
    }

    const receipt = await intake.wait(hash, this.options.receiptWaitMs ?? RECEIPT_WAIT_MS).catch(() => null);
    if (receipt === null) {
      return { ...base, success: false, settled: null, broadcast: true, errorReason: REASON.unconfirmed, errorMessage: `no receipt for ${hash} yet`, transaction: hash };
    }
    if (receipt.status === 'reverted') {
      // Somebody else may have sent the same authorization first; the USDC still came to the float.
      if (await intake.authorizationUsed(terms.payer, terms.nonce).catch(() => false)) {
        const spent = await intake.authorizationTransaction(terms.payer, terms.nonce, earning.baseBlock).catch(() => null);
        await ledger.receive(earning.id, spent);
        this.schedule(earning.id);
        return this.answer({ ...earning, status: 'received', baseTransaction: spent });
      }
      await ledger.fail(earning.id, `reverted in ${hash}`);
      return { ...base, success: false, settled: false, broadcast: true, errorReason: REASON.state, errorMessage: `the transfer reverted in ${hash}`, transaction: hash };
    }

    // The USDC has moved, so the answer is a sale whatever the ledger says next. A row left pending
    // here is read off the token by the next pass and credited then.
    try {
      await ledger.receive(earning.id, hash);
      this.schedule(earning.id);
    } catch (error) {
      this.log(`base earn received but unrecorded earning=${earning.id} base=${hash} reason=${describe(error)}`);
    }
    this.log(`base earn received earning=${earning.id} usdc=${terms.amountMicro} endowment=${terms.endowment} base=${hash}`);
    return this.answer({ ...earning, status: 'received', baseTransaction: hash });
  }

  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Checked | Refused> {
    const { intake } = this.options;
    if (payload.x402Version !== undefined && !isSupportedVersion(payload.x402Version)) return refused(REASON.version);
    if ((requirements.scheme ?? 'exact') !== 'exact') return refused(REASON.scheme, 'earnings settle the exact scheme');
    if (!isBase(requirements.network, intake.network)) return refused(REASON.network, `earnings settle on ${intake.network}`);
    if (!same(requirements.asset, intake.asset)) return refused(REASON.requirements, `earnings settle USDC at ${intake.asset}`);
    if (!same(requirements.payTo, intake.address)) {
      return refused(REASON.requirements, `payTo has to be ${intake.address}, the address this facilitator takes earnings at`);
    }
    const amount = requiredAmount(requirements);
    if (amount === null || amount <= 0n) return refused(REASON.requirements, 'the terms name no positive amount');
    const timeout = requirements.maxTimeoutSeconds;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS)) {
      return refused(REASON.requirements, `maxTimeoutSeconds has to be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`);
    }
    const endowment = readAddress(requirements.extra?.['endowment']);
    if (endowment === null) return refused(EARN_REASON.endowment, 'extra.endowment has to name the endowment on Robinhood Chain that the sale pays');

    // A buyer's client echoes the terms it accepted. Terms naming another endowment or another
    // payee are not the sale being settled.
    const accepted = payload.accepted;
    if (accepted) {
      if (accepted.network !== undefined && !isBase(accepted.network, intake.network)) return refused(REASON.network);
      if (accepted.payTo !== undefined && !same(accepted.payTo, intake.address)) return refused(EARN_REASON.terms, 'the buyer accepted a different payTo');
      const named = accepted.extra?.['endowment'];
      if (named !== undefined && !same(named, endowment)) return refused(EARN_REASON.terms, 'the buyer accepted terms for a different endowment');
    }

    const amountMicro = toMicro(amount);
    if (amountMicro > this.options.maxPaymentMicro) {
      return refused(EARN_REASON.tooLarge, `one sale is capped at ${this.options.maxPaymentMicro} USDC atomic units on this facilitator`);
    }
    const { feeMicro, creditMicro } = this.price(amountMicro);
    if (creditMicro <= 0n) return refused(EARN_REASON.tooSmall, `a sale of ${amountMicro} USDC atomic units does not cover the ${feeMicro} fee`);

    const scheme = payload.payload;
    const authorization = readAuthorization(scheme?.authorization);
    if (!scheme || authorization === null) return refused(REASON.payload, 'earnings take an EIP-3009 authorization');

    if (!(await this.isEndowment(endowment))) {
      return refused(EARN_REASON.unknown, `${endowment} is not an endowment created by Bursar on Robinhood Chain`, authorization.from);
    }

    const verdict = await eip3009Path.check({
      chain: intake.chain,
      asset: await intake.token(),
      payTo: intake.address,
      required: amountMicro,
      now: this.now(),
      mustOutlive: EXPIRY_MARGIN_SECONDS,
      relayer: intake.address,
      permit2: null,
      payload: scheme,
      binding: null,
    });
    if (!verdict.ok) return refused(verdict.reason, verdict.detail, verdict.payer);
    const call = verdict.calls[0];
    if (!call) return refused(REASON.payload);

    const resource =
      typeof requirements['resource'] === 'string'
        ? requirements['resource']
        : typeof (payload['resource'] as { url?: unknown } | undefined)?.url === 'string'
          ? ((payload['resource'] as { url: string }).url)
          : '';
    return {
      ok: true,
      terms: {
        payer: verdict.payer,
        endowment,
        amountMicro,
        feeMicro,
        creditMicro,
        nonce: authorization.nonce,
        validBefore: authorization.validBefore,
        resource: resource.slice(0, 2_000),
        call,
      },
    };
  }

  private async isEndowment(endowment: Address): Promise<boolean> {
    const key = endowment.toLowerCase();
    if (this.endowments.has(key)) return true;
    // A factory never forgets an endowment it made, so a yes is kept and a no is asked again.
    const known = await this.options.credit.isEndowment(endowment);
    if (known) this.endowments.add(key);
    return known;
  }

  private short(available: bigint, terms: EarnTerms): Refused | null {
    if (available >= terms.creditMicro) return null;
    return refused(EARN_REASON.float, this.shortDetail(toMicro(available), terms.creditMicro), terms.payer);
  }

  private shortDetail(available: Micro, needed: Micro): string {
    return `this facilitator can pay ${available > 0n ? available : 0n} USDG atomic units into endowments right now, and this sale needs ${needed}; nothing was taken from the buyer`;
  }

  private async simulate(terms: EarnTerms): Promise<Refused | null> {
    try {
      await this.options.credit.simulate(terms.endowment, terms.creditMicro);
      return null;
    } catch (error) {
      if (!isRevert(error)) throw error;
      return refused(EARN_REASON.refused, `${terms.endowment} would not take ${terms.creditMicro} USDG: ${describe(error)}`, terms.payer);
    }
  }

  private async approve(endowment: Address, creditMicro: Micro): Promise<void> {
    // The endowment only ever pulls from whoever calls `earn`, so an allowance left over is inert.
    // One sale's ceiling covers the next few credits with one approval.
    const amount = creditMicro > this.options.maxPaymentMicro ? creditMicro : this.options.maxPaymentMicro;
    const hash = await this.options.credit.approve(endowment, amount);
    this.log(`base earn approved endowment=${endowment} usdg=${amount} tx=${hash}`);
  }

  private async gasShort(): Promise<Refused | null> {
    const { balanceWei, neededWei } = await this.options.intake.gas();
    if (balanceWei >= neededWei) return null;
    return refused(EARN_REASON.gas, `the float holds ${balanceWei} wei of ETH on Base and one settlement needs about ${neededWei}`);
  }

  /** A read that throws is the chain not answering, which says nothing about the sale. */
  private async guard<T extends { ok: boolean }>(work: () => Promise<T>): Promise<T | Refused> {
    try {
      return await work();
    } catch (error) {
      this.log(`base earn check unreadable reason=${describe(error)}`);
      return refused(REASON.facilitator, `a chain did not answer: ${describe(error)}; nothing was taken from the buyer`);
    }
  }

  private replayed(earning: Earning): EarnSettleBody {
    const network = this.options.intake.network;
    const payer = getAddress(earning.payer);
    if (earning.status === 'pending') {
      return {
        success: false,
        settled: null,
        broadcast: true,
        errorReason: EARN_REASON.pending,
        errorMessage: 'an earlier settle of this authorization is still being read off Base',
        payer,
        transaction: '',
        network,
      };
    }
    return {
      success: false,
      settled: false,
      broadcast: false,
      errorReason: EARN_REASON.replay,
      errorMessage: `this authorization was settled before${earning.baseTransaction ? ` in ${earning.baseTransaction}` : ''}, as sale ${earning.id}`,
      payer,
      transaction: '',
      network,
    };
  }

  private answer(earning: Earning): EarnSettleBody {
    return {
      success: true,
      settled: true,
      broadcast: true,
      payer: getAddress(earning.payer),
      transaction: earning.baseTransaction ?? '',
      network: this.options.intake.network,
      amount: earning.amountMicro.toString(),
      extra: {
        earning: earning.id,
        endowment: getAddress(earning.endowment),
        creditMicro: earning.creditMicro.toString(),
        feeMicro: earning.feeMicro.toString(),
        status: earning.status,
      },
    };
  }

  /** One sale, by its id or by the Base transaction that paid it. */
  async earning(key: string): Promise<EarningView | null> {
    const earning = HASH.test(key) ? await this.options.ledger.findBaseTransaction(key as Hex) : await this.options.ledger.find(key);
    if (!earning) return null;
    return {
      id: earning.id,
      status: earning.status,
      payer: getAddress(earning.payer),
      endowment: getAddress(earning.endowment),
      chainId: earning.chainId,
      amountMicro: earning.amountMicro.toString(),
      feeMicro: earning.feeMicro.toString(),
      creditMicro: earning.creditMicro.toString(),
      baseTransaction: earning.baseTransaction,
      creditTransaction: earning.status === 'credited' ? earning.creditTransaction : null,
      createdAt: earning.createdAt.toISOString(),
      receivedAt: earning.receivedAt?.toISOString() ?? null,
      creditedAt: earning.creditedAt?.toISOString() ?? null,
    };
  }

  /** Starts the credit for a received sale without making the seller wait for it. */
  private schedule(id: string): void {
    void this.creditOnce(id).catch((error: unknown) => this.log(`base earn credit failed earning=${id} reason=${describe(error)}`));
  }

  /** Every credit this process has started, settled. For a clean stop and for tests. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.credits.values()]);
  }

  private creditOnce(id: string): Promise<CreditStep> {
    const running = this.credits.get(id);
    if (running) return running;
    const run = this.options.credit.exclusive(() => this.creditRow(id)).finally(() => this.credits.delete(id));
    this.credits.set(id, run);
    return run;
  }

  /**
   * Pays one received sale into its endowment.
   *
   * Runs alone among the float's writes, and reads the row again first, so two passes cannot both
   * send. The signed `earn` is written down under its hash before it is broadcast: a process that
   * dies after sending leaves a row that says exactly which transaction to look for.
   */
  private async creditRow(id: string): Promise<CreditStep> {
    const { credit, ledger } = this.options;
    let earning = await ledger.find(id);
    if (!earning || earning.status === 'pending' || earning.status === 'failed') return 'skipped';
    if (earning.status === 'credited') return 'credited';
    if (earning.status === 'crediting') {
      const resolved = await this.resolveCredit(earning);
      if (resolved !== 'retry') return resolved;
      earning = await ledger.find(id);
      if (!earning || earning.status !== 'received') return 'skipped';
    }

    if ((await credit.allowance(earning.endowment)) < earning.creditMicro) await this.approve(earning.endowment, earning.creditMicro);
    try {
      await credit.simulate(earning.endowment, earning.creditMicro);
    } catch (error) {
      if (!isRevert(error)) throw error;
      await ledger.note(id, `earn would revert: ${describe(error)}`);
      this.log(`base earn credit refused earning=${id} endowment=${earning.endowment} reason=${describe(error)}`);
      return 'refused';
    }

    const prepared = await credit.prepare(earning.endowment, earning.creditMicro);
    await ledger.crediting(id, prepared);
    try {
      await credit.broadcast(prepared.raw);
    } catch (error) {
      await ledger.note(id, `broadcast: ${describe(error)}`);
      return 'pending';
    }
    const outcome = await credit.wait(prepared.hash, this.options.receiptWaitMs ?? RECEIPT_WAIT_MS).catch(() => null);
    if (outcome === 'success') {
      await ledger.credited(id, prepared.hash);
      this.log(`base earn credited earning=${id} usdg=${earning.creditMicro} endowment=${earning.endowment} tx=${prepared.hash}`);
      return 'credited';
    }
    if (outcome === 'reverted') {
      await ledger.uncredit(id, `earn reverted in ${prepared.hash}`);
      return 'refused';
    }
    return 'pending';
  }

  /** What became of a credit that was sent before: landed, still coming, or never going to. */
  private async resolveCredit(earning: Earning): Promise<CreditStep | 'retry'> {
    const { credit, ledger } = this.options;
    const hash = earning.creditTransaction as Hex;
    const nonce = earning.creditNonce as number;
    let outcome = await credit.receipt(hash);
    if (outcome === null) {
      if ((await credit.minedNonce()) <= nonce) {
        // Not mined and its nonce still free: the same bytes again, which a node that has them ignores.
        await credit.broadcast(earning.creditRaw as Hex).catch((error: unknown) => this.log(`base earn rebroadcast earning=${earning.id} reason=${describe(error)}`));
        outcome = await credit.wait(hash, this.options.receiptWaitMs ?? RECEIPT_WAIT_MS).catch(() => null);
        if (outcome === null) return 'pending';
      } else {
        await new Promise((resolve) => setTimeout(resolve, this.options.recheckMs ?? RECEIPT_RECHECK_MS));
        outcome = await credit.receipt(hash);
        if (outcome === null) {
          await ledger.uncredit(earning.id, `credit ${hash} never landed and nonce ${nonce} went to another transaction`);
          return 'retry';
        }
      }
    }
    if (outcome === 'success') {
      await ledger.credited(earning.id, hash);
      this.log(`base earn credited earning=${earning.id} usdg=${earning.creditMicro} endowment=${earning.endowment} tx=${hash}`);
      return 'credited';
    }
    await ledger.uncredit(earning.id, `earn reverted in ${hash}`);
    return 'retry';
  }

  /**
   * One pass over everything owed. A pending sale is decided by the token; a received one is paid
   * into its endowment. A row a pass cannot finish waits for the next one.
   */
  async reconcile(): Promise<EarnPass> {
    const { ledger, intake } = this.options;
    const open = await ledger.listOpen(RECONCILE_BATCH);
    const pass = { checked: open.length, received: 0, credited: 0, failed: 0, pending: 0, errors: 0 };
    for (const earning of open) {
      if (this.settling.has(earning.id)) {
        pass.pending += 1;
        continue;
      }
      try {
        if (earning.status === 'pending') {
          if (await intake.authorizationUsed(earning.payer, earning.nonce)) {
            const spent = earning.baseTransaction ?? (await intake.authorizationTransaction(earning.payer, earning.nonce, earning.baseBlock).catch(() => null));
            await ledger.receive(earning.id, spent);
            pass.received += 1;
          } else if (BigInt(this.now()) > earning.validBefore + BigInt(EXPIRY_GRACE_SECONDS)) {
            await ledger.fail(earning.id, 'the authorization expired unused');
            pass.failed += 1;
            continue;
          } else {
            pass.pending += 1;
            continue;
          }
        }
        const step = await this.creditOnce(earning.id);
        if (step === 'credited') pass.credited += 1;
        else if (step === 'pending' || step === 'refused') pass.pending += 1;
      } catch (error) {
        pass.errors += 1;
        this.log(`base earn pass failed earning=${earning.id} reason=${describe(error)}`);
        await ledger.note(earning.id, describe(error)).catch(() => undefined);
      }
    }
    return pass;
  }

  async status(): Promise<EarnStatus> {
    const { intake, credit, ledger } = this.options;
    const late = new Date((this.now() - LATE_SECONDS) * 1000);
    const [usdg, owed, totals, gas] = await Promise.all([
      credit.balance(),
      ledger.owed(credit.address),
      ledger.totals(credit.address, late),
      intake.gas().then(
        (reading) => ({ balanceWei: reading.balanceWei.toString(), neededWei: reading.neededWei.toString(), healthy: reading.balanceWei >= reading.neededWei }),
        (error: unknown) => ({ healthy: false as const, detail: `could not read the float's ETH on Base: ${describe(error)}` }),
      ),
    ]);
    return {
      on: true,
      network: intake.network,
      asset: intake.asset,
      payTo: intake.address,
      endowmentsOn: credit.chainId,
      feeBps: this.options.feeBps,
      feeFloorMicro: this.options.feeFloorMicro.toString(),
      maxPaymentMicro: this.options.maxPaymentMicro.toString(),
      usdgMicro: usdg.toString(),
      owedMicro: owed.toString(),
      availableMicro: (usdg - owed).toString(),
      credited: totals.credited,
      creditedMicro: totals.creditedMicro.toString(),
      feesMicro: totals.feesMicro.toString(),
      owed: totals.owed,
      late: totals.late,
      pending: totals.pending,
      baseGas: gas,
      healthy: totals.late === 0 && gas.healthy,
    };
  }
}

function invalid(refusal: Refused): EarnVerifyBody {
  return {
    isValid: false,
    invalidReason: refusal.reason,
    ...(refusal.detail === undefined ? {} : { invalidMessage: refusal.detail }),
    ...(refusal.payer === undefined ? {} : { payer: refusal.payer }),
  };
}
