import { BASE_MAINNET, baseViemChain, endowmentAbi, endowmentFactoryAbi, escrowAbi, settlementAssetAbi, tokenVersionAbi, viemChain } from '@bursar/core';
import type { RhcChain } from '@bursar/core';
import { SettlementNotSentError, createPaymentChain, readControl, resolveAsset } from '@bursar/x402';
import type { AssetMeta, PaymentChain } from '@bursar/x402';
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  domainSeparator,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
} from 'viem';
import type { Address, Hex, TypedDataDomain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { BaseFloat, BaseIntake, EndowmentCredit, LockWriter, TransferAuthorization } from './ports.js';

/**
 * The two chains behind the lane's ports. No decisions here: this file reads what it is asked to
 * read, signs what it is handed and sends what it is given. The key arrives as an account and the
 * lane never sees it.
 */

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const AUTHORIZATION_USED = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)');

/** How far back one log read may reach. Base makes a block every two seconds. */
const LOG_WINDOW_BLOCKS = 5_000n;

export type BaseFloatOptions = {
  readonly key: Hex;
  readonly rpcUrl?: string;
  readonly asset?: Address;
};

export function createBaseFloat(options: BaseFloatOptions): BaseFloat {
  const account = privateKeyToAccount(options.key);
  const asset = options.asset ?? BASE_MAINNET.usdc;
  const client = createPublicClient({ chain: baseViemChain(options.rpcUrl), transport: http(options.rpcUrl ?? BASE_MAINNET.rpcUrl) });
  let domain: Promise<TypedDataDomain> | null = null;

  /**
   * The token's EIP-712 domain, read from the token and proved against its separator. USDC on Base
   * reports name "USD Coin" and version "2"; the published x402 example carries the testnet token's
   * name, and a domain one character off signs a well-formed authorization against nothing.
   */
  const readDomain = async (): Promise<TypedDataDomain> => {
    const [name, version, separator] = await Promise.all([
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'name' }),
      client.readContract({ address: asset, abi: tokenVersionAbi, functionName: 'version' }),
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'DOMAIN_SEPARATOR' }),
    ]);
    const candidate: TypedDataDomain = { name, version, chainId: BASE_MAINNET.chainId, verifyingContract: asset };
    if (domainSeparator({ domain: candidate }).toLowerCase() !== separator.toLowerCase()) {
      throw new Error(`USDC at ${asset} reports name ${JSON.stringify(name)} and version ${JSON.stringify(version)}, and its DOMAIN_SEPARATOR is not the one those produce`);
    }
    return candidate;
  };

  return {
    network: BASE_MAINNET.network,
    asset,
    address: account.address,
    balance: () => client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'balanceOf', args: [account.address] }),
    blockNumber: () => client.getBlockNumber(),
    authorizationUsed: (nonce) =>
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'authorizationState', args: [account.address, nonce] }),
    async authorizationTransaction(nonce, fromBlock) {
      const head = await client.getBlockNumber();
      const start = head - fromBlock > LOG_WINDOW_BLOCKS ? head - LOG_WINDOW_BLOCKS : fromBlock;
      const logs = await client.getLogs({ address: asset, event: AUTHORIZATION_USED, args: { authorizer: account.address, nonce }, fromBlock: start, toBlock: head });
      return logs[0]?.transactionHash ?? null;
    },
    async signAuthorization(authorization: TransferAuthorization) {
      domain ??= readDomain().catch((error: unknown) => {
        domain = null;
        throw error;
      });
      return account.signTypedData({
        domain: await domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: { ...authorization },
      });
    },
  };
}

/** Runs one piece of work at a time, in the order asked: one key's transactions, one nonce at a time. */
export type Serial = <T>(work: () => Promise<T>) => Promise<T>;

export function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

export type LockWriterOptions = {
  readonly key: Hex;
  readonly chain: RhcChain;
  readonly rpcUrl: string;
  readonly receiptTimeoutMs?: number;
  /** Shared with every other writer for the same key, so two sends never take the same nonce. */
  readonly queue?: Serial;
};

/** The float's address as a payee on Robinhood Chain: it releases and cancels its own locks. */
export function createLockWriter(options: LockWriterOptions): LockWriter {
  const account = privateKeyToAccount(options.key);
  const chain = viemChain(options.chain);
  const transport = http(options.rpcUrl);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const queue = options.queue ?? serial();

  const send = (functionName: 'release' | 'cancel', escrow: Address, args: readonly unknown[]): Promise<Hex> => queue(async () => {
    const fees = await client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas > options.chain.minFeeCap ? fees.maxFeePerGas : options.chain.minFeeCap;
    const hash = await wallet.writeContract({
      address: escrow,
      abi: escrowAbi,
      functionName,
      args: args as never,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: options.receiptTimeoutMs ?? 60_000 });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  });

  return {
    release: (escrow, id, outputCommit, outputURI) => send('release', escrow, [id, outputCommit, outputURI]),
    cancel: (escrow, id) => send('cancel', escrow, [id]),
  };
}

export function floatAddress(key: Hex): Address {
  return privateKeyToAccount(key).address;
}

const USDC_CONTROLS = parseAbi(['function paused() view returns (bool)', 'function isBlacklisted(address) view returns (bool)']);

/** Gas one `transferWithAuthorization` is allowed: about 75,000 is typical on USDC, with room. */
const SETTLE_GAS = 150_000n;
const RECEIPT_POLL_MS = 1_000;

export type BaseIntakeOptions = {
  readonly key: Hex;
  readonly rpcUrl?: string;
  readonly asset?: Address;
};

/**
 * Base for earnings: the buyer's authorization checked against USDC and sent from the float.
 *
 * The checks are the reference `exact` checks this repo runs for USDG, over a Base client. One
 * difference is USDC's own: its issuer stops an address with `isBlacklisted`, where USDG's freezes
 * it with `isFrozen`, so that is the control read for each party.
 */
export function createBaseIntake(options: BaseIntakeOptions): BaseIntake {
  const account = privateKeyToAccount(options.key);
  const asset = options.asset ?? BASE_MAINNET.usdc;
  const chain = baseViemChain(options.rpcUrl);
  const transport = http(options.rpcUrl ?? BASE_MAINNET.rpcUrl);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const queue = serial();

  const payments: PaymentChain = {
    ...createPaymentChain(client),
    async issuerControls(token, parties) {
      const [paused, ...blocked] = await Promise.all([
        readControl(() => client.readContract({ address: token, abi: USDC_CONTROLS, functionName: 'paused' })),
        ...parties.map((address) => readControl(() => client.readContract({ address: token, abi: USDC_CONTROLS, functionName: 'isBlacklisted', args: [address] }))),
      ]);
      const missing = { state: 'unreadable', detail: 'the read came back short one answer' } as const;
      return { asset: token, paused: paused ?? missing, parties: parties.map((address, index) => ({ address, frozen: blocked[index] ?? missing })) };
    },
  };
  let token: Promise<AssetMeta> | null = null;

  return {
    network: BASE_MAINNET.network,
    asset,
    address: account.address,
    chain: payments,
    token() {
      token ??= resolveAsset(payments, asset).catch((error: unknown) => {
        token = null;
        throw error;
      });
      return token;
    },
    async gas() {
      const [balanceWei, fees] = await Promise.all([client.getBalance({ address: account.address }), client.estimateFeesPerGas()]);
      return { balanceWei, neededWei: SETTLE_GAS * fees.maxFeePerGas };
    },
    blockNumber: () => client.getBlockNumber(),
    // One at a time, so each send reads a nonce the one before it has already taken.
    send: (call) =>
      queue(async () => {
        let raw: Hex;
        try {
          const request = await wallet.prepareTransactionRequest({ account, chain, to: call.to, data: call.data, gas: SETTLE_GAS });
          raw = await wallet.signTransaction(request);
        } catch (error) {
          throw new SettlementNotSentError(`the transfer could not be prepared: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        return client.sendRawTransaction({ serializedTransaction: raw });
      }),
    // Public Base hosts answer a receipt they have not indexed yet with an error rather than null,
    // and viem's waiter takes that error as final. Any miss here means "not yet" until the deadline.
    async wait(hash, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
        if (receipt) return { status: receipt.status, blockNumber: receipt.blockNumber };
        if (Date.now() + RECEIPT_POLL_MS > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
      }
    },
    authorizationUsed: (payer, nonce) =>
      client.readContract({ address: asset, abi: settlementAssetAbi, functionName: 'authorizationState', args: [payer, nonce] }),
    async authorizationTransaction(payer, nonce, fromBlock) {
      const head = await client.getBlockNumber();
      const start = head - fromBlock > LOG_WINDOW_BLOCKS ? head - LOG_WINDOW_BLOCKS : fromBlock;
      const logs = await client.getLogs({ address: asset, event: AUTHORIZATION_USED, args: { authorizer: payer, nonce }, fromBlock: start, toBlock: head });
      return logs[0]?.transactionHash ?? null;
    },
  };
}

export type EndowmentCreditOptions = {
  readonly key: Hex;
  readonly chain: RhcChain;
  readonly rpcUrl: string;
  /** Every endowment factory whose endowments may be paid. */
  readonly factories: readonly Address[];
  readonly queue: Serial;
  readonly receiptTimeoutMs?: number;
};

/** The float on Robinhood Chain as the payer of endowments: reads, one approval, and `earn`. */
export function createEndowmentCredit(options: EndowmentCreditOptions): EndowmentCredit {
  const account = privateKeyToAccount(options.key);
  const chain = viemChain(options.chain);
  const transport = http(options.rpcUrl);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const usdg = options.chain.usdg;

  const fees = async () => {
    const estimate = await client.estimateFeesPerGas();
    return {
      maxFeePerGas: estimate.maxFeePerGas > options.chain.minFeeCap ? estimate.maxFeePerGas : options.chain.minFeeCap,
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
    };
  };
  const receipt = async (hash: Hex) => {
    try {
      return (await client.getTransactionReceipt({ hash })).status;
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  };

  return {
    chainId: options.chain.chainId,
    address: account.address,
    async isEndowment(endowment) {
      const answers = await Promise.all(
        options.factories.map((factory) => client.readContract({ address: factory, abi: endowmentFactoryAbi, functionName: 'isEndowment', args: [endowment] })),
      );
      return answers.some(Boolean);
    },
    balance: () => client.readContract({ address: usdg, abi: settlementAssetAbi, functionName: 'balanceOf', args: [account.address] }),
    allowance: (endowment) => client.readContract({ address: usdg, abi: settlementAssetAbi, functionName: 'allowance', args: [account.address, endowment] }),
    async approve(endowment, amount) {
      const hash = await wallet.writeContract({ address: usdg, abi: settlementAssetAbi, functionName: 'approve', args: [endowment, amount], ...(await fees()) });
      const landed = await client.waitForTransactionReceipt({ hash, timeout: options.receiptTimeoutMs ?? 60_000 });
      if (landed.status !== 'success') throw new Error(`approve reverted in ${hash}`);
      return hash;
    },
    async simulate(endowment, amount) {
      await client.simulateContract({ account, address: endowment, abi: endowmentAbi, functionName: 'earn', args: [amount] });
    },
    async prepare(endowment, amount) {
      const data = encodeFunctionData({ abi: endowmentAbi, functionName: 'earn', args: [amount] });
      const [nonce, gas, price] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        client.estimateGas({ account, to: endowment, data }),
        fees(),
      ]);
      // Room over the estimate: the endowment's `earn` can deposit into a mandate, whose cost moves.
      const raw = await account.signTransaction({ type: 'eip1559', chainId: options.chain.chainId, to: endowment, data, nonce, gas: (gas * 3n) / 2n, ...price });
      return { hash: keccak256(raw), nonce, raw };
    },
    async broadcast(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (error) {
        const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (text.includes('already known') || text.includes('known transaction') || text.includes('nonce too low')) return;
        throw error;
      }
    },
    receipt,
    async wait(hash, timeoutMs) {
      try {
        return (await client.waitForTransactionReceipt({ hash, timeout: timeoutMs })).status;
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return null;
        throw error;
      }
    },
    minedNonce: () => client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    exclusive: options.queue,
  };
}
