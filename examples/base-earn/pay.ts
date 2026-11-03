import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_EARNINGS } from '@bursar/x402';

/**
 * A buyer on Base paying the seller in server.ts, with the reference x402 client and a plain key.
 *
 * Nothing here knows about endowments or Robinhood Chain: the seller's 402 asks for USDC on Base,
 * and the client signs it like any other payment. After it is paid, the script asks the facilitator
 * where the sale stands and prints the endowment's credit on Robinhood Chain once it lands.
 *
 *   EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-base-earn pay
 */
export type Signer = { readonly address: `0x${string}`; signTypedData: ReturnType<typeof privateKeyToAccount>['signTypedData'] };

export type Paid = {
  readonly status: number;
  readonly body: unknown;
  readonly transaction: string;
  readonly payer: string;
  readonly basescan: string;
};

export type Credited = {
  readonly status: string;
  readonly endowment: string;
  readonly creditMicro: string;
  readonly feeMicro: string;
  readonly creditTransaction: string | null;
  readonly blockscout: string | null;
};

export async function pay(signer: Signer, url: string): Promise<Paid> {
  const client = new x402Client().register('eip155:*', new ExactEvmScheme(signer));
  const response = await wrapFetchWithPayment(fetch, client)(url);
  const body: unknown = await response.clone().json().catch(() => null);
  if (response.status !== 200) return { status: response.status, body, transaction: '', payer: signer.address, basescan: '' };
  const settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => response.headers.get(name));
  return {
    status: response.status,
    body,
    transaction: settled.transaction,
    payer: settled.payer ?? signer.address,
    basescan: `https://basescan.org/tx/${settled.transaction}`,
  };
}

/** Polls the facilitator for the sale the Base transaction paid until the endowment is credited. */
export async function credited(facilitator: string, transaction: string, timeoutMs = 120_000): Promise<Credited | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Credited | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${facilitator.replace(/\/+$/, '')}/earnings/${transaction}`).catch(() => null);
    if (response?.ok) {
      const sale = (await response.json()) as Omit<Credited, 'blockscout'>;
      last = { ...sale, blockscout: sale.creditTransaction ? `https://robinhoodchain.blockscout.com/tx/${sale.creditTransaction}` : null };
      if (sale.status === 'credited') return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
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
    console.error('EVM_PRIVATE_KEY must be the buyer key, as 0x followed by 64 hex characters. It needs USDC on Base and no ETH.');
    process.exit(1);
  }
  const url = process.env['RESOURCE_URL'] ?? 'http://127.0.0.1:4022/note';
  const paid = await pay(privateKeyToAccount(key as `0x${string}`), url);
  console.log(JSON.stringify(paid, null, 2));
  if (paid.transaction !== '') {
    const sale = await credited(process.env['FACILITATOR_URL'] ?? BASE_EARNINGS.facilitator, paid.transaction);
    console.log(JSON.stringify({ endowment: sale }, null, 2));
  }
}
