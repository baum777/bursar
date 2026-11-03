import { deploymentForChain } from '@bursar/core';
import { createPublicClient, formatUnits, http, parseAbi } from 'viem';

/**
 * The Chainlink price of a tokenized stock on Robinhood Chain, read from the same feed a Bursar
 * mandate's stock purchases are priced against.
 *
 * Cloudflare's shared addresses are rate-limited by the chain's keyless endpoints, so a worker
 * either reads through an endpoint of its own (`BURSAR_RPC_URL`) or asks a back end that holds one
 * (`BURSAR_QUOTES_URL` with `BURSAR_QUOTES_TOKEN`, which is how Bursar's own copy runs).
 */
const FEED = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const ASSETS = deploymentForChain(4663).rwa?.assets ?? [];
export const SYMBOLS = ASSETS.map((asset) => asset.symbol);

const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export type QuoteEnv = {
  readonly BURSAR_RPC_URL?: string;
  readonly BURSAR_QUOTES_URL?: string;
  readonly BURSAR_QUOTES_TOKEN?: string;
};

/**
 * The quote as the response the route sends. Anything but a 200 is never settled, so a bad
 * symbol or an unreadable feed costs the buyer nothing.
 */
export async function quote(symbol: string, env: QuoteEnv): Promise<Response> {
  const asset = ASSETS.find((entry) => entry.symbol === symbol.toUpperCase());
  if (!asset) return Response.json({ error: 'unknown_symbol', symbols: SYMBOLS }, { status: 400 });

  try {
    if (env.BURSAR_QUOTES_URL && env.BURSAR_QUOTES_TOKEN) {
      const answer = await fetch(`${env.BURSAR_QUOTES_URL}?symbol=${asset.symbol}`, { headers: { authorization: `Bearer ${env.BURSAR_QUOTES_TOKEN}` } });
      if (!answer.ok) return Response.json({ error: 'feed_unreadable' }, { status: 503 });
      return Response.json(await answer.json());
    }
    const client = createPublicClient({ transport: http(env.BURSAR_RPC_URL ?? DEFAULT_RPC_URL, { retryCount: 1 }) });
    const [round, decimals] = await Promise.all([
      client.readContract({ address: asset.feed, abi: FEED, functionName: 'latestRoundData' }),
      client.readContract({ address: asset.feed, abi: FEED, functionName: 'decimals' }),
    ]);
    return Response.json({
      symbol: asset.symbol,
      kind: asset.kind,
      price: formatUnits(round[1], decimals),
      updatedAt: new Date(Number(round[3]) * 1000).toISOString(),
      token: asset.address,
      feed: asset.feed,
      chain: 'Robinhood Chain (eip155:4663)',
    });
  } catch {
    return Response.json({ error: 'feed_unreadable' }, { status: 503 });
  }
}
