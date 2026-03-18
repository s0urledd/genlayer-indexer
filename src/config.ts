import "dotenv/config";

export const config = {
  rpcUrl: process.env.RPC_URL || "https://zksync-os-testnet-genlayer.zksync.dev",
  stakingContract: (process.env.STAKING_CONTRACT ||
    "0x4A4449E617F8D10FDeD0b461CadEf83939E821A5") as `0x${string}`,
  consensusContract: (process.env.CONSENSUS_CONTRACT ||
    "0x0112Bf6e83497965A5fdD6Dad1E447a6E004271D") as `0x${string}`,
  // Slashing contract is separate from consensus — discovered via staking.getSlashingAddress()
  // If not set, SlashedFromIdleness events won't be indexed
  slashingContract: (process.env.SLASHING_CONTRACT || "") as `0x${string}`,
  chainId: parseInt(process.env.CHAIN_ID || "4221"),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://genlayer:genlayer@localhost:5432/genlayer_indexer",
  batchSize: parseInt(process.env.BATCH_SIZE || "1000"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000"),
  startBlock: BigInt(process.env.START_BLOCK || "0"),
  apiPort: parseInt(process.env.API_PORT || "3000"),
};
