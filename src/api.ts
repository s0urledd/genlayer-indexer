import http from "node:http";
import { URL } from "node:url";
import { Database } from "./db/queries.js";
import type { Indexer } from "./indexer.js";

type RouteHandler = (
  params: URLSearchParams,
  pathParts: string[]
) => Promise<unknown>;

export class Api {
  private server: http.Server;
  private db: Database;
  private indexer?: Indexer;
  private routes: Map<string, RouteHandler> = new Map();

  constructor(db: Database, port: number, indexer?: Indexer) {
    this.db = db;
    this.indexer = indexer;
    this.registerRoutes();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(port, () => {
      console.log(`API server listening on http://localhost:${port}`);
      console.log("Available endpoints:");
      console.log("  GET /health                          - Health check");
      console.log("  GET /stats                           - Network overview stats");
      console.log("  GET /stats/network-uptime             - Per-epoch network uptime");
      console.log("  GET /stats/timeline                  - Historical metrics time-series");
      console.log("  GET /stats/throughput                - Event throughput by hour");
      console.log("  GET /stats/latency                   - Live RPC latency metrics");
      console.log("  GET /validators                      - List all validators");
      console.log("  GET /validators/:address             - Single validator details");
      console.log("  GET /validators/:address/history     - Validator event history");
      console.log("  GET /validators/:address/uptime      - Epoch-by-epoch uptime");
      console.log("  GET /validators/:address/delegations - Delegations for validator");
      console.log("  GET /validators/:address/transactions - Consensus tx participation");
      console.log("  GET /consensus/stats                 - Consensus transaction stats");
      console.log("  GET /epochs                          - List epochs");
      console.log("  GET /epochs/:epoch                   - Single epoch details");
      console.log("  GET /epochs/durations                - Epoch duration analysis");
      console.log("  GET /events                          - Query all events");
      console.log("  GET /events/slashes                  - Recent slashing events");
      console.log("  GET /delegations                     - Query delegations");
    });
  }

  close() {
    this.server.close();
  }

  private registerRoutes() {
    // ──────────────────────────────────────────────────────────
    // GET /health
    // Returns indexer health status
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /health", async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }));

    // ──────────────────────────────────────────────────────────
    // GET /stats
    // Network overview: validator counts, total staked, latest epoch, etc.
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats", async () => {
      return this.db.getNetworkStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators
    // List all validators, ordered by stake descending
    // Query params:
    //   ?status=active|banned|quarantined|exiting
    //   ?limit=100  (default 100)
    //   ?offset=0   (default 0)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators", async (params) => {
      return this.db.getValidators({
        status: params.get("status") || undefined,
        limit: parseInt(params.get("limit") || "100"),
        offset: parseInt(params.get("offset") || "0"),
      });
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address
    // Single validator details: stake, rewards, slash count, status
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address", async (_params, parts) => {
      const address = parts[2]; // /validators/0x...
      const validator = await this.db.getValidator(address);
      if (!validator) return { error: "Validator not found" };
      return validator;
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/history
    // All events related to this validator, most recent first
    // Query params:
    //   ?limit=50  (default 50)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/history", async (params, parts) => {
      const address = parts[2];
      const limit = parseInt(params.get("limit") || "50");
      return this.db.getValidatorHistory(address, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/uptime
    // Epoch-by-epoch prime/miss status for uptime visualization
    // Query params:
    //   ?epochs=30  (default 30, how many epochs to look back)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/uptime", async (params, parts) => {
      const address = parts[2];
      const epochCount = parseInt(params.get("epochs") || "30");
      const uptimeData = await this.db.getValidatorUptimeByEpoch(address, epochCount);
      const totalEpochs = uptimeData.length;
      const primedEpochs = uptimeData.filter((e) => e.primed).length;
      return {
        address: address.toLowerCase(),
        totalEpochs,
        primedEpochs,
        missedEpochs: totalEpochs - primedEpochs,
        uptimePercentage:
          totalEpochs > 0
            ? ((primedEpochs / totalEpochs) * 100).toFixed(2)
            : "0.00",
        epochs: uptimeData,
      };
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/delegations
    // Delegations for a specific validator
    // Query params:
    //   ?limit=100  (default 100)
    //   ?offset=0   (default 0)
    // ──────────────────────────────────────────────────────────
    this.routes.set(
      "GET /validators/:address/delegations",
      async (params, parts) => {
        const address = parts[2];
        return this.db.getDelegations({
          validator: address,
          limit: parseInt(params.get("limit") || "100"),
          offset: parseInt(params.get("offset") || "0"),
        });
      }
    );

    // ──────────────────────────────────────────────────────────
    // GET /epochs
    // List epochs, most recent first
    // Query params:
    //   ?limit=50   (default 50)
    //   ?offset=0   (default 0)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs", async (params) => {
      return this.db.getEpochs(
        parseInt(params.get("limit") || "50"),
        parseInt(params.get("offset") || "0")
      );
    });

    // ──────────────────────────────────────────────────────────
    // GET /epochs/:epoch
    // Single epoch details
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs/:epoch", async (_params, parts) => {
      const epoch = BigInt(parts[2]);
      const epochData = await this.db.getEpoch(epoch);
      if (!epochData) return { error: "Epoch not found" };
      return epochData;
    });

    // ──────────────────────────────────────────────────────────
    // GET /events
    // Query all indexed events with filters
    // Query params:
    //   ?event_name=ValidatorPrime    (filter by event name)
    //   ?category=slashing            (filter by category)
    //   ?validator=0x...              (filter by validator address in args)
    //   ?from_block=1000              (filter by min block number)
    //   ?to_block=2000                (filter by max block number)
    //   ?limit=100                    (default 100)
    //   ?offset=0                     (default 0)
    //
    // Categories: validator_lifecycle, delegator_lifecycle, slashing,
    //             quarantine, epoch, economics, governance
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /events", async (params) => {
      const fromBlock = params.get("from_block");
      const toBlock = params.get("to_block");
      return this.db.getEvents({
        eventName: params.get("event_name") || undefined,
        category: params.get("category") || undefined,
        validator: params.get("validator") || undefined,
        fromBlock: fromBlock ? BigInt(fromBlock) : undefined,
        toBlock: toBlock ? BigInt(toBlock) : undefined,
        limit: parseInt(params.get("limit") || "100"),
        offset: parseInt(params.get("offset") || "0"),
      });
    });

    // ──────────────────────────────────────────────────────────
    // GET /events/slashes
    // Recent slashing events (shortcut for ?category=slashing)
    // Query params:
    //   ?limit=20  (default 20)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /events/slashes", async (params) => {
      return this.db.getRecentSlashes(parseInt(params.get("limit") || "20"));
    });

    // ──────────────────────────────────────────────────────────
    // GET /delegations
    // Query delegations across all validators
    // Query params:
    //   ?validator=0x...   (filter by validator)
    //   ?delegator=0x...   (filter by delegator)
    //   ?limit=100         (default 100)
    //   ?offset=0          (default 0)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /delegations", async (params) => {
      return this.db.getDelegations({
        validator: params.get("validator") || undefined,
        delegator: params.get("delegator") || undefined,
        limit: parseInt(params.get("limit") || "100"),
        offset: parseInt(params.get("offset") || "0"),
      });
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/transactions
    // Consensus transactions this validator participated in
    // Query params:
    //   ?limit=50   (default 50)
    //   ?offset=0   (default 0)
    // ──────────────────────────────────────────────────────────
    this.routes.set(
      "GET /validators/:address/transactions",
      async (params, parts) => {
        const address = parts[2];
        const limit = parseInt(params.get("limit") || "50");
        const offset = parseInt(params.get("offset") || "0");
        return this.db.getConsensusTxForValidator(address, limit, offset);
      }
    );

    // ──────────────────────────────────────────────────────────
    // GET /consensus/stats
    // Consensus transaction statistics
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /consensus/stats", async () => {
      return this.db.getConsensusTxStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/network-uptime
    // Per-epoch network uptime (% of validators that primed)
    // Query params:
    //   ?epochs=30  (default 30)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/network-uptime", async (params) => {
      const epochCount = parseInt(params.get("epochs") || "30");
      return this.db.getNetworkUptimeByEpoch(epochCount);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/timeline
    // Network metrics time-series for dashboard charts
    // Query params:
    //   ?hours=24    (how far back, default 24)
    //   ?limit=200   (max data points, default 200)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/timeline", async (params) => {
      const hours = parseInt(params.get("hours") || "24");
      const limit = parseInt(params.get("limit") || "200");
      return this.db.getMetricsTimeline(hours, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/throughput
    // Event throughput breakdown by hour and category
    // Query params:
    //   ?hours=24    (how far back, default 24)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/throughput", async (params) => {
      const hours = parseInt(params.get("hours") || "24");
      return this.db.getThroughputStats(hours);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/latency
    // Live RPC latency metrics from the indexer
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/latency", async () => {
      if (!this.indexer) {
        return { error: "Indexer not connected" };
      }
      return this.indexer.getLatencyStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /epochs/durations
    // Epoch duration analysis with per-epoch prime/slash counts
    // Query params:
    //   ?limit=50    (default 50)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs/durations", async (params) => {
      const limit = parseInt(params.get("limit") || "50");
      return this.db.getEpochDurations(limit);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      this.sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://localhost`);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const params = url.searchParams;

      // Match route
      const handler = this.matchRoute(req.method, pathParts);
      if (!handler) {
        this.sendJson(res, 404, {
          error: "Not found",
          availableEndpoints: [
            "GET /health",
            "GET /stats",
            "GET /stats/network-uptime",
            "GET /stats/timeline",
            "GET /stats/throughput",
            "GET /stats/latency",
            "GET /validators",
            "GET /validators/:address",
            "GET /validators/:address/history",
            "GET /validators/:address/uptime",
            "GET /validators/:address/delegations",
            "GET /validators/:address/transactions",
            "GET /consensus/stats",
            "GET /epochs",
            "GET /epochs/:epoch",
            "GET /epochs/durations",
            "GET /events",
            "GET /events/slashes",
            "GET /delegations",
          ],
        });
        return;
      }

      const result = await handler(params, ["", ...pathParts]);
      this.sendJson(res, 200, result);
    } catch (err) {
      console.error("API error:", err);
      this.sendJson(res, 500, { error: "Internal server error" });
    }
  }

  private matchRoute(
    method: string,
    pathParts: string[]
  ): RouteHandler | null {
    const path = pathParts.join("/");

    // Exact matches first
    const exactKey = `${method} /${path}`;
    if (this.routes.has(exactKey)) {
      return this.routes.get(exactKey)!;
    }

    // Parameterized matches
    // /validators/:address/history
    if (
      pathParts.length === 3 &&
      pathParts[0] === "validators" &&
      pathParts[2] === "history"
    ) {
      return this.routes.get("GET /validators/:address/history")!;
    }

    // /validators/:address/uptime
    if (
      pathParts.length === 3 &&
      pathParts[0] === "validators" &&
      pathParts[2] === "uptime"
    ) {
      return this.routes.get("GET /validators/:address/uptime")!;
    }

    // /validators/:address/delegations
    if (
      pathParts.length === 3 &&
      pathParts[0] === "validators" &&
      pathParts[2] === "delegations"
    ) {
      return this.routes.get("GET /validators/:address/delegations")!;
    }

    // /validators/:address/transactions
    if (
      pathParts.length === 3 &&
      pathParts[0] === "validators" &&
      pathParts[2] === "transactions"
    ) {
      return this.routes.get("GET /validators/:address/transactions")!;
    }

    // /consensus/stats
    if (pathParts.length === 2 && pathParts[0] === "consensus" && pathParts[1] === "stats") {
      return this.routes.get("GET /consensus/stats")!;
    }

    // /validators/:address
    if (pathParts.length === 2 && pathParts[0] === "validators") {
      return this.routes.get("GET /validators/:address")!;
    }

    // /epochs/durations (must check before :epoch to avoid matching "durations" as epoch number)
    if (pathParts.length === 2 && pathParts[0] === "epochs" && pathParts[1] === "durations") {
      return this.routes.get("GET /epochs/durations")!;
    }

    // /stats/timeline, /stats/throughput, /stats/latency
    if (pathParts.length === 2 && pathParts[0] === "stats") {
      const subRoute = `GET /stats/${pathParts[1]}`;
      if (this.routes.has(subRoute)) return this.routes.get(subRoute)!;
    }

    // /epochs/:epoch
    if (pathParts.length === 2 && pathParts[0] === "epochs") {
      return this.routes.get("GET /epochs/:epoch")!;
    }

    return null;
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(data, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      , 2)
    );
  }
}
