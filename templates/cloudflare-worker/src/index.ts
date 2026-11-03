import { paymentOf, withBursar } from '@bursar/provider-worker';
import type { BursarEnv } from '@bursar/provider-worker';

import { SYMBOLS, quote } from './quote';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * Two priced routes. An agent that calls one without paying gets a 402 with the price; one that
 * pays gets the result, and the payment settles through Bursar, or through Coinbase when it pays
 * the Base offer. Everything else passes through free.
 */
export default {
  fetch: withBursar<BursarEnv>(
    async (request, env) => {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/quote') {
        const symbol = url.searchParams.get('symbol') ?? '';
        const found = await quote(symbol, env.BURSAR_RPC_URL ?? RPC_URL);
        // A response that is not a success is never settled, so a bad symbol costs nothing.
        if (!found) return Response.json({ error: 'unknown_symbol', symbols: SYMBOLS }, { status: 400 });
        return Response.json(found);
      }

      if (request.method === 'POST' && url.pathname === '/render') {
        const { prompt = '' } = (await request.json().catch(() => ({}))) as { prompt?: string };
        const payment = paymentOf(request);
        return Response.json({
          rendered: `a stub render of "${prompt}"`,
          paidBy: payment?.payer,
          lock: payment?.lock?.id.toString(),
        });
      }

      return Response.json({
        service: 'bursar-provider',
        priced: ['GET /quote?symbol=NVDA', 'POST /render'],
        symbols: SYMBOLS,
        pay: 'Call a priced route. The 402 names the price and where to pay it.',
      });
    },
    {
      discovery: {
        'GET /quote': {
          description: `Live Chainlink price of a tokenized US stock or ETF on Robinhood Chain (${SYMBOLS.join(', ')}), with the token and feed addresses and when the feed last updated.`,
          input: { symbol: 'NVDA' },
          inputSchema: {
            properties: { symbol: { type: 'string', enum: SYMBOLS, description: 'Ticker of the tokenized asset' } },
            required: ['symbol'],
          },
          output: {
            symbol: 'NVDA',
            kind: 'stock',
            price: '204.64',
            updatedAt: '2026-11-02T21:00:00.000Z',
            token: '0x0000000000000000000000000000000000000000',
            feed: '0x0000000000000000000000000000000000000000',
            chain: 'Robinhood Chain (eip155:4663)',
          },
          outputSchema: {
            properties: {
              symbol: { type: 'string' },
              kind: { type: 'string' },
              price: { type: 'string' },
              updatedAt: { type: 'string' },
              token: { type: 'string' },
              feed: { type: 'string' },
              chain: { type: 'string' },
            },
            required: ['symbol', 'price', 'updatedAt'],
          },
          iconUrl: 'https://app.bursar.world/brand/mark.png',
        },
      },
    },
  ),
};
