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
import {
  configureWebhookContactPoint,
  ensureDatasource,
  ensureFolder,
  ensureOrg,
  ensureServiceAccount,
  listOrgs,
  model,
} from "./grafana_admin.ts";

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

const baseArgs = {
  orgId: 1,
  name: "admin-dashboards",
  role: "Editor" as const,
  mintToken: false,
  tokenName: "admin-dashboards-token",
  force: false,
  confirm: false,
};

Deno.test("listOrgs: read-only, writes an orgs snapshot, no org switch", async () => {
  const mock = installFetch({
    "GET /api/orgs": {
      body: [
        { id: 1, name: "Main Org." },
        { id: 3, name: "WidgetCo" },
      ],
    },
  });
  try {
    const { context, writes } = stubContext();
    const res = await listOrgs(context);
    // Only the read happened — nothing mutating, no org switch.
    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0].method, "GET");
    assertEquals(mock.calls[0].path, "/api/orgs");
    // Snapshot captured both orgs, projected to {id,name}.
    const w = writes[0];
    assertEquals(w.spec, "orgs");
    assertEquals(w.name, "orgs");
    assertEquals(w.data.count, 2);
    assertEquals(w.data.orgs, [
      { id: 1, name: "Main Org." },
      { id: 3, name: "WidgetCo" },
    ]);
    assertEquals(res.dataHandles.length, 1);
  } finally {
    mock.restore();
  }
});

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
      body: {
        id: 7,
        name: "admin-dashboards",
        login: "sa-1-admin-dashboards",
        role: "Editor",
      },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, confirm: true }, context);
    const post = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/serviceaccounts"
    );
    assertEquals(post?.body, { name: "admin-dashboards", role: "Editor" });
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.existed, false);
    assertEquals(w.saId, 7);
    // No org restore call needed (already in org 1).
    assertEquals(
      mock.calls.filter((c) => c.path.startsWith("/api/user/using/")).length,
      1,
    );
  } finally {
    mock.restore();
  }
});

Deno.test("confirm: patches role when it differs, no create", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": {
      body: {
        serviceAccounts: [{
          id: 5,
          name: "admin-dashboards",
          login: "l",
          role: "Viewer",
        }],
      },
    },
    "PATCH /api/serviceaccounts/5": { body: { id: 5, role: "Editor" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, confirm: true }, context);
    assertEquals(
      mock.calls.some((c) =>
        c.method === "POST" && c.path === "/api/serviceaccounts"
      ),
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
      body: {
        serviceAccounts: [{
          id: 9,
          name: "admin-dashboards",
          login: "l",
          role: "Editor",
        }],
      },
    },
    "GET /api/serviceaccounts/9/tokens": { body: [] },
    "POST /api/serviceaccounts/9/tokens": {
      body: { id: 42, name: "admin-dashboards-token", key: "glsa_SUPERSECRET" },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount(
      { ...baseArgs, mintToken: true, confirm: true },
      context,
    );
    const mint = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/serviceaccounts/9/tokens"
    );
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
      body: {
        serviceAccounts: [{
          id: 9,
          name: "admin-dashboards",
          login: "l",
          role: "Editor",
        }],
      },
    },
    "GET /api/serviceaccounts/9/tokens": {
      body: [{ id: 42, name: "admin-dashboards-token" }],
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount(
      { ...baseArgs, mintToken: true, confirm: true },
      context,
    );
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
      body: {
        serviceAccounts: [{
          id: 9,
          name: "admin-dashboards",
          login: "l",
          role: "Editor",
        }],
      },
    },
    "GET /api/serviceaccounts/9/tokens": {
      body: [{ id: 42, name: "admin-dashboards-token" }],
    },
    "DELETE /api/serviceaccounts/9/tokens/42": { body: { message: "deleted" } },
    "POST /api/serviceaccounts/9/tokens": {
      body: { id: 43, name: "admin-dashboards-token", key: "glsa_NEW" },
    },
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

// --- configureWebhookContactPoint ------------------------------------------

const cpArgs = {
  orgId: 1,
  name: "ntfy-bed-infra",
  url: "https://ntfy.example/bed-infra",
  httpMethod: "POST" as const,
  disableResolveMessage: false,
  title: "",
  message: "",
  confirm: false,
};

Deno.test("contact point dry run: plans create, mutates nothing, restores org", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 2 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/v1/provisioning/contact-points": { body: [] },
    "POST /api/user/using/2": { body: { message: "ok" } },
  });
  try {
    const { context, writes } = stubContext();
    const res = await configureWebhookContactPoint({ ...cpArgs }, context);
    // No create/update happened.
    const mutating = mock.calls.filter((c) =>
      c.method !== "GET" && !c.path.startsWith("/api/user/using/")
    );
    assertEquals(mutating.length, 0);
    // Original org (2) restored.
    assertEquals(mock.calls.some((c) => c.path === "/api/user/using/2"), true);
    const w = writes[0].data;
    assertEquals(w.existed, false);
    assertEquals(w.mutated, false);
    assertEquals(w.contactType, "webhook");
    assertEquals((w.plannedActions as string[]).length, 1);
    assertEquals(res.dataHandles.length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("contact point confirm: creates when absent (POST, type webhook)", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/v1/provisioning/contact-points": { body: [] },
    "POST /api/v1/provisioning/contact-points": {
      body: { uid: "cp-uid-1", name: "ntfy-bed-infra", type: "webhook" },
    },
  });
  try {
    const { context, writes } = stubContext();
    await configureWebhookContactPoint({ ...cpArgs, confirm: true }, context);
    const post = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/v1/provisioning/contact-points"
    );
    assertEquals((post?.body as { type: string }).type, "webhook");
    assertEquals(
      (post?.body as { settings: { url: string } }).settings.url,
      "https://ntfy.example/bed-infra",
    );
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.existed, false);
    assertEquals(w.uid, "cp-uid-1");
  } finally {
    mock.restore();
  }
});

Deno.test("contact point confirm: updates existing in place (PUT by uid), no duplicate", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/v1/provisioning/contact-points": {
      body: [{ uid: "cp-existing", name: "ntfy-bed-infra", type: "webhook" }],
    },
    "PUT /api/v1/provisioning/contact-points/cp-existing": {
      body: { uid: "cp-existing" },
    },
  });
  try {
    const { context, writes } = stubContext();
    await configureWebhookContactPoint({ ...cpArgs, confirm: true }, context);
    // No POST-create happened — updated in place.
    assertEquals(
      mock.calls.some((c) =>
        c.method === "POST" && c.path === "/api/v1/provisioning/contact-points"
      ),
      false,
    );
    const put = mock.calls.find((c) => c.method === "PUT");
    assertEquals(put?.path, "/api/v1/provisioning/contact-points/cp-existing");
    assertEquals(writes[0].data.mutated, true);
    assertEquals(writes[0].data.existed, true);
    assertEquals(writes[0].data.uid, "cp-existing");
  } finally {
    mock.restore();
  }
});

Deno.test("contact point update: preserves out-of-band settings (no clobber)", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/v1/provisioning/contact-points": {
      body: [{
        uid: "cp-existing",
        name: "ntfy-bed-infra",
        type: "webhook",
        settings: {
          url: "https://old.example/topic",
          httpMethod: "POST",
          authorization_credentials: "tok_set_out_of_band",
        },
      }],
    },
    "PUT /api/v1/provisioning/contact-points/cp-existing": {
      body: { uid: "cp-existing" },
    },
  });
  try {
    const { context } = stubContext();
    await configureWebhookContactPoint({ ...cpArgs, confirm: true }, context);
    const put = mock.calls.find((c) => c.method === "PUT");
    const sent = (put?.body as { settings: Record<string, unknown> }).settings;
    // url updated...
    assertEquals(sent.url, "https://ntfy.example/bed-infra");
    // ...but the operator's out-of-band credential survived.
    assertEquals(sent.authorization_credentials, "tok_set_out_of_band");
  } finally {
    mock.restore();
  }
});

Deno.test("contact point: empty url is rejected", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => configureWebhookContactPoint({ ...cpArgs, url: "" }, context),
    Error,
    "url is required",
  );
});

// --- ensureFolder -----------------------------------------------------------

const folderArgs = {
  orgId: 1,
  title: "Bed Host Health",
  uid: "",
  confirm: false,
};

Deno.test("ensureFolder dry run: plans create, mutates nothing", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/folders": { body: [] },
  });
  try {
    const { context, writes } = stubContext();
    await ensureFolder({ ...folderArgs }, context);
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/folders"),
      false,
    );
    const w = writes[0].data;
    assertEquals(w.existed, false);
    assertEquals(w.mutated, false);
    assertEquals((w.plannedActions as string[]).length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("ensureFolder idempotent: returns existing uid without creating", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/folders": {
      body: [{ uid: "folder-uid-9", title: "Bed Host Health" }],
    },
  });
  try {
    const { context, writes } = stubContext();
    // Even with confirm:true, an existing folder is not re-created.
    await ensureFolder({ ...folderArgs, confirm: true }, context);
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/folders"),
      false,
    );
    const w = writes[0].data;
    assertEquals(w.existed, true);
    assertEquals(w.mutated, false);
    assertEquals(w.uid, "folder-uid-9");
  } finally {
    mock.restore();
  }
});

Deno.test("ensureFolder confirm: creates when absent and returns new uid", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/folders": { body: [] },
    "POST /api/folders": {
      body: { uid: "folder-new", title: "Bed Host Health" },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureFolder({ ...folderArgs, confirm: true }, context);
    const post = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/folders"
    );
    assertEquals((post?.body as { title: string }).title, "Bed Host Health");
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.uid, "folder-new");
  } finally {
    mock.restore();
  }
});

Deno.test("ensureFolder: empty title is rejected", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => ensureFolder({ ...folderArgs, title: "" }, context),
    Error,
    "title is required",
  );
});

// --- ensureOrg --------------------------------------------------------------

const orgArgs = { name: "AcmeCorp", confirm: false };

Deno.test("ensureOrg dry run: plans create, mutates nothing (no org switch)", async () => {
  const mock = installFetch({
    "GET /api/orgs": { body: [{ id: 1, name: "Main Org." }] },
  });
  try {
    const { context, writes } = stubContext();
    await ensureOrg({ ...orgArgs }, context);
    // Only the read happened — org CRUD never switches the active org.
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/orgs"),
      false,
    );
    assertEquals(
      mock.calls.some((c) => c.path.startsWith("/api/user/using/")),
      false,
    );
    const w = writes[0].data;
    assertEquals(w.existed, false);
    assertEquals(w.mutated, false);
    assertEquals((w.plannedActions as string[]).length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("ensureOrg idempotent: existing org returns id, no create even with confirm", async () => {
  const mock = installFetch({
    "GET /api/orgs": {
      body: [{ id: 1, name: "Main Org." }, { id: 2, name: "AcmeCorp" }],
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureOrg({ ...orgArgs, confirm: true }, context);
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/orgs"),
      false,
    );
    const w = writes[0].data;
    assertEquals(w.existed, true);
    assertEquals(w.mutated, false);
    assertEquals(w.orgId, 2);
  } finally {
    mock.restore();
  }
});

Deno.test("ensureOrg confirm: creates when absent and returns the new orgId", async () => {
  const mock = installFetch({
    "GET /api/orgs": { body: [{ id: 1, name: "Main Org." }] },
    "POST /api/orgs": { body: { orgId: 7, message: "Organization created" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureOrg({ ...orgArgs, confirm: true }, context);
    const post = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/orgs"
    );
    assertEquals(post?.body, { name: "AcmeCorp" });
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.existed, false);
    assertEquals(w.orgId, 7);
  } finally {
    mock.restore();
  }
});

Deno.test("ensureOrg: empty name is rejected", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => ensureOrg({ ...orgArgs, name: "" }, context),
    Error,
    "name is required",
  );
});

// --- ensureDatasource -------------------------------------------------------

const dsArgs = {
  orgId: 2,
  name: "Mimir (acme)",
  dsType: "prometheus" as const,
  url: "https://ingest.example.com",
  tenant: "acme",
  isDefault: false,
  confirm: false,
};

Deno.test("ensureDatasource dry run: plans create, mutates nothing, restores org", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/2": { body: { message: "ok" } },
    "GET /api/datasources": { body: [] },
    "POST /api/user/using/1": { body: { message: "ok" } },
  });
  try {
    const { context, writes } = stubContext();
    await ensureDatasource({ ...dsArgs }, context);
    // No create/update happened.
    const mutating = mock.calls.filter((c) =>
      c.method !== "GET" && !c.path.startsWith("/api/user/using/")
    );
    assertEquals(mutating.length, 0);
    // Original org (1) restored after switching to 4.
    assertEquals(mock.calls.some((c) => c.path === "/api/user/using/1"), true);
    const w = writes[0].data;
    assertEquals(w.existed, false);
    assertEquals(w.mutated, false);
    assertEquals(w.tenant, "acme");
    assertEquals((w.plannedActions as string[]).length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("ensureDatasource confirm: creates with tenant header (name in jsonData, value in secureJsonData)", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 2 } },
    "POST /api/user/using/2": { body: { message: "ok" } },
    "GET /api/datasources": { body: [] },
    "POST /api/datasources": {
      body: { datasource: { uid: "ds-acme-mimir", name: "Mimir (acme)" } },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureDatasource({ ...dsArgs, confirm: true }, context);
    const post = mock.calls.find((c) =>
      c.method === "POST" && c.path === "/api/datasources"
    );
    const body = post?.body as {
      type: string;
      access: string;
      jsonData: Record<string, string>;
      secureJsonData: Record<string, string>;
    };
    assertEquals(body.type, "prometheus");
    assertEquals(body.access, "proxy");
    // The header NAME is in jsonData; the tenant VALUE only in secureJsonData.
    assertEquals(body.jsonData.httpHeaderName1, "X-Scope-OrgID");
    assertEquals(body.secureJsonData.httpHeaderValue1, "acme");
    const w = writes[0].data;
    assertEquals(w.mutated, true);
    assertEquals(w.uid, "ds-acme-mimir");
  } finally {
    mock.restore();
  }
});

Deno.test("ensureDatasource confirm: updates existing in place (PUT by uid), no duplicate, preserves jsonData", async () => {
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 2 } },
    "POST /api/user/using/2": { body: { message: "ok" } },
    "GET /api/datasources": {
      body: [{
        id: 2,
        uid: "ds-existing",
        name: "Mimir (acme)",
        type: "prometheus",
        url: "https://old.example",
        jsonData: { timeInterval: "30s" },
      }],
    },
    "PUT /api/datasources/uid/ds-existing": {
      body: { datasource: { uid: "ds-existing" } },
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureDatasource({ ...dsArgs, confirm: true }, context);
    // No POST-create — updated in place.
    assertEquals(
      mock.calls.some((c) =>
        c.method === "POST" && c.path === "/api/datasources"
      ),
      false,
    );
    const put = mock.calls.find((c) => c.method === "PUT");
    assertEquals(put?.path, "/api/datasources/uid/ds-existing");
    const body = put?.body as { jsonData: Record<string, string> };
    // url updated, out-of-band jsonData key preserved, header name set.
    assertEquals(
      (put?.body as { url: string }).url,
      "https://ingest.example.com",
    );
    assertEquals(body.jsonData.timeInterval, "30s");
    assertEquals(body.jsonData.httpHeaderName1, "X-Scope-OrgID");
    assertEquals(writes[0].data.existed, true);
    assertEquals(writes[0].data.uid, "ds-existing");
  } finally {
    mock.restore();
  }
});

Deno.test("ensureDatasource: empty url is rejected", async () => {
  const { context } = stubContext();
  await assertRejects(
    () => ensureDatasource({ ...dsArgs, url: "" }, context),
    Error,
    "url is required",
  );
});

// --- preflight coverage + exhaustive lookups --------------------------------

Deno.test("admin-authenticates check covers every mutating method", () => {
  // deno-lint-ignore no-explicit-any
  const applies = (model as any).checks["admin-authenticates"]
    .appliesTo as string[];
  for (
    const m of [
      "ensureServiceAccount",
      "configureWebhookContactPoint",
      "ensureFolder",
      "ensureOrg",
      "ensureDatasource",
    ]
  ) {
    assertEquals(
      applies.includes(m),
      true,
      `admin-authenticates must pre-check ${m}`,
    );
  }
  // listOrgs is read-only discovery and is intentionally excluded.
  assertEquals(applies.includes("listOrgs"), false);
});

Deno.test("ensureServiceAccount: pages search to match beyond the first page", async () => {
  let searchCall = 0;
  // A full first page (100) of non-matching SAs, then the real match on page 2.
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    name: `unrelated-${i}`,
    login: "l",
    role: "Viewer",
  }));
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/serviceaccounts/search": () => {
      searchCall++;
      return searchCall === 1 ? { body: { serviceAccounts: firstPage } } : {
        body: {
          serviceAccounts: [
            { id: 999, name: "admin-dashboards", login: "l", role: "Editor" },
          ],
        },
      };
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureServiceAccount({ ...baseArgs, confirm: true }, context);
    // Found on page 2 -> treated as existing, so no create POST.
    assertEquals(
      mock.calls.some((c) =>
        c.method === "POST" && c.path === "/api/serviceaccounts"
      ),
      false,
    );
    assertEquals(writes[0].data.existed, true);
    assertEquals(writes[0].data.saId, 999);
    // Both search pages were fetched (full first page forced a second).
    assertEquals(
      mock.calls.filter((c) => c.path === "/api/serviceaccounts/search").length,
      2,
    );
  } finally {
    mock.restore();
  }
});

Deno.test("ensureFolder: pages folder list to match beyond the first page", async () => {
  let folderCall = 0;
  const firstPage = Array.from({ length: 1000 }, (_, i) => ({
    uid: `f-${i}`,
    title: `Folder ${i}`,
  }));
  const mock = installFetch({
    "GET /api/user": { body: { login: "admin", orgId: 1 } },
    "POST /api/user/using/1": { body: { message: "ok" } },
    "GET /api/folders": () => {
      folderCall++;
      return folderCall === 1
        ? { body: firstPage }
        : { body: [{ uid: "folder-target", title: "Bed Host Health" }] };
    },
  });
  try {
    const { context, writes } = stubContext();
    await ensureFolder({ ...folderArgs, confirm: true }, context);
    // Match on page 2 -> existing, no create POST.
    assertEquals(
      mock.calls.some((c) => c.method === "POST" && c.path === "/api/folders"),
      false,
    );
    assertEquals(writes[0].data.existed, true);
    assertEquals(writes[0].data.uid, "folder-target");
    assertEquals(
      mock.calls.filter((c) => c.path === "/api/folders").length,
      2,
    );
  } finally {
    mock.restore();
  }
});
