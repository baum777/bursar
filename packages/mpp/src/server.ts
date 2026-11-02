import { evm } from 'mppx/server';

import { FACILITATOR, USDG } from './index.js';

export { CHAIN_ID, EXPLORER, FACILITATOR, NETWORK, USDG } from './index.js';

type ChargeParameters = Parameters<typeof evm.charge>[0];

export type UsdgChargeOptions = Omit<ChargeParameters, 'authorization' | 'chainId' | 'currency' | 'decimals'> & {
  /** Bursar's keyless facilitator unless a self-hosted one is named. */
  readonly x402?: ChargeParameters['x402'];
};

/**
 * An `mppx` charge method in USDG on Robinhood Chain, settled by Bursar.
 *
 * The route it protects answers a 402 with both an MPP challenge and an x402 one, and takes either
 * credential back. Native MPP credentials are verified and settled through the same facilitator
 * routes a stock x402 client uses, so the server holds no key. Everything `evm.charge` accepts is
 * accepted here, except the chain and the token, which are USDG on Robinhood Chain.
 *
 * x402 route binding defaults to `resource`, which is what lets a client built on the reference
 * x402 packages pay: `mppx`'s own `required` mode asks for an extension only `mppx` clients send.
 * Pass `x402: { routeBinding: 'required' }` to serve `mppx` clients alone.
 *
 * ```ts
 * const mppx = Mppx.create({ methods: [usdgCharge({ recipient })], secretKey });
 * app.get('/quote', mppx.evm.charge({ amount: '0.01' }), handler);
 * ```
 */
export function usdgCharge(options: UsdgChargeOptions): ReturnType<typeof evm.charge> {
  const { x402, ...rest } = options;
  return evm.charge({
    ...rest,
    currency: USDG,
    x402: { facilitator: FACILITATOR, routeBinding: 'resource', ...x402 },
  } as ChargeParameters);
}
