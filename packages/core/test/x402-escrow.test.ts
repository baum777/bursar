import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { deriveNonce, hashRequest, nonceBindsRequest, randomSalt } from '../src/binding.js';
import { canonicalStringify, commitCanonical } from '../src/commit.js';
import {
  ESCROW_SETTLEMENT_TAG,
  REQUEST_DOCUMENT_MEDIA_TYPE,
  escrowSettlementNonce,
  isRequestDocumentURI,
  readRequestURI,
  requestCommit,
  requestDocument,
  requestURI,
} from '../src/x402-escrow.js';

/**
 * What an x402 lock commits to and what it settles under. The client, the facilitator and the
 * resolver each compute these on their own, so the vectors here are what they have to agree on.
 */

const ESCROW = '0x4315F8be7C9661345710910577Ec31cb867f3c20' as const;
const SALT = `0x${'5a'.repeat(32)}` as const;
const BODY = '{"prompt":"a koi"}';

const binding = { requestHash: hashRequest(BODY), salt: SALT };
const document = () => requestDocument({ method: 'post', url: 'https://api.provider.dev/render?key=secret#frag', binding });

describe('the request document', () => {
  it('names the method and the endpoint, and binds the body without publishing it', () => {
    const doc = document();
    expect(doc).toEqual({ method: 'POST', resource: 'https://api.provider.dev/render', requestNonce: deriveNonce(binding) });
    expect(requestCommit(doc)).toBe(commitCanonical(doc));

    // Neither the digest nor the salt is in the bytes the chain will carry, and the query is not
    // either. Whoever holds both halves of the binding can still check the lock against them.
    const published = canonicalStringify(doc);
    expect(published).not.toContain(binding.requestHash);
    expect(published).not.toContain(SALT.slice(2));
    expect(published).not.toContain('secret');
    expect(nonceBindsRequest(doc.requestNonce, binding)).toBe(true);
    expect(nonceBindsRequest(doc.requestNonce, { requestHash: hashRequest('{}'), salt: SALT })).toBe(false);
  });

  it('commits differently for the same call paid twice, through the salt', () => {
    const again = requestDocument({ method: 'POST', url: 'https://api.provider.dev/render', binding: { ...binding, salt: randomSalt() } });
    expect(again.resource).toBe(document().resource);
    expect(requestCommit(again)).not.toBe(requestCommit(document()));
  });

  it('publishes inline under its own media type and reads back to the same document', () => {
    const doc = document();
    const uri = requestURI(doc);
    expect(uri.startsWith(`data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,`)).toBe(true);
    expect(isRequestDocumentURI(uri)).toBe(true);
    expect(readRequestURI(uri)).toEqual(doc);

    const payload = uri.split(',')[1] ?? '';
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(canonicalStringify(doc));
    // Media types are case-blind, so a reader that received one upper-cased still knows it.
    expect(readRequestURI(`DATA:${REQUEST_DOCUMENT_MEDIA_TYPE.toUpperCase()};BASE64,${payload}`)).toEqual(doc);
  });

  it('reads nothing from a URI that is not a request document', () => {
    const doc = document();
    const under = (value: unknown) => `data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;

    expect(readRequestURI('')).toBeNull();
    expect(readRequestURI(`data:application/json;base64,${Buffer.from(canonicalStringify(doc)).toString('base64')}`)).toBeNull();
    expect(readRequestURI(`data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,!!!`)).toBeNull();
    expect(readRequestURI(under([doc]))).toBeNull();
    expect(readRequestURI(under({ ...doc, extra: 1 }))).toBeNull();
    expect(readRequestURI(under({ method: doc.method, resource: doc.resource }))).toBeNull();
    expect(readRequestURI(under({ ...doc, requestNonce: '0x5a' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, requestNonce: 'not hex' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, method: '' }))).toBeNull();
    expect(readRequestURI(under({ ...doc, resource: 7 }))).toBeNull();
  });

  it('refuses a URL it cannot name an endpoint from', () => {
    expect(() => requestDocument({ method: 'GET', url: '/render', binding })).toThrow();
  });
});

describe('the settlement nonce', () => {
  const lock = { chainId: 4663, escrow: ESCROW, lockId: 7n, inputCommit: requestCommit(document()) };

  it('is keccak256 over the tag, chain, escrow, lock id and commitment', () => {
    expect(escrowSettlementNonce(lock)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
          [ESCROW_SETTLEMENT_TAG, 4663n, ESCROW, 7n, lock.inputCommit],
        ),
      ),
    );
    expect(escrowSettlementNonce(lock)).toBe(escrowSettlementNonce({ ...lock, escrow: ESCROW.toLowerCase() as typeof ESCROW }));
  });

  it('changes with every field, so no lock shares a name with another', () => {
    const nonce = escrowSettlementNonce(lock);
    expect(escrowSettlementNonce({ ...lock, chainId: 46630 })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, escrow: '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4' })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, lockId: 8n })).not.toBe(nonce);
    expect(escrowSettlementNonce({ ...lock, inputCommit: `0x${'11'.repeat(32)}` })).not.toBe(nonce);
  });
});

describe('a request document that names a payee on another network', () => {
  const binding = { requestHash: hashRequest('{}'), salt: `0x${'02'.repeat(32)}` as const };
  const payee = {
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    payTo: '0xD7d49D6a12Ee3852f29A52A40908069bF4e48914' as const,
    amount: '1000',
  };

  it('leaves a document without one byte for byte as before', () => {
    const plain = requestDocument({ method: 'post', url: 'https://x.dev/a?q=1', binding });
    expect(Object.keys(plain).sort()).toEqual(['method', 'requestNonce', 'resource']);
  });

  it('round-trips through the lock URI and changes the commitment', () => {
    const plain = requestDocument({ method: 'POST', url: 'https://x.dev/a', binding });
    const named = requestDocument({ method: 'POST', url: 'https://x.dev/a', binding, payee });
    const read = readRequestURI(requestURI(named));
    expect(read?.payee).toEqual({ ...payee, asset: payee.asset.toLowerCase(), payTo: payee.payTo.toLowerCase() });
    expect(requestCommit(read!)).toBe(requestCommit(named));
    expect(requestCommit(named)).not.toBe(requestCommit(plain));
  });

  it('refuses a payee with a missing or malformed field', () => {
    const encode = (doc: unknown) =>
      `data:${REQUEST_DOCUMENT_MEDIA_TYPE};base64,${Buffer.from(JSON.stringify(doc)).toString('base64')}`;
    const base = requestDocument({ method: 'POST', url: 'https://x.dev/a', binding });
    expect(readRequestURI(encode({ ...base, payee: { ...payee, amount: '0' } }))).toBeNull();
    expect(readRequestURI(encode({ ...base, payee: { ...payee, payTo: 'nobody' } }))).toBeNull();
    const { amount: _amount, ...short } = payee;
    expect(readRequestURI(encode({ ...base, payee: short }))).toBeNull();
  });
});
