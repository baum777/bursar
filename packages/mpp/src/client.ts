import { evm } from 'mppx/client';

import { USDG } from './index.js';

export { CHAIN_ID, EXPLORER, FACILITATOR, NETWORK, USDG } from './index.js';

type ChargeParameters = Parameters<typeof evm.charge>[0];

export type UsdgPayerOptions = Omit<ChargeParameters, 'assets' | 'currencies' | 'networks' | 'authorization' | 'decimals'>;

/**
 * An `mppx` client method that pays MPP charges in USDG on Robinhood Chain.
 *
 * The account signs an EIP-3009 authorization under USDG's domain; the server's facilitator
 * broadcasts it and pays the gas, so the payer holds USDG and no ETH. `maxAmount` is the most one
 * charge may take, in dollars.
 *
 * ```ts
 * const fetch = Fetch.from({ methods: [usdgPayer({ account, maxAmount: '1.00' })] });
 * ```
 */
export function usdgPayer(options: UsdgPayerOptions): ReturnType<typeof evm.charge> {
  return evm.charge({ ...options, currencies: [USDG] });
}
