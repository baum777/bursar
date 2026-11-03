import { BASE_LANE, BASE_MAINNET, parseMicro } from '@bursar/core';
import type { Caip2 } from '@bursar/core';
import { getAddress } from 'viem';

import { parsePayment, paymentRequired } from './codec.js';
import type { PaymentRequiredResponse, ResourceDescriptor } from './codec.js';
import { X402ConfigError } from './errors.js';
import { createFacilitatorClient } from './facilitator-client.js';
import { REASON } from './reasons.js';
import type { PaymentRequirements, RemoteVerifyResult, SettleResult, X402Version } from './types.js';

/**
 * Selling on Base into an endowment on Robinhood Chain.
 *
 * A buyer on Base pays USDC with the standard `exact` scheme to the Base lane's float, and Bursar's
 * facilitator pays the same amount, less its fee, into the endowment the seller names, in USDG on
 * Robinhood Chain. Nothing about the buyer changes: any x402 client that pays USDC on Base pays
 * this. The seller names two things, the endowment and the price, and the terms carry the
 * endowment in `extra.endowment` so the facilitator knows where the money goes.
 */
export const BASE_EARNINGS = Object.freeze({
  network: BASE_MAINNET.network as Caip2,
  asset: Object.freeze({
    asset: BASE_MAINNET.usdc,
    // USDC on Base, read from the token: name "USD Coin", version "2". A buyer signs under this.
    name: 'USD Coin',
    version: '2',
    decimals: BASE_MAINNET.usdcDecimals,
    symbol: 'USDC',
  }),
  payTo: BASE_LANE.float,
  facilitator: BASE_LANE.earn,
});

const MAX_TIMEOUT_SECONDS = 3_600;
const DEFAULT_TIMEOUT_SECONDS = 300;

export type BaseEarningsOptions = {
  /** The endowment on Robinhood Chain that is paid what the agent earns. */
  readonly endowment: string;
  /** Dollars per call, as `"0.01"`, `"$0.01"` or `0.01`. Settled in USDC, six decimals. */
  readonly price: string | number;
  /** How long the seller may take between the buyer's payment and its settlement. Default 300. */
  readonly maxTimeoutSeconds?: number;
  /** Another facilitator's earnings surface. Default Bursar's. */
  readonly facilitator?: string;
  /** The float that facilitator takes payments at. Default the Base lane's. */
  readonly payTo?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
};

/** The same terms as a route option for the reference servers (`@x402/express`, `@x402/hono`, `@x402/next`). */
export type BaseEarningsRoute = {
  readonly scheme: 'exact';
  readonly network: Caip2;
  readonly price: string;
  readonly payTo: `0x${string}`;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly endowment: `0x${string}` };
};

/** What the facilitator credited for one sale, when it says. */
export type EarningCredit = {
  readonly earning: string;
  readonly endowment: `0x${string}`;
  readonly creditMicro: string;
  readonly feeMicro: string;
  readonly status: string;
};

export type EarningSettlement = SettleResult & { readonly credit?: EarningCredit };

export type BaseEarnings = {
  readonly endowment: `0x${string}`;
  readonly network: Caip2;
  readonly facilitator: string;
  /** One `accepts` entry, in v2 spelling, with the amount in USDC atomic units. */
  readonly requirements: PaymentRequirements;
  readonly route: BaseEarningsRoute;
  /** The 402 to answer an unpaid request with. */
  paymentRequired(options?: { readonly resource?: ResourceDescriptor; readonly version?: X402Version; readonly error?: string }): PaymentRequiredResponse;
  /** Checks a payment header against these terms without moving anything. */
  verify(header: string): Promise<RemoteVerifyResult>;
  /** Settles a payment header: the buyer's USDC moves on Base, and the endowment is paid on Robinhood Chain. */
  settle(header: string): Promise<EarningSettlement>;
};

/**
 * Terms for selling on Base into an endowment, and the two calls that settle against them.
 *
 *   const earnings = baseEarnings({ endowment: '0x0F8C…8C0d', price: '$0.01' });
 *   // unpaid: answer earnings.paymentRequired()
 *   // paid:   const settled = await earnings.settle(header); if (settled.success) serve();
 */
export function baseEarnings(options: BaseEarningsOptions): BaseEarnings {
  const endowment = address(options.endowment, 'endowment');
  const payTo = address(options.payTo ?? BASE_EARNINGS.payTo, 'payTo');
  const dollars = typeof options.price === 'number' ? options.price.toString() : options.price.trim().replace(/^\$/, '');
  let amount: bigint;
  try {
    amount = parseMicro(dollars);
  } catch (error) {
    throw new X402ConfigError('x402_price_invalid', `price ${String(options.price)} is not a dollar figure USDC can carry: ${error instanceof Error ? error.message : String(error)}`, {
      price: String(options.price),
    });
  }
  if (amount <= 0n) throw new X402ConfigError('x402_price_invalid', `price ${String(options.price)} has to be above zero`, { price: String(options.price) });
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1 || maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new X402ConfigError('x402_timeout_invalid', `maxTimeoutSeconds has to be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}`, { maxTimeoutSeconds });
  }
  const facilitator = (options.facilitator ?? BASE_EARNINGS.facilitator).replace(/\/+$/, '');
  const { asset, name, version } = BASE_EARNINGS.asset;

  const requirements: PaymentRequirements = Object.freeze({
    scheme: 'exact',
    network: BASE_EARNINGS.network,
    amount: amount.toString(),
    asset,
    payTo,
    maxTimeoutSeconds,
    extra: Object.freeze({ name, version, endowment }),
  });
  const client = createFacilitatorClient({
    baseUrl: facilitator,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    // A settle waits for Base to confirm the transfer, which is longer than a verify.
    timeoutMs: options.timeoutMs ?? 60_000,
  });

  return {
    endowment,
    network: BASE_EARNINGS.network,
    facilitator,
    requirements,
    route: Object.freeze({ scheme: 'exact', network: BASE_EARNINGS.network, price: `$${dollars}`, payTo, maxTimeoutSeconds, extra: Object.freeze({ endowment }) }),

    paymentRequired(answer = {}) {
      return paymentRequired(answer.version ?? 2, {
        accepts: [requirements],
        error: answer.error ?? 'Payment required',
        ...(answer.resource ? { resource: answer.resource } : {}),
      });
    },

    async verify(header) {
      const payload = parsePayment(header);
      if (payload === null) return { isValid: false, invalidReason: REASON.payload };
      return client.verify(payload, requirements);
    },

    async settle(header) {
      const payload = parsePayment(header);
      if (payload === null) {
        return { success: false, settled: false, broadcast: false, errorReason: REASON.payload, payer: '', transaction: '', network: BASE_EARNINGS.network };
      }
      const settled = await client.settle(payload, requirements);
      const credit = creditOf(settled.extra);
      return credit === null ? settled : { ...settled, credit };
    },
  };
}

function address(value: string, role: string): `0x${string}` {
  try {
    return getAddress(value);
  } catch {
    throw new X402ConfigError('x402_address_invalid', `${role} ${value} is not an address`, { [role]: value });
  }
}

function creditOf(extra: Readonly<Record<string, unknown>> | undefined): EarningCredit | null {
  if (!extra) return null;
  const { earning, endowment, creditMicro, feeMicro, status } = extra as Record<string, unknown>;
  if (typeof earning !== 'string' || typeof endowment !== 'string' || typeof creditMicro !== 'string' || typeof feeMicro !== 'string' || typeof status !== 'string') {
    return null;
  }
  return { earning, endowment: endowment as `0x${string}`, creditMicro, feeMicro, status };
}
