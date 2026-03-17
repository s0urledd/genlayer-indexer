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
  total_rewards NUMERIC NOT NULL DEFAULT 0,
  total_slashed NUMERIC NOT NULL DEFAULT 0,
  prime_count INTEGER NOT NULL DEFAULT 0,
  slash_count INTEGER NOT NULL DEFAULT 0,
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
  inflation_amount NUMERIC,
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
