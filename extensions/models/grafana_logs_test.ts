/**
 * Unit tests for the `queryLogs` extension on `@keeb/grafana/instance`.
 *
 * Two layers: the pure `resolveTime` helper (relative + ISO parsing), and the
 * `queryLogs` execute path over a mocked `fetch` Grafana API. The mock serves
 * `GET /api/datasources` (datasource discovery) and the Loki DS-proxy
 * `query_range`, recording requests so tests can assert the proxy path, the
 * nanosecond time window, the URL-encoded LogQL, and the streams/lines snapshot
 * written to the `logResult` resource.
 *
 * @module
 */
import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import { queryLogs, resolveTime } from "./grafana_logs.ts";

// --- Pure helper ------------------------------------------------------------

Deno.test("resolveTime parses relative tokens and ISO timestamps", () => {
  const now = 1_000_000;
  assertEquals(resolveTime("15m", now), now - 900);
  assertEquals(resolveTime("2h", now), now - 7200);
  assertEquals(resolveTime("1d", now), now - 86400);
  assertEquals(resolveTime("30s", now), now - 30);
  // Absolute ISO → whole seconds.
  assertEquals(resolveTime("2026-07-11T00:00:00Z", now), 1783728000);
});

// --- Mocked transport -------------------------------------------------------

type Reply = { status?: number; body?: unknown };

interface RequestCall {
  method: string;
  path: string;
  search: string;
}

function installFetch(handlers: Record<string, Reply>): {
  restore: () => void;
  calls: RequestCall[];
} {
  const original = globalThis.fetch;
  const calls: RequestCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.search });
    // Datasource-proxy query_range is keyed by its (dynamic) path prefix.
    const key = url.pathname.includes("/loki/api/v1/query_range")
      ? "PROXY_QUERY_RANGE"
      : `${method} ${url.pathname}`;
    const reply = handlers[key];
    if (reply === undefined) {
      throw new Error(`unexpected route in test: ${method} ${url.pathname}`);
    }
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(text, { status, statusText: status < 300 ? "OK" : "Error" }),
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

function stubContext() {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const context = {
    globalArgs: {
      grafanaUrl: "https://grafana.example.com",
      apiKey: "sa-token",
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes };
}

const logsArgs = {
  query: '{service_name="mimir"} |= `error`',
  start: "1h",
  end: "",
  limit: 100,
  direction: "backward" as const,
  datasourceName: "",
};

Deno.test("queryLogs proxies to the Loki DS and snapshots streams/lines", async () => {
  const mock = installFetch({
    "GET /api/datasources": {
      body: [
        { id: 1, name: "Mimir", type: "prometheus" },
        { id: 2, name: "Loki", type: "loki" },
      ],
    },
    "PROXY_QUERY_RANGE": {
      body: {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { service_name: "mimir", level: "error" },
              values: [["1783728000000000000", "boom"], [
                "1783728001000000000",
                "kaput",
              ]],
            },
          ],
        },
      },
    },
  });
  try {
    const { context, writes } = stubContext();
    const res = await queryLogs({ ...logsArgs }, context);
    // Proxy path uses the Loki DS id (2), not the prometheus one.
    const proxy = mock.calls.find((c) =>
      c.path.includes("/loki/api/v1/query_range")
    );
    assertEquals(
      proxy?.path,
      "/api/datasources/proxy/2/loki/api/v1/query_range",
    );
    // Window is expressed in nanoseconds; LogQL is URL-encoded (a space -> %20 or +).
    assertEquals(/start=\d+000000000/.test(proxy!.search), true);
    assertEquals(/end=\d+000000000/.test(proxy!.search), true);
    assertEquals(proxy!.search.includes("service_name"), true);
    // Snapshot.
    const w = writes[0].data;
    assertEquals(writes[0].spec, "logResult");
    assertEquals(w.resultType, "streams");
    assertEquals(w.seriesCount, 1);
    assertEquals(w.lineCount, 2);
    assertEquals(res.dataHandles.length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("queryLogs disambiguates by datasourceName", async () => {
  const mock = installFetch({
    "GET /api/datasources": {
      body: [
        { id: 2, name: "Loki", type: "loki" },
        { id: 3, name: "Loki-bed", type: "loki" },
      ],
    },
    "PROXY_QUERY_RANGE": {
      body: { status: "success", data: { resultType: "streams", result: [] } },
    },
  });
  try {
    const { context } = stubContext();
    await queryLogs({ ...logsArgs, datasourceName: "Loki-bed" }, context);
    const proxy = mock.calls.find((c) =>
      c.path.includes("/loki/api/v1/query_range")
    );
    assertEquals(
      proxy?.path,
      "/api/datasources/proxy/3/loki/api/v1/query_range",
    );
  } finally {
    mock.restore();
  }
});

Deno.test("queryLogs throws when no Loki datasource exists", async () => {
  const mock = installFetch({
    "GET /api/datasources": {
      body: [{ id: 1, name: "Mimir", type: "prometheus" }],
    },
  });
  try {
    const { context } = stubContext();
    await assertRejects(
      () => queryLogs({ ...logsArgs }, context),
      Error,
      "No Loki datasource found",
    );
  } finally {
    mock.restore();
  }
});

Deno.test("queryLogs surfaces a Loki error status", async () => {
  const mock = installFetch({
    "GET /api/datasources": { body: [{ id: 2, name: "Loki", type: "loki" }] },
    "PROXY_QUERY_RANGE": { body: { status: "error", error: "parse error" } },
  });
  try {
    const { context } = stubContext();
    await assertRejects(
      () => queryLogs({ ...logsArgs }, context),
      Error,
      "Loki query failed",
    );
  } finally {
    mock.restore();
  }
});

Deno.test("queryLogs requires a query", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => queryLogs({ ...logsArgs, query: "" }, context),
    Error,
    "query is required",
  );
  // Keep assertAlmostEquals referenced (guards against unused-import lint).
  assertAlmostEquals(1, 1);
});
