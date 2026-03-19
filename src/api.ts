import http from "node:http";
import { URL } from "node:url";
import { Database } from "./db/queries.js";
import type { Indexer } from "./indexer.js";

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Parse an integer query param, returning defaultVal if absent. Throws ValidationError if present but invalid. */
function parseIntParam(params: URLSearchParams, name: string, defaultVal: number): number {
  const raw = params.get(name);
  if (raw === null) return defaultVal;
  const val = parseInt(raw, 10);
  if (isNaN(val) || val < 0) throw new ValidationError(`Invalid parameter '${name}': must be a non-negative integer`);
  return val;
}

/** Parse a bigint from a path segment or query param. Throws ValidationError if invalid. */
function parseBigInt(value: string, name: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new ValidationError(`Invalid parameter '${name}': must be a valid integer`);
  }
}

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
      console.log("  GET /health");
      console.log("  GET /stats");
      console.log("  GET /stats/summary");
      console.log("  GET /stats/network-uptime");
      console.log("  GET /stats/timeline");
      console.log("  GET /stats/event-activity");
      console.log("  GET /stats/rpc-latency");
      console.log("  GET /validators");
      console.log("  GET /validators/top");
      console.log("  GET /validators/:address");
      console.log("  GET /validators/:address/history");
      console.log("  GET /validators/:address/uptime");
      console.log("  GET /validators/:address/delegations");
      console.log("  GET /validators/:address/transactions");
      console.log("  GET /validators/:address/participation-history");
      console.log("  GET /validators/:address/reward-history");
      console.log("  GET /validators/:address/slash-history");
      console.log("  GET /consensus/stats");
      console.log("  GET /epochs");
      console.log("  GET /epochs/:epoch");
      console.log("  GET /epochs/durations");
      console.log("  GET /events");
      console.log("  GET /events/feed");
      console.log("  GET /events/slashes");
      console.log("  GET /delegations");
    });
  }

  close() {
    this.server.close();
  }

  private registerRoutes() {
    // ──────────────────────────────────────────────────────────
    // GET /health
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /health", async () => {
      try {
        await this.db.ping();
        return { status: "ok", timestamp: new Date().toISOString() };
      } catch {
        return { status: "degraded", timestamp: new Date().toISOString(), error: "database unreachable" };
      }
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats
    // Full network overview (kept for backward compat)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats", async () => {
      return this.db.getNetworkStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/summary
    // Dashboard top bar — single request for all key metrics
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/summary", async () => {
      const rpcLatency = this.indexer
        ? this.indexer.getLatencyStats().rpcPing
        : undefined;
      return this.db.getDashboardSummary(rpcLatency);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/network-uptime
    // Per-epoch network uptime (% of validators that primed)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/network-uptime", async (params) => {
      const epochCount = parseIntParam(params, "epochs", 30);
      return this.db.getNetworkUptimeByEpoch(epochCount);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/timeline
    // Network metrics time-series for dashboard charts
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/timeline", async (params) => {
      const hours = parseIntParam(params, "hours", 24);
      const limit = parseIntParam(params, "limit", 200);
      return this.db.getMetricsTimeline(hours, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/event-activity  (renamed from throughput)
    // Event counts by hour and category
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/event-activity", async (params) => {
      const hours = parseIntParam(params, "hours", 24);
      return this.db.getThroughputStats(hours);
    });

    // Keep old name as alias
    this.routes.set("GET /stats/throughput", async (params) => {
      const hours = parseIntParam(params, "hours", 24);
      return this.db.getThroughputStats(hours);
    });

    // ──────────────────────────────────────────────────────────
    // GET /stats/rpc-latency  (renamed from latency)
    // Live RPC ping + log fetch duration from the indexer
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /stats/rpc-latency", async () => {
      if (!this.indexer) {
        return { error: "Indexer not connected" };
      }
      return this.indexer.getLatencyStats();
    });

    // Keep old name as alias
    this.routes.set("GET /stats/latency", async () => {
      if (!this.indexer) {
        return { error: "Indexer not connected" };
      }
      return this.indexer.getLatencyStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators
    // List all validators with sort/order support
    // ?status=active|banned|quarantined|exiting
    // ?sort=total_stake|uptime_percentage|total_rewards|...
    // ?order=asc|desc
    // ?limit=100  ?offset=0
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators", async (params) => {
      return this.db.getValidatorsSorted({
        status: params.get("status") || undefined,
        sort: params.get("sort") || undefined,
        order: (params.get("order") as "asc" | "desc") || undefined,
        limit: parseIntParam(params, "limit", 100),
        offset: parseIntParam(params, "offset", 0),
      });
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/top
    // Top N validators by stake, uptime, or rewards
    // ?sort=stake|uptime|rewards  (default: stake)
    // ?limit=10
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/top", async (params) => {
      const sortRaw = params.get("sort") || "stake";
      if (!["stake", "uptime", "rewards"].includes(sortRaw)) {
        throw new ValidationError("Invalid sort: must be one of stake, uptime, rewards");
      }
      const sort = sortRaw as "stake" | "uptime" | "rewards";
      const limit = parseIntParam(params, "limit", 10);
      return this.db.getTopValidators(sort, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address
    // Enriched single validator detail
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address", async (_params, parts) => {
      const address = parts[2];
      const validator = await this.db.getValidatorEnriched(address);
      if (!validator) return { error: "Validator not found" };
      return validator;
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/history
    // All events related to this validator
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/history", async (params, parts) => {
      const address = parts[2];
      const limit = parseIntParam(params, "limit", 50);
      const offset = parseIntParam(params, "offset", 0);
      return this.db.getValidatorHistory(address, limit, offset);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/uptime
    // Epoch-by-epoch prime/miss (technical, secondary metric)
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/uptime", async (params, parts) => {
      const address = parts[2];
      const epochCount = parseIntParam(params, "epochs", 30);
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
    // GET /validators/:address/participation-history
    // Chart-friendly per-epoch participation data
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/participation-history", async (params, parts) => {
      const address = parts[2];
      const epochCount = parseIntParam(params, "epochs", 30);
      return this.db.getValidatorParticipationHistory(address, epochCount);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/reward-history
    // Chart-friendly per-epoch reward breakdown
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/reward-history", async (params, parts) => {
      const address = parts[2];
      const limit = parseIntParam(params, "limit", 50);
      return this.db.getValidatorRewardHistory(address, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/slash-history
    // Timeline of slashes, quarantines, bans
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /validators/:address/slash-history", async (params, parts) => {
      const address = parts[2];
      const limit = parseIntParam(params, "limit", 50);
      return this.db.getValidatorSlashHistory(address, limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/delegations
    // ──────────────────────────────────────────────────────────
    this.routes.set(
      "GET /validators/:address/delegations",
      async (params, parts) => {
        const address = parts[2];
        return this.db.getDelegations({
          validator: address,
          limit: parseIntParam(params, "limit", 100),
          offset: parseIntParam(params, "offset", 0),
        });
      }
    );

    // ──────────────────────────────────────────────────────────
    // GET /validators/:address/transactions
    // Default: compact mode. ?detail=full for all fields.
    // ──────────────────────────────────────────────────────────
    this.routes.set(
      "GET /validators/:address/transactions",
      async (params, parts) => {
        const address = parts[2];
        const limit = parseIntParam(params, "limit", 50);
        const offset = parseIntParam(params, "offset", 0);
        const detail = params.get("detail");
        if (detail === "full") {
          return this.db.getConsensusTxForValidator(address, limit, offset);
        }
        return this.db.getConsensusTxForValidatorCompact(address, limit, offset);
      }
    );

    // ──────────────────────────────────────────────────────────
    // GET /consensus/stats
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /consensus/stats", async () => {
      return this.db.getConsensusTxStats();
    });

    // ──────────────────────────────────────────────────────────
    // GET /epochs
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs", async (params) => {
      return this.db.getEpochs(
        parseIntParam(params, "limit", 50),
        parseIntParam(params, "offset", 0)
      );
    });

    // ──────────────────────────────────────────────────────────
    // GET /epochs/:epoch
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs/:epoch", async (_params, parts) => {
      const epoch = parseBigInt(parts[2], "epoch");
      const epochData = await this.db.getEpoch(epoch);
      if (!epochData) return { error: "Epoch not found" };
      return epochData;
    });

    // ──────────────────────────────────────────────────────────
    // GET /epochs/durations
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /epochs/durations", async (params) => {
      const limit = parseIntParam(params, "limit", 50);
      return this.db.getEpochDurations(limit);
    });

    // ──────────────────────────────────────────────────────────
    // GET /events
    // Full event query with sort/order support
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /events", async (params) => {
      const fromBlock = params.get("from_block");
      const toBlock = params.get("to_block");
      return this.db.getEventsSorted({
        eventName: params.get("event_name") || undefined,
        category: params.get("category") || undefined,
        validator: params.get("validator") || undefined,
        fromBlock: fromBlock ? parseBigInt(fromBlock, "from_block") : undefined,
        toBlock: toBlock ? parseBigInt(toBlock, "to_block") : undefined,
        sort: params.get("sort") || undefined,
        order: (params.get("order") as "asc" | "desc") || undefined,
        limit: parseIntParam(params, "limit", 100),
        offset: parseIntParam(params, "offset", 0),
      });
    });

    // ──────────────────────────────────────────────────────────
    // GET /events/feed
    // Normalized, UI-ready event stream for "recent activity" card
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /events/feed", async (params) => {
      const limit = parseIntParam(params, "limit", 50);
      const offset = parseIntParam(params, "offset", 0);
      return this.db.getEventFeed(limit, offset);
    });

    // ──────────────────────────────────────────────────────────
    // GET /events/slashes
    // Recent slashing events
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /events/slashes", async (params) => {
      return this.db.getRecentSlashes(parseIntParam(params, "limit", 20));
    });

    // ──────────────────────────────────────────────────────────
    // GET /delegations
    // ──────────────────────────────────────────────────────────
    this.routes.set("GET /delegations", async (params) => {
      return this.db.getDelegations({
        validator: params.get("validator") || undefined,
        delegator: params.get("delegator") || undefined,
        limit: parseIntParam(params, "limit", 100),
        offset: parseIntParam(params, "offset", 0),
      });
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
            "GET /stats/summary",
            "GET /stats/network-uptime",
            "GET /stats/timeline",
            "GET /stats/event-activity",
            "GET /stats/rpc-latency",
            "GET /validators",
            "GET /validators/top",
            "GET /validators/:address",
            "GET /validators/:address/history",
            "GET /validators/:address/uptime",
            "GET /validators/:address/participation-history",
            "GET /validators/:address/reward-history",
            "GET /validators/:address/slash-history",
            "GET /validators/:address/delegations",
            "GET /validators/:address/transactions",
            "GET /consensus/stats",
            "GET /epochs",
            "GET /epochs/:epoch",
            "GET /epochs/durations",
            "GET /events",
            "GET /events/feed",
            "GET /events/slashes",
            "GET /delegations",
          ],
        });
        return;
      }

      const result = await handler(params, ["", ...pathParts]);
      this.sendJson(res, 200, result);
    } catch (err) {
      // Distinguish client errors (bad input) from server errors
      if (err instanceof ValidationError) {
        this.sendJson(res, 400, { error: err.message });
        return;
      }
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

    // /validators/top (must check before :address)
    if (pathParts.length === 2 && pathParts[0] === "validators" && pathParts[1] === "top") {
      return this.routes.get("GET /validators/top")!;
    }

    // /validators/:address/sub-routes
    if (pathParts.length === 3 && pathParts[0] === "validators") {
      const subRoutes: Record<string, string> = {
        history: "GET /validators/:address/history",
        uptime: "GET /validators/:address/uptime",
        delegations: "GET /validators/:address/delegations",
        transactions: "GET /validators/:address/transactions",
        "participation-history": "GET /validators/:address/participation-history",
        "reward-history": "GET /validators/:address/reward-history",
        "slash-history": "GET /validators/:address/slash-history",
      };
      const route = subRoutes[pathParts[2]];
      if (route) return this.routes.get(route)!;
    }

    // /consensus/stats
    if (pathParts.length === 2 && pathParts[0] === "consensus" && pathParts[1] === "stats") {
      return this.routes.get("GET /consensus/stats")!;
    }

    // /validators/:address
    if (pathParts.length === 2 && pathParts[0] === "validators") {
      return this.routes.get("GET /validators/:address")!;
    }

    // /epochs/durations (must check before :epoch)
    if (pathParts.length === 2 && pathParts[0] === "epochs" && pathParts[1] === "durations") {
      return this.routes.get("GET /epochs/durations")!;
    }

    // /stats/* sub-routes (summary, network-uptime, timeline, event-activity, rpc-latency, throughput, latency)
    if (pathParts.length === 2 && pathParts[0] === "stats") {
      const subRoute = `GET /stats/${pathParts[1]}`;
      if (this.routes.has(subRoute)) return this.routes.get(subRoute)!;
    }

    // /events/feed, /events/slashes
    if (pathParts.length === 2 && pathParts[0] === "events") {
      const subRoute = `GET /events/${pathParts[1]}`;
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
