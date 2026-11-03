import { BASE_NETWORK } from './config.js';
import type { CdpKey } from './config.js';
import { remote } from './facilitator.js';
import type { Facilitator } from './facilitator.js';
import { hex } from './x402.js';

/**
 * Coinbase's CDP facilitator, which settles the Base offer. A payment it settles for a route that
 * carries the discovery extension is what lists the route in the Bazaar and on Agentic.Market.
 *
 * It authenticates each call with a short-lived JWT signed by the provider's CDP API key: EdDSA for
 * the Ed25519 keys the CDP portal issues by default, ES256 for the older EC keys. The claims and
 * header are the ones `@coinbase/cdp-sdk` signs, built here on WebCrypto because a Worker has no
 * Node crypto.
 */
export const COINBASE_HOST = 'api.cdp.coinbase.com';
export const COINBASE_FACILITATOR = `https://${COINBASE_HOST}/platform/v2/x402`;

const TOKEN_SECONDS = 120;

export function coinbase(key: CdpKey, fetchFn: typeof fetch = fetch): Facilitator {
  return remote(
    {
      url: COINBASE_FACILITATOR,
      network: BASE_NETWORK,
      headers: async (path) => ({ authorization: `Bearer ${await cdpJwt(key, 'POST', `${COINBASE_HOST}/platform/v2/x402${path}`)}` }),
      body: ({ paymentPayload, paymentRequirements }) => ({ x402Version: 2, paymentPayload, paymentRequirements }),
      refused: (status) => `Coinbase refused the CDP API key (${status}). Check CDP_API_KEY_ID and CDP_API_KEY_SECRET.`,
    },
    fetchFn,
  );
}

export async function cdpJwt(key: CdpKey, method: string, uri: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const signer = await signerFor(key.secret);
  const header = { alg: signer.alg, kid: key.id, typ: 'JWT', nonce: hex(crypto.getRandomValues(new Uint8Array(16))) };
  const claims = { sub: key.id, iss: 'cdp', uris: [`${method} ${uri}`], iat: now, nbf: now, exp: now + TOKEN_SECONDS };
  const signingInput = `${base64url(json(header))}.${base64url(json(claims))}`;
  const signature = await crypto.subtle.sign(signer.algorithm, signer.key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

type Signer = { readonly alg: 'EdDSA' | 'ES256'; readonly algorithm: { readonly name: string; readonly hash?: string }; readonly key: CryptoKey };

const signers = new Map<string, Promise<Signer>>();

function signerFor(secret: string): Promise<Signer> {
  let signer = signers.get(secret);
  if (!signer) {
    signer = importSigner(secret);
    signers.set(secret, signer);
  }
  return signer;
}

async function importSigner(secret: string): Promise<Signer> {
  const ed = ed25519Bytes(secret);
  if (ed !== null) {
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: base64url(ed.subarray(0, 32)), x: base64url(ed.subarray(32)) };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    return { alg: 'EdDSA', algorithm: { name: 'Ed25519' }, key };
  }
  const der = pemBody(secret);
  const pkcs8 = /BEGIN EC PRIVATE KEY/.test(secret) ? sec1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { alg: 'ES256', algorithm: { name: 'ECDSA', hash: 'SHA-256' }, key };
}

function isPem(secret: string): boolean {
  return /-----BEGIN (EC )?PRIVATE KEY-----/.test(secret);
}

/** The 64 bytes of an Ed25519 key (seed, then public key), or null when the secret is not one. */
function ed25519Bytes(secret: string): Uint8Array | null {
  if (isPem(secret)) return null;
  try {
    const bytes = Uint8Array.from(atob(secret.trim()), (character) => character.charCodeAt(0));
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

function pemBody(pem: string): Uint8Array {
  const base64 = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/**
 * Wraps a SEC1 EC key ("BEGIN EC PRIVATE KEY") as PKCS#8, which is the only form WebCrypto imports:
 * SEQUENCE { INTEGER 0, SEQUENCE { id-ecPublicKey, prime256v1 }, OCTET STRING { the SEC1 key } }.
 */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const algorithm = Uint8Array.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const octets = concat(Uint8Array.from([0x04]), derLength(sec1.length), sec1);
  const inner = concat(version, algorithm, octets);
  return concat(Uint8Array.from([0x30]), derLength(inner.length), inner);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  if (length < 0x100) return Uint8Array.from([0x81, length]);
  return Uint8Array.from([0x82, length >> 8, length & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
