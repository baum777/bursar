import { REMOTE_AGENT_CHAINS, erc8004Registries, identityRegistryAbi } from '@bursar/core';
import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';
import { readContract } from 'viem/actions';

import { CHAIN_ID } from './rhc';

/**
 * Agents on other chains, read where they live.
 *
 * The ERC-8004 registry is the same contract on every chain it is on, so reading an owner on Base or
 * Ethereum is the same call as on Robinhood Chain against a different endpoint. These are public,
 * keyless endpoints; a read that fails is reported as such and nothing is created from it.
 */
const HOMES: Readonly<Record<number, { readonly label: string; readonly urls: readonly string[] }>> = {
  8453: { label: 'Base', urls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  1: { label: 'Ethereum', urls: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'] },
};

export const AGENT_CHAINS: readonly { readonly chainId: number; readonly label: string }[] = [
  { chainId: CHAIN_ID, label: 'Robinhood Chain' },
  ...REMOTE_AGENT_CHAINS.filter((id) => HOMES[id] !== undefined).map((id) => ({ chainId: id, label: HOMES[id]!.label })),
];

export function chainLabel(chainId: number): string {
  return chainId === CHAIN_ID ? 'Robinhood Chain' : (HOMES[chainId]?.label ?? `chain ${chainId}`);
}

type HomeClient = ReturnType<typeof createPublicClient>;
const clients = new Map<number, HomeClient>();

// Reads only, so the client carries no chain object: the endpoint is the chain.
function homeClient(chainId: number): HomeClient {
  const home = HOMES[chainId];
  if (home === undefined) throw new Error(`No endpoint for chain ${chainId}.`);
  let client = clients.get(chainId);
  if (client === undefined) {
    client = createPublicClient({ transport: http(home.urls[0], { timeout: 10_000, retryCount: 1 }) });
    clients.set(chainId, client);
  }
  return client;
}

/** Who owns `agentId` on `chainId`'s registry. Throws when the token does not exist or the chain does not answer. */
export async function homeOwner(chainId: number, agentId: bigint): Promise<Address> {
  const registries = erc8004Registries(chainId);
  if (registries === undefined) throw new Error(`No registry on chain ${chainId}.`);
  return (await readContract(homeClient(chainId), {
    address: registries.identity,
    abi: identityRegistryAbi,
    functionName: 'ownerOf',
    args: [agentId],
  })) as Address;
}

/** The agent's card URI on its home chain, or undefined when the chain does not answer. */
export async function homeTokenUri(chainId: number, agentId: bigint): Promise<string | undefined> {
  const registries = erc8004Registries(chainId);
  if (registries === undefined) return undefined;
  try {
    return (await readContract(homeClient(chainId), {
      address: registries.identity,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [agentId],
    })) as string;
  } catch {
    return undefined;
  }
}
