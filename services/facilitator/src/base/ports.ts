import type { Micro } from '@bursar/core';
import type { AssetMeta, PaymentChain, SettlementCall } from '@bursar/x402';
import type { Address, Hex } from 'viem';

/**
 * What the Base lane needs from the two chains and the key, and nothing more.
 *
 * The float's key signs authorizations on Base and releases or cancels locks on Robinhood Chain,
 * and it is held by whatever implements these two ports. The lane itself never sees it, which is
 * what keeps every decision here testable with a double.
 */

export type TransferAuthorization = {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
};

export type BaseFloat = {
  readonly network: string;
  readonly asset: Address;
  readonly address: Address;
  /** The float's USDC balance, in the token's own atomic units. */
  balance(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Whether USDC reports the authorization spent. The one fact that decides a settlement. */
  authorizationUsed(nonce: Hex): Promise<boolean>;
  /** The transaction that spent it, when the logs from `fromBlock` can be read. Null is not "unused". */
  authorizationTransaction(nonce: Hex, fromBlock: bigint): Promise<Hex | null>;
  /** Signs on the token's EIP-712 domain, read from the token and proved against its separator. */
  signAuthorization(authorization: TransferAuthorization): Promise<Hex>;
};

/** The payee's two moves on a lock, sent from the float's address on Robinhood Chain. */
export type LockWriter = {
  release(escrow: Address, id: bigint, outputCommit: Hex, outputURI: string): Promise<Hex>;
  cancel(escrow: Address, id: bigint): Promise<Hex>;
};

export type BasePaymentStatus = 'signed' | 'paid' | 'settled' | 'returned';

export type BasePayment = {
  readonly id: string;
  readonly chainId: number;
  readonly escrow: Address;
  readonly lockId: bigint;
  readonly lockTransaction: Hex;
  readonly mandate: Address;
  readonly float: Address;
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly resource: string;
  /** USDC paid to the service. */
  readonly amountMicro: Micro;
  /** USDG the mandate locked. */
  readonly lockMicro: Micro;
  readonly feeMicro: Micro;
  readonly nonce: Hex;
  readonly validBefore: bigint;
  readonly deadline: bigint;
  readonly signedBlock: bigint;
  readonly status: BasePaymentStatus;
  readonly reportedTransaction: Hex | null;
  readonly baseTransaction: Hex | null;
  readonly rhcTransaction: Hex | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
};

export type OpenPaymentInput = Omit<
  BasePayment,
  'id' | 'status' | 'reportedTransaction' | 'baseTransaction' | 'rhcTransaction' | 'createdAt' | 'closedAt'
>;

export type OpenResult =
  | { readonly opened: true; readonly payment: BasePayment }
  | { readonly opened: false; readonly reason: 'replay' | 'float'; readonly availableMicro: Micro };

export type BaseLedger = {
  /**
   * Writes the row for a signed authorization, or refuses without writing.
   *
   * The float check and the insert happen under one lock per float, so two pays racing for the last
   * of the float cannot both be promised it. `balance` is what the chain reported a moment ago.
   */
  open(input: OpenPaymentInput, float: { readonly balance: bigint; readonly minimumMicro: Micro }): Promise<OpenResult>;
  promised(float: Address): Promise<Micro>;
  find(id: string): Promise<BasePayment | null>;
  findLock(chainId: number, escrow: Address, lockId: bigint): Promise<BasePayment | null>;
  /** Open rows, least recently touched first, so a row that keeps failing cannot hold the head. */
  listOpen(limit: number): Promise<BasePayment[]>;
  /** Sends a row the pass could not finish to the back of the queue. */
  defer(id: string): Promise<void>;
  listMandate(mandate: Address, limit: number): Promise<BasePayment[]>;
  report(id: string, transaction: Hex): Promise<void>;
  markPaid(id: string, baseTransaction: Hex | null): Promise<void>;
  close(id: string, status: 'settled' | 'returned', rhcTransaction: Hex): Promise<void>;
  /** Rows still open past their lock's deadline: money the lane can no longer settle on its own. */
  countStuck(nowSeconds: bigint): Promise<number>;
};

/**
 * Earnings: the lane run the other way. A buyer on Base pays USDC to the float with a standard
 * `exact` authorization, and the float pays an endowment on Robinhood Chain the same amount, less
 * the fee, in USDG. The three ports below are Base, Robinhood Chain and the ledger between them.
 */

/** Base as the earnings side reads and writes it: the buyer's authorization, settled from the float. */
export type BaseIntake = {
  readonly network: string;
  readonly asset: Address;
  readonly address: Address;
  /** The chain behind the standard EIP-3009 checks, with USDC's own issuer controls. */
  readonly chain: PaymentChain;
  /** USDC's domain and transfer paths, read from the token and proved against its separator. */
  token(): Promise<AssetMeta>;
  /** The float's ETH on Base, and what one settlement could cost at the current price. */
  gas(): Promise<{ readonly balanceWei: bigint; readonly neededWei: bigint }>;
  blockNumber(): Promise<bigint>;
  /**
   * Signs and broadcasts from the float. Throws `SettlementNotSentError` when nothing reached a
   * node; any other throw may have broadcast.
   */
  send(call: SettlementCall): Promise<Hex>;
  /** The receipt, or null when none arrived within the wait. */
  wait(hash: Hex, timeoutMs: number): Promise<{ readonly status: 'success' | 'reverted'; readonly blockNumber: bigint } | null>;
  authorizationUsed(payer: Address, nonce: Hex): Promise<boolean>;
  /** The transaction that spent it, when the logs from `fromBlock` can be read. Null is not "unused". */
  authorizationTransaction(payer: Address, nonce: Hex, fromBlock: bigint): Promise<Hex | null>;
};

/** A transaction signed before it is sent, so its hash can be written down first. */
export type PreparedTransaction = {
  readonly hash: Hex;
  readonly nonce: number;
  readonly raw: Hex;
};

/** Robinhood Chain as the earnings side sees it: the float's USDG and the endowments it pays. */
export type EndowmentCredit = {
  readonly chainId: number;
  readonly address: Address;
  /** Whether one of Bursar's endowment factories created this address. */
  isEndowment(endowment: Address): Promise<boolean>;
  /** The float's USDG. */
  balance(): Promise<bigint>;
  allowance(endowment: Address): Promise<bigint>;
  /** Sends `approve` and waits for it. Throws when it does not land. */
  approve(endowment: Address, amount: bigint): Promise<Hex>;
  /** `earn(amount)` from the float as a call. Throws when it would revert. */
  simulate(endowment: Address, amount: bigint): Promise<void>;
  /** `earn(amount)` signed at the float's next nonce, not yet sent. */
  prepare(endowment: Address, amount: bigint): Promise<PreparedTransaction>;
  /** Sends a prepared transaction. A node that already holds it is not an error. */
  broadcast(raw: Hex): Promise<void>;
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
  wait(hash: Hex, timeoutMs: number): Promise<'success' | 'reverted' | null>;
  /** How many of the float's transactions have been mined. */
  minedNonce(): Promise<number>;
  /** Runs `work` alone among the float's writes on Robinhood Chain, lock releases included. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
};

/**
 * `pending` is a reservation: the checks passed and the Base transfer is being sent. `received`
 * means USDC reports the authorization spent, so the endowment is owed. `crediting` means a signed
 * `earn` is out under a recorded hash. `credited` is final. `failed` means the authorization never
 * moved anything and the reservation is released.
 */
export type EarningStatus = 'pending' | 'received' | 'crediting' | 'credited' | 'failed';

export type Earning = {
  readonly id: string;
  readonly network: string;
  readonly asset: Address;
  readonly float: Address;
  readonly payer: Address;
  readonly nonce: Hex;
  readonly chainId: number;
  readonly endowment: Address;
  readonly resource: string;
  /** USDC the buyer paid. */
  readonly amountMicro: Micro;
  readonly feeMicro: Micro;
  /** USDG the endowment is paid. */
  readonly creditMicro: Micro;
  readonly validBefore: bigint;
  readonly baseBlock: bigint;
  readonly status: EarningStatus;
  readonly baseTransaction: Hex | null;
  readonly creditTransaction: Hex | null;
  readonly creditNonce: number | null;
  readonly creditRaw: Hex | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly receivedAt: Date | null;
  readonly creditedAt: Date | null;
};

export type ReserveInput = Pick<
  Earning,
  'network' | 'asset' | 'float' | 'payer' | 'nonce' | 'chainId' | 'endowment' | 'resource' | 'amountMicro' | 'feeMicro' | 'creditMicro' | 'validBefore' | 'baseBlock'
>;

export type ReserveResult =
  | { readonly reserved: true; readonly earning: Earning }
  | { readonly reserved: false; readonly reason: 'replay'; readonly earning: Earning }
  | { readonly reserved: false; readonly reason: 'float'; readonly availableMicro: Micro };

export type EarningTotals = {
  readonly credited: number;
  readonly creditedMicro: Micro;
  readonly feesMicro: Micro;
  /** Received on Base and not yet paid into the endowment. */
  readonly owed: number;
  readonly owedMicro: Micro;
  /** Owed for longer than the lane should take. */
  readonly late: number;
  readonly pending: number;
};

export type EarnLedger = {
  /**
   * Writes the reservation, or refuses without writing.
   *
   * The float check and the insert run under one lock per float, so two sales racing for the last
   * of the float's USDG cannot both be promised it. An authorization already on the ledger is a
   * replay; one whose earlier attempt failed is taken up again.
   */
  reserve(input: ReserveInput, float: { readonly balance: bigint }): Promise<ReserveResult>;
  /** USDG promised to endowments and not yet paid: pending, received and crediting. */
  owed(float: Address): Promise<Micro>;
  find(id: string): Promise<Earning | null>;
  /** The row for an authorization, as USDC keys it. */
  findAuthorization(network: string, asset: Address, payer: Address, nonce: Hex): Promise<Earning | null>;
  findBaseTransaction(hash: Hex): Promise<Earning | null>;
  receive(id: string, baseTransaction: Hex | null): Promise<void>;
  fail(id: string, reason: string): Promise<void>;
  crediting(id: string, transaction: PreparedTransaction): Promise<void>;
  /** Back to received after a credit that reverted or can no longer land. */
  uncredit(id: string, reason: string): Promise<void>;
  credited(id: string, transaction: Hex): Promise<void>;
  /** Records why a pass could not finish a row and sends it to the back of the queue. */
  note(id: string, reason: string): Promise<void>;
  /** Pending, received and crediting rows, least recently touched first. */
  listOpen(limit: number): Promise<Earning[]>;
  totals(float: Address, lateBefore: Date): Promise<EarningTotals>;
};
