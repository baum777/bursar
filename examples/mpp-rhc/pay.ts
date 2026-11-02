import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Fetch } from 'mppx/client';
import { Receipt } from 'mppx';
import { privateKeyToAccount } from 'viem/accounts';
import { EXPLORER, NETWORK, usdgPayer } from '@bursar/mpp/client';

/**
 * An MPP client paying the endpoint in server.ts.
 *
 * `usdgPayer` is `mppx`'s EVM charge client with USDG on Robinhood Chain as the currency it
 * signs. The client reads the 402, signs an EIP-3009 authorization under the token's domain, and
 * retries with the credential; the server's facilitator broadcasts it and pays the gas. The payer
 * holds USDG and no ETH.
 *
 *   EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-mpp-rhc pay
 */
export type Signer = ReturnType<typeof privateKeyToAccount>;

export type Paid = {
  readonly status: number;
  readonly body: unknown;
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
  readonly explorer: string;
};

export async function pay(signer: Signer, url: string): Promise<Paid> {
  const fetchWithPayment = Fetch.from({ methods: [usdgPayer({ account: signer, maxAmount: '1.00' })] });
  const response = await fetchWithPayment(url);
  const body: unknown = await response.clone().json().catch(() => null);
  const receipt = Receipt.fromResponse(response);
  return {
    status: response.status,
    body,
    transaction: receipt.reference,
    network: NETWORK,
    payer: signer.address,
    explorer: `${EXPLORER}/tx/${receipt.reference}`,
  };
}

function startedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  const key = process.env['EVM_PRIVATE_KEY'];
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('EVM_PRIVATE_KEY must be the payer key, as 0x followed by 64 hex characters. It needs USDG on Robinhood Chain and no ETH.');
    process.exit(1);
  }
  const url = process.env['RESOURCE_URL'] ?? 'http://127.0.0.1:4022/quote';
  const paid = await pay(privateKeyToAccount(key as `0x${string}`), url);
  console.log(JSON.stringify(paid, null, 2));
}
