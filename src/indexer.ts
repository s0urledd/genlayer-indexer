import {
  createPublicClient,
  http,
  parseAbiItem,
  type Log,
  type AbiEvent,
  decodeEventLog,
} from "viem";
import { config } from "./config.js";
import { STAKING_EVENTS_ABI, SLASHING_EVENTS_ABI, EVENT_CATEGORIES } from "./abi.js";
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
    const currentBlock = await this.client.getBlockNumber();

    // Index staking contract
    await this.indexContract(
      config.stakingContract,
      STAKING_EVENTS_ABI as unknown as AbiEvent[],
      currentBlock
    );

    // Index slashing events from consensus contract
    // (SlashedFromIdleness comes from a separate slashing contract,
    //  but we check consensus address as well)
    await this.indexContract(
      config.consensusContract,
      SLASHING_EVENTS_ABI as unknown as AbiEvent[],
      currentBlock
    );
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
    const logs = await this.client.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock,
    });

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

    // Build combined ABI for decoding
    const combinedAbi = [...eventAbis];

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

        // Try to get block timestamp
        let blockTimestamp: Date | undefined;
        try {
          const block = await this.client.getBlock({
            blockNumber: log.blockNumber,
          });
          blockTimestamp = new Date(Number(block.timestamp) * 1000);
        } catch {
          // Timestamp is optional, continue without it
        }

        decoded.push({
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex ?? 0,
          contractAddress: contractAddress.toLowerCase(),
          eventName: result.eventName,
          args,
          blockTimestamp,
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
        // We'd need to add to existing stake; for now just update last seen
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
        });
        break;
      }

      case "EpochFinalize": {
        const epoch = BigInt(args.epoch as string);
        await this.db.upsertEpoch(epoch, {
          finalizedAtBlock: blockNumber,
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

      case "SlashedFromIdleness": {
        const validator = (args.validator as string).toLowerCase();
        const current = await this.db.getValidator(validator);
        const newSlashCount = (current?.slash_count || 0) + 1;

        await this.db.upsertValidator(validator, {
          slashCount: newSlashCount,
          lastSeenBlock: blockNumber,
        });
        break;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
