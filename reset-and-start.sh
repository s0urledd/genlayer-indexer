#!/bin/bash
echo "=== GenLayer Indexer Reset ==="

# 1. Kill existing indexer
pkill -f "node dist/index.js" 2>/dev/null
echo "[1/4] Stopped existing indexer"

# 2. Start PostgreSQL if not running
pg_isready -q || pg_ctlcluster 16 main start
echo "[2/4] PostgreSQL is running"

# 3. Truncate all tables
node -e "
const pg = require('pg');
const pool = new pg.Pool({connectionString: 'postgresql://genlayer:genlayer@localhost:5432/genlayer_indexer'});
pool.query('TRUNCATE validators, epochs, events, delegations, network_metrics, consensus_transactions, validator_tx_participation, indexer_state CASCADE')
.then(() => { console.log('[3/4] All tables truncated'); return pool.end(); })
.catch(e => { console.error('DB Error:', e.message); pool.end(); process.exit(1); });
" || exit 1

# 4. Build and start
npm run build && echo "[4/4] Build complete, starting indexer..." && npm start
