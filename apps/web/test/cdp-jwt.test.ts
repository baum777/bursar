import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { cdpCredentials, cdpJwt, cdpUrl } from '@/app/api/onramp/cdp-jwt';

/** A fresh Ed25519 key in the 64-byte form Coinbase hands out: seed then public key. */
function coinbaseStyleKey(): { readonly secret: string; readonly publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  return { secret: Buffer.concat([seed, pub]).toString('base64'), publicKey };
}

describe('the CDP bearer token', () => {
  it('is an EdDSA JWT for one request that the public key verifies', () => {
    const { secret, publicKey } = coinbaseStyleKey();
    const jwt = cdpJwt({ keyId: 'key-1', secret }, 'post', '/onramp/v1/token', 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'key-1' });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims).toMatchObject({ sub: 'key-1', iss: 'cdp', aud: ['cdp_service'], nbf: 1_700_000_000, exp: 1_700_000_120 });
    expect(claims.uris).toEqual(['POST api.developer.coinbase.com/onramp/v1/token']);
    expect(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('refuses a secret that is not an Ed25519 key', () => {
    expect(() => cdpJwt({ keyId: 'k', secret: Buffer.from('short').toString('base64') }, 'GET', '/x')).toThrow(/Ed25519/);
  });

  it('reads both halves of the credential from the environment or nothing', () => {
    expect(cdpCredentials({})).toBeUndefined();
    expect(cdpCredentials({ CDP_API_KEY_ID: 'id' })).toBeUndefined();
    expect(cdpCredentials({ CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 's' })).toEqual({ keyId: 'id', secret: 's' });
    expect(cdpUrl('/onramp/v1/token')).toBe('https://api.developer.coinbase.com/onramp/v1/token');
  });
});
