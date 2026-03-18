import pg from "pg";
import { config } from "../config.js";

const schema = `
-- Indexer state: tracks last processed block per contract
CREATE TABLE IF NOT EXISTS indexer_state (
  contract_address TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- All indexed events in a single table with JSONB args
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  block_number BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_name TEXT NOT NULL,
  category TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}',
  block_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tx_hash, log_index)
);

-- Validator summary table (materialized from events)
CREATE TABLE IF NOT EXISTS validators (
  address TEXT PRIMARY KEY,
  operator TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  total_stake NUMERIC NOT NULL DEFAULT 0,
  total_shares NUMERIC NOT NULL DEFAULT 0,
  delegated_stake NUMERIC NOT NULL DEFAULT 0,
  selection_weight NUMERIC NOT NULL DEFAULT 0,
  total_rewards NUMERIC NOT NULL DEFAULT 0,
  total_delegator_rewards NUMERIC NOT NULL DEFAULT 0,
  total_fee_rewards NUMERIC NOT NULL DEFAULT 0,
  total_fee_penalties NUMERIC NOT NULL DEFAULT 0,
  total_slashed NUMERIC NOT NULL DEFAULT 0,
  total_delegator_slashed NUMERIC NOT NULL DEFAULT 0,
  prime_count INTEGER NOT NULL DEFAULT 0,
  slash_count INTEGER NOT NULL DEFAULT 0,
  delegator_count INTEGER NOT NULL DEFAULT 0,
  last_prime_epoch BIGINT,
  last_seen_block BIGINT,
  joined_at_block BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Epoch summary table
CREATE TABLE IF NOT EXISTS epochs (
  epoch BIGINT PRIMARY KEY,
  advanced_at_block BIGINT,
  finalized_at_block BIGINT,
  advanced_at_timestamp TIMESTAMPTZ,
  finalized_at_timestamp TIMESTAMPTZ,
  inflation_amount NUMERIC,
  total_weight NUMERIC,
  total_stake_deposited NUMERIC,
  total_stake_withdrawn NUMERIC,
  total_slashed NUMERIC,
  validator_count INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delegations tracking
CREATE TABLE IF NOT EXISTS delegations (
  id BIGSERIAL PRIMARY KEY,
  validator_address TEXT NOT NULL,
  delegator_address TEXT NOT NULL,
  total_deposited NUMERIC NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC NOT NULL DEFAULT 0,
  current_shares NUMERIC NOT NULL DEFAULT 0,
  current_stake NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(validator_address, delegator_address)
);

-- Network metrics snapshots (for dashboard time-series)
CREATE TABLE IF NOT EXISTS network_metrics (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  block_number BIGINT NOT NULL,
  active_validators INTEGER NOT NULL DEFAULT 0,
  banned_validators INTEGER NOT NULL DEFAULT 0,
  quarantined_validators INTEGER NOT NULL DEFAULT 0,
  total_staked NUMERIC NOT NULL DEFAULT 0,
  epoch BIGINT,
  events_in_window INTEGER NOT NULL DEFAULT 0,
  rpc_latency_avg_ms INTEGER,
  rpc_latency_p95_ms INTEGER
);

-- Consensus transactions (materialized from consensus contract events)
CREATE TABLE IF NOT EXISTS consensus_transactions (
  tx_id TEXT PRIMARY KEY,
  recipient TEXT,
  activator TEXT,
  leader TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  vote_type TEXT,
  result_type TEXT,
  rotation_count INTEGER NOT NULL DEFAULT 0,
  appeal_count INTEGER NOT NULL DEFAULT 0,
  appellant TEXT,
  appeal_bond NUMERIC,
  validators TEXT[] DEFAULT '{}',
  created_at_block BIGINT,
  created_at_timestamp TIMESTAMPTZ,
  accepted_at_block BIGINT,
  finalized_at_block BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validator-transaction participation (which validators voted on which txs)
CREATE TABLE IF NOT EXISTS validator_tx_participation (
  id BIGSERIAL PRIMARY KEY,
  tx_id TEXT NOT NULL,
  validator TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'validator',
  vote_type TEXT,
  vote_result INTEGER,
  vote_committed BOOLEAN NOT NULL DEFAULT false,
  vote_revealed BOOLEAN NOT NULL DEFAULT false,
  block_number BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tx_id, validator)
);

CREATE INDEX IF NOT EXISTS idx_consensus_tx_status ON consensus_transactions(status);
CREATE INDEX IF NOT EXISTS idx_consensus_tx_leader ON consensus_transactions(leader);
CREATE INDEX IF NOT EXISTS idx_consensus_tx_recipient ON consensus_transactions(recipient);
CREATE INDEX IF NOT EXISTS idx_vtx_validator ON validator_tx_participation(validator);
CREATE INDEX IF NOT EXISTS idx_vtx_txid ON validator_tx_participation(tx_id);

-- Add columns for existing databases
DO $$ BEGIN
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS advanced_at_timestamp TIMESTAMPTZ;
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS finalized_at_timestamp TIMESTAMPTZ;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS total_delegator_rewards NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS total_fee_rewards NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS total_fee_penalties NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS total_delegator_slashed NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS total_shares NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS delegated_stake NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS selection_weight NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE validators ADD COLUMN IF NOT EXISTS delegator_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE validator_tx_participation ADD COLUMN IF NOT EXISTS vote_result INTEGER;
  ALTER TABLE consensus_transactions ADD COLUMN IF NOT EXISTS appellant TEXT;
  ALTER TABLE consensus_transactions ADD COLUMN IF NOT EXISTS appeal_bond NUMERIC;
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS total_weight NUMERIC;
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS total_stake_deposited NUMERIC;
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS total_stake_withdrawn NUMERIC;
  ALTER TABLE epochs ADD COLUMN IF NOT EXISTS total_slashed NUMERIC;
  ALTER TABLE delegations ADD COLUMN IF NOT EXISTS current_shares NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE delegations ADD COLUMN IF NOT EXISTS current_stake NUMERIC NOT NULL DEFAULT 0;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON network_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_block ON network_metrics(block_number);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_address);
CREATE INDEX IF NOT EXISTS idx_events_args_validator ON events((args->>'validator'));
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(block_timestamp);
CREATE INDEX IF NOT EXISTS idx_validators_status ON validators(status);
CREATE INDEX IF NOT EXISTS idx_delegations_validator ON delegations(validator_address);
CREATE INDEX IF NOT EXISTS idx_delegations_delegator ON delegations(delegator_address);
`;

async function migrate() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    console.log("Running migrations...");
    await pool.query(schema);
    console.log("Migrations complete.");
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
