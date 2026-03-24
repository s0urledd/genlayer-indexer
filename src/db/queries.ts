import pg from "pg";
import { EVENT_CATEGORIES, VOTE_TYPES, TX_STATUSES } from "../abi.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Lowercase all Ethereum address values in an args object for consistent storage */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      result[key] = value.toLowerCase();
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class Database {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async getActiveValidatorCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}'`
    );
    return parseInt(result.rows[0].count);
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
    const normalized = normalizeArgs(event.args);
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
        JSON.stringify(normalized, (_key, value) =>
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
          const normalized = normalizeArgs(event.args);
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
            JSON.stringify(normalized, (_key, value) =>
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
       VALUES ($1, $2, COALESCE($3, 'active'), COALESCE($4::numeric, 0), COALESCE($5::numeric, 0), COALESCE($6::numeric, 0), COALESCE($7, 0), COALESCE($8, 0), $9, $10, $11, NOW())
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
    advancedAtTimestamp: Date;
    finalizedAtTimestamp: Date;
    inflationAmount: string;
    validatorCount: number;
    totalWeight: string;
    totalStakeDeposited: string;
    totalStakeWithdrawn: string;
    totalSlashed: string;
  }>) {
    await this.pool.query(
      `INSERT INTO epochs (epoch, advanced_at_block, finalized_at_block, advanced_at_timestamp, finalized_at_timestamp, inflation_amount, validator_count, total_weight, total_stake_deposited, total_stake_withdrawn, total_slashed, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric, NOW())
       ON CONFLICT (epoch) DO UPDATE SET
         advanced_at_block = COALESCE($2, epochs.advanced_at_block),
         finalized_at_block = COALESCE($3, epochs.finalized_at_block),
         advanced_at_timestamp = COALESCE($4, epochs.advanced_at_timestamp),
         finalized_at_timestamp = COALESCE($5, epochs.finalized_at_timestamp),
         inflation_amount = COALESCE($6, epochs.inflation_amount),
         validator_count = COALESCE($7, epochs.validator_count),
         total_weight = COALESCE($8::numeric, epochs.total_weight),
         total_stake_deposited = COALESCE($9::numeric, epochs.total_stake_deposited),
         total_stake_withdrawn = COALESCE($10::numeric, epochs.total_stake_withdrawn),
         total_slashed = COALESCE($11::numeric, epochs.total_slashed),
         updated_at = NOW()`,
      [
        epoch.toString(),
        data.advancedAtBlock?.toString() || null,
        data.finalizedAtBlock?.toString() || null,
        data.advancedAtTimestamp || null,
        data.finalizedAtTimestamp || null,
        data.inflationAmount || null,
        data.validatorCount ?? null,
        data.totalWeight || null,
        data.totalStakeDeposited || null,
        data.totalStakeWithdrawn || null,
        data.totalSlashed || null,
      ]
    );
  }

  // Atomically increment validator stake (for ValidatorDeposit)
  // Uses upsert so deposits arriving before ValidatorJoin are not lost
  async incrementValidatorStake(address: string, amount: string) {
    await this.pool.query(
      `INSERT INTO validators (address, total_stake, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (address) DO UPDATE SET
         total_stake = validators.total_stake + $2,
         updated_at = NOW()`,
      [address.toLowerCase(), amount]
    );
  }

  // Atomically increment prime_count and add rewards (for ValidatorPrime)
  // Uses upsert so primes arriving before ValidatorJoin are not lost
  async incrementValidatorPrime(address: string, data: {
    validatorRewards: string;
    delegatorRewards: string;
    feeRewards: string;
    feePenalties: string;
    epoch: bigint;
  }) {
    await this.pool.query(
      `INSERT INTO validators (address, prime_count, total_rewards, total_delegator_rewards, total_fee_rewards, total_fee_penalties, last_prime_epoch, updated_at)
       VALUES ($1, 1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6, NOW())
       ON CONFLICT (address) DO UPDATE SET
        prime_count = validators.prime_count + 1,
        total_rewards = validators.total_rewards + $2::numeric,
        total_delegator_rewards = validators.total_delegator_rewards + $3::numeric,
        total_fee_rewards = validators.total_fee_rewards + $4::numeric,
        total_fee_penalties = validators.total_fee_penalties + $5::numeric,
        last_prime_epoch = $6,
        updated_at = NOW()`,
      [address.toLowerCase(), data.validatorRewards, data.delegatorRewards, data.feeRewards, data.feePenalties, data.epoch.toString()]
    );
  }

  // Atomically increment slash_count and add slashed amount (for ValidatorSlash/SlashedFromIdleness)
  // Uses upsert so slashes arriving before ValidatorJoin are not lost
  async incrementValidatorSlash(address: string, validatorSlashing: string, delegatorSlashing: string) {
    await this.pool.query(
      `INSERT INTO validators (address, slash_count, total_slashed, total_delegator_slashed, updated_at)
       VALUES ($1, 1, $2::numeric, $3::numeric, NOW())
       ON CONFLICT (address) DO UPDATE SET
        slash_count = validators.slash_count + 1,
        total_slashed = validators.total_slashed + $2::numeric,
        total_delegator_slashed = validators.total_delegator_slashed + $3::numeric,
        updated_at = NOW()`,
      [address.toLowerCase(), validatorSlashing, delegatorSlashing]
    );
  }

  // Atomically decrement validator stake (for ValidatorClaim withdrawal)
  // Uses upsert so claims arriving before ValidatorJoin are not lost
  async decrementValidatorStake(address: string, amount: string) {
    await this.pool.query(
      `INSERT INTO validators (address, total_stake, updated_at)
       VALUES ($1, 0, NOW())
       ON CONFLICT (address) DO UPDATE SET
        total_stake = GREATEST(validators.total_stake - $2, 0),
        updated_at = NOW()`,
      [address.toLowerCase(), amount]
    );
  }

  async updateValidatorWeight(address: string, weight: string) {
    await this.pool.query(
      `UPDATE validators SET selection_weight = $2::numeric, updated_at = NOW() WHERE address = $1`,
      [address.toLowerCase(), weight]
    );
  }

  async updateValidatorLiveData(address: string, data: {
    totalStake: string;
    totalShares: string;
    delegatedStake: string;
  }) {
    await this.pool.query(
      `UPDATE validators SET
        total_stake = $2::numeric,
        total_shares = $3::numeric,
        delegated_stake = $4::numeric,
        updated_at = NOW()
       WHERE address = $1`,
      [address.toLowerCase(), data.totalStake, data.totalShares, data.delegatedStake]
    );
  }

  async updateValidatorDelegatorCount(address: string, count: number) {
    await this.pool.query(
      `UPDATE validators SET delegator_count = $2, updated_at = NOW() WHERE address = $1`,
      [address.toLowerCase(), count]
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
  // Consensus Transaction Aggregation
  // ============================================================

  async upsertConsensusTx(txId: string, data: Partial<{
    recipient: string;
    activator: string;
    leader: string;
    status: string;
    voteType: string;
    resultType: string;
    rotationCount: number;
    appealCount: number;
    validators: string[];
    createdAtBlock: bigint;
    createdAtTimestamp: Date;
    acceptedAtBlock: bigint;
    acceptedAtTimestamp: Date;
    finalizedAtBlock: bigint;
    finalizedAtTimestamp: Date;
  }>) {
    await this.pool.query(
      `INSERT INTO consensus_transactions (tx_id, recipient, activator, leader, status, vote_type, result_type, rotation_count, appeal_count, validators, created_at_block, created_at_timestamp, accepted_at_block, accepted_at_timestamp, finalized_at_block, finalized_at_timestamp, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'pending'), $6, $7, COALESCE($8, 0), COALESCE($9, 0), $10, $11, $12, $13, $14, $15, $16, NOW())
       ON CONFLICT (tx_id) DO UPDATE SET
         recipient = COALESCE($2, consensus_transactions.recipient),
         activator = COALESCE($3, consensus_transactions.activator),
         leader = COALESCE($4, consensus_transactions.leader),
         status = COALESCE($5, consensus_transactions.status),
         vote_type = COALESCE($6, consensus_transactions.vote_type),
         result_type = COALESCE($7, consensus_transactions.result_type),
         rotation_count = COALESCE($8, consensus_transactions.rotation_count),
         appeal_count = COALESCE($9, consensus_transactions.appeal_count),
         validators = COALESCE($10, consensus_transactions.validators),
         created_at_block = COALESCE($11, consensus_transactions.created_at_block),
         created_at_timestamp = COALESCE($12, consensus_transactions.created_at_timestamp),
         accepted_at_block = COALESCE($13, consensus_transactions.accepted_at_block),
         accepted_at_timestamp = COALESCE($14, consensus_transactions.accepted_at_timestamp),
         finalized_at_block = COALESCE($15, consensus_transactions.finalized_at_block),
         finalized_at_timestamp = COALESCE($16, consensus_transactions.finalized_at_timestamp),
         updated_at = NOW()`,
      [
        txId,
        data.recipient?.toLowerCase() || null,
        data.activator?.toLowerCase() || null,
        data.leader?.toLowerCase() || null,
        data.status || 'pending',
        data.voteType || null,
        data.resultType || null,
        data.rotationCount ?? null,
        data.appealCount ?? null,
        data.validators ? `{${data.validators.map(v => v.toLowerCase()).join(",")}}` : null,
        data.createdAtBlock?.toString() || null,
        data.createdAtTimestamp || null,
        data.acceptedAtBlock?.toString() || null,
        data.acceptedAtTimestamp || null,
        data.finalizedAtBlock?.toString() || null,
        data.finalizedAtTimestamp || null,
      ]
    );
  }

  async incrementConsensusTxRotation(txId: string) {
    await this.pool.query(
      `UPDATE consensus_transactions SET rotation_count = rotation_count + 1, updated_at = NOW() WHERE tx_id = $1`,
      [txId]
    );
  }

  async incrementConsensusTxAppeal(txId: string, appellant?: string, bond?: string) {
    await this.pool.query(
      `UPDATE consensus_transactions SET
        appeal_count = appeal_count + 1,
        appellant = COALESCE($2, consensus_transactions.appellant),
        appeal_bond = COALESCE($3::numeric, consensus_transactions.appeal_bond),
        updated_at = NOW()
       WHERE tx_id = $1`,
      [txId, appellant?.toLowerCase() || null, bond || null]
    );
  }

  async upsertValidatorTxParticipation(txId: string, validator: string, data: Partial<{
    role: string;
    voteType: string;
    voteResult: number;
    voteCommitted: boolean;
    voteRevealed: boolean;
    blockNumber: bigint;
  }>) {
    // Do NOT create validator records from consensus participation.
    // Only staking events (ValidatorJoin, ValidatorDeposit, etc.) should create validators.
    // Consensus participants are tracked in validator_tx_participation only.
    await this.pool.query(
      `INSERT INTO validator_tx_participation (tx_id, validator, role, vote_type, vote_result, vote_committed, vote_revealed, block_number, updated_at)
       VALUES ($1, $2, COALESCE($3, 'validator'), $4, $5, COALESCE($6, false), COALESCE($7, false), $8, NOW())
       ON CONFLICT (tx_id, validator) DO UPDATE SET
         role = COALESCE($3, validator_tx_participation.role),
         vote_type = COALESCE($4, validator_tx_participation.vote_type),
         vote_result = COALESCE($5, validator_tx_participation.vote_result),
         vote_committed = COALESCE($6, validator_tx_participation.vote_committed),
         vote_revealed = COALESCE($7, validator_tx_participation.vote_revealed),
         block_number = COALESCE($8, validator_tx_participation.block_number),
         updated_at = NOW()`,
      [
        txId,
        validator.toLowerCase(),
        data.role || null,
        data.voteType || null,
        data.voteResult ?? null,
        data.voteCommitted ?? null,
        data.voteRevealed ?? null,
        data.blockNumber?.toString() || null,
      ]
    );
  }

  // ============================================================
  // Consensus Transaction Queries
  // ============================================================

  async getConsensusTxForValidator(validator: string, limit = 50, offset = 0) {
    const result = await this.pool.query(
      `SELECT ct.*, vtp.role, vtp.vote_type as validator_vote_type,
         vtp.vote_committed, vtp.vote_revealed
       FROM consensus_transactions ct
       INNER JOIN validator_tx_participation vtp ON vtp.tx_id = ct.tx_id
       WHERE vtp.validator = $1
       ORDER BY ct.created_at_block DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [validator.toLowerCase(), limit, offset]
    );
    return result.rows;
  }

  async getConsensusTxStats() {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total_transactions,
        COUNT(*) FILTER (WHERE status = 'accepted') as accepted,
        COUNT(*) FILTER (WHERE status = 'finalized') as finalized,
        COUNT(*) FILTER (WHERE status = 'undetermined') as undetermined,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status NOT IN ('accepted', 'finalized', 'undetermined', 'cancelled')) as in_progress,
        COALESCE(AVG(rotation_count), 0) as avg_rotations,
        COALESCE(AVG(appeal_count), 0) as avg_appeals
      FROM consensus_transactions
    `);
    return result.rows[0];
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
      conditions.push(`LOWER(args->>'validator') = $${paramIndex++}`);
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
      conditions.push(`LOWER(args->>'validator') = $${paramIndex++}`);
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
    const conditions: string[] = [`v.address != '${ZERO_ADDRESS}'`];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params?.status) {
      conditions.push(`v.status = $${paramIndex++}`);
      values.push(params.status);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = params?.limit || 100;
    const offset = params?.offset || 0;

    const result = await this.pool.query(
      `SELECT v.*,
        COALESCE(d.delegated_stake, 0) as delegated_stake,
        COALESCE(d.delegator_count, 0) as delegator_count,
        GREATEST(v.total_stake - COALESCE(d.delegated_stake, 0), 0) as self_stake,
        COALESCE(u.uptime_pct, 0) as uptime_percentage
       FROM validators v
       LEFT JOIN (
         SELECT validator_address,
           SUM(total_deposited - total_withdrawn) as delegated_stake,
           COUNT(*) FILTER (WHERE total_deposited > total_withdrawn) as delegator_count
         FROM delegations
         GROUP BY validator_address
       ) d ON d.validator_address = v.address
       LEFT JOIN LATERAL (
         SELECT ROUND(
           COUNT(DISTINCT (ev.args->>'epoch'))::numeric /
           GREATEST(
             (SELECT COUNT(*) FROM epochs
              WHERE advanced_at_block IS NOT NULL
                AND advanced_at_block >= COALESCE(v.joined_at_block, 0)
                AND epoch >= COALESCE(
                  (SELECT MIN(epoch) FROM (
                    SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
                  ) _r), 0
                )
             ), 1
           ) * 100, 2
         ) as uptime_pct
         FROM events ev
         WHERE ev.event_name = 'ValidatorPrime'
           AND LOWER(ev.args->>'validator') = v.address
           AND (ev.args->>'epoch')::bigint >= COALESCE(
             (SELECT MIN(epoch) FROM (
               SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
             ) _recent), 0
           )
       ) u ON true
       ${where}
       ORDER BY v.total_stake DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }

  async getValidator(address: string) {
    const result = await this.pool.query(
      `SELECT v.*,
        COALESCE(d.delegated_stake, 0) as delegated_stake,
        COALESCE(d.delegator_count, 0) as delegator_count,
        GREATEST(v.total_stake - COALESCE(d.delegated_stake, 0), 0) as self_stake
       FROM validators v
       LEFT JOIN (
         SELECT validator_address,
           SUM(total_deposited - total_withdrawn) as delegated_stake,
           COUNT(*) FILTER (WHERE total_deposited > total_withdrawn) as delegator_count
         FROM delegations
         GROUP BY validator_address
       ) d ON d.validator_address = v.address
       WHERE v.address = $1`,
      [address.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  async getValidatorHistory(address: string, limit = 50, offset = 0) {
    const result = await this.pool.query(
      `SELECT * FROM events
       WHERE LOWER(args->>'validator') = $1
       ORDER BY block_number DESC, log_index DESC
       LIMIT $2 OFFSET $3`,
      [address.toLowerCase(), limit, offset]
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
    const zeroAddr = ZERO_ADDRESS;
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM validators WHERE address != '${zeroAddr}') as total_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${zeroAddr}') as active_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'banned' AND address != '${zeroAddr}') as banned_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'quarantined' AND address != '${zeroAddr}') as quarantined_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'exiting' AND address != '${zeroAddr}') as exiting_validators,
        (SELECT COALESCE(SUM(total_stake), 0) FROM validators WHERE address != '${zeroAddr}') as total_staked,
        (SELECT COALESCE(SUM(total_rewards), 0) FROM validators WHERE address != '${zeroAddr}') as total_rewards_distributed,
        (SELECT COALESCE(SUM(total_slashed), 0) FROM validators WHERE address != '${zeroAddr}') as total_slashed,
        (SELECT MAX(epoch) FROM epochs WHERE advanced_at_block IS NOT NULL) as latest_epoch,
        (SELECT COUNT(*) FROM events) as total_events,
        (SELECT MAX(block_number) FROM events) as latest_indexed_block,
        (SELECT COUNT(*) FROM events WHERE block_timestamp > NOW() - INTERVAL '1 hour') as events_last_hour,
        (SELECT COUNT(*) FROM events WHERE block_timestamp > NOW() - INTERVAL '24 hours') as events_last_24h,
        (SELECT COUNT(*) FROM delegations) as total_delegations,
        (SELECT COALESCE(SUM(total_deposited - total_withdrawn), 0) FROM delegations) as total_delegated,
        -- Estimated APY: total rewards distributed / total staked, annualized from first epoch to now
        (SELECT CASE
          WHEN COALESCE(SUM(v.total_stake), 0) > 0
            AND first_epoch.ts IS NOT NULL
            AND EXTRACT(EPOCH FROM NOW() - first_epoch.ts) > 3600
          THEN LEAST(
            ROUND(
              COALESCE(SUM(v.total_rewards), 0)::numeric / GREATEST(SUM(v.total_stake), 1) *
              (365.25 * 86400.0 / EXTRACT(EPOCH FROM NOW() - first_epoch.ts)) * 100, 2
            ),
            9999.99
          )
          ELSE 0
        END
        FROM validators v,
        (SELECT MIN(advanced_at_timestamp) as ts FROM epochs WHERE advanced_at_timestamp IS NOT NULL) first_epoch
        WHERE v.address != '${zeroAddr}'
        ) as estimated_apy
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
        NOW(), $1::bigint,
        (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}'),
        (SELECT COUNT(*) FROM validators WHERE status = 'banned' AND address != '${ZERO_ADDRESS}'),
        (SELECT COUNT(*) FROM validators WHERE status = 'quarantined' AND address != '${ZERO_ADDRESS}'),
        (SELECT COALESCE(SUM(total_stake), 0) FROM validators WHERE address != '${ZERO_ADDRESS}'),
        (SELECT MAX(epoch) FROM epochs),
        (SELECT COUNT(*) FROM events WHERE block_number > $1::bigint - 1000),
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
    // Calculate epoch duration using LAG (handles genesis epoch 0→2 skip)
    const result = await this.pool.query(
      `SELECT
         e1.epoch,
         e1.advanced_at_block,
         e1.finalized_at_block,
         e1.inflation_amount,
         e1.validator_count,
         e1.advanced_at_block - LAG(e1.advanced_at_block) OVER (ORDER BY e1.epoch) as block_duration,
         ROUND(EXTRACT(EPOCH FROM
           e1.advanced_at_timestamp - LAG(e1.advanced_at_timestamp) OVER (ORDER BY e1.epoch)
         )::numeric, 0) as duration_seconds,
         (SELECT COUNT(DISTINCT LOWER(args->>'validator')) FROM events
          WHERE event_name = 'ValidatorPrime'
          AND (args->>'epoch')::bigint = e1.epoch
         ) as prime_count,
         (SELECT COUNT(*) FROM events
          WHERE event_name IN ('ValidatorSlash', 'SlashedFromIdleness', 'SlashEnacted')
          AND (args->>'epoch')::bigint = e1.epoch
         ) as slash_count_in_epoch
       FROM epochs e1
       WHERE e1.advanced_at_block IS NOT NULL
       ORDER BY e1.epoch DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getNetworkUptimeByEpoch(epochCount = 30) {
    const result = await this.pool.query(
      `SELECT
         e.epoch,
         e.advanced_at_block,
         e.finalized_at_block,
         COALESCE(p.primed_count, 0) as primed_validators,
         COALESCE(e.validator_count,
           (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}')
         ) as total_validators,
         CASE WHEN COALESCE(e.validator_count,
           (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}')
         ) > 0
           THEN ROUND(
             COALESCE(p.primed_count, 0)::numeric /
             COALESCE(e.validator_count,
               (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}')
             ) * 100, 2
           )
           ELSE 0
         END as uptime_percentage
       FROM epochs e
       LEFT JOIN (
         SELECT (args->>'epoch')::bigint as epoch,
           COUNT(DISTINCT LOWER(args->>'validator')) FILTER (WHERE LOWER(args->>'validator') != '${ZERO_ADDRESS}') as primed_count
         FROM events
         WHERE event_name = 'ValidatorPrime'
         GROUP BY (args->>'epoch')::bigint
       ) p ON p.epoch = e.epoch
       WHERE e.advanced_at_block IS NOT NULL
         AND e.finalized_at_block IS NOT NULL
       ORDER BY e.epoch DESC
       LIMIT $1`,
      [epochCount]
    );
    const rows = result.rows;
    const avgUptime = rows.length > 0
      ? (rows.reduce((sum: number, r: { uptime_percentage: string }) => sum + parseFloat(r.uptime_percentage), 0) / rows.length).toFixed(2)
      : "0.00";
    return { avgUptime, epochs: rows };
  }

  async getThroughputStats(hours = 24) {
    // Events per hour for the last N hours, including consensus categories
    const result = await this.pool.query(
      `SELECT
         date_trunc('hour', block_timestamp) as hour,
         COUNT(*) as total_events,
         COUNT(*) FILTER (WHERE category = 'validator_lifecycle') as validator_events,
         COUNT(*) FILTER (WHERE category = 'delegator_lifecycle') as delegator_events,
         COUNT(*) FILTER (WHERE category = 'slashing') as slashing_events,
         COUNT(*) FILTER (WHERE category = 'epoch') as epoch_events,
         COUNT(*) FILTER (WHERE category = 'economics') as economics_events,
         COUNT(*) FILTER (WHERE category = 'consensus_tx') as consensus_tx_events,
         COUNT(*) FILTER (WHERE category = 'consensus_vote') as consensus_vote_events,
         COUNT(*) FILTER (WHERE category IN ('consensus_appeal', 'consensus_rotation')) as consensus_appeal_rotation_events,
         COUNT(*) FILTER (WHERE category = 'governance') as governance_events,
         COUNT(*) FILTER (WHERE category = 'quarantine') as quarantine_events,
         COUNT(*) FILTER (WHERE category IN ('consensus_infra', 'unknown')) as infra_events
       FROM events
       WHERE block_timestamp > NOW() - INTERVAL '1 hour' * $1
       GROUP BY date_trunc('hour', block_timestamp)
       ORDER BY hour ASC`,
      [hours]
    );
    return result.rows;
  }

  // ============================================================
  // Network Latency — GenLayer consensus timing metrics
  // GenLayer is an L2 on ZKSync; L1 block time is irrelevant.
  // We measure the actual Optimistic Democracy consensus stages:
  //   1. Consensus round: Created → Accepted (validator agreement time)
  //   2. Finalization: Accepted → Finalized (finality window)
  //   3. End-to-end: Created → Finalized (total user-facing latency)
  //   4. Epoch duration: time between epoch advances (~1 day target)
  // ============================================================

  async getNetworkLatency() {
    const parse = (row: Record<string, string | null>) => ({
      avg_seconds: row.avg_seconds ? parseFloat(row.avg_seconds) : null,
      p50_seconds: row.p50_seconds ? parseFloat(row.p50_seconds) : null,
      p95_seconds: row.p95_seconds ? parseFloat(row.p95_seconds) : null,
      min_seconds: row.min_seconds ? parseFloat(row.min_seconds) : null,
      max_seconds: row.max_seconds ? parseFloat(row.max_seconds) : null,
      sample_count: row.sample_count ? parseInt(row.sample_count) : 0,
    });

    const statsSQL = (col: string) => `
      ROUND(AVG(${col})::numeric, 2) as avg_seconds,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${col})::numeric, 2) as p50_seconds,
      ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${col})::numeric, 2) as p95_seconds,
      ROUND(MIN(${col})::numeric, 2) as min_seconds,
      ROUND(MAX(${col})::numeric, 2) as max_seconds,
      COUNT(*) as sample_count
    `;

    // 1. Consensus round: Created → Accepted
    //    How fast the validator group reaches agreement via Optimistic Democracy
    const consensusRoundResult = await this.pool.query(`
      WITH recent AS (
        SELECT EXTRACT(EPOCH FROM accepted_at_timestamp - created_at_timestamp) as secs
        FROM consensus_transactions
        WHERE accepted_at_timestamp IS NOT NULL AND created_at_timestamp IS NOT NULL
        ORDER BY accepted_at_block DESC LIMIT 200
      )
      SELECT ${statsSQL('secs')} FROM recent WHERE secs > 0
    `);

    // 2. Finalization: Accepted → Finalized (finality window duration)
    const finalizationResult = await this.pool.query(`
      WITH recent AS (
        SELECT EXTRACT(EPOCH FROM finalized_at_timestamp - accepted_at_timestamp) as secs
        FROM consensus_transactions
        WHERE finalized_at_timestamp IS NOT NULL AND accepted_at_timestamp IS NOT NULL
        ORDER BY finalized_at_block DESC LIMIT 200
      )
      SELECT ${statsSQL('secs')} FROM recent WHERE secs > 0
    `);

    // 3. End-to-end: Created → Finalized (total user-facing latency)
    const endToEndResult = await this.pool.query(`
      WITH recent AS (
        SELECT EXTRACT(EPOCH FROM finalized_at_timestamp - created_at_timestamp) as secs
        FROM consensus_transactions
        WHERE finalized_at_timestamp IS NOT NULL AND created_at_timestamp IS NOT NULL
        ORDER BY finalized_at_block DESC LIMIT 200
      )
      SELECT ${statsSQL('secs')} FROM recent WHERE secs > 0
    `);

    // 4. Epoch duration (target ~86400s = 1 day)
    //    Use LAG to get previous epoch's timestamp (handles gaps like epoch 0→2 genesis skip)
    const epochDurationResult = await this.pool.query(`
      WITH ordered AS (
        SELECT epoch, advanced_at_timestamp,
          LAG(advanced_at_timestamp) OVER (ORDER BY epoch) as prev_ts
        FROM epochs
        WHERE advanced_at_timestamp IS NOT NULL
        ORDER BY epoch DESC LIMIT 31
      ),
      epoch_diffs AS (
        SELECT EXTRACT(EPOCH FROM advanced_at_timestamp - prev_ts) as secs
        FROM ordered WHERE prev_ts IS NOT NULL
      )
      SELECT ${statsSQL('secs')} FROM epoch_diffs WHERE secs > 0
    `);

    return {
      consensus_round: parse(consensusRoundResult.rows[0] || {}),
      finalization: parse(finalizationResult.rows[0] || {}),
      end_to_end: parse(endToEndResult.rows[0] || {}),
      epoch_duration: parse(epochDurationResult.rows[0] || {}),
    };
  }

  async getValidatorUptimeByEpoch(address: string, epochCount = 30) {
    const result = await this.pool.query(
      `SELECT
         e.epoch,
         CASE WHEN ev.id IS NOT NULL THEN true ELSE false END as primed
       FROM epochs e
       LEFT JOIN events ev ON ev.event_name = 'ValidatorPrime'
         AND LOWER(ev.args->>'validator') = $1
         AND (ev.args->>'epoch')::bigint = e.epoch
       WHERE e.advanced_at_block IS NOT NULL
       ORDER BY e.epoch DESC
       LIMIT $2`,
      [address.toLowerCase(), epochCount]
    );
    return result.rows;
  }

  // ============================================================
  // Dashboard Summary (single-call aggregate for top bar)
  // ============================================================

  async getDashboardSummary() {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM validators WHERE address != '${ZERO_ADDRESS}') as total_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}') as active_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'banned' AND address != '${ZERO_ADDRESS}') as banned_validators,
        (SELECT COUNT(*) FROM validators WHERE status = 'quarantined' AND address != '${ZERO_ADDRESS}') as quarantined_validators,
        (SELECT MAX(epoch) FROM epochs WHERE advanced_at_block IS NOT NULL) as latest_epoch,
        (SELECT COALESCE(SUM(total_stake), 0) FROM validators WHERE address != '${ZERO_ADDRESS}') as total_staked,
        (SELECT COUNT(*) FROM events WHERE block_timestamp > NOW() - INTERVAL '24 hours') as event_throughput_24h
    `);
    const row = result.rows[0];

    // Network uptime = avg of last 30 finalized epochs
    const uptimeResult = await this.pool.query(`
      SELECT COALESCE(AVG(
        CASE WHEN COALESCE(e.validator_count,
          (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}')
        ) > 0
          THEN COALESCE(p.primed_count, 0)::numeric /
            COALESCE(e.validator_count,
              (SELECT COUNT(*) FROM validators WHERE status = 'active' AND address != '${ZERO_ADDRESS}')
            ) * 100
          ELSE 0
        END
      ), 0) as network_uptime
      FROM (SELECT * FROM epochs
            WHERE advanced_at_block IS NOT NULL
              AND finalized_at_block IS NOT NULL
            ORDER BY epoch DESC LIMIT 30) e
      LEFT JOIN (
        SELECT (args->>'epoch')::bigint as epoch,
          COUNT(DISTINCT LOWER(args->>'validator')) FILTER (WHERE LOWER(args->>'validator') != '${ZERO_ADDRESS}') as primed_count
        FROM events WHERE event_name = 'ValidatorPrime'
        GROUP BY (args->>'epoch')::bigint
      ) p ON p.epoch = e.epoch
    `);

    // Real network latency from on-chain data
    const latency = await this.getNetworkLatency();

    return {
      active_validators: parseInt(row.active_validators),
      banned_validators: parseInt(row.banned_validators),
      quarantined_validators: parseInt(row.quarantined_validators),
      total_validators: parseInt(row.total_validators),
      latest_epoch: row.latest_epoch,
      total_staked: row.total_staked,
      network_uptime: parseFloat(parseFloat(uptimeResult.rows[0].network_uptime).toFixed(2)),
      event_throughput_24h: parseInt(row.event_throughput_24h),
      consensus_round_avg_seconds: latency.consensus_round.avg_seconds,
      finalization_avg_seconds: latency.finalization.avg_seconds,
      end_to_end_avg_seconds: latency.end_to_end.avg_seconds,
      epoch_duration_avg_seconds: latency.epoch_duration.avg_seconds,
    };
  }

  // ============================================================
  // Top Validators (sorted by different criteria)
  // ============================================================

  async getTopValidators(sort: "stake" | "uptime" | "rewards" = "stake", limit = 10) {
    const orderBy = {
      stake: "v.total_stake DESC",
      uptime: "uptime_percentage DESC, v.total_stake DESC",
      rewards: "v.total_rewards DESC",
    }[sort];

    const result = await this.pool.query(
      `SELECT v.address, v.status, v.total_stake, v.total_rewards, v.total_slashed,
        v.prime_count, v.slash_count,
        COALESCE(d.delegated_stake, 0) as delegated_stake,
        COALESCE(d.delegator_count, 0) as delegator_count,
        GREATEST(v.total_stake - COALESCE(d.delegated_stake, 0), 0) as self_stake,
        COALESCE(u.uptime_pct, 0) as uptime_percentage
       FROM validators v
       LEFT JOIN (
         SELECT validator_address,
           SUM(total_deposited - total_withdrawn) as delegated_stake,
           COUNT(*) FILTER (WHERE total_deposited > total_withdrawn) as delegator_count
         FROM delegations GROUP BY validator_address
       ) d ON d.validator_address = v.address
       LEFT JOIN LATERAL (
         SELECT ROUND(
           COUNT(DISTINCT (ev.args->>'epoch'))::numeric /
           GREATEST(
             (SELECT COUNT(*) FROM epochs
              WHERE advanced_at_block IS NOT NULL
                AND advanced_at_block >= COALESCE(v.joined_at_block, 0)
                AND epoch >= COALESCE(
                  (SELECT MIN(epoch) FROM (
                    SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
                  ) _r), 0
                )
             ), 1
           ) * 100, 2
         ) as uptime_pct
         FROM events ev
         WHERE ev.event_name = 'ValidatorPrime'
           AND LOWER(ev.args->>'validator') = v.address
           AND (ev.args->>'epoch')::bigint >= COALESCE(
             (SELECT MIN(epoch) FROM (
               SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
             ) _recent), 0
           )
       ) u ON true
       WHERE v.address != '${ZERO_ADDRESS}'
       ORDER BY ${orderBy}
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // ============================================================
  // Participation History (chart-friendly per-epoch data)
  // ============================================================

  async getValidatorParticipationHistory(address: string, epochCount = 30) {
    const result = await this.pool.query(
      `SELECT
         e.epoch,
         CASE WHEN prime_ev.id IS NOT NULL THEN true ELSE false END as prime_present,
         CASE WHEN slash_ev.cnt > 0 THEN true ELSE false END as slashed,
         v.status
       FROM epochs e
       CROSS JOIN (SELECT status FROM validators WHERE address = $1) v
       LEFT JOIN events prime_ev ON prime_ev.event_name = 'ValidatorPrime'
         AND LOWER(prime_ev.args->>'validator') = $1
         AND (prime_ev.args->>'epoch')::bigint = e.epoch
       LEFT JOIN (
         SELECT (args->>'epoch')::bigint as epoch, COUNT(*) as cnt
         FROM events
         WHERE category = 'slashing' AND LOWER(args->>'validator') = $1
         GROUP BY (args->>'epoch')::bigint
       ) slash_ev ON slash_ev.epoch = e.epoch
       ORDER BY e.epoch DESC
       LIMIT $2`,
      [address.toLowerCase(), epochCount]
    );

    // Compute running prime_rate (prime count / epochs seen)
    const rows = result.rows;
    let primeTotal = 0;
    let totalEpochs = 0;
    // Process in epoch-ascending order for running rate
    const reversed = [...rows].reverse();
    const scored = reversed.map((r) => {
      totalEpochs++;
      if (r.prime_present) primeTotal++;
      return {
        epoch: r.epoch,
        prime_rate: totalEpochs > 0 ? parseFloat(((primeTotal / totalEpochs) * 100).toFixed(2)) : 100,
        prime_present: r.prime_present,
        slashed: r.slashed,
        status: r.status,
      };
    });
    return scored.reverse(); // Return most-recent-first
  }

  // ============================================================
  // Reward History (chart-friendly per-epoch rewards)
  // ============================================================

  async getValidatorRewardHistory(address: string, limit = 50) {
    const result = await this.pool.query(
      `SELECT
         (args->>'epoch')::bigint as epoch,
         block_timestamp as timestamp,
         COALESCE((args->>'validatorRewards')::numeric, 0) as validator_rewards,
         COALESCE((args->>'delegatorRewards')::numeric, 0) as delegator_rewards,
         COALESCE((args->>'feeRewards')::numeric, 0) as fee_rewards,
         COALESCE((args->>'feePenalties')::numeric, 0) as fee_penalties,
         COALESCE((args->>'validatorRewards')::numeric, 0)
           + COALESCE((args->>'feeRewards')::numeric, 0)
           - COALESCE((args->>'feePenalties')::numeric, 0) as net_rewards
       FROM events
       WHERE event_name = 'ValidatorPrime'
         AND LOWER(args->>'validator') = $1
       ORDER BY block_number DESC
       LIMIT $2`,
      [address.toLowerCase(), limit]
    );
    return result.rows;
  }

  // ============================================================
  // Slash History (timeline of slashes/quarantines/bans)
  // ============================================================

  async getValidatorSlashHistory(address: string, limit = 50) {
    const result = await this.pool.query(
      `SELECT
         e.block_timestamp as timestamp,
         COALESCE((e.args->>'epoch')::bigint,
           (SELECT MAX(epoch) FROM epochs WHERE advanced_at_block <= e.block_number)
         ) as epoch,
         e.event_name as slash_type,
         COALESCE((e.args->>'amount')::numeric, (e.args->>'slashAmount')::numeric, 0) as amount,
         CASE
           WHEN e.event_name = 'SlashedFromIdleness' THEN 'Idleness'
           WHEN e.event_name = 'ValidatorBannedIdleness' THEN 'Banned for idleness'
           WHEN e.event_name = 'ValidatorBannedDeterministic' THEN 'Banned for deterministic violation'
           WHEN e.event_name = 'ValidatorSlash' THEN 'Slashed'
           WHEN e.event_name = 'ValidatorQuarantined' THEN 'Quarantined'
           ELSE e.event_name
         END as reason,
         CASE
           WHEN e.event_name IN ('ValidatorBannedIdleness', 'ValidatorBannedDeterministic') THEN 'banned'
           WHEN e.event_name = 'ValidatorQuarantined' THEN 'quarantined'
           ELSE 'active'
         END as resulting_status
       FROM events e
       WHERE LOWER(e.args->>'validator') = $1
         AND (e.category = 'slashing' OR e.category = 'quarantine')
       ORDER BY e.block_number DESC
       LIMIT $2`,
      [address.toLowerCase(), limit]
    );
    return result.rows;
  }

  // ============================================================
  // Event Feed (normalized, UI-ready event stream)
  // ============================================================

  async getEventFeed(limit = 50, offset = 0) {
    const result = await this.pool.query(
      `SELECT
         id,
         block_timestamp as timestamp,
         event_name,
         category,
         args,
         block_number
       FROM events
       ORDER BY block_number DESC, log_index DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return result.rows.map((row) => {
      const { type, title, subtitle, severity } = this.mapEventToFeed(row.event_name, row.args, row.category);
      return {
        id: row.id,
        timestamp: row.timestamp,
        type,
        title,
        subtitle,
        validator_address: row.args?.validator || null,
        tx_id: row.args?.txId || row.args?.hash || null,
        severity,
      };
    });
  }

  private mapEventToFeed(eventName: string, args: Record<string, unknown>, category: string): {
    type: string;
    title: string;
    subtitle: string;
    severity: "info" | "warning" | "critical";
  } {
    const addr = (args?.validator as string)?.slice(0, 10) || "";

    switch (eventName) {
      case "EpochFinalize":
        return { type: "epoch_finalized", title: "Epoch Finalized", subtitle: `Epoch ${args?.epoch || ""}`, severity: "info" };
      case "EpochAdvance":
        return { type: "epoch_advanced", title: "Epoch Advanced", subtitle: `Epoch ${args?.epoch || ""}`, severity: "info" };
      case "ValidatorPrime":
        return { type: "validator_primed", title: "Validator Primed", subtitle: `${addr}... epoch ${args?.epoch || ""}`, severity: "info" };
      case "ValidatorSlash":
        return { type: "validator_slashed", title: "Validator Slashed", subtitle: `${addr}...`, severity: "warning" };
      case "SlashedFromIdleness":
        return { type: "validator_slashed", title: "Slashed (Idleness)", subtitle: `${addr}...`, severity: "warning" };
      case "ValidatorQuarantined":
        return { type: "validator_quarantined", title: "Validator Quarantined", subtitle: `${addr}...`, severity: "warning" };
      case "ValidatorBannedIdleness":
      case "ValidatorBannedDeterministic":
        return { type: "validator_banned", title: "Validator Banned", subtitle: `${addr}...`, severity: "critical" };
      case "ValidatorJoin":
        return { type: "validator_joined", title: "Validator Joined", subtitle: `${addr}...`, severity: "info" };
      case "ValidatorExit":
        return { type: "validator_exited", title: "Validator Exited", subtitle: `${addr}...`, severity: "info" };
      case "DelegatorJoin":
        return { type: "delegation_updated", title: "Delegation Added", subtitle: `to ${addr}...`, severity: "info" };
      case "DelegatorExit":
        return { type: "delegation_updated", title: "Delegation Removed", subtitle: `from ${addr}...`, severity: "info" };
      case "TransactionFinalized":
        return { type: "tx_finalized", title: "Transaction Finalized", subtitle: `${(args?.txId as string)?.slice(0, 10) || ""}...`, severity: "info" };
      case "TransactionAccepted":
        return { type: "tx_accepted", title: "Transaction Accepted", subtitle: `${(args?.txId as string)?.slice(0, 10) || ""}...`, severity: "info" };
      case "TransactionLeaderRotated":
        return { type: "leader_rotated", title: "Leader Rotated", subtitle: `${(args?.txId as string)?.slice(0, 10) || ""}...`, severity: "warning" };
      case "AppealStarted":
        return { type: "appeal_started", title: "Appeal Started", subtitle: `${(args?.txId as string)?.slice(0, 10) || ""}...`, severity: "warning" };
      default:
        return {
          type: category,
          title: eventName.replace(/([A-Z])/g, " $1").trim(),
          subtitle: addr ? `${addr}...` : "",
          severity: category === "slashing" ? "warning" : "info",
        };
    }
  }

  // ============================================================
  // Consensus Tx for Validator (with detail mode)
  // ============================================================

  async getConsensusTxForValidatorCompact(validator: string, limit = 50, offset = 0) {
    const result = await this.pool.query(
      `SELECT ct.tx_id, ct.status, ct.created_at_timestamp as submitted_at,
         vtp.role, ct.rotation_count, ct.appeal_count
       FROM consensus_transactions ct
       INNER JOIN validator_tx_participation vtp ON vtp.tx_id = ct.tx_id
       WHERE vtp.validator = $1
       ORDER BY ct.created_at_block DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [validator.toLowerCase(), limit, offset]
    );
    return result.rows;
  }

  // ============================================================
  // Enhanced Validator Detail
  // ============================================================

  async getValidatorEnriched(address: string) {
    const addr = address.toLowerCase();
    const result = await this.pool.query(
      `SELECT v.*,
        COALESCE(d.delegated_stake, 0) as delegated_stake,
        COALESCE(d.delegator_count, 0) as delegator_count,
        GREATEST(v.total_stake - COALESCE(d.delegated_stake, 0), 0) as self_stake,
        COALESCE(u.uptime_pct, 0) as uptime_percentage,
        -- latest status-changing event timestamp
        (SELECT block_timestamp FROM events
         WHERE LOWER(args->>'validator') = $1
           AND event_name IN ('ValidatorJoin','ValidatorExit','ValidatorBannedIdleness','ValidatorBannedDeterministic','ValidatorQuarantined','ValidatorQuarantineRemoved','ValidatorBanRemoved','AllValidatorBansRemoved')
         ORDER BY block_number DESC LIMIT 1
        ) as latest_status_change_at,
        -- last event timestamp
        (SELECT block_timestamp FROM events
         WHERE LOWER(args->>'validator') = $1
         ORDER BY block_number DESC LIMIT 1
        ) as last_event_at,
        -- recent slashes in last 30 days
        (SELECT COUNT(*) FROM events
         WHERE LOWER(args->>'validator') = $1
           AND category = 'slashing'
           AND block_timestamp > NOW() - INTERVAL '30 days'
        ) as recent_slash_count_30d,
        -- recent prime rate over last 30 real epochs (excluding phantom epoch records)
        (SELECT CASE WHEN COUNT(*) > 0
          THEN ROUND(
            COUNT(*) FILTER (WHERE prime_ev.id IS NOT NULL)::numeric / COUNT(*) * 100, 2
          ) ELSE 0 END
         FROM (SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30) recent_e
         LEFT JOIN events prime_ev ON prime_ev.event_name = 'ValidatorPrime'
           AND LOWER(prime_ev.args->>'validator') = $1
           AND (prime_ev.args->>'epoch')::bigint = recent_e.epoch
        ) as recent_prime_rate_30_epochs
       FROM validators v
       LEFT JOIN (
         SELECT validator_address,
           SUM(total_deposited - total_withdrawn) as delegated_stake,
           COUNT(*) FILTER (WHERE total_deposited > total_withdrawn) as delegator_count
         FROM delegations GROUP BY validator_address
       ) d ON d.validator_address = v.address
       LEFT JOIN LATERAL (
         SELECT ROUND(
           COUNT(DISTINCT (ev.args->>'epoch'))::numeric /
           GREATEST(
             (SELECT COUNT(*) FROM epochs
              WHERE advanced_at_block IS NOT NULL
                AND advanced_at_block >= COALESCE(v.joined_at_block, 0)
                AND epoch >= COALESCE(
                  (SELECT MIN(epoch) FROM (
                    SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
                  ) _r), 0
                )
             ), 1
           ) * 100, 2
         ) as uptime_pct
         FROM events ev
         WHERE ev.event_name = 'ValidatorPrime'
           AND LOWER(ev.args->>'validator') = v.address
           AND (ev.args->>'epoch')::bigint >= COALESCE(
             (SELECT MIN(epoch) FROM (
               SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
             ) _recent), 0
           )
       ) u ON true
       WHERE v.address = $1`,
      [addr]
    );

    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      ...row,
      latest_primed_epoch: row.last_prime_epoch,
      recent_prime_rate_30_epochs: parseFloat(row.recent_prime_rate_30_epochs),
    };
  }

  // ============================================================
  // Validators with sort/order support
  // ============================================================

  private static readonly VALIDATOR_SORT_WHITELIST = new Set([
    "total_stake", "total_rewards", "total_slashed",
    "prime_count", "slash_count", "delegated_stake", "uptime_percentage",
  ]);

  async getValidatorsSorted(params: {
    status?: string;
    limit?: number;
    offset?: number;
    sort?: string;
    order?: "asc" | "desc";
  }) {
    const conditions: string[] = [`v.address != '${ZERO_ADDRESS}'`];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (params.status) {
      conditions.push(`v.status = $${paramIndex++}`);
      values.push(params.status);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = params.limit || 100;
    const offset = params.offset || 0;

    // Validate sort field
    const sortField = params.sort && Database.VALIDATOR_SORT_WHITELIST.has(params.sort)
      ? params.sort : "total_stake";
    const sortOrder = params.order === "asc" ? "ASC" : "DESC";

    // Wrap in a subquery so ORDER BY on aliased columns is unambiguous
    const result = await this.pool.query(
      `SELECT * FROM (
        SELECT v.*,
          COALESCE(d.delegated_stake, 0) as delegated_stake,
          COALESCE(d.delegator_count, 0) as delegator_count,
          GREATEST(v.total_stake - COALESCE(d.delegated_stake, 0), 0) as self_stake,
          COALESCE(u.uptime_pct, 0) as uptime_percentage
         FROM validators v
         LEFT JOIN (
           SELECT validator_address,
             SUM(total_deposited - total_withdrawn) as delegated_stake,
             COUNT(*) FILTER (WHERE total_deposited > total_withdrawn) as delegator_count
           FROM delegations GROUP BY validator_address
         ) d ON d.validator_address = v.address
         LEFT JOIN LATERAL (
           SELECT ROUND(
             COUNT(DISTINCT (ev.args->>'epoch'))::numeric /
             GREATEST(
               (SELECT COUNT(*) FROM epochs
                WHERE advanced_at_block IS NOT NULL
                  AND advanced_at_block >= COALESCE(v.joined_at_block, 0)
                  AND epoch >= COALESCE(
                    (SELECT MIN(epoch) FROM (
                      SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
                    ) _r), 0
                  )
               ), 1
             ) * 100, 2
           ) as uptime_pct
           FROM events ev
           WHERE ev.event_name = 'ValidatorPrime'
             AND LOWER(ev.args->>'validator') = v.address
             AND (ev.args->>'epoch')::bigint >= COALESCE(
               (SELECT MIN(epoch) FROM (
                 SELECT epoch FROM epochs WHERE advanced_at_block IS NOT NULL ORDER BY epoch DESC LIMIT 30
               ) _recent), 0
             )
         ) u ON true
         ${where}
       ) sub
       ORDER BY ${sortField} ${sortOrder}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }

  // ============================================================
  // Events with sort/order support
  // ============================================================

  private static readonly EVENT_SORT_WHITELIST = new Set([
    "block_number", "block_timestamp", "event_name", "category",
  ]);

  async getEventsSorted(params: {
    eventName?: string;
    category?: string;
    validator?: string;
    fromBlock?: bigint;
    toBlock?: bigint;
    limit?: number;
    offset?: number;
    sort?: string;
    order?: "asc" | "desc";
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
      conditions.push(`LOWER(args->>'validator') = $${paramIndex++}`);
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

    const sortField = params.sort && Database.EVENT_SORT_WHITELIST.has(params.sort)
      ? params.sort : "block_number";
    const sortOrder = params.order === "asc" ? "ASC" : "DESC";
    const secondary = sortField === "block_number" ? ", log_index DESC" : "";

    const result = await this.pool.query(
      `SELECT id, block_number, tx_hash, log_index, contract_address, event_name, category, args, block_timestamp, created_at
       FROM events ${where}
       ORDER BY ${sortField} ${sortOrder}${secondary}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );
    return result.rows;
  }
}
