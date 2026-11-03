import { deploymentForChain } from '@bursar/core';
import { formatUnits, parseAbi } from 'viem';
import type { Address } from 'viem';
import { readContract } from 'viem/actions';

import { rhcClient } from '@/chain/client';
import { CHAIN_ID } from '@/chain/rhc';

/**
 * The Chainlink price of a tokenized asset on Robinhood Chain, for Bursar's own paid quote route.
 *
 * That route runs on Cloudflare, whose shared addresses the chain's keyless endpoints rate-limit,
 * so it reads here, through this app's endpoint pool. It is a back end for that one route, not a
 * public price feed: it answers only a request carrying the token both sides hold, and a
 * deployment without the token answers nothing.
 */
export const dynamic = 'force-dynamic';

const FEED = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** A feed moves at most every few seconds; one read serves every buyer inside this window. */
const FRESH_MS = 15_000;

type Quote = {
  readonly symbol: string;
  readonly kind: 'stock' | 'treasury';
  readonly price: string;
  readonly updatedAt: string;
  readonly token: Address;
  readonly feed: Address;
  readonly chain: string;
};

const held = new Map<string, { readonly at: number; readonly quote: Quote }>();

export async function GET(request: Request): Promise<Response> {
  const token = process.env.BURSAR_QUOTES_TOKEN?.trim();
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('not found', { status: 404 });

  const assets = deploymentForChain(CHAIN_ID).rwa?.assets ?? [];
  const symbol = (new URL(request.url).searchParams.get('symbol') ?? '').toUpperCase();
  const asset = assets.find((entry) => entry.symbol === symbol);
  if (!asset) return Response.json({ error: 'unknown_symbol', symbols: assets.map((entry) => entry.symbol) }, { status: 400 });

  const cached = held.get(symbol);
  if (cached && Date.now() - cached.at < FRESH_MS) return Response.json(cached.quote);

  try {
    const client = rhcClient();
    const [round, decimals] = await Promise.all([
      readContract(client, { address: asset.feed, abi: FEED, functionName: 'latestRoundData' }),
      readContract(client, { address: asset.feed, abi: FEED, functionName: 'decimals' }),
    ]);
    const quote: Quote = {
      symbol: asset.symbol,
      kind: asset.kind,
      price: formatUnits(round[1], decimals),
      updatedAt: new Date(Number(round[3]) * 1000).toISOString(),
      token: asset.address,
      feed: asset.feed,
      chain: 'Robinhood Chain (eip155:4663)',
    };
    held.set(symbol, { at: Date.now(), quote });
    return Response.json(quote);
  } catch {
    return Response.json({ error: 'feed_unreadable' }, { status: 503 });
  }
}
