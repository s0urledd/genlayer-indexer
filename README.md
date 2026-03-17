# GenLayer Indexer

Event indexer for GenLayer blockchain. Indexes staking, consensus, slashing, epoch, delegation, and governance events from the GenLayer Bradbury testnet into PostgreSQL. Provides a REST API optimized for explorer/dashboard consumption.

## Quick Start

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure (defaults work for Bradbury testnet)
cp .env.example .env

# 4. Run database migrations
npm run migrate

# 5. Start the indexer + API server
npm run dev
```

## Architecture

The indexer tracks two on-chain contracts in parallel:

| Contract | Address | Events |
|----------|---------|--------|
| **Staking** | `0x4A4449...E821A5` | 38 events — validator/delegator lifecycle, epochs, economics, governance |
| **ConsensusMain** | `0x0112Bf...004271D` | 27 events — transaction lifecycle, voting, appeals, rotation, slashing |

Data flows into 7 PostgreSQL tables:

- `events` — Raw event log (all 65 events, JSONB args)
- `validators` — Aggregated validator state (stake, rewards, slashes, status)
- `epochs` — Epoch timeline with timestamps
- `delegations` — Delegator deposits/withdrawals per validator
- `consensus_transactions` — Transaction lifecycle (status, leader, rotations, appeals)
- `validator_tx_participation` — Per-validator role and vote on each transaction
- `network_metrics` — Time-series snapshots for dashboard charts

---

## UI Consumption Map

Which endpoints to use for each page:

### Dashboard Page

| Section | Endpoint | Notes |
|---------|----------|-------|
| Top bar metrics | `GET /stats/summary` | Single call: validators, epoch, participation, uptime, staked, latency |
| Top validators | `GET /validators/top?sort=stake&limit=10` | Also `sort=participation` or `sort=rewards` |
| Recent activity | `GET /events/feed?limit=20` | Pre-normalized: type, title, subtitle, severity |
| Network uptime chart | `GET /stats/network-uptime?epochs=30` | Chart-ready array |
| Event activity chart | `GET /stats/event-activity?hours=24` | Hourly breakdown by category |
| Metrics timeline | `GET /stats/timeline?hours=24` | Time-series: validators, staked, epoch |

### Validators List Page

| Section | Endpoint | Notes |
|---------|----------|-------|
| Validator table | `GET /validators?sort=participation_score&order=desc&limit=50` | Sortable columns: `total_stake`, `participation_score`, `total_rewards`, `total_slashed`, `uptime_percentage` |
| Filter by status | `GET /validators?status=active` | Values: `active`, `banned`, `quarantined`, `exiting` |

### Validator Detail Page

| Section | Endpoint | Notes |
|---------|----------|-------|
| Header & stats | `GET /validators/:address` | Enriched: self_stake, delegated_stake, participation_score, recent_slash_count_30d, recent_prime_rate_30_epochs, latest_status_change_at, last_event_at |
| Participation chart | `GET /validators/:address/participation-history?epochs=30` | Chart-ready: `[{ epoch, participation_score, prime_present, slashed, status }]` |
| Reward chart | `GET /validators/:address/reward-history?limit=30` | Chart-ready: `[{ epoch, validator_rewards, delegator_rewards, fee_rewards, fee_penalties, net_rewards }]` |
| Slash timeline | `GET /validators/:address/slash-history` | `[{ timestamp, epoch, slash_type, amount, reason, resulting_status }]` |
| Uptime grid | `GET /validators/:address/uptime?epochs=30` | Per-epoch primed/missed |
| Delegators | `GET /validators/:address/delegations` | Standard list |
| Transactions | `GET /validators/:address/transactions` | Compact by default; `?detail=full` for all fields |
| Event history | `GET /validators/:address/history` | Raw events |

---

## API Reference

All endpoints return JSON. Default port: `3000`.

### Network & Dashboard

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /stats` | Full network overview (backward compat) |
| `GET /stats/summary` | Dashboard top bar — all key metrics in one call |
| `GET /stats/network-uptime` | Per-epoch network uptime (% of validators that primed) |
| `GET /stats/timeline` | Historical metrics time-series |
| `GET /stats/event-activity` | Event counts by hour and category |
| `GET /stats/rpc-latency` | RPC ping latency + log fetch duration (avg, p50, p95) |

> `/stats/throughput` and `/stats/latency` are kept as aliases for backward compatibility.

### Validators

| Endpoint | Description |
|----------|-------------|
| `GET /validators` | List validators with sort/order support |
| `GET /validators/top` | Top N validators by `?sort=stake\|participation\|rewards` |
| `GET /validators/:address` | Enriched detail — includes `latest_status_change_at`, `last_event_at`, `recent_slash_count_30d`, `recent_prime_rate_30_epochs` |
| `GET /validators/:address/history` | All events for this validator |
| `GET /validators/:address/uptime` | Epoch-by-epoch prime/miss (technical metric) |
| `GET /validators/:address/participation-history` | Chart-ready per-epoch participation trend |
| `GET /validators/:address/reward-history` | Chart-ready per-epoch reward breakdown |
| `GET /validators/:address/slash-history` | Slash/quarantine/ban timeline |
| `GET /validators/:address/delegations` | Delegations for this validator |
| `GET /validators/:address/transactions` | Compact by default; `?detail=full` for all consensus fields |

### Consensus

| Endpoint | Description |
|----------|-------------|
| `GET /consensus/stats` | Transaction statistics — accepted, finalized, undetermined, avg rotations/appeals |

### Epochs

| Endpoint | Description |
|----------|-------------|
| `GET /epochs` | List epochs with timestamps |
| `GET /epochs/:epoch` | Single epoch details |
| `GET /epochs/durations` | Epoch duration analysis with prime/slash counts per epoch |

### Events

| Endpoint | Description |
|----------|-------------|
| `GET /events` | Query all events with filters + sort/order support |
| `GET /events/feed` | Normalized event stream for UI (type, title, subtitle, severity) |
| `GET /events/slashes` | Recent slashing events |

### Delegations

| Endpoint | Description |
|----------|-------------|
| `GET /delegations` | Query all delegations |

### Common Query Parameters

All list endpoints support:

| Param | Default | Description |
|-------|---------|-------------|
| `limit` | 100 | Max results |
| `offset` | 0 | Pagination offset |
| `sort` | varies | Sort field (whitelisted per endpoint) |
| `order` | `desc` | `asc` or `desc` |

**Validator sort fields:** `total_stake`, `participation_score`, `total_rewards`, `total_slashed`, `prime_count`, `slash_count`, `delegated_stake`, `uptime_percentage`

**Event sort fields:** `block_number`, `block_timestamp`, `event_name`, `category`

---

## Key Metrics Glossary

| Metric | Definition | Primary? |
|--------|-----------|----------|
| `participation_score` | `prime_count / (prime_count + slash_count) × 100` — Duty completion rate | Yes |
| `uptime_percentage` | Prime events in last 30 epochs / 30 — Epoch presence rate | Secondary |
| `network_uptime` | Avg % of validators that primed across last 30 epochs | Dashboard |
| `rpc_latency` | `getBlockNumber()` round-trip time — Node response speed | Infrastructure |
| `event_activity` | Event count per hour by category — Network activity level | Dashboard |

> **`participation_score`** is the primary validator health metric for the UI. **`uptime_percentage`** is secondary/technical.

## Validator Status Enum

All endpoints use the same status values:

| Status | Meaning |
|--------|---------|
| `active` | Normal operating validator |
| `quarantined` | Temporarily restricted |
| `banned` | Permanently banned (idleness or deterministic violation) |
| `exiting` | In unbonding period |

---

## Event Feed Types

The `/events/feed` endpoint returns normalized events with these types:

| Type | Severity | Source Events |
|------|----------|---------------|
| `epoch_finalized` | info | EpochFinalize |
| `epoch_advanced` | info | EpochAdvance |
| `validator_primed` | info | ValidatorPrime |
| `validator_slashed` | warning | ValidatorSlash, SlashedFromIdleness |
| `validator_quarantined` | warning | ValidatorQuarantined |
| `validator_banned` | critical | ValidatorBannedIdleness, ValidatorBannedDeterministic |
| `validator_joined` | info | ValidatorJoin |
| `validator_exited` | info | ValidatorExit |
| `delegation_updated` | info | DelegatorJoin, DelegatorExit |
| `tx_finalized` | info | TransactionFinalized |
| `tx_accepted` | info | TransactionAccepted |
| `leader_rotated` | warning | TransactionLeaderRotated |
| `appeal_started` | warning | AppealStarted |

---

## Consensus Transaction Detail Modes

`GET /validators/:address/transactions` supports two modes:

**Default (compact):** `tx_id`, `status`, `submitted_at`, `role`, `rotation_count`, `appeal_count`

**Full (`?detail=full`):** All fields including `leader`, `recipient`, `activator`, `vote_type`, `result_type`, `validators`, `validator_vote_type`, `vote_committed`, `vote_revealed`, block numbers

---

## Event Categories

### Staking Contract
- `validator_lifecycle` — ValidatorJoin, ValidatorDeposit, ValidatorExit, ValidatorClaim, ValidatorPrime
- `delegator_lifecycle` — DelegatorJoin, DelegatorExit, DelegatorClaim
- `slashing` — ValidatorSlash, ValidatorBannedIdleness, ValidatorBannedDeterministic, SlashedFromIdleness
- `quarantine` — ValidatorQuarantined, ValidatorQuarantineRemoved, ValidatorQuarantineRepealed
- `epoch` — EpochAdvance, EpochFinalize, EpochZeroEnded, EpochHasPendingTribunals
- `economics` — InflationReceived, FeesReceived, BurnToL1, BurnFailed
- `governance` — SetMaxValidators, SetEpochMinDuration, SetValidatorWeightParams, etc.

### Consensus Contract
- `consensus_tx` — NewTransaction, TransactionActivated, TransactionAccepted, TransactionFinalized, etc.
- `consensus_vote` — VoteCommitted, VoteRevealed, AllVotesCommitted, TransactionLeaderRevealed
- `consensus_appeal` — AppealStarted, TribunalAppealVoteCommitted, TribunalAppealVoteRevealed
- `consensus_rotation` — TransactionLeaderRotated, TransactionLeaderTimeout, ValidatorReplaced
- `consensus_infra` — BatchFinalizationCompleted, InternalMessageProcessed, AddressManagerSet

## Configuration

All settings via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://zksync-os-testnet-genlayer.zksync.dev` | GenLayer chain RPC |
| `STAKING_CONTRACT` | `0x4A4449E617F8D10FDeD0b461CadEf83939E821A5` | Staking contract address |
| `CONSENSUS_CONTRACT` | `0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D` | ConsensusMain contract address |
| `DATABASE_URL` | `postgresql://genlayer:genlayer@localhost:5432/genlayer_indexer` | PostgreSQL connection |
| `BATCH_SIZE` | `1000` | Blocks per indexing batch |
| `POLL_INTERVAL_MS` | `5000` | Polling interval in ms |
| `START_BLOCK` | `0` | Block to start indexing from |
| `API_PORT` | `3000` | REST API port |

## Reindexing Consensus Events

If upgrading from a version that only indexed `SlashedFromIdleness`, reset the consensus contract to reindex all events:

```sql
UPDATE indexer_state
SET last_block = 0
WHERE contract_address = '0x0112bf6e83497965a5fdd6dad1e447a6e004271d';
```

Then restart the indexer. Staking data remains intact.

## Indexed Events (65 total)

- **38** events from the Staking contract
- **1** from the Slashing contract (`SlashedFromIdleness`)
- **26** from the ConsensusMain contract

ABI sources: `genlayer-js` SDK (`STAKING_ABI` + `testnetBradbury.ts` ConsensusMain ABI).
