/**
 * Earnings on Base, end to end, on forks of both chains, with the facilitator in this process.
 *
 *   npx tsx scripts/base-earn-rig.ts
 *
 * Forks Base and Robinhood Chain, gives a fresh float key ETH on both and USDG on Robinhood Chain, and
 * a fresh buyer key USDC on Base. Then two sellers sell to that buyer: the example server in
 * examples/base-earn on the reference x402 stack, and a server written against `baseEarnings` alone.
 * The buyer is the example's own `pay` script, the reference client with a plain key. Each sale has to
 * land as an `Earned` event on the demo endowment from the float, and a replayed payment header has to
 * be refused. No key here exists anywhere but this run; nothing touches either chain itself.
 *
 * Robinhood Chain forks with Foundry 1.5.0 (anvil 1.8 cannot run calls on an Orbit fork): ANVIL_RHC
 * names that binary. DATABASE_URL names a server this run may drop and recreate its own database on.
 * Writes what happened to BURSAR_RIG_OUT (default /tmp/base-earn-rig/local.json).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_MAINNET, RHC_MAINNET, baseViemChain, endowmentAbi, settlementAssetAbi, viemChain } from '@bursar/core';
import { baseEarnings } from '@bursar/x402';
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbiItem } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createPostgres } from '../src/db/postgres.js';
import { compose } from '../src/main.js';

const ENDOWMENT: Address = '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';
const OUT = process.env['BURSAR_RIG_OUT'] ?? join('/tmp', 'base-earn-rig', 'local.json');
const BASE_FORK_URL = process.env['BASE_FORK_URL'] ?? 'https://mainnet.base.org';
const RHC_FORK_URL = process.env['RHC_FORK_URL'] ?? RHC_MAINNET.rpcUrl;
const BASE_PORT = 9441;
const RHC_PORT = 9442;
const FACILITATOR_PORT = 9443;
const EXAMPLE_PORT = 9444;
const PLAIN_PORT = 9445;
const EXAMPLE_DIR = fileURLToPath(new URL('../../../examples/base-earn/', import.meta.url));
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const EARNED = parseAbiItem('event Earned(address indexed from, uint256 amount, uint256 toPrincipal, uint256 toAgent)');

const log: Record<string, unknown> = {};
const children: ChildProcess[] = [];
const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const record = (key: string, value: unknown) => {
  log[key] = value;
  console.log(`${key}: ${json(value)}`);
};
const save = () => {
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(JSON.parse(json(log)), null, 2));
};

async function anvil(port: number, forkUrl: string, chainId: number): Promise<string> {
  const binary = chainId === 4663 ? (process.env['ANVIL_RHC'] ?? 'anvil') : 'anvil';
  const child = spawn(binary, ['--port', String(port), '--fork-url', forkUrl, '--chain-id', String(chainId), '--block-time', '1', '--silent', '--no-rate-limit', '--retries', '5', '--timeout', '45000'], { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const chain = await rpc(url, 'eth_chainId', []);
      if (Number(chain) === chainId) return url;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`anvil on ${port} did not come up`);
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Moves `amount` of `token` to `to` on a fork, from a recent recipient that holds enough and has no
 * code. Recipients are read from `logsUrl`, the chain itself, because a fork forwards `eth_getLogs`
 * for earlier blocks to an endpoint that may not serve it; balances and the transfer are the fork's.
 */
async function lend(url: string, logsUrl: string, chain: Parameters<typeof createPublicClient>[0]['chain'], token: Address, to: Address, amount: bigint, span: bigint): Promise<Address> {
  const client = createPublicClient({ chain, transport: http(url) });
  const upstream = createPublicClient({ chain, transport: http(logsUrl) });
  const info = (await rpc(url, 'anvil_nodeInfo', [])) as { forkConfig?: { forkBlockNumber?: number } };
  const head = BigInt(info.forkConfig?.forkBlockNumber ?? (await client.getBlockNumber()));
  for (let window = 0n; window < 30n; window += 1n) {
    const toBlock = head - window * span;
    const logs = await upstream.getLogs({ address: token, event: TRANSFER, fromBlock: toBlock - span + 1n, toBlock }).catch(() => []);
    const holders = [...new Set(logs.map((entry) => entry.args.to as Address))].slice(0, 25);
    for (const holder of holders) {
      const [balance, code] = await Promise.all([
        client.readContract({ address: token, abi: settlementAssetAbi, functionName: 'balanceOf', args: [holder] }),
        client.getCode({ address: holder }),
      ]);
      if (balance < amount || (code !== undefined && code !== '0x')) continue;
      await rpc(url, 'anvil_impersonateAccount', [holder]);
      await rpc(url, 'anvil_setBalance', [holder, '0x1000000000000000000']);
      const hash = (await rpc(url, 'eth_sendTransaction', [{ from: holder, to: token, data: `0xa9059cbb${to.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` }])) as Hex;
      await client.waitForTransactionReceipt({ hash });
      await rpc(url, 'anvil_stopImpersonatingAccount', [holder]);
      return holder;
    }
  }
  throw new Error(`no recent holder of ${token} on the fork holds ${amount}`);
}

/** USDC keeps balances in slot 9 (`balanceAndBlacklistStates` since 2.2, the low 255 bits), so a fork can simply be told one. */
async function mintUsdc(url: string, to: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, 9n]));
  await rpc(url, 'anvil_setStorageAt', [BASE_MAINNET.usdc, slot, `0x${amount.toString(16).padStart(64, '0')}`]);
}

async function freshDatabase(url: string): Promise<string> {
  const target = new URL(url);
  const name = target.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`DATABASE_URL names ${name}, which is not a name this rig will drop and recreate`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const db = createPostgres({ url: admin.toString() });
  try {
    await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await db.query(`CREATE DATABASE ${name}`);
  } finally {
    await db.close();
  }
  return url;
}

/** Runs a script of the example with its own dependencies, and hands back what it printed. */
function example(script: 'server' | 'pay', env: Record<string, string>): { child: ChildProcess; output: Promise<string>; ready: Promise<void> } {
  const child = spawn('pnpm', ['exec', 'tsx', `${script}.ts`], { cwd: EXAMPLE_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  let text = '';
  let signal: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (signal = resolve));
  child.stdout?.on('data', (chunk: Buffer) => {
    text += chunk.toString();
    if (text.includes('selling')) signal();
  });
  const output = new Promise<string>((resolve) => child.on('exit', () => resolve(text)));
  return { child, output, ready };
}

/** A seller written against `baseEarnings` alone: a 402 from the terms, a settle before it serves. */
function plainSeller(facilitator: string, payTo: Address) {
  const earnings = baseEarnings({ endowment: ENDOWMENT, price: '0.02', facilitator, payTo });
  const headers: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const header = request.headers['payment-signature'];
      if (typeof header !== 'string') {
        const required = earnings.paymentRequired({ resource: { url: `http://127.0.0.1:${PLAIN_PORT}/note`, description: 'One note', mimeType: 'application/json' } });
        response.writeHead(402, { 'content-type': 'application/json', ...required.headers });
        response.end(JSON.stringify(required.body));
        return;
      }
      headers.push(header);
      const settled = await earnings.settle(header);
      const answer = Buffer.from(JSON.stringify({ success: settled.success, transaction: settled.transaction, network: settled.network, payer: settled.payer, ...(settled.errorReason ? { errorReason: settled.errorReason } : {}) })).toString('base64');
      response.writeHead(settled.success ? 200 : 402, { 'content-type': 'application/json', 'payment-response': answer });
      response.end(JSON.stringify(settled.success ? { note: 'paid through baseEarnings', credit: settled.credit } : { error: settled.errorReason, detail: settled.detail }));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  return { server, earnings, headers };
}

async function main(): Promise<void> {
  const floatKey = generatePrivateKey();
  const buyerKey = generatePrivateKey();
  const float = privateKeyToAccount(floatKey).address;
  const buyer = privateKeyToAccount(buyerKey).address;
  record('keys', { float, buyer, note: 'fresh for this run' });

  const [baseUrl, rhcUrl] = await Promise.all([anvil(BASE_PORT, BASE_FORK_URL, 8453), anvil(RHC_PORT, RHC_FORK_URL, 4663)]);
  record('forks', { base: { url: baseUrl, from: new URL(BASE_FORK_URL).host }, rhc: { url: rhcUrl, from: new URL(RHC_FORK_URL).host } });

  const base = createPublicClient({ chain: baseViemChain(baseUrl), transport: http(baseUrl) });
  const rhc = createPublicClient({ chain: viemChain({ ...RHC_MAINNET, rpcUrl: rhcUrl }), transport: http(rhcUrl) });
  await rpc(baseUrl, 'anvil_setBalance', [float, '0x2386F26FC10000']);
  await rpc(rhcUrl, 'anvil_setBalance', [float, '0x2386F26FC10000']);
  const usdc = (who: Address) => base.readContract({ address: BASE_MAINNET.usdc, abi: settlementAssetAbi, functionName: 'balanceOf', args: [who] });
  await mintUsdc(baseUrl, buyer, 1_000_000n);
  if ((await usdc(buyer)) !== 1_000_000n) throw new Error('USDC on the Base fork did not take the balance written to slot 9');
  const usdgFrom = await lend(rhcUrl, RHC_FORK_URL, viemChain({ ...RHC_MAINNET, rpcUrl: rhcUrl }), RHC_MAINNET.usdg, float, 2_000_000n, 300n);
  const usdg = (who: Address) => rhc.readContract({ address: RHC_MAINNET.usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [who] });
  const endowment = async () => {
    const [earned, earnedToPrincipal, accepted, mandate] = await Promise.all([
      rhc.readContract({ address: ENDOWMENT, abi: endowmentAbi, functionName: 'earned' }),
      rhc.readContract({ address: ENDOWMENT, abi: endowmentAbi, functionName: 'earnedToPrincipal' }),
      rhc.readContract({ address: ENDOWMENT, abi: endowmentAbi, functionName: 'accepted' }),
      rhc.readContract({ address: ENDOWMENT, abi: endowmentAbi, functionName: 'mandate' }),
    ]);
    return { earned, earnedToPrincipal, accepted, mandate, mandateUsdg: await usdg(mandate as Address) };
  };
  const startBlock = await rhc.getBlockNumber();
  record('funded', { buyerUsdcOnBase: await usdc(buyer), floatUsdgOnRhc: await usdg(float), usdgLentBy: usdgFrom });
  record('endowment before', await endowment());

  const relayer = generatePrivateKey();
  const other = () => privateKeyToAccount(generatePrivateKey()).address;
  const database = await freshDatabase(process.env['DATABASE_URL'] ?? 'postgres://localhost/bursar_base_earn_rig');
  const composed = await compose({
    DATABASE_URL: database,
    FACILITATOR_MIGRATE: 'on-start',
    RHC_NETWORK: 'mainnet',
    RHC_RPC_PRIMARY: rhcUrl,
    RHC_RPC_FALLBACK: `http://localhost:${RHC_PORT}`,
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: String(FACILITATOR_PORT),
    FACILITATOR_RELAYER_KEY: relayer,
    FACILITATOR_GAS_FLOAT: privateKeyToAccount(relayer).address,
    FACILITATOR_SETTLEMENT: other(),
    FACILITATOR_COLLATERAL: other(),
    FACILITATOR_TREASURY: other(),
    FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.0001',
    FACILITATOR_FEE_BPS: '100',
    FACILITATOR_FEE_FLOOR_MICRO: '1900',
    FACILITATOR_UNDERWRITER: 'none',
    FACILITATOR_BASE_KEY: floatKey,
    FACILITATOR_BASE_RPC_URL: baseUrl,
    FACILITATOR_BASE_FEE_BPS: '100',
    FACILITATOR_BASE_FEE_FLOOR_MICRO: '2000',
    FACILITATOR_BASE_FLOAT_MINIMUM_MICRO: '1000000',
    FACILITATOR_BASE_MAX_PAYMENT_MICRO: '5000000',
    FACILITATOR_BASE_EARN: 'true',
  });
  await composed.service.start();
  const facilitator = `http://127.0.0.1:${FACILITATOR_PORT}`;
  const earn = `${facilitator}/base/earn`;
  record('facilitator', { supported: await (await fetch(`${earn}/supported`)).json() });

  // The reference stack: the example server, paid by the example buyer.
  const seller = example('server', { PORT: String(EXAMPLE_PORT), FACILITATOR_URL: earn, PAY_TO: float });
  await seller.ready;
  const first = example('pay', { EVM_PRIVATE_KEY: buyerKey, RESOURCE_URL: `http://127.0.0.1:${EXAMPLE_PORT}/note`, FACILITATOR_URL: earn });
  record('reference seller, reference buyer', await first.output);

  // The helper alone: a 402 and a settle from `baseEarnings`, paid by the same buyer.
  const plain = plainSeller(earn, float);
  await new Promise<void>((resolve) => plain.server.listen(PLAIN_PORT, '127.0.0.1', resolve));
  const second = example('pay', { EVM_PRIVATE_KEY: buyerKey, RESOURCE_URL: `http://127.0.0.1:${PLAIN_PORT}/note`, FACILITATOR_URL: earn });
  record('baseEarnings seller, reference buyer', await second.output);

  const replay = plain.headers[0] ? await plain.earnings.settle(plain.headers[0]) : null;
  record('the same header settled again', replay);

  await composed.service.earn?.idle();
  const events = await rhc.getLogs({ address: ENDOWMENT, event: EARNED, args: { from: float }, fromBlock: startBlock, toBlock: 'latest' });
  record('earned from the float on robinhood chain', events.map((event) => ({ ...event.args, tx: event.transactionHash, block: event.blockNumber })));
  record('endowment after', await endowment());
  record('balances after', { buyerUsdcOnBase: await usdc(buyer), floatUsdcOnBase: await usdc(float), floatUsdgOnRhc: await usdg(float) });
  record('float', await (await fetch(`${facilitator}/base/float`)).json().catch(() => null));
  record('earn status', await composed.service.earn?.status());

  const ok = events.length === 2 && replay?.success === false && String(replay.errorReason) === 'payment_already_used';
  record('verdict', ok ? 'two sales on Base, two credits to the endowment, the replay refused' : 'FAILED');
  if (!ok) process.exitCode = 1;

  if (process.env['BURSAR_RIG_HOLD']) {
    // Kept up for a look from the console: NEXT_PUBLIC_RHC_RPC_PRIMARY at the Robinhood Chain fork.
    console.log(`holding: Robinhood Chain fork at ${rhcUrl}, Base fork at ${baseUrl}, facilitator at ${facilitator}; stop with Ctrl-C`);
    await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  }
  seller.child.kill('SIGTERM');
  plain.server.close();
  await composed.stop();
}

main()
  .catch((error: unknown) => {
    record('failed', error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    save();
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
