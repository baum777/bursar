-- Earnings on Base: a buyer's USDC authorization settled to the Base float, and the endowment on
-- Robinhood Chain paid the same amount, less the fee, from the float's USDG.
--
-- A row is written before anything is sent on Base, keyed on the authorization as USDC keys it: the
-- payer and the nonce. A second settle of the same authorization finds the row and sends nothing.
--
-- `pending` reserves the credit while the Base transfer is out. `received` means USDC reports the
-- authorization spent, so the endowment is owed. `crediting` means a signed `earn` is out under the
-- hash, nonce and raw bytes recorded here, written before it was broadcast, so a restart can tell
-- whether it landed and send the same bytes again if it did not. `credited` is final. `failed`
-- means the authorization moved nothing and the reservation is released. What the float owes is the
-- sum over pending, received and crediting.
CREATE TABLE IF NOT EXISTS bursar_base_earnings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network          TEXT NOT NULL,
  asset            TEXT NOT NULL,
  float            TEXT NOT NULL,
  payer            TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  chain_id         BIGINT NOT NULL,
  endowment        TEXT NOT NULL,
  resource         TEXT NOT NULL,
  amount_micro     NUMERIC(20, 6) NOT NULL,
  fee_micro        NUMERIC(20, 6) NOT NULL,
  credit_micro     NUMERIC(20, 6) NOT NULL,
  valid_before     BIGINT NOT NULL,
  base_block       BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  base_tx_hash     TEXT,
  credit_tx_hash   TEXT,
  credit_nonce     BIGINT,
  credit_raw       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at      TIMESTAMPTZ,
  credited_at      TIMESTAMPTZ,
  CONSTRAINT uq_base_earnings_authorization UNIQUE (network, asset, payer, nonce),
  CONSTRAINT chk_base_earnings_status CHECK (status IN ('pending', 'received', 'crediting', 'credited', 'failed')),
  CONSTRAINT chk_base_earnings_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT chk_base_earnings_credit CHECK (
    credit_micro > 0 AND fee_micro >= 0 AND credit_micro = trunc(credit_micro) AND fee_micro = trunc(fee_micro)
    AND credit_micro + fee_micro = amount_micro
  ),
  CONSTRAINT chk_base_earnings_lowercase CHECK (
    asset = lower(asset) AND float = lower(float) AND payer = lower(payer) AND nonce = lower(nonce) AND endowment = lower(endowment)
  ),
  CONSTRAINT chk_base_earnings_received CHECK (status IN ('pending', 'failed') OR received_at IS NOT NULL),
  CONSTRAINT chk_base_earnings_crediting CHECK (
    status <> 'crediting' OR (credit_tx_hash IS NOT NULL AND credit_nonce IS NOT NULL AND credit_raw IS NOT NULL)
  ),
  CONSTRAINT chk_base_earnings_credited CHECK (status <> 'credited' OR (credit_tx_hash IS NOT NULL AND credited_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_base_earnings_open
  ON bursar_base_earnings (updated_at ASC) WHERE status IN ('pending', 'received', 'crediting');
CREATE INDEX IF NOT EXISTS idx_base_earnings_endowment
  ON bursar_base_earnings (endowment, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_base_earnings_base_tx
  ON bursar_base_earnings (base_tx_hash) WHERE base_tx_hash IS NOT NULL;
