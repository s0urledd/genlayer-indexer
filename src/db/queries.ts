import pg from "pg";
import { EVENT_CATEGORIES } from "../abi.js";

export class Database {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async close() {
    await this.pool.end();
  }

  // ============================================================
  // Indexer State
  // ============================================================

  async getLastBlock(contractAddress: string): Promise<bigint> {
    const result = await this.pool.query(
      "SELECT last_block FROM indexer_state WHERE contract_address = $1",
      [contractAddress.toLowerCase()]
    );
    return result.rows.length > 0 ? BigInt(result.rows[0].last_block) : 0n;
  }

  async setLastBlock(contractAddress: string, block: bigint) {
    await this.pool.query(
      `INSERT INTO indexer_state (contract_address, last_block, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (contract_address) DO UPDATE SET last_block = $2, updated_at = NOW()`,
      [contractAddress.toLowerCase(), block.toString()]
    );
  }

  // ============================================================
  // Event Storage
  // ============================================================

  async insertEvent(event: {
    blockNumber: bigint;
    txHash: string;
    logIndex: number;
    contractAddress: string;
    eventName: string;
    args: Record<string, unknown>;
    blockTimestamp?: Date;
  }) {
    const category = EVENT_CATEGORIES[event.eventName] || "unknown";
    await this.pool.query(
      `INSERT INTO events (block_number, tx_hash, log_index, contract_address, event_name, category, args, block_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [
        event.blockNumber.toString(),
        event.txHash,
        event.logIndex,
        event.contractAddress.toLowerCase(),
        event.eventName,
        category,
        JSON.stringify(event.args, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        ),
        event.blockTimestamp || null,
      ]
    );
  }

  async insertEvents(
    events: Array<{
      blockNumber: bigint;
      txHash: string;
      logIndex: number;
      contractAddress: string;
      eventName: string;
      args: Record<string, unknown>;
      blockTimestamp?: Date;
    }>
  ) {
    if (events.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Multi-row INSERT for much better performance (1 query vs N queries)
      const CHUNK_SIZE = 500; // Avoid exceeding PG parameter limit (65535)
      for (let i = 0; i < events.length; i += CHUNK_SIZE) {
        const chunk = events.slice(i, i + CHUNK_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        for (let j = 0; j < chunk.length; j++) {
          const event = chunk[j];
          const category = EVENT_CATEGORIES[event.eventName] || "unknown";
          const base = j * 8;
          placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
          );
          values.push(
            event.blockNumber.toString(),
            event.txHash,
            event.logIndex,
            event.contractAddress.toLowerCase(),
            event.eventName,
            category,
            JSON.stringify(event.args, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value
            ),
            event.blockTimestamp || null,
          );
        }

        await client.query(
          `INSERT INTO events (block_number, tx_hash, log_index, contract_address, event_name, category, args, block_timestamp)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (tx_hash, log_index) DO NOTHING`,
          values
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================
  // Validator Aggregation (called after indexing events)
  // ============================================================

  async upsertValidator(address: string, data: Partial<{
    operator: string;
    status: string;
    totalStake: string;
    totalRewards: string;
    totalSlashed: string;
    primeCount: number;
    slashCount: number;
    lastPrimeEpoch: bigint;
    lastSeenBlock: bigint;
    joinedAtBlock: bigint;
  }>) {
    await this.pool.query(
      `INSERT INTO validators (address, operator, status, total_stake, total_rewards, total_slashed, prime_count, slash_count, last_prime_epoch, last_seen_block, joined_at_block, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (address) DO UPDATE SET
         operator = COALESCE($2, validators.operator),
         status = COALESCE($3, validators.status),
         total_stake = COALESCE($4, validators.total_stake),
         total_rewards = COALESCE($5, validators.total_rewards),
         total_slashed = COALESCE($6, validators.total_slashed),
         prime_count = COALESCE($7, validators.prime_count),
         slash_count = COALESCE($8, validators.slash_count),
         last_prime_epoch = COALESCE($9, validators.last_prime_epoch),
         last_seen_block = COALESCE($10, validators.last_seen_block),
         joined_at_block = COALESCE($11, validators.joined_at_block),
         updated_at = NOW()`,
      [
        address.toLowerCase(),
        data.operator?.toLowerCase() || null,
        data.status || null,
        data.totalStake || null,
        data.totalRewards || null,
        data.totalSlashed || null,
        data.primeCount ?? null,
        data.slashCount ?? null,
        data.lastPrimeEpoch?.toString() || null,
        data.lastSeenBlock?.toString() || null,
        data.joinedAtBlock?.toString() || null,
      ]
    );
  }

  async upsertEpoch(epoch: bigint, data: Partial<{
    advancedAtBlock: bigint;
    finalizedAtBlock: bigint;
    inflationAmount: string;
    validatorCount: number;
  }>) {
    await this.pool.query(
      `INSERT INTO epochs (epoch, advanced_at_block, finalized_at_block, inflation_amount, validator_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (epoch) DO UPDATE SET
         advanced_at_block = COALESCE($2, epochs.advanced_at_block),
         finalized_at_block = COALESCE($3, epochs.finalized_at_block),
         inflation_amount = COALESCE($4, epochs.inflation_amount),
         validator_count = COALESCE($5, epochs.validator_count),
         updated_at = NOW()`,
      [
        epoch.toString(),
        data.advancedAtBlock?.toString() || null,
        data.finalizedAtBlock?.toString() || null,
        data.inflationAmount || null,
        data.validatorCount ?? null,
      ]
    );
  }

  // Atomically increment validator stake (for ValidatorDeposit)
  async incrementValidatorStake(address: string, amount: string) {
    await this.pool.query(
      `UPDATE validators SET
        total_stake = total_stake + $2,
        updated_at = NOW()
       WHERE address = $1`,
      [address.toLowerCase(), amount]
    );
  }

  // Reset all banned validators to active (for AllValidatorBansRemoved event)
  async resetAllBannedValidators() {
    await this.pool.query(
      `UPDATE validators SET status = 'active', updated_at = NOW()
       WHERE status = 'banned'`
    );
  }

  async upsertDelegation(
    validatorAddress: string,
    delegatorAddress: string,
    depositDelta: string,
    withdrawDelta: string
  ) {
    await this.pool.query(
      `INSERT INTO delegations (validator_address, delegator_address, total_deposited, total_withdrawn, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (validator_address, delegator_address) DO UPDATE SET
         total_deposited = delegations.total_deposited + $3,
         total_withdrawn = delegations.total_withdrawn + $4,
         updated_at = NOW()`,
      [
        validatorAddress.toLowerCase(),
        delegatorAddress.toLowerCase(),
        depositDelta,
        withdrawDelta,
      ]
    );
  }

  // ============================================================
  // Query Methods (for API endpoints)
  // ============================================================

  async getEvents(params: {
    eventName?: string;
    category?: string;
    validator?: string;
    limit?: number;
    offset?: number;
    fromBlock?: bigint;
    toBlock?: bigint;
  }) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.eventName) {
      conditions.push(`event_name = $${paramIndex++}`);
      values.push(params.eventName);
    }
    if (params.category) {
      conditions.push(`category = $${paramIndex++}`);
      values.push(params.category);
    }
    if (params.validator) {
      conditions.push(`args->>'validator' = $${paramIndex++}`);
      values.push(params.validator.toLowerCase());
    }
    if (params.fromBlock !== undefined) {
      conditions.push(`block_number >= $${paramIndex++}`);
      values.push(params.fromBlock.toString());
    }
    if (params.toBlock !== undefined) {
      conditions.push(`block_number <= $${paramIndex++}`);
      values.push(params.toBlock.toString());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit || 100;
    const offset = params.offset || 0;

    const result = await this.pool.query(
      `SELECT id, block_number, tx_hash, log_index, contract_address, event_name, category, args, block_timestamp, created_at
       FROM events ${where}
       ORDER BY block_number DESC, log_index DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }

  async getEventCount(params: {
    eventName?: string;
    category?: string;
    validator?: string;
  }) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.eventName) {
      conditions.push(`event_name = $${paramIndex++}`);
      values.push(params.eventName);
    }
    if (params.category) {
      conditions.push(`category = $${paramIndex++}`);
      values.push(params.category);
    }
    if (params.validator) {
      conditions.push(`args->>'validator' = $${paramIndex++}`);
      values.push(params.validator.toLowerCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM events ${where}`,
      values
    );
    return parseInt(result.rows[0].count);
  }

  async getValidators(params?: { status?: string; limit?: number; offset?: number }) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(params.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params?.limit || 100;
    const offset = params?.offset || 0;

    const result = await this.pool.query(
      `SELECT * FROM validators ${where}
       ORDER BY total_stake DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }

  async getValidator(address: string) {
    const result = await this.pool.query(
      "SELECT * FROM validators WHERE address = $1",
      [address.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  async getValidatorHistory(address: string, limit = 50) {
    const result = await this.pool.query(
      `SELECT * FROM events
       WHERE args->>'validator' = $1
       ORDER BY block_number DESC, log_index DESC
       LIMIT $2`,
      [address.toLowerCase(), limit]
    );
    return result.rows;
  }

  async getEpochs(limit = 50, offset = 0) {
    const result = await this.pool.query(
      `SELECT * FROM epochs ORDER BY epoch DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  async getEpoch(epoch: bigint) {
    const result = await this.pool.query(
      "SELECT * FROM epochs WHERE epoch = $1",
      [epoch.toString()]
    );
    return result.rows[0] || null;
  }

  async getDelegations(params: {
    validator?: string;
    delegator?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.validator) {
      conditions.push(`validator_address = $${paramIndex++}`);
      values.push(params.validator.toLowerCase());
    }
    if (params.delegator) {
      conditions.push(`delegator_address = $${paramIndex++}`);
      values.push(params.delegator.toLowerCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit || 100;
    const offset = params.offset || 0;

    const result = await this.pool.query(
      `SELECT * FROM delegations ${where}
       ORDER BY total_deposited DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }

  async getNetworkStats() {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM validators) as total_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'active') as active_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'banned') as banned_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'quarantined') as quarantined_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'exiting') as exiting_validators,
        (SELECT COALESCE(SUM(total_stake), 0) FROM validators) as total_staked,
        (SELECT COALESCE(SUM(total_rewards), 0) FROM validators) as total_rewards_distributed,
        (SELECT COALESCE(SUM(total_slashed), 0) FROM validators) as total_slashed,
        (SELECT MAX(epoch) FROM epochs) as latest_epoch,
        (SELECT COUNT(*) FROM events) as total_events,
        (SELECT MAX(block_number) FROM events) as latest_indexed_block,
        (SELECT COUNT(*) FROM events WHERE block_timestamp > NOW() - INTERVAL '1 hour') as events_last_hour,
        (SELECT COUNT(*) FROM events WHERE block_timestamp > NOW() - INTERVAL '24 hours') as events_last_24h,
        (SELECT COUNT(*) FROM delegations) as total_delegations,
        (SELECT COALESCE(SUM(total_deposited - total_withdrawn), 0) FROM delegations) as total_delegated
    `);
    return result.rows[0];
  }

  async getRecentSlashes(limit = 20) {
    const result = await this.pool.query(
      `SELECT * FROM events
       WHERE category = 'slashing'
       ORDER BY block_number DESC, log_index DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // ============================================================
  // Network Metrics (for dashboard time-series)
  // ============================================================

  async recordMetricsSnapshot(data: {
    blockNumber: bigint;
    rpcLatencyAvg?: number;
    rpcLatencyP95?: number;
  }) {
    await this.pool.query(
      `INSERT INTO network_metrics (
        timestamp, block_number,
        active_validators, banned_validators, quarantined_validators,
        total_staked, epoch, events_in_window,
        rpc_latency_avg_ms, rpc_latency_p95_ms
      ) SELECT
        NOW(), $1,
        (SELECT COUNT(*) FROM validators WHERE status = 'active'),
        (SELECT COUNT(*) FROM validators WHERE status = 'banned'),
        (SELECT COUNT(*) FROM validators WHERE status = 'quarantined'),
        (SELECT COALESCE(SUM(total_stake), 0) FROM validators),
        (SELECT MAX(epoch) FROM epochs),
        (SELECT COUNT(*) FROM events WHERE block_number > $1 - 1000),
        $2, $3`,
      [
        data.blockNumber.toString(),
        data.rpcLatencyAvg ?? null,
        data.rpcLatencyP95 ?? null,
      ]
    );
  }

  async getMetricsTimeline(hours = 24, limit = 200) {
    const result = await this.pool.query(
      `SELECT * FROM network_metrics
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       ORDER BY timestamp ASC
       LIMIT $2`,
      [hours, limit]
    );
    return result.rows;
  }

  async getEpochDurations(limit = 50) {
    // Calculate epoch duration from advanced_at_block differences
    const result = await this.pool.query(
      `SELECT
         e1.epoch,
         e1.advanced_at_block,
         e1.finalized_at_block,
         e1.inflation_amount,
         e1.validator_count,
         CASE WHEN e2.advanced_at_block IS NOT NULL
           THEN e1.advanced_at_block - e2.advanced_at_block
           ELSE NULL
         END as block_duration,
         (SELECT COUNT(*) FROM events
          WHERE event_name = 'ValidatorPrime'
          AND (args->>'epoch')::bigint = e1.epoch
         ) as prime_count,
         (SELECT COUNT(*) FROM events
          WHERE category = 'slashing'
          AND block_number >= COALESCE(e2.advanced_at_block, 0)
          AND block_number < e1.advanced_at_block
         ) as slash_count_in_epoch
       FROM epochs e1
       LEFT JOIN epochs e2 ON e2.epoch = e1.epoch - 1
       ORDER BY e1.epoch DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getThroughputStats(hours = 24) {
    // Events per hour for the last N hours
    const result = await this.pool.query(
      `SELECT
         date_trunc('hour', block_timestamp) as hour,
         COUNT(*) as total_events,
         COUNT(*) FILTER (WHERE category = 'validator_lifecycle') as validator_events,
         COUNT(*) FILTER (WHERE category = 'delegator_lifecycle') as delegator_events,
         COUNT(*) FILTER (WHERE category = 'slashing') as slashing_events,
         COUNT(*) FILTER (WHERE category = 'epoch') as epoch_events,
         COUNT(*) FILTER (WHERE category = 'economics') as economics_events
       FROM events
       WHERE block_timestamp > NOW() - INTERVAL '1 hour' * $1
       GROUP BY date_trunc('hour', block_timestamp)
       ORDER BY hour ASC`,
      [hours]
    );
    return result.rows;
  }

  async getValidatorUptimeByEpoch(address: string, epochCount = 30) {
    const result = await this.pool.query(
      `SELECT
         e.epoch,
         CASE WHEN ev.id IS NOT NULL THEN true ELSE false END as primed
       FROM epochs e
       LEFT JOIN events ev ON ev.event_name = 'ValidatorPrime'
         AND ev.args->>'validator' = $1
         AND (ev.args->>'epoch')::bigint = e.epoch
       ORDER BY e.epoch DESC
       LIMIT $2`,
      [address.toLowerCase(), epochCount]
    );
    return result.rows;
  }
}
