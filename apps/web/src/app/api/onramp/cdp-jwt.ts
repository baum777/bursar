import { createPrivateKey, randomBytes, sign } from 'node:crypto';

/**
 * The bearer token Coinbase's developer APIs take: a JWT signed with the project's Ed25519 secret
 * key, good for two minutes and for one request (method and path are in its claims). Built here
 * rather than through Coinbase's SDK because this is all the console needs from it, and the key
 * material stays in one short file that can be read in full.
 */
export const CDP_KEY_ID_ENV = 'CDP_API_KEY_ID';
export const CDP_KEY_SECRET_ENV = 'CDP_API_KEY_SECRET';

const CDP_HOST = 'api.developer.coinbase.com';
const TTL_SECONDS = 120;
/** PKCS#8 wrapping for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type CdpCredentials = { readonly keyId: string; readonly secret: string };

export function cdpCredentials(env: Readonly<Record<string, string | undefined>> = process.env): CdpCredentials | undefined {
  const keyId = env[CDP_KEY_ID_ENV];
  const secret = env[CDP_KEY_SECRET_ENV];
  if (!keyId || !secret) return undefined;
  return { keyId, secret };
}

/** A JWT for one call to `method path` on Coinbase's developer API. */
export function cdpJwt(credentials: CdpCredentials, method: string, path: string, now: number = Math.floor(Date.now() / 1000)): string {
  const raw = Buffer.from(credentials.secret, 'base64');
  // Coinbase hands out the 64-byte form (seed then public key); the seed alone signs.
  if (raw.length !== 64 && raw.length !== 32) throw new Error('The CDP secret is not an Ed25519 key.');
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const header = { alg: 'EdDSA', typ: 'JWT', kid: credentials.keyId, nonce: randomBytes(16).toString('hex') };
  const claims = {
    sub: credentials.keyId,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: now,
    exp: now + TTL_SECONDS,
    uris: [`${method.toUpperCase()} ${CDP_HOST}${path}`],
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${base64url(signature)}`;
}

export function cdpUrl(path: string): string {
  return `https://${CDP_HOST}${path}`;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}
