import { config } from "./config.js";
import { Database } from "./db/queries.js";
import { Indexer } from "./indexer.js";
import { Api } from "./api.js";

async function main() {
  console.log("GenLayer Indexer starting...");
  console.log(`  Chain ID: ${config.chainId}`);
  console.log(`  Database: ${config.databaseUrl.replace(/:[^@]*@/, ":***@")}`);

  const db = new Database(config.databaseUrl);
  const indexer = new Indexer(db);
  const api = new Api(db, config.apiPort);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    indexer.stop();
    api.close();
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start indexing
  await indexer.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
