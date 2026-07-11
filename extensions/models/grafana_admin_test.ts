/**
 * Unit tests for `@shrug/grafana-admin/instance` (ensureServiceAccount),
 * driven through a mocked `fetch` Grafana admin API.
 *
 * The one network seam is `grafanaAdminRequest()` over global `fetch`;
 * {@link installFetch} stubs it, serving responses keyed by `"METHOD /path"`
 * (full pathname, query stripped) and recording every request so tests can
 * assert the wire method/path/body. Coverage: the always-run org switch +
 * restore; dry-run (confirm:false) mutates nothing but still plans; create,
 * role-patch, and token-mint under confirm:true; token idempotency (existing
 * token not re-minted) and force-rotate; and that the token secret is never
 * written into a resource.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ensureServiceAccount } from "./grafana_admin.ts";

type Reply = { status?: number; body?: unknown };
type Handler = Reply | (() => Reply);

interface RequestCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

interface WriteCall {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

interface FetchMock {
  restore: () => void;
  calls: RequestCall[];
}

function installFetch(handlers: Record<string, Handler>): FetchMock {
  const original = globalThis.fetch;
  const calls: RequestCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw);
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body != null ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, search: url.search, body });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) {
      throw new Error(`unexpected route in test: ${method} ${path}`);
    }
    const reply = typeof handler === "function" ? handler() : handler;
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(text, {
        status,
        statusText: status < 300 ? "OK" : "Error",
        headers: { "content-type": "application/json" },
      }),
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
  const writes: WriteCall[] = [];
  const context = {
    globalArgs: {
      grafanaUrl: "https://grafana.example.com",
      adminUser: "admin",
      adminPassword: "secret",
    },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { context, writes };
}

const baseArgs = {
  orgId: 1,
  name: "admin-dashboards",
  role: "Editor" as const,
  mintToken: false,
  tokenName: "admin-dashboards-token",
  force: false,
  confirm: false,
};

Deno.test("dry run: plans create but mutates nothing, restores org", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 2 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": { body: { serviceAccounts: [] } },
    "POST /api/user/using/2": { body: { message: "ok" } },
  });
  try {
    const { context, writes } = stubContext();
    const res = await ensureServiceAccount({ ...baseArgs }, context);
    // No create/patch/token POSTs happened.
    const mutating = mock.calls.filter((c) =>
      c.method !== "GET" && !c.path.startsWith("/api/user/using/")
    );
    assertEquals(mutating.length, 0);
    // Original org (2) restored after switching to 1.
    assertEquals(mock.calls.some((c) => c.path === "/api/user/using/2"), true);
    const w = writes[0].data;
    assertEquals(w.existed, false);
    assertEquals(w.mutated, false);
    assertEquals((w.plannedActions as string[]).length, 1);
    assertEquals(res.dataHandles.length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("confirm: creates the SA when absent", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": { body: { serviceAccounts: [] } },
    "POST /api/serviceaccounts": {
      body: { id: 7, name: "admin-dashboards", login: "sa-1-admin-dashboards", role: "Editor" },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, confirm: true }, context);
    const post = mock.calls.find((c) => c.method === "POST" && c.path === "/api/serviceaccounts");
    assertEquals(post?.body, { name: "admin-dashboards", role: "Editor" });
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.existed, false);
    assertEquals(w.saId, 7);
    // No org restore call needed (already in org 1).
    assertEquals(mock.calls.filter((c) => c.path.startsWith("/api/user/using/")).length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("confirm: patches role when it differs, no create", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": {
      body: { serviceAccounts: [{ id: 5, name: "admin-dashboards", login: "l", role: "Viewer" }] },
    },
    "PATCH /api/serviceaccounts/5": { body: { id: 5, role: "Editor" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, confirm: true }, context);
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/serviceaccounts"),
      false,
    );
    const patch = mock.calls.find((c) => c.method === "PATCH");
    assertEquals(patch?.body, { role: "Editor" });
    assertEquals(writes[0].data.mutated, true);
    assertEquals(writes[0].data.existed, true);
  } finally {
    mock.restore();
  }
});

Deno.test("confirm + mintToken: mints token, secret never persisted", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": {
      body: { serviceAccounts: [{ id: 9, name: "admin-dashboards", login: "l", role: "Editor" }] },
    },
    "GET /api/serviceaccounts/9/tokens": { body: [] },
    "POST /api/serviceaccounts/9/tokens": { body: { id: 42, name: "admin-dashboards-token", key: "glsa_SUPERSECRET" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, mintToken: true, confirm: true }, context);
    const mint = mock.calls.find((c) => c.method === "POST" && c.path === "/api/serviceaccounts/9/tokens");
    assertEquals(mint?.body, { name: "admin-dashboards-token" });
    const w = writes[0].data;
    assertEquals(w.tokenMinted, true);
    assertEquals(w.tokenId, 42);
    // The secret must NOT appear anywhere in the persisted resource.
    assertEquals(JSON.stringify(w).includes("SUPERSECRET"), false);
  } finally {
    mock.restore();
  }
});

Deno.test("mintToken idempotent: existing token not re-minted without force", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": {
      body: { serviceAccounts: [{ id: 9, name: "admin-dashboards", login: "l", role: "Editor" }] },
    },
    "GET /api/serviceaccounts/9/tokens": {
      body: [{ id: 42, name: "admin-dashboards-token" }],
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, mintToken: true, confirm: true }, context);
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path.endsWith("/tokens")),
      false,
    );
    assertEquals(writes[0].data.tokenMinted, false);
  } finally {
    mock.restore();
  }
});

Deno.test("mintToken force: rotates (deletes then recreates) the token", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": {
      body: { serviceAccounts: [{ id: 9, name: "admin-dashboards", login: "l", role: "Editor" }] },
    },
    "GET /api/serviceaccounts/9/tokens": {
      body: [{ id: 42, name: "admin-dashboards-token" }],
    },
    "DELETE /api/serviceaccounts/9/tokens/42": { body: { message: "deleted" } },
    "POST /api/serviceaccounts/9/tokens": { body: { id: 43, name: "admin-dashboards-token", key: "glsa_NEW" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount(
      { ...baseArgs, mintToken: true, force: true, confirm: true },
      context,
    );
    assertEquals(mock.calls.some((c) => c.method === "DELETE"), true);
    assertEquals(writes[0].data.tokenMinted, true);
    assertEquals(writes[0].data.tokenId, 43);
  } finally {
    mock.restore();
  }
});

Deno.test("empty name is rejected", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => ensureServiceAccount({ ...baseArgs, name: "" }, context),
    Error,
    "name is required",
  );
});
