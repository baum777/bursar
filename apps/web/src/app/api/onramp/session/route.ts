import { isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { readContract } from 'viem/actions';
import { endowmentFactoryAbi } from '@bursar/core';

import { isCrossSite } from '@/app/api/index/upstream';
import { refused, relayBase, relayHeaders } from '@/app/api/relay/upstream';
import { rhcClient } from '@/chain/client';
import { ENDOWMENTS, previousFactories } from '@/chain/endowments';
import { ADDRESSES, CHAIN_ID } from '@/chain/rhc';
import { parseQuote, quoteBody, sourceChain } from '@/relay';
import { cdpCredentials, cdpJwt, cdpUrl } from '../cdp-jwt';

export const dynamic = 'force-dynamic';

/**
 * A gift by card: one Coinbase Onramp session whose destination is a Relay deposit address on Base
 * that pays this endowment in USDG on Robinhood Chain.
 *
 * The reader buys USDC on Base at Coinbase. Coinbase sends it to the deposit address Relay opened
 * for this request; Relay turns it into USDG and pays the endowment, which books it as it books
 * any USDG that arrives. Nobody signs anything on a chain and nobody needs gas. The console keeps
 * Coinbase's key on this side and hands the page a URL and the request to follow.
 */
const MIN_DOLLARS = 5;
const MAX_DOLLARS = 1_000;
const ONRAMP_PAGE = 'https://pay.coinbase.com/buy/select-asset';

type Ask = { readonly endowment: Address; readonly dollars: number };

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return refused('This route answers this app only.', 403);
  const credentials = cdpCredentials();
  if (credentials === undefined) return refused('Gifts by card are not switched on for this deployment.', 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refused('The request has to be a JSON object.');
  }
  const ask = readAsk(body);
  if ('refused' in ask) return refused(ask.refused);

  if (!(await isEndowment(ask.endowment))) return refused('That address is not an endowment this console knows.', 404);

  const base = sourceChain('base');
  if (base === undefined) return refused('Base is not a funding chain on this deployment.', 503);

  // Relay's deposit address for this gift. The amount prices the route; what Coinbase actually
  // delivers is what Relay fills, so the quote is informative, not binding.
  const quoteResponse = await fetch(`${relayBase()}/quote`, {
    method: 'POST',
    headers: { ...relayHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(
      quoteBody({
        user: ask.endowment,
        recipient: ask.endowment,
        source: base,
        amount: BigInt(Math.round(ask.dollars * 10 ** base.usdc.decimals)),
        destination: { chainId: CHAIN_ID, currency: ADDRESSES.usdg },
        depositAddress: true,
      }),
    ),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  let quote;
  try {
    quote = parseQuote(await quoteResponse.json());
  } catch (error) {
    return refused(`Relay could not open a route for this gift: ${error instanceof Error ? error.message : 'no answer'}`, 502);
  }
  const depositAddress = quote.depositAddress;
  if (depositAddress === undefined) return refused('Relay gave this gift no deposit address.', 502);

  // Coinbase's session token, bound to that deposit address on Base and to USDC.
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const path = '/onramp/v1/token';
  const tokenResponse = await fetch(cdpUrl(path), {
    method: 'POST',
    headers: { authorization: `Bearer ${cdpJwt(credentials, 'POST', path)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      addresses: [{ address: depositAddress, blockchains: ['base'] }],
      assets: ['USDC'],
      ...(clientIp ? { clientIp } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  const token = await tokenResponse.json().catch(() => undefined);
  const sessionToken = (token as { token?: unknown } | undefined)?.token;
  if (!tokenResponse.ok || typeof sessionToken !== 'string' || sessionToken === '') {
    return refused('Coinbase did not open a session.', 502);
  }

  const origin = new URL(request.url).origin;
  const url = new URL(ONRAMP_PAGE);
  url.searchParams.set('sessionToken', sessionToken);
  url.searchParams.set('defaultAsset', 'USDC');
  url.searchParams.set('defaultNetwork', 'base');
  url.searchParams.set('defaultExperience', 'buy');
  url.searchParams.set('fiatCurrency', 'USD');
  url.searchParams.set('presetFiatAmount', String(ask.dollars));
  url.searchParams.set('partnerUserRef', `endow:${quote.requestId.slice(2, 18)}`);
  url.searchParams.set('redirectUrl', `${origin}/endowments/${ask.endowment}?relay=${quote.requestId}&from=base`);

  return Response.json({
    url: url.toString(),
    requestId: quote.requestId,
    depositAddress,
    expected: quote.arrives.expected.toString(),
    sends: quote.source.amount.toString(),
  });
}

function readAsk(body: unknown): Ask | { readonly refused: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { refused: 'The request has to be a JSON object.' };
  const asked = body as Record<string, unknown>;
  const endowment = asked['endowment'];
  if (typeof endowment !== 'string' || !isAddress(endowment)) return { refused: 'endowment has to be a 20-byte address.' };
  const dollars = asked['dollars'];
  if (typeof dollars !== 'number' || !Number.isInteger(dollars) || dollars < MIN_DOLLARS || dollars > MAX_DOLLARS) {
    return { refused: `dollars has to be a whole number from ${MIN_DOLLARS} to ${MAX_DOLLARS}.` };
  }
  return { endowment, dollars };
}

/** Whether a factory this deployment knows started the endowment. */
async function isEndowment(address: Address): Promise<boolean> {
  if (ENDOWMENTS === undefined) return false;
  const factories = [ENDOWMENTS.EndowmentFactory, ...previousFactories()];
  for (const factory of factories) {
    const known = (await readContract(rhcClient(), { address: factory, abi: endowmentFactoryAbi, functionName: 'isEndowment', args: [address] }).catch(
      () => false,
    )) as boolean;
    if (known) return true;
  }
  return false;
}

export type { Hex };
