import type { Config } from './config.js';
import { NETWORK } from './config.js';
import { isRecord } from './x402.js';
import type { Offer, PaymentPayload, Settlement } from './x402.js';

/**
 * The two calls a provider makes to the facilitator, and the one judgement that matters here: a
 * settle that times out has not failed. The facilitator broadcasts before it answers, so a dropped
 * connection can leave a transfer that is mining, and reporting that as a refusal would serve the
 * call for free against a payment the payer was charged for. It is reported as unconfirmed instead.
 */
export const UNREACHABLE = 'facilitator_unavailable';
export const UNCONFIRMED = 'settlement_unconfirmed';

const VERIFY_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 60_000;

export type Verdict =
  | { readonly isValid: true; readonly payer: string }
  | { readonly isValid: false; readonly invalidReason: string; readonly payer?: string };

export type Exchange = {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: Offer;
  /** SHA-256 of the request body, hex, so the facilitator can hold the payment to this request. */
  readonly requestHash: string;
};

export type Facilitator = {
  verify(exchange: Exchange): Promise<Verdict>;
  settle(exchange: Exchange): Promise<Settlement>;
};

/** Where a facilitator answers, how each call is signed, and what it reads. */
export type Endpoint = {
  readonly url: string;
  /** The network a failed settlement is reported on. */
  readonly network: string;
  headers(path: '/verify' | '/settle'): Promise<Record<string, string>>;
  body(exchange: Exchange): unknown;
  refused(status: number): string;
};

/** Bursar's facilitator, which settles both schemes on Robinhood Chain. */
export function facilitator(config: Config, fetchFn: typeof fetch = fetch): Facilitator {
  return remote(
    {
      url: config.facilitatorUrl,
      network: NETWORK,
      headers: async (): Promise<Record<string, string>> => (config.facilitatorToken === undefined ? {} : { authorization: `Bearer ${config.facilitatorToken}` }),
      body: (exchange) => exchange,
      refused: (status) => `facilitator refused the token (${status}). Set BURSAR_FACILITATOR_TOKEN to the one it issued you.`,
    },
    fetchFn,
  );
}

export function remote(endpoint: Endpoint, fetchFn: typeof fetch = fetch): Facilitator {
  async function call(path: '/verify' | '/settle', exchange: Exchange, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${endpoint.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await endpoint.headers(path)) },
        body: JSON.stringify(endpoint.body(exchange)),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status === 401 || response.status === 403) throw new Error(endpoint.refused(response.status));
      if (text.length === 0) throw new Error(`facilitator answered ${response.status} with an empty body`);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async verify(exchange) {
      let body: unknown;
      try {
        body = await call('/verify', exchange, VERIFY_TIMEOUT_MS);
      } catch (error) {
        console.error('bursar: verify did not answer', message(error));
        return { isValid: false, invalidReason: UNREACHABLE };
      }
      if (!isRecord(body) || typeof body['isValid'] !== 'boolean') return { isValid: false, invalidReason: UNREACHABLE };
      const payer = typeof body['payer'] === 'string' ? body['payer'] : undefined;
      if (body['isValid'] !== true || payer === undefined) {
        const reason = typeof body['invalidReason'] === 'string' ? body['invalidReason'] : 'invalid_payload';
        return payer === undefined ? { isValid: false, invalidReason: reason } : { isValid: false, invalidReason: reason, payer };
      }
      return { isValid: true, payer };
    },

    async settle(exchange) {
      let body: unknown;
      try {
        body = await call('/settle', exchange, SETTLE_TIMEOUT_MS);
      } catch (error) {
        console.error('bursar: settle did not answer', message(error));
        return { success: false, transaction: '', network: endpoint.network, payer: '', errorReason: UNCONFIRMED };
      }
      if (!isRecord(body)) return { success: false, transaction: '', network: endpoint.network, payer: '', errorReason: UNCONFIRMED };
      const success = body['success'] === true;
      const reason = body['errorReason'] ?? body['invalidReason'];
      return {
        success,
        transaction: typeof body['transaction'] === 'string' ? body['transaction'] : '',
        network: typeof body['network'] === 'string' ? body['network'] : endpoint.network,
        payer: typeof body['payer'] === 'string' ? body['payer'] : '',
        ...(success || typeof reason !== 'string' ? {} : { errorReason: reason }),
      };
    },
  };
}

function message(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'timed out' : error.message;
  return String(error);
}
