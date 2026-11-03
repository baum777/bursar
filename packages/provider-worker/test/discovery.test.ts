import type { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

import { cdpJwt } from '../src/coinbase.js';
import { decodeBase64Json, encodeBase64Json } from '../src/x402.js';
import { ENV, PROVIDER, facilitatorStub, worker } from './support.js';
import type { Outbound } from './support.js';

let running: Miniflare | undefined;
afterEach(async () => {
  await running?.dispose();
  running = undefined;
});

const BASE_PAY_TO = '0x239830833BE550B8CFD2C0D3c476743F94620246';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BUYER = '0x47F1000000000000000000000000000000003F34';
const PRICES = 'POST /render=0.01, GET /quote=0.001';

type Key = { secret: string; publicKey: CryptoKey };

async function ed25519Key(): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const bytes = (field: string) => Buffer.from(field, 'base64url');
  return { secret: Buffer.concat([bytes(jwk.d!), bytes(jwk.x!)]).toString('base64'), publicKey: pair.publicKey };
}

async function verifiesWith(token: string, publicKey: CryptoKey, algorithm: { name: string; hash?: string }): Promise<boolean> {
  const [header, claims, signature] = token.split('.') as [string, string, string];
  return crypto.subtle.verify(algorithm, publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claims}`));
}

function jwtParts(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [header, claims] = token.split('.') as [string, string];
  return { header: JSON.parse(Buffer.from(header, 'base64url').toString()), claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) };
}

async function start(bindings: Record<string, string>, outbound: Outbound): Promise<Miniflare> {
  running = await worker(bindings, outbound);
  return running;
}

function challengeOf(response: { headers: { get(name: string): string | null } }) {
  return decodeBase64Json(response.headers.get('payment-required')!) as {
    resource: Record<string, unknown>;
    accepts: Record<string, unknown>[];
    extensions?: { bazaar: { info: Record<string, any>; schema: Record<string, any> } };
  };
}

describe('discovery in the 402', () => {
  it('declares a body route and a query route the way Coinbase indexes them', async () => {
    const mf = await start({ ...ENV, BURSAR_PRICES: PRICES }, async () => new Response('never', { status: 599 }));

    const post = challengeOf(await mf.dispatchFetch('http://worker/render', { method: 'POST', body: '{}' }));
    expect(post.resource).toMatchObject({ url: 'http://worker/render', description: 'Renders a prompt.', mimeType: 'application/json' });
    expect(post.extensions?.bazaar.info).toEqual({
      input: { type: 'http', method: 'POST', bodyType: 'json', body: { prompt: 'a koi' } },
      output: { type: 'json', example: { rendered: 'a koi' } },
    });
    expect(post.extensions?.bazaar.schema.properties.input.required).toEqual(['type', 'method', 'bodyType', 'body']);

    const response = await mf.dispatchFetch('http://worker/quote?symbol=NVDA');
    const get = challengeOf(response);
    expect(get.resource).toMatchObject({ iconUrl: 'https://bursar.world/icon.png' });
    expect(get.extensions?.bazaar.info.input).toEqual({ type: 'http', method: 'GET', queryParams: { symbol: 'NVDA' } });
    expect(get.extensions?.bazaar.schema.properties.input.properties.method.enum).toEqual(['GET', 'HEAD', 'DELETE']);
    const body = (await response.json()) as { extensions?: unknown };
    expect(body.extensions).toEqual(get.extensions);
  });

  it('makes no Base offer until a Base address is configured', async () => {
    const mf = await start({ ...ENV, BURSAR_PRICES: PRICES }, async () => new Response('never', { status: 599 }));
    const offers = challengeOf(await mf.dispatchFetch('http://worker/quote?symbol=NVDA')).accepts;
    expect(offers.map((offer) => offer['network'])).toEqual(['eip155:4663', 'eip155:4663']);
  });

  it('refuses a Base address without a CDP key', async () => {
    const mf = await start({ ...ENV, BURSAR_PRICES: PRICES, BURSAR_BASE_PAY_TO: BASE_PAY_TO }, async () => new Response('never', { status: 599 }));
    const response = await mf.dispatchFetch('http://worker/quote?symbol=NVDA');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'bursar_misconfigured' });
  });
});

describe('the Base offer, settled by Coinbase', () => {
  it('leads the offers with USDC on Base and settles a Base payment through Coinbase, signed by the CDP key', async () => {
    const key = await ed25519Key();
    const bindings = { ...ENV, BURSAR_PRICES: PRICES, BURSAR_BASE_PAY_TO: BASE_PAY_TO, CDP_API_KEY_ID: 'key-under-test', CDP_API_KEY_SECRET: key.secret };
    const coinbaseCalls: { path: string; body: Record<string, any>; authorization: string | null }[] = [];
    const bursar = facilitatorStub({ verify: () => ({ isValid: false, invalidReason: 'never' }) });
    const outbound: Outbound = async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'api.cdp.coinbase.com') return bursar.handle(request);
      const body = (await request.json()) as Record<string, any>;
      coinbaseCalls.push({ path: url.pathname, body, authorization: request.headers.get('authorization') });
      if (url.pathname.endsWith('/verify')) return Response.json({ isValid: true, payer: BUYER });
      return Response.json({ success: true, transaction: `0x${'12'.repeat(32)}`, network: 'eip155:8453', payer: BUYER });
    };
    const mf = await start(bindings, outbound);

    const first = await mf.dispatchFetch('http://worker/quote?symbol=NVDA');
    const offers = challengeOf(first).accepts;
    expect(offers[0]).toMatchObject({ scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: BASE_USDC, payTo: BASE_PAY_TO, extra: { name: 'USD Coin', version: '2' } });
    expect(offers.slice(1).map((offer) => offer['network'])).toEqual(['eip155:4663', 'eip155:4663']);

    const payment = encodeBase64Json({ x402Version: 2, accepted: offers[0], payload: { signature: '0x01', authorization: { from: BUYER } } });
    const paid = await mf.dispatchFetch('http://worker/quote?symbol=NVDA', { headers: { 'payment-signature': payment } });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ symbol: 'NVDA', price: '204.64', network: 'eip155:8453' });
    expect(decodeBase64Json(paid.headers.get('payment-response')!)).toMatchObject({ success: true, network: 'eip155:8453', payer: BUYER });

    expect(bursar.calls).toHaveLength(0);
    expect(coinbaseCalls.map((call) => call.path)).toEqual(['/platform/v2/x402/verify', '/platform/v2/x402/settle']);
    const settle = coinbaseCalls[1]!;
    expect(settle.body['x402Version']).toBe(2);
    expect(settle.body['paymentRequirements']).toMatchObject({ network: 'eip155:8453', payTo: BASE_PAY_TO });
    expect(settle.body['paymentPayload'].resource).toMatchObject({ url: 'http://worker/quote' });
    expect(settle.body['paymentPayload'].extensions.bazaar.info.input).toEqual({ type: 'http', method: 'GET', queryParams: { symbol: 'NVDA' } });

    const token = settle.authorization!.replace(/^Bearer /, '');
    expect(await verifiesWith(token, key.publicKey, { name: 'Ed25519' })).toBe(true);
    const { header, claims } = jwtParts(token);
    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'key-under-test', typ: 'JWT' });
    expect(claims).toMatchObject({ sub: 'key-under-test', iss: 'cdp', uris: ['POST api.cdp.coinbase.com/platform/v2/x402/settle'] });
    expect((claims['exp'] as number) - (claims['nbf'] as number)).toBe(120);
  });

  it('never sends a payment that leaves out its network to Coinbase', async () => {
    const key = await ed25519Key();
    const bursar = facilitatorStub({ verify: () => ({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }) });
    const mf = await start(
      { ...ENV, BURSAR_PRICES: PRICES, BURSAR_BASE_PAY_TO: BASE_PAY_TO, CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: key.secret },
      async (request) => (new URL(request.url).host === 'api.cdp.coinbase.com' ? new Response('never', { status: 599 }) : bursar.handle(request)),
    );
    const payment = encodeBase64Json({ x402Version: 2, accepted: { scheme: 'exact', payTo: PROVIDER }, payload: {} });
    const response = await mf.dispatchFetch('http://worker/quote?symbol=NVDA', { headers: { 'payment-signature': payment } });
    expect(response.status).toBe(402);
    expect(bursar.calls.map((call) => call.path)).toEqual(['/verify']);
  });
});

describe('the CDP JWT', () => {
  it('signs ES256 with an EC key in PKCS#8 or SEC1 PEM', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----`;
    // PKCS#8 wraps the SEC1 key as the OCTET STRING after the version and the algorithm.
    const outer = pkcs8[1]! & 0x80 ? 2 + (pkcs8[1]! & 0x7f) : 2;
    const algorithm = outer + 3;
    const octets = algorithm + 2 + pkcs8[algorithm + 1]!;
    const sec1 = pkcs8.subarray(octets + 2, octets + 2 + pkcs8[octets + 1]!);

    for (const secret of [pem('PRIVATE KEY', pkcs8), pem('EC PRIVATE KEY', sec1)]) {
      const token = await cdpJwt({ id: 'ec-key', secret }, 'POST', 'api.cdp.coinbase.com/platform/v2/x402/verify');
      expect(jwtParts(token).header).toMatchObject({ alg: 'ES256', kid: 'ec-key' });
      expect(await verifiesWith(token, pair.publicKey, { name: 'ECDSA', hash: 'SHA-256' })).toBe(true);
    }
  });
});
