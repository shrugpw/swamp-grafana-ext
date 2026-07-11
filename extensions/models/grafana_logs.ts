/**
 * Extends `@keeb/grafana/instance` with `queryLogs` — the Loki sibling of the
 * model's existing `queryMetrics`.
 *
 * Same shape and credential as `queryMetrics`: it authenticates with the
 * instance's service-account Bearer token (`globalArgs.apiKey`), auto-discovers
 * the Loki datasource, and reads through Grafana's datasource proxy
 * (`GET /api/datasources/proxy/{id}/loki/api/v1/query_range`) with the LogQL
 * query URL-encoded — so no shell escaping and no direct Loki credentials are
 * needed. It replaces the ad-hoc read-only `curl` against the Loki DS proxy,
 * keeping "swamp-native reads" whole (metrics AND logs off one instance model).
 *
 * Loaded as a source extension (`export const extension`); it merges into the
 * pulled `@keeb/grafana` type and needs no separate instance.
 */
import { z } from "npm:zod@4";

// --- Transport (Bearer, mirrors @keeb/grafana lib) --------------------------

interface Conn {
  grafanaUrl: string;
  apiKey?: string;
}

async function grafanaGet(
  conn: Conn,
  path: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (conn.apiKey) headers["Authorization"] = `Bearer ${conn.apiKey}`;
  const resp = await fetch(`${conn.grafanaUrl}${path}`, { headers });
  if (!resp.ok) {
    throw new Error(
      `Grafana API GET ${path} failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return resp.json();
}

/**
 * Resolve an ISO8601 timestamp or a relative token like `15m`/`24h`/`7d` to a
 * whole-second Unix time, relative to `nowSec`. Mirrors `queryMetrics`.
 */
export function resolveTime(value: string, nowSec: number): number {
  const rel = value.match(/^(\d+)([smhd])$/);
  if (rel) {
    const num = parseInt(rel[1], 10);
    const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return nowSec - num * mult[rel[2]];
  }
  return Math.floor(new Date(value).getTime() / 1000);
}

// --- Resource schema --------------------------------------------------------

const LogResultSchema = z.object({
  query: z.string(),
  resultType: z.string().describe("Loki result type: 'streams' or 'matrix'"),
  results: z.string().describe("JSON-encoded Loki result array"),
  seriesCount: z.number().describe(
    "Number of streams (or matrix series) returned",
  ),
  lineCount: z.number().describe("Total log lines across all streams"),
  timestamp: z.iso.datetime(),
});

// --- Execute context --------------------------------------------------------

interface ExecuteContext {
  globalArgs: Conn;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

interface QueryLogsArgs {
  query: string;
  start: string;
  end: string;
  limit: number;
  direction: "backward" | "forward";
  datasourceName: string;
}

/**
 * Core of `queryLogs`, extracted for direct testing. Discovers the Loki
 * datasource, runs a LogQL `query_range` over the DS proxy, logs the returned
 * lines, and snapshots the raw result into a `logResult` resource.
 */
export async function queryLogs(
  args: QueryLogsArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const { query, start, end, limit, direction, datasourceName } = args;
  if (!query) throw new Error("query is required");
  if (!start) throw new Error("start is required");
  const conn = context.globalArgs;

  console.log(`[queryLogs] Discovering Loki datasource...`);
  const datasources =
    (await grafanaGet(conn, "/api/datasources")) as unknown as Array<
      { id: number; name: string; type: string }
    >;
  const lokiCandidates = datasources.filter((ds) => ds.type === "loki");
  if (lokiCandidates.length === 0) {
    throw new Error("No Loki datasource found in Grafana");
  }
  const lokiDs = datasourceName
    ? lokiCandidates.find((ds) => ds.name === datasourceName)
    : lokiCandidates[0];
  if (!lokiDs) {
    throw new Error(
      `Loki datasource '${datasourceName}' not found (have: ${
        lokiCandidates.map((d) => d.name).join(", ")
      })`,
    );
  }
  console.log(
    `[queryLogs] Using datasource '${lokiDs.name}' (id: ${lokiDs.id})`,
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = resolveTime(start, nowSec);
  const endSec = end ? resolveTime(end, nowSec) : nowSec;
  // Loki wants nanosecond timestamps.
  const startNs = `${startSec}000000000`;
  const endNs = `${endSec}000000000`;

  console.log(`[queryLogs] Query: ${query}`);
  console.log(
    `[queryLogs] Range: ${new Date(startSec * 1000).toISOString()} → ${
      new Date(endSec * 1000).toISOString()
    } limit=${limit} direction=${direction}`,
  );

  const params = new URLSearchParams({
    query,
    start: startNs,
    end: endNs,
    limit: String(limit),
    direction,
  });
  const path =
    `/api/datasources/proxy/${lokiDs.id}/loki/api/v1/query_range?${params.toString()}`;
  const response = await grafanaGet(conn, path) as {
    status?: string;
    error?: string;
    data?: { resultType?: string; result?: Array<Record<string, unknown>> };
  };

  if (response.status !== "success") {
    throw new Error(
      `Loki query failed: ${response.error || JSON.stringify(response)}`,
    );
  }

  const resultType = response.data?.resultType || "unknown";
  const series = response.data?.result || [];
  let lineCount = 0;

  for (const s of series) {
    const labels = (s.stream as Record<string, string>) ||
      (s.metric as Record<string, string>) || {};
    const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(
      ", ",
    );
    const values = (s.values as Array<[string, string]>) || [];
    lineCount += values.length;
    console.log(`\n  Stream: {${labelStr}} (${values.length} entries)`);
    const shown = values.slice(0, 20);
    for (const [ts, line] of shown) {
      const iso = new Date(Number(ts) / 1e6).toISOString();
      console.log(`    ${iso}  ${line}`);
    }
    if (values.length > shown.length) {
      console.log(`    ... (${values.length - shown.length} more entries)`);
    }
  }

  console.log(
    `\n[queryLogs] Done — ${series.length} streams, ${lineCount} lines returned`,
  );

  const handle = await context.writeResource(
    "logResult",
    `logs-${Date.now()}`,
    {
      query,
      resultType,
      results: JSON.stringify(series),
      seriesCount: series.length,
      lineCount,
      timestamp: new Date().toISOString(),
    },
  );
  return { dataHandles: [handle] };
}

// --- Extension --------------------------------------------------------------

/** Merges `queryLogs` (and its `logResult` resource) into `@keeb/grafana/instance`. */
export const extension = {
  type: "@keeb/grafana/instance",
  resources: {
    "logResult": {
      description: "Loki LogQL query result (streams + lines)",
      schema: LogResultSchema,
      lifetime: "1h",
      garbageCollection: 20,
    },
  },
  methods: [
    {
      queryLogs: {
        description:
          "Query Loki logs via the Grafana Loki datasource proxy (LogQL query_range). The Loki sibling of queryMetrics.",
        arguments: z.object({
          query: z.string().default("").describe("LogQL query string"),
          start: z
            .string()
            .default("1h")
            .describe("Range start (ISO8601 or relative like '15m'/'24h')"),
          end: z
            .string()
            .default("")
            .describe("Range end (ISO8601 or relative; defaults to now)"),
          limit: z.number().default(100).describe("Max log lines to return"),
          direction: z
            .enum(["backward", "forward"])
            .default("backward")
            .describe("Newest-first ('backward') or oldest-first ('forward')"),
          datasourceName: z
            .string()
            .default("")
            .describe(
              "Loki datasource name to disambiguate (default: first Loki DS)",
            ),
        }),
        execute: (
          args: QueryLogsArgs,
          context: ExecuteContext,
        ): Promise<ExecuteResult> => queryLogs(args, context),
      },
    },
  ],
};
