import { deploymentForChain } from '@bursar/core';
import { createPublicClient, formatUnits, http, parseAbi } from 'viem';

/**
 * The Chainlink price of a tokenized stock on Robinhood Chain, read from the same feed a Bursar
 * mandate's stock purchases are priced against.
 */
const FEED = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const ASSETS = deploymentForChain(4663).rwa?.assets ?? [];
export const SYMBOLS = ASSETS.map((asset) => asset.symbol);

export type Quote = {
  readonly symbol: string;
  readonly kind: 'stock' | 'treasury';
  readonly price: string;
  readonly updatedAt: string;
  readonly token: string;
  readonly feed: string;
  readonly chain: string;
};

export async function quote(symbol: string, rpcUrl: string): Promise<Quote | null> {
  const asset = ASSETS.find((entry) => entry.symbol === symbol.toUpperCase());
  if (!asset) return null;
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
  const [round, decimals] = await Promise.all([
    client.readContract({ address: asset.feed, abi: FEED, functionName: 'latestRoundData' }),
    client.readContract({ address: asset.feed, abi: FEED, functionName: 'decimals' }),
  ]);
  return {
    symbol: asset.symbol,
    kind: asset.kind,
    price: formatUnits(round[1], decimals),
    updatedAt: new Date(Number(round[3]) * 1000).toISOString(),
    token: asset.address,
    feed: asset.feed,
    chain: 'Robinhood Chain (eip155:4663)',
  };
}
