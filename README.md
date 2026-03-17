# GenLayer Indexer

Event indexer for GenLayer blockchain. Indexes staking, consensus, slashing, epoch, delegation, and governance events from the GenLayer Bradbury testnet into PostgreSQL. Provides a REST API for dashboard consumption.

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

## API Endpoints

All endpoints return JSON. Default port: `3000`.

### Network Overview

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /stats` | Network overview — validator counts, total staked, latest epoch, estimated APY |
| `GET /stats/network-uptime` | Per-epoch network uptime (% of validators that primed) |
| `GET /stats/timeline` | Historical metrics time-series |
| `GET /stats/throughput` | Event throughput by hour and category |
| `GET /stats/latency` | RPC ping latency + log fetch duration (avg, p50, p95) |

### Validators

| Endpoint | Description |
|----------|-------------|
| `GET /validators` | List all validators with stake breakdown, participation score, uptime |
| `GET /validators?status=active` | Filter by status: `active`, `banned`, `quarantined`, `exiting` |
| `GET /validators/:address` | Single validator — self_stake, delegated_stake, delegator_count, participation_score |
| `GET /validators/:address/history` | All staking events for this validator |
| `GET /validators/:address/uptime` | Epoch-by-epoch prime/miss data |
| `GET /validators/:address/delegations` | Delegations for this validator |
| `GET /validators/:address/transactions` | Consensus transactions this validator participated in |

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
| `GET /events` | Query all events with filters |
| `GET /events?event_name=VoteRevealed` | Filter by event name |
| `GET /events?category=consensus_vote` | Filter by category |
| `GET /events?validator=0x...` | Filter by validator address |
| `GET /events?from_block=1000&to_block=2000` | Filter by block range |
| `GET /events/slashes` | Recent slashing events |

### Delegations

| Endpoint | Description |
|----------|-------------|
| `GET /delegations` | Query all delegations |
| `GET /delegations?validator=0x...` | Filter by validator |
| `GET /delegations?delegator=0x...` | Filter by delegator |

All list endpoints support `?limit=100&offset=0` pagination.

## Validator Response Fields

The `/validators` and `/validators/:address` endpoints return enriched data:

| Field | Source | Description |
|-------|--------|-------------|
| `total_stake` | ValidatorJoin + ValidatorDeposit | Total GEN staked |
| `self_stake` | total_stake - delegated | Validator's own stake |
| `delegated_stake` | Delegations table | Stake from delegators |
| `delegator_count` | Delegations table | Active delegator count |
| `participation_score` | prime_count / (prime + slash) × 100 | Duty completion rate |
| `uptime_percentage` | Prime events over last 30 epochs | Epoch participation rate |
| `total_rewards` | ValidatorPrime.validatorRewards sum | Total GEN earned |
| `total_slashed` | ValidatorSlash + SlashedFromIdleness | Total GEN slashed |
| `status` | Latest lifecycle event | active / banned / quarantined / exiting |

## Consensus Transaction Fields

The `/validators/:address/transactions` endpoint returns:

| Field | Source | Description |
|-------|--------|-------------|
| `tx_id` | NewTransaction | Transaction hash (bytes32) |
| `status` | Lifecycle events | pending / proposing / accepted / finalized / undetermined / cancelled |
| `leader` | TransactionActivated | Current leader address |
| `role` | Participation table | leader / validator / appeal_validator |
| `validator_vote_type` | VoteRevealed | AGREE / DISAGREE / TIMEOUT / DETERMINISTIC_VIOLATION |
| `rotation_count` | TransactionLeaderRotated count | Number of leader rotations |
| `appeal_count` | AppealStarted count | Number of appeals |

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
