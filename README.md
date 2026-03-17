# GenLayer Indexer

Event indexer for GenLayer blockchain. Indexes all staking, slashing, epoch, delegation, and governance events from the GenLayer Bradbury testnet into PostgreSQL.

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

## API Endpoints

All endpoints return JSON. Default port: `3000`.

### Network

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /stats` | Network overview (validator counts, total staked, latest epoch) |

### Validators

| Endpoint | Description |
|----------|-------------|
| `GET /validators` | List all validators (sorted by stake) |
| `GET /validators?status=active` | Filter by status: `active`, `banned`, `quarantined`, `exiting` |
| `GET /validators/:address` | Single validator details |
| `GET /validators/:address/history` | All events for this validator |
| `GET /validators/:address/uptime` | Epoch-by-epoch prime/miss uptime data |
| `GET /validators/:address/delegations` | Delegations for this validator |

### Epochs

| Endpoint | Description |
|----------|-------------|
| `GET /epochs` | List epochs (most recent first) |
| `GET /epochs/:epoch` | Single epoch details |

### Events

| Endpoint | Description |
|----------|-------------|
| `GET /events` | Query all events with filters |
| `GET /events?event_name=ValidatorPrime` | Filter by event name |
| `GET /events?category=slashing` | Filter by category |
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

### Event Categories

- `validator_lifecycle` - ValidatorJoin, ValidatorDeposit, ValidatorExit, ValidatorClaim, ValidatorPrime
- `delegator_lifecycle` - DelegatorJoin, DelegatorExit, DelegatorClaim
- `slashing` - ValidatorSlash, ValidatorBannedIdleness, ValidatorBannedDeterministic, SlashedFromIdleness
- `quarantine` - ValidatorQuarantined, ValidatorQuarantineRemoved, ValidatorQuarantineRepealed
- `epoch` - EpochAdvance, EpochFinalize, EpochZeroEnded, EpochHasPendingTribunals
- `economics` - InflationReceived, FeesReceived, BurnToL1
- `governance` - SetMaxValidators, SetEpochMinDuration, SetValidatorWeightParams, etc.

## Configuration

All settings via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://zksync-os-testnet-genlayer.zksync.dev` | GenLayer chain RPC |
| `STAKING_CONTRACT` | `0x4A4449E617F8D10FDeD0b461CadEf83939E821A5` | Staking contract address |
| `CONSENSUS_CONTRACT` | `0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D` | Consensus/AddressManager contract |
| `DATABASE_URL` | `postgresql://genlayer:genlayer@localhost:5432/genlayer_indexer` | PostgreSQL connection |
| `BATCH_SIZE` | `1000` | Blocks per indexing batch |
| `POLL_INTERVAL_MS` | `5000` | Polling interval in ms |
| `START_BLOCK` | `0` | Block to start indexing from |
| `API_PORT` | `3000` | REST API port |

## Indexed Events (39 total)

38 events from the Staking contract + 1 from the Slashing contract (`SlashedFromIdleness`), as verified from the `genlayer-js` SDK v0.35.0.
