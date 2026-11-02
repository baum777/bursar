import { RHC_MAINNET, RHC_MAINNET_USDG_DOMAIN } from '@bursar/core';
import { assets } from 'mppx/x402';

/**
 * Robinhood Chain for the Machine Payments Protocol.
 *
 * MPP's EVM charge method needs three things to run on a chain its tables do not carry: the chain
 * id, the token, and the EIP-712 domain the token's `transferWithAuthorization` is signed under.
 * All three come from `@bursar/core`, where the USDG domain is the one proved against the token's
 * own separator, never guessed. `USDG` is the asset in the shape `mppx` keeps per chain, so a
 * server built on `mppx` quotes it and a client built on `mppx` signs it like any other chain.
 */
export const CHAIN_ID: number = RHC_MAINNET.chainId;

export const NETWORK = `eip155:${RHC_MAINNET.chainId}` as const;

/** USDG on Robinhood Chain, for `mppx`'s `evm.charge` on either side. */
export const USDG = assets.define({
  address: RHC_MAINNET.usdg,
  decimals: RHC_MAINNET.usdgDecimals,
  network: NETWORK,
  transfer: { type: 'eip3009', name: RHC_MAINNET_USDG_DOMAIN.name, version: RHC_MAINNET_USDG_DOMAIN.version },
});

/**
 * Bursar's keyless facilitator for the `exact` scheme in USDG. `mppx` verifies and settles a native
 * MPP authorization through it as well as an x402 one, so a server needs no key and no gas.
 */
export const FACILITATOR = 'https://facilitator.bursar.world/x402';

export const EXPLORER: string = RHC_MAINNET.explorer;
