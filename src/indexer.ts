import {
  createPublicClient,
  http,
  type Log,
  type AbiEvent,
  decodeEventLog,
} from "viem";
import { config } from "./config.js";
import { STAKING_EVENTS_ABI, SLASHING_EVENTS_ABI, CONSENSUS_EVENTS_ABI, EVENT_CATEGORIES, VOTE_TYPES, TX_STATUSES } from "./abi.js";
import { Database } from "./db/queries.js";

// Build a custom chain definition for GenLayer
const genlayerChain = {
  id: config.chainId,
  name: "GenLayer Bradbury Testnet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcUrl] },
  },
} as const;

export class Indexer {
  private client;
  private db: Database;
  private running = false;
  // Block timestamp cache - avoids N+1 RPC calls per batch
  private blockTimestampCache = new Map<bigint, Date>();
  private readonly TIMESTAMP_CACHE_MAX = 5000;

  // RPC latency tracking
  private rpcLatencySamples: number[] = [];
  private readonly LATENCY_WINDOW = 100; // keep last 100 samples

  // Metrics snapshot interval (every 60 batches ≈ 5 minutes at 5s poll)
  private batchCount = 0;
  private readonly METRICS_INTERVAL = 60;

  constructor(db: Database) {
    this.client = createPublicClient({
      chain: genlayerChain,
      transport: http(config.rpcUrl),
    });
    this.db = db;
  }

  async start() {
    this.running = true;
    console.log(`Indexer starting...`);
    console.log(`  RPC: ${config.rpcUrl}`);
    console.log(`  Staking contract: ${config.stakingContract}`);
    console.log(`  Consensus contract: ${config.consensusContract}`);
    console.log(`  Batch size: ${config.batchSize}`);
    console.log(`  Poll interval: ${config.pollIntervalMs}ms`);

    while (this.running) {
      try {
        await this.indexBatch();
      } catch (err) {
        console.error("Indexer error:", err);
        // Wait before retrying on error
        await this.sleep(config.pollIntervalMs * 2);
      }
      await this.sleep(config.pollIntervalMs);
    }
  }

  stop() {
    this.running = false;
    console.log("Indexer stopping...");
  }

  private async indexBatch() {
    const currentBlock = await this.measureRpc(() => this.client.getBlockNumber());

    // Index both contracts in parallel for ~2x faster catch-up
    await Promise.all([
      this.indexContract(
        config.stakingContract,
        STAKING_EVENTS_ABI as unknown as AbiEvent[],
        currentBlock
      ),
      this.indexContract(
        config.consensusContract,
        [...SLASHING_EVENTS_ABI, ...CONSENSUS_EVENTS_ABI] as unknown as AbiEvent[],
        currentBlock
      ),
    ]);

    // Record metrics snapshot periodically
    this.batchCount++;
    if (this.batchCount % this.METRICS_INTERVAL === 0) {
      try {
        const latency = this.getLatencyStats();
        await this.db.recordMetricsSnapshot({
          blockNumber: currentBlock,
          rpcLatencyAvg: latency.avgMs,
          rpcLatencyP95: latency.p95Ms,
        });
      } catch (err) {
        console.error("Failed to record metrics snapshot:", err);
      }
    }

    // Evict old cache entries to prevent memory bloat
    if (this.blockTimestampCache.size > this.TIMESTAMP_CACHE_MAX) {
      const entries = [...this.blockTimestampCache.entries()]
        .sort((a, b) => Number(a[0] - b[0]));
      const toRemove = entries.slice(0, entries.length - this.TIMESTAMP_CACHE_MAX / 2);
      for (const [key] of toRemove) {
        this.blockTimestampCache.delete(key);
      }
    }
  }

  private async indexContract(
    contractAddress: `0x${string}`,
    eventAbis: AbiEvent[],
    currentBlock: bigint
  ) {
    const lastBlock = await this.db.getLastBlock(contractAddress);
    const fromBlock = lastBlock > 0n ? lastBlock + 1n : config.startBlock;

    if (fromBlock > currentBlock) return;

    const toBlock =
      currentBlock - fromBlock > BigInt(config.batchSize)
        ? fromBlock + BigInt(config.batchSize)
        : currentBlock;

    const isCatchingUp = toBlock < currentBlock;
    if (isCatchingUp) {
      const progress = Number(toBlock) / Number(currentBlock) * 100;
      console.log(
        `[${contractAddress.slice(0, 10)}...] Indexing blocks ${fromBlock}-${toBlock} / ${currentBlock} (${progress.toFixed(1)}%)`
      );
    }

    // Fetch all logs from this contract in the block range
    const logs = await this.measureRpc(() =>
      this.client.getLogs({
        address: contractAddress,
        fromBlock,
        toBlock,
      })
    );

    if (logs.length > 0) {
      console.log(
        `[${contractAddress.slice(0, 10)}...] Found ${logs.length} logs in blocks ${fromBlock}-${toBlock}`
      );
    }

    // Decode and store events
    const decodedEvents = await this.decodeLogs(logs, eventAbis, contractAddress);

    if (decodedEvents.length > 0) {
      await this.db.insertEvents(decodedEvents);
      await this.processEvents(decodedEvents);
      console.log(
        `[${contractAddress.slice(0, 10)}...] Stored ${decodedEvents.length} events`
      );
    }

    await this.db.setLastBlock(contractAddress, toBlock);
  }

  private async decodeLogs(
    logs: Log[],
    eventAbis: AbiEvent[],
    contractAddress: string
  ) {
    const decoded: Array<{
      blockNumber: bigint;
      txHash: string;
      logIndex: number;
      contractAddress: string;
      eventName: string;
      args: Record<string, unknown>;
      blockTimestamp?: Date;
    }> = [];

    const combinedAbi = [...eventAbis];

    // Batch-fetch block timestamps: collect unique block numbers first,
    // then fetch only the ones not already in cache (fixes N+1 RPC problem)
    const uniqueBlocks = new Set<bigint>();
    for (const log of logs) {
      if (log.blockNumber && !this.blockTimestampCache.has(log.blockNumber)) {
        uniqueBlocks.add(log.blockNumber);
      }
    }

    if (uniqueBlocks.size > 0) {
      // Fetch blocks in parallel batches of 20 to avoid overwhelming RPC
      const blockNumbers = [...uniqueBlocks];
      const PARALLEL_LIMIT = 20;
      for (let i = 0; i < blockNumbers.length; i += PARALLEL_LIMIT) {
        const batch = blockNumbers.slice(i, i + PARALLEL_LIMIT);
        const results = await Promise.allSettled(
          batch.map((bn) => this.client.getBlock({ blockNumber: bn }))
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "fulfilled") {
            this.blockTimestampCache.set(
              batch[j],
              new Date(Number(result.value.timestamp) * 1000)
            );
          }
        }
      }
    }

    for (const log of logs) {
      if (!log.blockNumber || !log.transactionHash) continue;

      try {
        const result = decodeEventLog({
          abi: combinedAbi,
          data: log.data,
          topics: log.topics,
        });

        // Convert args to a plain object with string values for bigints
        const args: Record<string, unknown> = {};
        if (result.args && typeof result.args === "object") {
          for (const [key, value] of Object.entries(
            result.args as Record<string, unknown>
          )) {
            args[key] = typeof value === "bigint" ? value.toString() : value;
          }
        }

        decoded.push({
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          contractAddress: contractAddress.toLowerCase(),
          eventName: result.eventName,
          args,
          blockTimestamp: this.blockTimestampCache.get(log.blockNumber),
        });
      } catch {
        // Log doesn't match any of our event ABIs - skip
        continue;
      }
    }

    return decoded;
  }

  private async processEvents(
    events: Array<{
      blockNumber: bigint;
      eventName: string;
      args: Record<string, unknown>;
      blockTimestamp?: Date;
    }>
  ) {
    for (const event of events) {
      try {
        await this.processEvent(event);
      } catch (err) {
        console.error(`Error processing event ${event.eventName}:`, err);
      }
    }
  }

  private async processEvent(event: {
    blockNumber: bigint;
    eventName: string;
    args: Record<string, unknown>;
    blockTimestamp?: Date;
  }) {
    const { eventName, args, blockNumber } = event;

    switch (eventName) {
      case "ValidatorJoin": {
        const validator = (args.validator as string).toLowerCase();
        const operator = (args.operator as string).toLowerCase();
        const amount = args.amount as string;
        await this.db.upsertValidator(validator, {
          operator,
          status: "active",
          totalStake: amount,
          joinedAtBlock: blockNumber,
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorDeposit": {
        const validator = (args.validator as string).toLowerCase();
        const amount = args.amount as string;
        // Add deposit amount to existing stake
        await this.db.incrementValidatorStake(validator, amount);
        await this.db.upsertValidator(validator, {
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorExit": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          status: "exiting",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorClaim": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorPrime": {
        const validator = (args.validator as string).toLowerCase();
        const epoch = BigInt(args.epoch as string);
        const validatorRewards = args.validatorRewards as string;

        // Get current validator to increment counters
        const current = await this.db.getValidator(validator);
        const newPrimeCount = (current?.prime_count || 0) + 1;
        const newTotalRewards = (
          BigInt(current?.total_rewards || "0") + BigInt(validatorRewards)
        ).toString();

        await this.db.upsertValidator(validator, {
          primeCount: newPrimeCount,
          totalRewards: newTotalRewards,
          lastPrimeEpoch: epoch,
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorSlash": {
        const validator = (args.validator as string).toLowerCase();
        const validatorSlashing = args.validatorSlashing as string;
        const epoch = BigInt(args.epoch as string);

        const current = await this.db.getValidator(validator);
        const newSlashCount = (current?.slash_count || 0) + 1;
        const newTotalSlashed = (
          BigInt(current?.total_slashed || "0") + BigInt(validatorSlashing)
        ).toString();

        await this.db.upsertValidator(validator, {
          slashCount: newSlashCount,
          totalSlashed: newTotalSlashed,
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorBannedIdleness":
      case "ValidatorBannedDeterministic": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          status: "banned",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "AllValidatorBansRemoved": {
        // Reset ALL banned validators back to active
        await this.db.resetAllBannedValidators();
        break;
      }

      case "ValidatorBanRemoved": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          status: "active",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorQuarantined": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          status: "quarantined",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorQuarantineRemoved":
      case "ValidatorQuarantineRepealed": {
        const validator = (args.validator as string).toLowerCase();
        await this.db.upsertValidator(validator, {
          status: "active",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "EpochAdvance": {
        const epoch = BigInt(args.epoch as string);
        await this.db.upsertEpoch(epoch, {
          advancedAtBlock: blockNumber,
          advancedAtTimestamp: event.blockTimestamp,
        });
        break;
      }

      case "EpochFinalize": {
        const epoch = BigInt(args.epoch as string);
        await this.db.upsertEpoch(epoch, {
          finalizedAtBlock: blockNumber,
          finalizedAtTimestamp: event.blockTimestamp,
        });
        break;
      }

      case "InflationReceived": {
        const epoch = BigInt(args.epoch as string);
        const amount = args.amount as string;
        await this.db.upsertEpoch(epoch, {
          inflationAmount: amount,
        });
        break;
      }

      case "DelegatorJoin": {
        const validator = (args.validator as string).toLowerCase();
        const delegator = (args.delegator as string).toLowerCase();
        const amount = args.amount as string;
        await this.db.upsertDelegation(validator, delegator, amount, "0");
        break;
      }

      case "DelegatorExit": {
        const validator = (args.validator as string).toLowerCase();
        const delegator = (args.delegator as string).toLowerCase();
        const amount = args.amount as string;
        await this.db.upsertDelegation(validator, delegator, "0", amount);
        break;
      }

      // ============================================================
      // Consensus Contract Events
      // ============================================================

      case "NewTransaction": {
        const txId = args.txId as string;
        const recipient = args.recipient as string;
        const activator = args.activator as string;
        await this.db.upsertConsensusTx(txId, {
          recipient,
          activator,
          status: "pending",
          createdAtBlock: blockNumber,
          createdAtTimestamp: event.blockTimestamp,
        });
        break;
      }

      case "TransactionActivated": {
        const txId = args.txId as string;
        const leader = args.leader as string;
        await this.db.upsertConsensusTx(txId, {
          leader,
          status: "proposing",
        });
        // Leader participates with role "leader"
        await this.db.upsertValidatorTxParticipation(txId, leader, {
          role: "leader",
          blockNumber,
        });
        break;
      }

      case "TransactionReceiptProposed": {
        const txId = args.txId as string;
        const validators = args.validators as string[];
        await this.db.upsertConsensusTx(txId, {
          status: "committing",
          validators,
        });
        // Register all validators as participants
        for (const v of validators) {
          await this.db.upsertValidatorTxParticipation(txId, v, {
            role: "validator",
            blockNumber,
          });
        }
        break;
      }

      case "VoteCommitted": {
        const txId = args.txId as string;
        const validator = args.validator as string;
        await this.db.upsertValidatorTxParticipation(txId, validator, {
          voteCommitted: true,
          blockNumber,
        });
        break;
      }

      case "VoteRevealed": {
        const txId = args.txId as string;
        const validator = args.validator as string;
        const voteTypeNum = parseInt(args.voteType as string);
        const voteType = VOTE_TYPES[voteTypeNum] || `UNKNOWN_${voteTypeNum}`;
        await this.db.upsertValidatorTxParticipation(txId, validator, {
          voteRevealed: true,
          voteType,
          blockNumber,
        });
        await this.db.upsertConsensusTx(txId, { voteType });
        break;
      }

      case "AllVotesCommitted": {
        const txId = args.txId as string;
        const statusNum = parseInt(args.newStatus as string);
        const status = TX_STATUSES[statusNum]?.toLowerCase() || "committing";
        await this.db.upsertConsensusTx(txId, { status });
        break;
      }

      case "TransactionAccepted": {
        const txId = args.txId as string;
        await this.db.upsertConsensusTx(txId, {
          status: "accepted",
          acceptedAtBlock: blockNumber,
        });
        break;
      }

      case "TransactionFinalized": {
        const txId = args.txId as string;
        await this.db.upsertConsensusTx(txId, {
          status: "finalized",
          finalizedAtBlock: blockNumber,
        });
        break;
      }

      case "TransactionUndetermined": {
        const txId = args.txId as string;
        await this.db.upsertConsensusTx(txId, { status: "undetermined" });
        break;
      }

      case "TransactionCancelled": {
        const txId = args.txId as string;
        await this.db.upsertConsensusTx(txId, { status: "cancelled" });
        break;
      }

      case "TransactionLeaderRotated": {
        const txId = args.txId as string;
        const newLeader = args.newLeader as string;
        await this.db.upsertConsensusTx(txId, { leader: newLeader });
        await this.db.incrementConsensusTxRotation(txId);
        await this.db.upsertValidatorTxParticipation(txId, newLeader, {
          role: "leader",
          blockNumber,
        });
        break;
      }

      case "TransactionLeaderTimeout":
      case "LeaderIdlenessProcessed":
      case "ProcessIdlenessAccepted": {
        // These are tracked via raw events, no extra aggregation needed
        break;
      }

      case "AppealStarted": {
        const txId = args.txId as string;
        await this.db.incrementConsensusTxAppeal(txId);
        break;
      }

      case "TribunalAppealVoteCommitted": {
        const txId = args.txId as string;
        const validator = args.validator as string;
        await this.db.upsertValidatorTxParticipation(txId, validator, {
          role: "appeal_validator",
          voteCommitted: true,
          blockNumber,
        });
        break;
      }

      case "TribunalAppealVoteRevealed": {
        const txId = args.txId as string;
        const validator = args.validator as string;
        const voteTypeNum = parseInt(args.voteType as string);
        const voteType = VOTE_TYPES[voteTypeNum] || `UNKNOWN_${voteTypeNum}`;
        await this.db.upsertValidatorTxParticipation(txId, validator, {
          voteRevealed: true,
          voteType,
          blockNumber,
        });
        break;
      }

      case "ValidatorReplaced": {
        const txId = args.txId as string;
        const newValidator = args.newValidator as string;
        await this.db.upsertValidatorTxParticipation(txId, newValidator, {
          role: "validator",
          blockNumber,
        });
        break;
      }

      // Infrastructure events - stored in raw events table, no aggregation
      case "CreatedTransaction":
      case "TransactionFinalizationFailed":
      case "TransactionNeedsRecomputation":
      case "TransactionLeaderRevealed":
      case "BatchFinalizationCompleted":
      case "InternalMessageProcessed":
      case "ValueWithdrawalFailed":
      case "ActivatorReplaced":
      case "AddressManagerSet":
        break;

      case "SlashedFromIdleness": {
        const validator = (args.validator as string).toLowerCase();
        const percentage = args.percentage as string;
        const current = await this.db.getValidator(validator);
        const newSlashCount = (current?.slash_count || 0) + 1;

        // Calculate slashed amount from percentage and current stake
        let slashAmount = "0";
        if (current?.total_stake && percentage) {
          const stake = BigInt(current.total_stake);
          const pct = BigInt(percentage);
          // percentage is in basis points or direct - divide by 100
          slashAmount = ((stake * pct) / 100n).toString();
        }

        const newTotalSlashed = (
          BigInt(current?.total_slashed || "0") + BigInt(slashAmount)
        ).toString();

        await this.db.upsertValidator(validator, {
          slashCount: newSlashCount,
          totalSlashed: newTotalSlashed,
          lastSeenBlock: blockNumber,
        });
        break;
      }
    }
  }

  // Measure and record RPC latency for a given async call
  private async measureRpc<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const latency = performance.now() - start;
    this.rpcLatencySamples.push(latency);
    if (this.rpcLatencySamples.length > this.LATENCY_WINDOW) {
      this.rpcLatencySamples.shift();
    }
    return result;
  }

  // Expose latency stats for the API
  getLatencyStats(): {
    avgMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    samples: number;
  } {
    if (this.rpcLatencySamples.length === 0) {
      return { avgMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, samples: 0 };
    }
    const sorted = [...this.rpcLatencySamples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p = (pct: number) => sorted[Math.floor(sorted.length * pct)] || 0;
    return {
      avgMs: Math.round(sum / sorted.length),
      minMs: Math.round(sorted[0]),
      maxMs: Math.round(sorted[sorted.length - 1]),
      p50Ms: Math.round(p(0.5)),
      p95Ms: Math.round(p(0.95)),
      samples: sorted.length,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
