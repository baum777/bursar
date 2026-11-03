import type { Micro } from '@bursar/core';

import { BASE_NETWORK, BASE_USDC, BASE_USDC_DOMAIN, MAX_TIMEOUT_SECONDS, NETWORK } from './config.js';
import type { Config, Scheme } from './config.js';

/**
 * The wire half: what a 402 carries, how a payment header is read, and what the paid response
 * reports. Written against the web primitives, which is all a Worker has.
 */
export type X402Version = 1 | 2;

export type Offer = {
  readonly scheme: Scheme;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, string>>;
};

export type Resource = { readonly url: string; readonly description: string; readonly mimeType?: string; readonly iconUrl?: string };

export type PaymentPayload = {
  readonly x402Version?: unknown;
  readonly accepted?: Readonly<Record<string, unknown>>;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
};

export type Settlement = {
  readonly success: boolean;
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
  readonly errorReason?: string;
};

/**
 * The offers a priced route makes. With a Base address configured, USDC on Base comes first: it is
 * the offer Coinbase's validator reads, and any x402 client on Base can pay it. Bursar's own
 * clients pick their offer by scheme and network, so the order does not move them.
 */
export function offersFor(config: Config, amount: Micro): readonly Offer[] {
  const robinhood = config.schemes.map((scheme): Offer => {
    const extra: Record<string, string> =
      scheme === 'escrow'
        ? { capability: config.capability, escrow: config.escrow }
        : { name: config.assetDomain.name, version: config.assetDomain.version };
    return { scheme, network: NETWORK, amount: amount.toString(), asset: config.asset, payTo: config.provider, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra };
  });
  if (!config.base) return robinhood;
  const base: Offer = {
    scheme: 'exact',
    network: BASE_NETWORK,
    amount: amount.toString(),
    asset: BASE_USDC,
    payTo: config.base.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...BASE_USDC_DOMAIN },
  };
  return [base, ...robinhood];
}

/**
 * The 402. The offer travels twice: as the v2 `PAYMENT-REQUIRED` header, and in the body with the
 * v1 spelling of the amount alongside, so a client of either version finds it.
 */
export function challenge(
  offers: readonly Offer[],
  resource: Resource,
  error: string,
  options: {
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly report?: { readonly version: X402Version; readonly settlement: Settlement };
  } = {},
): Response {
  const { extensions, report } = options;
  const discovered = extensions === undefined ? {} : { extensions };
  const body = {
    x402Version: 2,
    error,
    resource,
    accepts: offers.map((offer) => ({ ...offer, maxAmountRequired: offer.amount, resource: resource.url, description: resource.description })),
    ...discovered,
  };
  const headers = new Headers({
    'content-type': 'application/json',
    'payment-required': encodeBase64Json({ x402Version: 2, error, resource, accepts: offers, ...discovered }),
  });
  if (report) {
    for (const [name, value] of Object.entries(settlementHeaders(report.version, report.settlement))) headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status: 402, headers });
}

export type PresentedPayment = { readonly version: X402Version; readonly payload: PaymentPayload };

/** The payment a request carries: none, one that does not decode, or one in either version. */
export function readPayment(request: Request): PresentedPayment | null | 'malformed' {
  const v2 = request.headers.get('payment-signature');
  const v1 = request.headers.get('x-payment');
  const header = v2 || v1;
  if (!header) return null;

  let decoded: unknown;
  try {
    decoded = decodeBase64Json(header);
  } catch {
    return 'malformed';
  }
  if (!isRecord(decoded)) return 'malformed';
  return { version: v2 ? 2 : 1, payload: decoded as PaymentPayload };
}

/** The terms the payer says it paid under, in the v2 shape whichever version sent them. */
export function acceptedOf(payload: PaymentPayload): Readonly<Record<string, unknown>> | null {
  if (isRecord(payload.accepted)) return payload.accepted;
  const { scheme, network, asset, payTo } = payload;
  if (typeof scheme !== 'string') return null;
  return { scheme, network, asset, payTo };
}

/**
 * Whether the terms the payer echoed are the terms this worker offered. The worker's copy is what
 * the facilitator judges. An offer off Robinhood Chain matches only a payment that names its
 * network, so a payment that leaves the network out is never sent to Coinbase.
 */
export function agrees(offer: Offer, accepted: Readonly<Record<string, unknown>>): boolean {
  const same = (left: unknown, right: string) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
  if (!same(accepted['scheme'], offer.scheme)) return false;
  if (offer.network !== NETWORK && !same(accepted['network'], offer.network)) return false;
  if (accepted['payTo'] !== undefined && !same(accepted['payTo'], offer.payTo)) return false;
  if (accepted['asset'] !== undefined && !same(accepted['asset'], offer.asset)) return false;
  if (accepted['network'] !== undefined && !same(accepted['network'], offer.network)) return false;
  const amount = accepted['amount'] ?? accepted['maxAmountRequired'];
  if (amount !== undefined && String(amount) !== offer.amount) return false;
  return true;
}

export function settlementHeaders(version: X402Version, settlement: Settlement): Readonly<Record<string, string>> {
  const encoded = encodeBase64Json({
    success: settlement.success,
    transaction: settlement.transaction,
    network: settlement.network,
    payer: settlement.payer,
    ...(settlement.errorReason === undefined ? {} : { errorReason: settlement.errorReason }),
  });
  return version === 2 ? { 'payment-response': encoded } : { 'x-payment-response': encoded };
}

export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Json(value: string): unknown {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
