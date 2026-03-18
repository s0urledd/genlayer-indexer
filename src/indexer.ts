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

  // RPC latency tracking (ping = getBlockNumber, fetch = getLogs)
  private rpcPingSamples: number[] = [];
  private rpcFetchSamples: number[] = [];
  private readonly LATENCY_WINDOW = 100; // keep last 100 samples

  // Metrics snapshot interval (every 60 batches)
  private batchCount = 0;
  private readonly METRICS_INTERVAL = 60;

  // Validator status sync interval (every 30 batches ≈ 30s at 1s poll)
  private readonly VALIDATOR_SYNC_INTERVAL = 30;

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
    if (config.slashingContract) {
      console.log(`  Slashing contract: ${config.slashingContract}`);
    } else {
      console.log(`  Slashing contract: NOT CONFIGURED (SlashedFromIdleness events will not be indexed)`);
    }
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
    const currentBlock = await this.measureRpc("ping", () => this.client.getBlockNumber());

    // Index contracts in parallel
    const contracts: Array<Promise<void>> = [
      this.indexContract(
        config.stakingContract,
        STAKING_EVENTS_ABI as unknown as AbiEvent[],
        currentBlock
      ),
      this.indexContract(
        config.consensusContract,
        CONSENSUS_EVENTS_ABI as unknown as AbiEvent[],
        currentBlock
      ),
    ];
    // Slashing contract is separate — only index if configured
    if (config.slashingContract) {
      contracts.push(
        this.indexContract(
          config.slashingContract,
          SLASHING_EVENTS_ABI as unknown as AbiEvent[],
          currentBlock
        )
      );
    }
    await Promise.all(contracts);

    // Record metrics snapshot periodically
    this.batchCount++;
    if (this.batchCount % this.METRICS_INTERVAL === 0) {
      try {
        const { rpcPing } = this.getLatencyStats();
        await this.db.recordMetricsSnapshot({
          blockNumber: currentBlock,
          rpcLatencyAvg: rpcPing.avgMs,
          rpcLatencyP95: rpcPing.p95Ms,
        });
      } catch (err) {
        console.error("Failed to record metrics snapshot:", err);
      }
    }

    // Sync validator statuses from on-chain state periodically
    if (this.batchCount % this.VALIDATOR_SYNC_INTERVAL === 0) {
      try {
        await this.syncValidatorStatuses();
      } catch (err) {
        console.error("Failed to sync validator statuses:", err);
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

  /**
   * Sync validator statuses directly from staking contract state.
   * This catches any status changes that might have been missed by events
   * and ensures banned/quarantined/active statuses are always accurate.
   */
  private async syncValidatorStatuses() {
    const stakingAddr = config.stakingContract;

    // Fetch active validators
    const activeResult = await this.client.readContract({
      address: stakingAddr,
      abi: [{
        type: "function", name: "activeValidators",
        inputs: [], outputs: [{ type: "address[]", name: "" }],
        stateMutability: "view",
      }] as const,
      functionName: "activeValidators",
    });
    const activeValidators = new Set(
      (activeResult as string[]).map((a: string) => a.toLowerCase())
    );

    // Fetch quarantined validators
    const quarantineResult = await this.client.readContract({
      address: stakingAddr,
      abi: [{
        type: "function", name: "getValidatorQuarantineList",
        inputs: [], outputs: [{ type: "address[]", name: "" }],
        stateMutability: "view",
      }] as const,
      functionName: "getValidatorQuarantineList",
    });
    const quarantinedValidators = new Set(
      (quarantineResult as string[]).map((a: string) => a.toLowerCase())
    );

    // Fetch banned validators (paginated, get first 1000)
    let bannedValidators = new Set<string>();
    try {
      const bannedResult = await this.client.readContract({
        address: stakingAddr,
        abi: [{
          type: "function", name: "getAllBannedValidators",
          inputs: [
            { type: "uint256", name: "_startIndex" },
            { type: "uint256", name: "_size" },
          ],
          outputs: [{ type: "tuple[]", name: "validatorList", components: [
            { type: "address", name: "validator" },
            { type: "uint256", name: "bannedAt" },
            { type: "uint256", name: "bannedUntil" },
          ]}],
          stateMutability: "view",
        }] as const,
        functionName: "getAllBannedValidators",
        args: [0n, 1000n],
      });
      bannedValidators = new Set(
        (bannedResult as unknown as Array<{ validator: string }>).map(b => b.validator.toLowerCase())
      );
    } catch {
      // getAllBannedValidators may not be available on all versions
    }

    // Fetch active weights (parallel with status updates)
    let activeWeights: bigint[] = [];
    try {
      const weightsResult = await this.client.readContract({
        address: stakingAddr,
        abi: [{
          type: "function", name: "activeWeights",
          inputs: [], outputs: [{ type: "uint256[]", name: "" }],
          stateMutability: "view",
        }] as const,
        functionName: "activeWeights",
      });
      activeWeights = weightsResult as bigint[];
    } catch {
      // activeWeights may not be available
    }

    // Update validator statuses and weights in DB
    const activeList = [...activeValidators];
    for (let i = 0; i < activeList.length; i++) {
      const addr = activeList[i];
      const weight = activeWeights[i] ? activeWeights[i].toString() : "0";
      await this.db.upsertValidator(addr, { status: "active" });
      await this.db.updateValidatorWeight(addr, weight);
    }
    for (const addr of quarantinedValidators) {
      if (!activeValidators.has(addr)) {
        await this.db.upsertValidator(addr, { status: "quarantined" });
      }
    }
    for (const addr of bannedValidators) {
      if (!activeValidators.has(addr)) {
        await this.db.upsertValidator(addr, { status: "banned" });
      }
    }

    // Sync live stake data from validatorView() for each active validator
    for (const addr of activeList) {
      try {
        const viewResult = await this.client.readContract({
          address: stakingAddr,
          abi: [{
            type: "function", name: "validatorView",
            inputs: [{ type: "address", name: "_validator" }],
            outputs: [{ type: "tuple", name: "", components: [
              { type: "uint256", name: "stake" },
              { type: "uint256", name: "shares" },
              { type: "uint256", name: "delegatedStake" },
              { type: "uint256", name: "delegatedShares" },
              { type: "uint256", name: "totalStake" },
              { type: "uint256", name: "totalShares" },
              { type: "uint256", name: "deposited" },
              { type: "uint256", name: "withdrawn" },
            ]}],
            stateMutability: "view",
          }] as const,
          functionName: "validatorView",
          args: [addr as `0x${string}`],
        });
        const view = viewResult as unknown as {
          stake: bigint; shares: bigint;
          delegatedStake: bigint; totalStake: bigint;
        };
        await this.db.updateValidatorLiveData(addr, {
          totalStake: view.totalStake.toString(),
          totalShares: view.shares.toString(),
          delegatedStake: view.delegatedStake.toString(),
        });
      } catch {
        // validatorView may fail for some validators
      }
    }

    // Sync delegator counts per validator
    for (const addr of activeList) {
      try {
        const countResult = await this.client.readContract({
          address: stakingAddr,
          abi: [{
            type: "function", name: "validatorDelegatorCount",
            inputs: [{ type: "address", name: "_validator" }],
            outputs: [{ type: "uint256", name: "" }],
            stateMutability: "view",
          }] as const,
          functionName: "validatorDelegatorCount",
          args: [addr as `0x${string}`],
        });
        await this.db.updateValidatorDelegatorCount(addr, Number(countResult));
      } catch {
        // May not be available
      }
    }

    // Sync epoch details
    await this.syncEpochDetails();
  }

  private async syncEpochDetails() {
    const stakingAddr = config.stakingContract;
    try {
      const currentEpoch = await this.client.readContract({
        address: stakingAddr,
        abi: [{
          type: "function", name: "epoch",
          inputs: [], outputs: [{ type: "uint256", name: "" }],
          stateMutability: "view",
        }] as const,
        functionName: "epoch",
      });
      const epochNum = currentEpoch as bigint;

      // Epoch data alternates between even/odd storage slots
      const fnName = epochNum % 2n === 0n ? "epochEven" : "epochOdd";
      const epochAbi = [{
        type: "function" as const, name: fnName,
        inputs: [] as const,
        outputs: [
          { type: "uint256", name: "start" },
          { type: "uint256", name: "end" },
          { type: "uint256", name: "inflation" },
          { type: "uint256", name: "weight" },
          { type: "uint256", name: "weightDeposit" },
          { type: "uint256", name: "weightWithdrawal" },
          { type: "uint256", name: "vcount" },
          { type: "uint256", name: "claimed" },
          { type: "uint256", name: "stakeDeposit" },
          { type: "uint256", name: "stakeWithdrawal" },
          { type: "uint256", name: "slashed" },
        ],
        stateMutability: "view" as const,
      }];

      const epochData = await this.client.readContract({
        address: stakingAddr,
        abi: epochAbi,
        functionName: fnName,
      });
      const data = epochData as unknown as {
        inflation: bigint; weight: bigint;
        vcount: bigint; stakeDeposit: bigint;
        stakeWithdrawal: bigint; slashed: bigint;
      };

      await this.db.upsertEpoch(epochNum, {
        inflationAmount: data.inflation.toString(),
        validatorCount: Number(data.vcount),
        totalWeight: data.weight.toString(),
        totalStakeDeposited: data.stakeDeposit.toString(),
        totalStakeWithdrawn: data.stakeWithdrawal.toString(),
        totalSlashed: data.slashed.toString(),
      });
    } catch (err) {
      // Epoch sync is best-effort
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
    const logs = await this.measureRpc("fetch", () =>
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

    // Only advance cursor after events are fully processed
    // If processEvents threw, we'll re-process on next run (insertEvents uses ON CONFLICT DO NOTHING)
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
        // Log but re-throw to prevent setLastBlock from advancing past failed events
        console.error(`Error processing event ${event.eventName} at block ${event.blockNumber}:`, err);
        throw err;
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
        const claimAmount = args.amount as string | undefined;
        if (claimAmount) {
          // Reduce stake by claimed amount (post-exit withdrawal)
          await this.db.decrementValidatorStake(validator, claimAmount);
        }
        await this.db.upsertValidator(validator, {
          status: "inactive",
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorPrime": {
        const validator = (args.validator as string).toLowerCase();
        const epoch = BigInt(args.epoch as string);
        const validatorRewards = (args.validatorRewards as string) || "0";
        const delegatorRewards = (args.delegatorRewards as string) || "0";
        const feeRewards = (args.feeRewards as string) || "0";
        const feePenalties = (args.feePenalties as string) || "0";

        await this.db.incrementValidatorPrime(validator, {
          validatorRewards,
          delegatorRewards,
          feeRewards,
          feePenalties,
          epoch,
        });
        await this.db.upsertValidator(validator, {
          lastSeenBlock: blockNumber,
        });
        break;
      }

      case "ValidatorSlash": {
        const validator = (args.validator as string).toLowerCase();
        const validatorSlashing = (args.validatorSlashing as string) || "0";
        const delegatorSlashing = (args.delegatorSlashing as string) || "0";

        await this.db.incrementValidatorSlash(validator, validatorSlashing, delegatorSlashing);
        await this.db.upsertValidator(validator, {
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
        // Snapshot current active validator count at epoch boundary
        const activeCount = await this.db.getActiveValidatorCount();
        await this.db.upsertEpoch(epoch, {
          advancedAtBlock: blockNumber,
          advancedAtTimestamp: event.blockTimestamp,
          validatorCount: activeCount,
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
        const voteResult = parseInt(args.result as string);
        await this.db.upsertValidatorTxParticipation(txId, validator, {
          voteRevealed: true,
          voteType,
          voteResult: isNaN(voteResult) ? undefined : voteResult,
          blockNumber,
        });
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
        const appellant = args.appellant as string;
        const bond = (args.bond as string) || "0";
        const appealValidators = args.validators as string[];
        await this.db.incrementConsensusTxAppeal(txId, appellant, bond);
        // Register appeal validators as participants
        if (appealValidators) {
          for (const v of appealValidators) {
            await this.db.upsertValidatorTxParticipation(txId, v, {
              role: "appeal_validator",
              blockNumber,
            });
          }
        }
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

      // Economics events — stored in raw events table, amounts tracked via epoch/inflation
      case "FeesReceived":
      case "BurnToL1":
      case "BurnFailed":
      case "InflationInitiated":
        break;

      // Delegator claim — no delegation state change needed (just a reward withdrawal)
      case "DelegatorClaim":
        break;

      // Epoch lifecycle events — stored in raw events
      case "EpochZeroEnded":
      case "EpochHasPendingTribunals":
        break;

      // Quarantine batch cleanup — individual quarantine events already tracked
      case "QuarantinesCleanedUp":
        break;

      // Validator registration batch — individual joins already tracked
      case "ValidatorsRegistered":
        break;

      // Governance parameter changes — stored in raw events for audit trail
      case "SetValidatorMinimumStake":
      case "SetDelegatorMinimumStake":
      case "SetMaxValidators":
      case "SetEpochMinDuration":
      case "SetEpochMinDurationThreshold":
      case "SetEpochZeroMinDuration":
      case "SetValidatorWeightParams":
      case "SetUnbondingPeriods":
      case "SetReductionFactor":
      case "SetGen":
      case "SetDeepthought":
      case "SetTransactionFeesManager":
      case "SetStakingInvariant":
        break;

      case "SlashedFromIdleness": {
        const validator = (args.validator as string).toLowerCase();
        const percentage = args.percentage as string;

        // Calculate slashed amount from percentage (basis points: 100 = 1%) and current stake
        let slashAmount = "0";
        if (percentage) {
          const current = await this.db.getValidator(validator);
          if (current?.total_stake) {
            const stake = BigInt(current.total_stake);
            const pct = BigInt(percentage);
            slashAmount = ((stake * pct) / 10000n).toString();
          }
        }

        await this.db.incrementValidatorSlash(validator, slashAmount, "0");
        await this.db.upsertValidator(validator, {
          lastSeenBlock: blockNumber,
        });
        break;
      }

      // Infrastructure events — stored in raw events table, no aggregation
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

      default:
        // Unknown event — already stored in raw events table
        console.warn(`Unhandled event: ${eventName}`);
        break;
    }
  }

  // Measure and record RPC call duration
  private async measureRpc<T>(type: "ping" | "fetch", fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    const samples = type === "ping" ? this.rpcPingSamples : this.rpcFetchSamples;
    samples.push(duration);
    if (samples.length > this.LATENCY_WINDOW) {
      samples.shift();
    }
    return result;
  }

  private computeStats(samples: number[]) {
    if (samples.length === 0) {
      return { avgMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, samples: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
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

  // Expose latency stats for the API
  getLatencyStats() {
    return {
      rpcPing: this.computeStats(this.rpcPingSamples),
      logFetch: this.computeStats(this.rpcFetchSamples),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
