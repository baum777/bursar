import { USDG_DOMAIN_NAME, USDG_DOMAIN_VERSION, deploymentForChain } from '@bursar/core';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

import { ConfigError } from './errors.js';
import { readPrices } from './prices.js';
import type { PriceTable } from './prices.js';

/** Robinhood Chain, the only network Bursar settles on. */
export const CHAIN_ID = 4663;
export const NETWORK = `eip155:${CHAIN_ID}`;
export const DEFAULT_FACILITATOR_URL = 'https://facilitator.bursar.world';
export const DEFAULT_RPC_URL = 'https://robinhood.drpc.org';

/** Base, where the optional second offer is paid in USDC and settled by Coinbase. */
export const BASE_NETWORK = 'eip155:8453';
/** USDC on Base. It signs transfers under the EIP-712 domain "USD Coin", version "2". */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_USDC_DOMAIN = { name: 'USD Coin', version: '2' } as const;

/** Seconds the offer gives the worker to serve and settle. Agents sign authorisations that outlive it. */
export const MAX_TIMEOUT_SECONDS = 120;

export type Scheme = 'escrow' | 'exact';

/**
 * What the worker reads from its environment. Set the first three as `[vars]` in wrangler.toml
 * and the token with `wrangler secret put`.
 */
export type BursarEnv = {
  /** The address the escrow pays: your provider address, listed on the registry. */
  readonly BURSAR_PROVIDER?: string;
  /** The capability each call falls under, the label a payer's mandate allows, such as `service:render:1`. */
  readonly BURSAR_CAPABILITY?: string;
  /** Priced routes, `POST /render=0.01, GET /quote=0.001`, in USDG. */
  readonly BURSAR_PRICES?: string;
  /** Defaults to the hosted facilitator. */
  readonly BURSAR_FACILITATOR_URL?: string;
  /** The bearer token the facilitator issued you. A secret. */
  readonly BURSAR_FACILITATOR_TOKEN?: string;
  /**
   * Optional. The provider's own key, as a secret. With it the worker releases each escrow lock it
   * serves, which is what pays you. Without it the locks stay open for your sidecar or the
   * provider desk to release.
   */
  readonly BURSAR_PROVIDER_KEY?: string;
  /** The endpoint releases are sent through. Defaults to a keyless public one. */
  readonly BURSAR_RPC_URL?: string;
  /** `escrow`, `exact`, or both. Defaults to both, escrow first. */
  readonly BURSAR_SCHEMES?: string;
  /**
   * Optional. Your address on Base. With it every priced route also offers the price in USDC on
   * Base, settled by Coinbase's facilitator, and a route whose payment Coinbase settles is listed
   * in the Bazaar and on Agentic.Market. Needs the two CDP keys below.
   */
  readonly BURSAR_BASE_PAY_TO?: string;
  /** Your CDP API key id, from portal.cdp.coinbase.com. */
  readonly CDP_API_KEY_ID?: string;
  /** Its secret, as a Worker secret: the base64 Ed25519 key, or an EC key in PEM. */
  readonly CDP_API_KEY_SECRET?: string;
};

export type CdpKey = { readonly id: string; readonly secret: string };

export type Config = {
  readonly provider: Address;
  readonly capability: string;
  readonly prices: PriceTable;
  readonly facilitatorUrl: string;
  readonly facilitatorToken: string | undefined;
  readonly schemes: readonly Scheme[];
  readonly escrow: Address;
  readonly asset: Address;
  readonly assetDomain: { readonly name: string; readonly version: string };
  readonly signer: { readonly account: PrivateKeyAccount; readonly rpcUrl: string } | undefined;
  /** The Base offer: where Coinbase pays the USDC, and the key that signs for its facilitator. */
  readonly base: { readonly payTo: Address; readonly key: CdpKey } | undefined;
};

const cache = new WeakMap<object, Config>();

export function readConfig(env: BursarEnv): Config {
  const cached = cache.get(env);
  if (cached) return cached;

  const provider = readAddress('BURSAR_PROVIDER', env.BURSAR_PROVIDER);
  const capability = (env.BURSAR_CAPABILITY ?? '').trim();
  if (capability === '') throw new ConfigError('BURSAR_CAPABILITY is not set. Example: service:render:1');

  const prices = readPrices(env.BURSAR_PRICES ?? '');
  const deployment = deploymentForChain(CHAIN_ID);

  const config: Config = {
    provider,
    capability,
    prices,
    facilitatorUrl: (env.BURSAR_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, ''),
    facilitatorToken: env.BURSAR_FACILITATOR_TOKEN?.trim() || undefined,
    schemes: readSchemes(env.BURSAR_SCHEMES),
    escrow: deployment.contracts.Escrow,
    asset: deployment.settlementAsset,
    assetDomain: { name: USDG_DOMAIN_NAME, version: USDG_DOMAIN_VERSION },
    signer: readSigner(env.BURSAR_PROVIDER_KEY, provider, env.BURSAR_RPC_URL),
    base: readBase(env),
  };
  cache.set(env, config);
  return config;
}

function readAddress(name: string, value: string | undefined): Address {
  try {
    if (value) return getAddress(value.trim());
  } catch {
    // reported below
  }
  throw new ConfigError(`${name} is not an address. Set it to the provider address the escrow pays.`);
}

function readSchemes(value: string | undefined): readonly Scheme[] {
  if (value === undefined || value.trim() === '') return ['escrow', 'exact'];
  const schemes = value.split(',').map((scheme) => scheme.trim().toLowerCase());
  for (const scheme of schemes) {
    if (scheme !== 'escrow' && scheme !== 'exact') {
      throw new ConfigError(`BURSAR_SCHEMES names "${scheme}". The schemes are escrow and exact.`);
    }
  }
  return schemes as Scheme[];
}

function readSigner(key: string | undefined, provider: Address, rpcUrl: string | undefined): Config['signer'] {
  if (!key || key.trim() === '') return undefined;
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(key.trim() as Hex);
  } catch {
    throw new ConfigError('BURSAR_PROVIDER_KEY is not a private key.');
  }
  if (account.address !== provider) {
    throw new ConfigError(`BURSAR_PROVIDER_KEY belongs to ${account.address}, and BURSAR_PROVIDER is ${provider}. The key has to be the provider's own.`);
  }
  return { account, rpcUrl: rpcUrl?.trim() || DEFAULT_RPC_URL };
}

function readBase(env: BursarEnv): Config['base'] {
  const payTo = env.BURSAR_BASE_PAY_TO?.trim();
  if (!payTo) return undefined;
  let address: Address;
  try {
    address = getAddress(payTo);
  } catch {
    throw new ConfigError('BURSAR_BASE_PAY_TO is not an address. Set it to the address on Base that Coinbase pays.');
  }
  const id = env.CDP_API_KEY_ID?.trim();
  const secret = env.CDP_API_KEY_SECRET?.trim();
  if (!id || !secret) {
    throw new ConfigError('BURSAR_BASE_PAY_TO is set without CDP_API_KEY_ID and CDP_API_KEY_SECRET. Coinbase settles the Base offer only for a CDP API key.');
  }
  if (!/-----BEGIN (EC )?PRIVATE KEY-----/.test(secret) && !isEd25519(secret)) {
    throw new ConfigError('CDP_API_KEY_SECRET is neither a base64 Ed25519 key nor an EC private key in PEM. Paste it as the CDP portal gave it.');
  }
  return { payTo: address, key: { id, secret } };
}

function isEd25519(secret: string): boolean {
  try {
    return atob(secret).length === 64;
  } catch {
    return false;
  }
}
