import { toMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { countToNumber, microToNumeric, numericToMicro } from '../db/numeric.js';
import type { Database, Queryable } from '../db/sql.js';
import { one, many } from '../db/sql.js';
import type { EarnLedger, Earning, EarningStatus, EarningTotals, PreparedTransaction, ReserveInput, ReserveResult } from './ports.js';

const COLUMNS = `id, network, asset, float, payer, nonce, chain_id, endowment, resource, amount_micro, fee_micro,
  credit_micro, valid_before, base_block, status, base_tx_hash, credit_tx_hash, credit_nonce, credit_raw, attempts,
  last_error, created_at, received_at, credited_at`;

const OWING = `('pending', 'received', 'crediting')`;

type Row = {
  id: string;
  network: string;
  asset: string;
  float: string;
  payer: string;
  nonce: string;
  chain_id: string | number;
  endowment: string;
  resource: string;
  amount_micro: string;
  fee_micro: string;
  credit_micro: string;
  valid_before: string | number;
  base_block: string | number;
  status: EarningStatus;
  base_tx_hash: string | null;
  credit_tx_hash: string | null;
  credit_nonce: string | number | null;
  credit_raw: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  received_at: Date | null;
  credited_at: Date | null;
};

function toEarning(row: Row): Earning {
  return {
    id: row.id,
    network: row.network,
    asset: row.asset as Address,
    float: row.float as Address,
    payer: row.payer as Address,
    nonce: row.nonce as Hex,
    chainId: Number(row.chain_id),
    endowment: row.endowment as Address,
    resource: row.resource,
    amountMicro: numericToMicro(row.amount_micro, 'amount_micro'),
    feeMicro: numericToMicro(row.fee_micro, 'fee_micro'),
    creditMicro: numericToMicro(row.credit_micro, 'credit_micro'),
    validBefore: BigInt(row.valid_before),
    baseBlock: BigInt(row.base_block),
    status: row.status,
    baseTransaction: (row.base_tx_hash as Hex | null) ?? null,
    creditTransaction: (row.credit_tx_hash as Hex | null) ?? null,
    creditNonce: row.credit_nonce === null ? null : Number(row.credit_nonce),
    creditRaw: (row.credit_raw as Hex | null) ?? null,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    receivedAt: row.received_at ?? null,
    creditedAt: row.credited_at ?? null,
  };
}

async function owedOn(client: Queryable, float: Address): Promise<Micro> {
  const row = await one<{ owed: string | null }>(
    client,
    `SELECT COALESCE(SUM(credit_micro), 0) AS owed FROM bursar_base_earnings WHERE float = $1 AND status IN ${OWING}`,
    [float.toLowerCase()],
  );
  return numericToMicro(row?.owed ?? '0', 'owed');
}

export class PostgresEarnLedger implements EarnLedger {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async reserve(input: ReserveInput, float: { balance: bigint }): Promise<ReserveResult> {
    return this.db.transaction(async (client) => {
      // One sale at a time per float, so two reading the same owed figure cannot both be promised
      // the last of its USDG.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`earn:${input.float.toLowerCase()}`]);
      const existing = await one<Row>(
        client,
        `SELECT ${COLUMNS} FROM bursar_base_earnings WHERE network = $1 AND asset = $2 AND payer = $3 AND nonce = $4`,
        [input.network, input.asset.toLowerCase(), input.payer.toLowerCase(), input.nonce.toLowerCase()],
      );
      if (existing && existing.status !== 'failed') return { reserved: false, reason: 'replay', earning: toEarning(existing) };

      const available = toMicro(float.balance - (await owedOn(client, input.float)));
      if (available < input.creditMicro) return { reserved: false, reason: 'float', availableMicro: available };

      const now = this.now();
      const values = [
        input.network,
        input.asset.toLowerCase(),
        input.float.toLowerCase(),
        input.payer.toLowerCase(),
        input.nonce.toLowerCase(),
        input.chainId,
        input.endowment.toLowerCase(),
        input.resource,
        microToNumeric(input.amountMicro),
        microToNumeric(input.feeMicro),
        microToNumeric(input.creditMicro),
        input.validBefore.toString(),
        input.baseBlock.toString(),
        now,
      ];
      // A failed attempt moved nothing, so the same authorization may be presented again: the row
      // is taken up under the terms of the new attempt.
      const row = existing
        ? await one<Row>(
            client,
            `UPDATE bursar_base_earnings SET float = $3, chain_id = $6, endowment = $7, resource = $8, amount_micro = $9,
               fee_micro = $10, credit_micro = $11, valid_before = $12, base_block = $13, status = 'pending',
               base_tx_hash = NULL, last_error = NULL, updated_at = $14
             WHERE network = $1 AND asset = $2 AND payer = $4 AND nonce = $5 AND status = 'failed'
             RETURNING ${COLUMNS}`,
            values,
          )
        : await one<Row>(
            client,
            `INSERT INTO bursar_base_earnings (network, asset, float, payer, nonce, chain_id, endowment, resource,
               amount_micro, fee_micro, credit_micro, valid_before, base_block, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
             RETURNING ${COLUMNS}`,
            values,
          );
      if (!row) throw new Error(`the earning for ${input.payer} ${input.nonce} changed under the advisory lock`);
      return { reserved: true, earning: toEarning(row) };
    });
  }

  owed(float: Address): Promise<Micro> {
    return owedOn(this.db, float);
  }

  async find(id: string): Promise<Earning | null> {
    const row = await one<Row>(this.db, `SELECT ${COLUMNS} FROM bursar_base_earnings WHERE id = $1::uuid`, [id]);
    return row ? toEarning(row) : null;
  }

  async findAuthorization(network: string, asset: Address, payer: Address, nonce: Hex): Promise<Earning | null> {
    const row = await one<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_earnings WHERE network = $1 AND asset = $2 AND payer = $3 AND nonce = $4`,
      [network, asset.toLowerCase(), payer.toLowerCase(), nonce.toLowerCase()],
    );
    return row ? toEarning(row) : null;
  }

  async findBaseTransaction(hash: Hex): Promise<Earning | null> {
    const row = await one<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_earnings WHERE base_tx_hash = $1 ORDER BY created_at DESC LIMIT 1`,
      [hash.toLowerCase()],
    );
    return row ? toEarning(row) : null;
  }

  async receive(id: string, baseTransaction: Hex | null): Promise<void> {
    const now = this.now();
    await this.db.query(
      `UPDATE bursar_base_earnings SET status = 'received', base_tx_hash = COALESCE($2, base_tx_hash), received_at = $3,
         updated_at = $3, last_error = NULL
       WHERE id = $1::uuid AND status IN ('pending', 'failed')`,
      [id, baseTransaction?.toLowerCase() ?? null, now],
    );
  }

  async fail(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE bursar_base_earnings SET status = 'failed', last_error = $2, updated_at = $3 WHERE id = $1::uuid AND status = 'pending'`,
      [id, reason, this.now()],
    );
  }

  async crediting(id: string, transaction: PreparedTransaction): Promise<void> {
    const updated = await this.db.query(
      `UPDATE bursar_base_earnings SET status = 'crediting', credit_tx_hash = $2, credit_nonce = $3, credit_raw = $4,
         attempts = attempts + 1, updated_at = $5
       WHERE id = $1::uuid AND status = 'received'`,
      [id, transaction.hash.toLowerCase(), transaction.nonce, transaction.raw, this.now()],
    );
    // The hash has to be on the ledger before the bytes go out. A row that was not in `received`
    // means another pass got here first, and sending would pay the endowment twice.
    if (updated.rowCount !== 1) throw new Error(`earning ${id} is no longer waiting for its credit`);
  }

  async uncredit(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE bursar_base_earnings SET status = 'received', credit_tx_hash = NULL, credit_nonce = NULL, credit_raw = NULL,
         last_error = $2, updated_at = $3
       WHERE id = $1::uuid AND status = 'crediting'`,
      [id, reason, this.now()],
    );
  }

  async credited(id: string, transaction: Hex): Promise<void> {
    const now = this.now();
    await this.db.query(
      `UPDATE bursar_base_earnings SET status = 'credited', credit_tx_hash = $2, credited_at = $3, updated_at = $3, last_error = NULL
       WHERE id = $1::uuid AND status IN ('received', 'crediting')`,
      [id, transaction.toLowerCase(), now],
    );
  }

  async note(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE bursar_base_earnings SET last_error = $2, updated_at = $3 WHERE id = $1::uuid AND status IN ${OWING}`,
      [id, reason.slice(0, 500), this.now()],
    );
  }

  async listOpen(limit: number): Promise<Earning[]> {
    const rows = await many<Row>(
      this.db,
      `SELECT ${COLUMNS} FROM bursar_base_earnings WHERE status IN ${OWING} ORDER BY updated_at ASC, created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map(toEarning);
  }

  async totals(float: Address, lateBefore: Date): Promise<EarningTotals> {
    const row = await one<{
      credited: string;
      credited_micro: string | null;
      fees_micro: string | null;
      owed: string;
      owed_micro: string | null;
      late: string;
      pending: string;
    }>(
      this.db,
      `SELECT
         COUNT(*) FILTER (WHERE status = 'credited') AS credited,
         COALESCE(SUM(credit_micro) FILTER (WHERE status = 'credited'), 0) AS credited_micro,
         COALESCE(SUM(fee_micro) FILTER (WHERE status = 'credited'), 0) AS fees_micro,
         COUNT(*) FILTER (WHERE status IN ('received', 'crediting')) AS owed,
         COALESCE(SUM(credit_micro) FILTER (WHERE status IN ('received', 'crediting')), 0) AS owed_micro,
         COUNT(*) FILTER (WHERE status IN ('received', 'crediting') AND received_at < $2) AS late,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM bursar_base_earnings WHERE float = $1`,
      [float.toLowerCase(), lateBefore],
    );
    return {
      credited: countToNumber(row?.credited),
      creditedMicro: numericToMicro(row?.credited_micro ?? '0', 'credited_micro'),
      feesMicro: numericToMicro(row?.fees_micro ?? '0', 'fees_micro'),
      owed: countToNumber(row?.owed),
      owedMicro: numericToMicro(row?.owed_micro ?? '0', 'owed_micro'),
      late: countToNumber(row?.late),
      pending: countToNumber(row?.pending),
    };
  }
}
