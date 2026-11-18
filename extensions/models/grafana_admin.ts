/**
 * @shrug/grafana-admin — Grafana *control-plane* operations that a data-plane
 * service-account token cannot perform.
 *
 * The community `@keeb/grafana/instance` model authenticates with an org-scoped
 * service-account Bearer token: perfect for dashboards, queries, and alerts
 * inside one org, but a SA token is bound to a single org and lacks the
 * privilege to create *other* service accounts. Bootstrapping the service
 * accounts you push dashboards with therefore needs Grafana **admin basic-auth**
 * plus an org switch (`POST /api/user/using/{orgId}`) — which is exactly what
 * this model wraps, replacing the one-off `curl` admin-API bootstrap.
 *
 * `ensureServiceAccount` is idempotent and **dry-run by default**: without
 * `confirm:true` it only discovers the current state and reports the actions it
 * *would* take. Token minting is a deliberate second opt-in (`mintToken:true`) —
 * the freshly minted secret is printed to the run log ONCE (Grafana never
 * reveals it again) and is intentionally NOT persisted in swamp data.
 *
 * Auth: `--global-arg 'grafanaUrl=https://grafana.example.com'` and
 * `--global-arg 'adminPassword=${{ vault.get("<vault>", "grafana/admin-password") }}'`.
 * Never hard-code the password.
 */
import { z } from "npm:zod@4";

// --- Global arguments -------------------------------------------------------

const GlobalArgsSchema = z.object({
  grafanaUrl: z
    .string()
    .default("https://grafana.example.com")
    .describe(
      "Grafana base URL (no trailing slash), e.g. https://grafana.example.com",
    ),
  adminUser: z
    .string()
    .default("admin")
    .describe("Grafana server-admin username for basic auth"),
  adminPassword: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "Grafana server-admin password — resolve from a vault via CEL, do not hard-code",
    ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const Role = z.enum(["Viewer", "Editor", "Admin"]);

// --- Transport --------------------------------------------------------------

/**
 * Minimal Grafana HTTP client over `fetch`, authenticating as the server admin
 * via HTTP Basic. Throws on any non-2xx. Returns the parsed JSON body (or `{}`
 * for an empty body).
 */
async function grafanaAdminRequest(
  cfg: GlobalArgs,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = cfg.grafanaUrl.replace(/\/+$/, "");
  const auth = btoa(`${cfg.adminUser}:${cfg.adminPassword}`);
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `Grafana ${method} ${path} failed: ${resp.status} ${resp.statusText} — ${
        text.slice(0, 300)
      }`,
    );
  }
  return text ? JSON.parse(text) : {};
}

// --- Resource schema --------------------------------------------------------

const ServiceAccountSchema = z.object({
  grafanaUrl: z.string(),
  orgId: z.number(),
  name: z.string(),
  role: z.string(),
  saId: z.number().optional(),
  login: z.string().optional(),
  existed: z.boolean().describe(
    "Whether the SA already existed before this run",
  ),
  mutated: z.boolean().describe(
    "Whether this run changed Grafana (confirm:true)",
  ),
  plannedActions: z
    .array(z.string())
    .describe("Actions this run would (dry-run) or did (confirm) take"),
  tokenName: z.string().optional(),
  tokenMinted: z
    .boolean()
    .describe(
      "Whether a new token secret was minted this run (printed to log)",
    ),
  tokenId: z.number().optional(),
  ensuredAt: z.iso.datetime(),
});

// A webhook (e.g. ntfy) contact point ensured in a given org. Idempotent:
// keyed by (orgId, name); an existing point of the same name is updated in
// place (PUT by uid) rather than duplicated.
const ContactPointSchema = z.object({
  grafanaUrl: z.string(),
  orgId: z.number(),
  name: z.string(),
  contactType: z.string().describe("Grafana contact-point type (webhook)"),
  url: z.string().describe("Webhook target URL (the ntfy topic URL)"),
  httpMethod: z.string(),
  uid: z.string().optional().describe(
    "Grafana-assigned uid (present once the point exists)",
  ),
  existed: z.boolean().describe(
    "Whether a contact point of this name existed before this run",
  ),
  mutated: z.boolean().describe(
    "Whether this run changed Grafana (confirm:true)",
  ),
  plannedActions: z
    .array(z.string())
    .describe("Actions this run would (dry-run) or did (confirm) take"),
  ensuredAt: z.iso.datetime(),
});

// A Grafana folder ensured by title. Alert rules need a folderUID; this
// returns a stable uid, creating the folder only when absent.
const FolderSchema = z.object({
  grafanaUrl: z.string(),
  orgId: z.number(),
  title: z.string(),
  uid: z.string().optional().describe(
    "Folder uid (present once the folder exists)",
  ),
  existed: z.boolean().describe(
    "Whether a folder of this title existed before this run",
  ),
  mutated: z.boolean().describe(
    "Whether this run changed Grafana (confirm:true)",
  ),
  plannedActions: z
    .array(z.string())
    .describe("Actions this run would (dry-run) or did (confirm) take"),
  ensuredAt: z.iso.datetime(),
});

// A read-only snapshot of the orgs visible to the server admin. Written by
// `listOrgs` so the org id backing a tenant (e.g. the Mimir X-Scope-OrgID) can
// be discovered before minting a service account into it.
const OrgsSchema = z.object({
  grafanaUrl: z.string(),
  orgs: z
    .array(z.object({ id: z.number(), name: z.string() }))
    .describe("All orgs returned by GET /api/orgs (server-admin scope)"),
  count: z.number(),
  listedAt: z.iso.datetime(),
});

// State + plan for an ensured Grafana org (created by name when absent). An org
// is the query-side tenant boundary: its datasources carry the X-Scope-OrgID
// that scopes Mimir/Loki reads, so a dedicated org per tenant keeps one
// tenant's dashboards from reading another's series.
const EnsuredOrgSchema = z.object({
  grafanaUrl: z.string(),
  name: z.string(),
  orgId: z.number().optional().describe(
    "Grafana org id (present once the org exists)",
  ),
  existed: z.boolean().describe(
    "Whether an org of this name existed before this run",
  ),
  mutated: z.boolean().describe(
    "Whether this run changed Grafana (confirm:true)",
  ),
  plannedActions: z
    .array(z.string())
    .describe("Actions this run would (dry-run) or did (confirm) take"),
  ensuredAt: z.iso.datetime(),
});

// State + plan for an ensured datasource in a given org. Idempotent by (orgId,
// name): an existing datasource of the same name is updated in place (PUT by
// uid), never duplicated. The tenant header (X-Scope-OrgID) is injected
// server-side by Grafana's proxy — its NAME in jsonData, its VALUE in
// secureJsonData — so an org Viewer can neither read the value nor forge a
// different tenant's id on this datasource.
const DatasourceSchema = z.object({
  grafanaUrl: z.string(),
  orgId: z.number(),
  name: z.string(),
  dsType: z.string().describe("Grafana datasource type (prometheus | loki)"),
  url: z.string(),
  tenant: z.string().describe(
    "X-Scope-OrgID value this datasource scopes reads to (empty = no tenant header)",
  ),
  isDefault: z.boolean(),
  uid: z.string().optional().describe(
    "Grafana-assigned uid (present once the datasource exists)",
  ),
  existed: z.boolean().describe(
    "Whether a datasource of this name existed before this run",
  ),
  mutated: z.boolean().describe(
    "Whether this run changed Grafana (confirm:true)",
  ),
  plannedActions: z
    .array(z.string())
    .describe("Actions this run would (dry-run) or did (confirm) take"),
  ensuredAt: z.iso.datetime(),
});

// --- Execute context --------------------------------------------------------

interface ExecuteContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

interface EnsureArgs {
  orgId: number;
  name: string;
  role: z.infer<typeof Role>;
  mintToken: boolean;
  tokenName: string;
  force: boolean;
  confirm: boolean;
}

interface SaSummary {
  id: number;
  name: string;
  login?: string;
  role?: string;
}

interface TokenSummary {
  id: number;
  name: string;
}

/**
 * Core of `ensureServiceAccount`, extracted so tests can drive it directly. It
 * switches to `orgId`, discovers the SA (and, when minting, its tokens), builds
 * a plan, and — only under `confirm` — applies create/patch/mint. The admin's
 * original active org is always restored in the `finally`.
 */
export async function ensureServiceAccount(
  args: EnsureArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const { orgId, name, role, mintToken, tokenName, force, confirm } = args;
  if (!name) throw new Error("name is required");

  const me = await grafanaAdminRequest(cfg, "GET", "/api/user");
  const originalOrg = typeof me.orgId === "number" ? me.orgId : undefined;

  try {
    await grafanaAdminRequest(cfg, "POST", `/api/user/using/${orgId}`);

    const search = await grafanaAdminRequest(
      cfg,
      "GET",
      `/api/serviceaccounts/search?query=${
        encodeURIComponent(name)
      }&perpage=100`,
    );
    const list = (search.serviceAccounts as SaSummary[] | undefined) ?? [];
    const existing = list.find((sa) => sa.name === name);

    // Discover an existing token of tokenName (only relevant when minting).
    let existingToken: TokenSummary | undefined;
    if (mintToken && existing) {
      const toks = (await grafanaAdminRequest(
        cfg,
        "GET",
        `/api/serviceaccounts/${existing.id}/tokens`,
      )) as unknown as TokenSummary[];
      existingToken = (toks ?? []).find((t) => t.name === tokenName);
    }

    // Build the plan.
    const plannedActions: string[] = [];
    if (!existing) {
      plannedActions.push(`create service account '${name}' (role=${role})`);
    } else if (existing.role !== role) {
      plannedActions.push(
        `patch service account '${name}' role ${existing.role} -> ${role}`,
      );
    }
    if (mintToken) {
      if (existingToken && !force) {
        console.log(
          `[ensureServiceAccount] token '${tokenName}' already exists (id ${existingToken.id}); ` +
            `its secret is not retrievable — pass force:true to rotate it.`,
        );
      } else if (existingToken && force) {
        plannedActions.push(`rotate token '${tokenName}' (delete + recreate)`);
      } else {
        plannedActions.push(`mint token '${tokenName}'`);
      }
    }

    console.log(
      `[ensureServiceAccount] org=${orgId} sa='${name}' existed=${!!existing} ` +
        `role=${role} confirm=${confirm}`,
    );
    for (const a of plannedActions) console.log(`  - ${a}`);
    if (plannedActions.length === 0) {
      console.log(`  (no changes needed)`);
    }

    // Dry run: report state + plan, mutate nothing.
    if (!confirm) {
      if (plannedActions.length > 0) {
        console.log(
          `[ensureServiceAccount] DRY RUN — re-run with confirm:true to apply`,
        );
      }
      const handle = await context.writeResource(
        "serviceAccount",
        `${orgId}-${name}`,
        {
          grafanaUrl: cfg.grafanaUrl,
          orgId,
          name,
          role,
          saId: existing?.id,
          login: existing?.login,
          existed: !!existing,
          mutated: false,
          plannedActions,
          tokenName: mintToken ? tokenName : undefined,
          tokenMinted: false,
          ensuredAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    }

    // Apply.
    let sa: SaSummary;
    if (!existing) {
      const created = await grafanaAdminRequest(
        cfg,
        "POST",
        "/api/serviceaccounts",
        {
          name,
          role,
        },
      );
      sa = {
        id: created.id as number,
        name: (created.name as string) ?? name,
        login: created.login as string | undefined,
        role: (created.role as string | undefined) ?? role,
      };
      console.log(
        `[ensureServiceAccount] created SA id=${sa.id} login=${sa.login}`,
      );
    } else {
      sa = existing;
      if (existing.role !== role) {
        await grafanaAdminRequest(
          cfg,
          "PATCH",
          `/api/serviceaccounts/${existing.id}`,
          {
            role,
          },
        );
        sa = { ...existing, role };
        console.log(
          `[ensureServiceAccount] patched SA id=${sa.id} role -> ${role}`,
        );
      }
    }

    let tokenMinted = false;
    let tokenId: number | undefined;
    if (mintToken) {
      if (existingToken && force) {
        await grafanaAdminRequest(
          cfg,
          "DELETE",
          `/api/serviceaccounts/${sa.id}/tokens/${existingToken.id}`,
        );
        console.log(
          `[ensureServiceAccount] deleted old token id=${existingToken.id}`,
        );
        existingToken = undefined;
      }
      if (!existingToken) {
        const t = await grafanaAdminRequest(
          cfg,
          "POST",
          `/api/serviceaccounts/${sa.id}/tokens`,
          { name: tokenName },
        );
        tokenMinted = true;
        tokenId = t.id as number;
        console.log(
          `\n[ensureServiceAccount] ==== NEW TOKEN SECRET (shown once) ====\n` +
            `  ${t.key}\n` +
            `  Store it now in your secret manager (e.g. pass/vault).\n` +
            `  Grafana will never reveal this secret again.\n` +
            `========================================================\n`,
        );
      }
    }

    const handle = await context.writeResource(
      "serviceAccount",
      `${orgId}-${name}`,
      {
        grafanaUrl: cfg.grafanaUrl,
        orgId,
        name,
        role: sa.role ?? role,
        saId: sa.id,
        login: sa.login,
        existed: !!existing,
        mutated: true,
        plannedActions,
        tokenName: mintToken ? tokenName : undefined,
        tokenMinted,
        tokenId,
        ensuredAt: new Date().toISOString(),
      },
    );
    return { dataHandles: [handle] };
  } finally {
    // Restore the admin's original active org, best-effort.
    if (originalOrg !== undefined && originalOrg !== orgId) {
      try {
        await grafanaAdminRequest(
          cfg,
          "POST",
          `/api/user/using/${originalOrg}`,
        );
      } catch (_e) { /* best-effort restore */ }
    }
  }
}

interface EnsureContactPointArgs {
  orgId: number;
  name: string;
  url: string;
  httpMethod: string;
  disableResolveMessage: boolean;
  title: string;
  message: string;
  confirm: boolean;
}

interface ContactPointSummary {
  uid?: string;
  name?: string;
  type?: string;
  settings?: Record<string, unknown>;
}

/**
 * Core of `configureWebhookContactPoint`, extracted so tests can drive it
 * directly. Ensures a generic **webhook**-type contact point (e.g. an ntfy
 * topic) exists in `orgId`, keyed by `name`: an existing point of the same
 * name is updated in place (PUT by uid), never duplicated. Dry-run unless
 * `confirm`. The admin's active org is switched for the operation and always
 * restored in the `finally`.
 */
export async function configureWebhookContactPoint(
  args: EnsureContactPointArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const {
    orgId,
    name,
    url,
    httpMethod,
    disableResolveMessage,
    title,
    message,
  } = args;
  const { confirm } = args;
  if (!name) throw new Error("name is required");
  if (!url) throw new Error("url is required");

  const me = await grafanaAdminRequest(cfg, "GET", "/api/user");
  const originalOrg = typeof me.orgId === "number" ? me.orgId : undefined;

  try {
    await grafanaAdminRequest(cfg, "POST", `/api/user/using/${orgId}`);

    // Contact points are org-scoped; list and match by name.
    const list = (await grafanaAdminRequest(
      cfg,
      "GET",
      `/api/v1/provisioning/contact-points?name=${encodeURIComponent(name)}`,
    )) as unknown as ContactPointSummary[];
    const existing = (list ?? []).find((cp) => cp.name === name);

    // Webhook settings. On update, MERGE onto the existing point's settings so
    // out-of-band keys the operator set (auth header, HMAC secret, TLS config)
    // survive — this method only owns url/httpMethod (and title/message when
    // supplied). Empty title/message are left untouched rather than nulled.
    const settings: Record<string, unknown> = {
      ...(existing?.settings ?? {}),
      url,
      httpMethod,
    };
    if (title) settings.title = title;
    if (message) settings.message = message;

    const contactPoint: Record<string, unknown> = {
      name,
      type: "webhook",
      settings,
      disableResolveMessage,
    };

    const plannedActions: string[] = [];
    if (!existing) {
      plannedActions.push(
        `create webhook contact point '${name}' -> ${url}`,
      );
    } else {
      plannedActions.push(
        `update webhook contact point '${name}' (uid ${existing.uid}) -> ${url}`,
      );
    }

    console.log(
      `[configureWebhookContactPoint] org=${orgId} name='${name}' ` +
        `type=webhook existed=${!!existing} confirm=${confirm}`,
    );
    for (const a of plannedActions) console.log(`  - ${a}`);

    if (!confirm) {
      console.log(
        `[configureWebhookContactPoint] DRY RUN — re-run with confirm:true to apply`,
      );
      const handle = await context.writeResource(
        "contactPoint",
        `${orgId}-${name}`,
        {
          grafanaUrl: cfg.grafanaUrl,
          orgId,
          name,
          contactType: "webhook",
          url,
          httpMethod,
          uid: existing?.uid,
          existed: !!existing,
          mutated: false,
          plannedActions,
          ensuredAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    }

    let uid = existing?.uid;
    if (!existing) {
      const created = await grafanaAdminRequest(
        cfg,
        "POST",
        "/api/v1/provisioning/contact-points",
        contactPoint,
      );
      uid = created.uid as string | undefined;
      console.log(
        `[configureWebhookContactPoint] created contact point uid=${uid}`,
      );
    } else {
      await grafanaAdminRequest(
        cfg,
        "PUT",
        `/api/v1/provisioning/contact-points/${existing.uid}`,
        { uid: existing.uid, ...contactPoint },
      );
      console.log(
        `[configureWebhookContactPoint] updated contact point uid=${existing.uid}`,
      );
    }

    const handle = await context.writeResource(
      "contactPoint",
      `${orgId}-${name}`,
      {
        grafanaUrl: cfg.grafanaUrl,
        orgId,
        name,
        contactType: "webhook",
        url,
        httpMethod,
        uid,
        existed: !!existing,
        mutated: true,
        plannedActions,
        ensuredAt: new Date().toISOString(),
      },
    );
    return { dataHandles: [handle] };
  } finally {
    if (originalOrg !== undefined && originalOrg !== orgId) {
      try {
        await grafanaAdminRequest(
          cfg,
          "POST",
          `/api/user/using/${originalOrg}`,
        );
      } catch (_e) { /* best-effort restore */ }
    }
  }
}

interface EnsureFolderArgs {
  orgId: number;
  title: string;
  uid: string;
  confirm: boolean;
}

interface FolderSummary {
  uid?: string;
  title?: string;
}

/**
 * Core of `ensureFolder`, extracted so tests can drive it directly. Ensures a
 * Grafana folder of `title` exists in `orgId` and returns its uid — alert
 * rules need a folderUID. Idempotent (matched by title); creates only when
 * absent. Dry-run unless `confirm`; on a dry run with no existing folder the
 * returned uid is the *desired* uid (when supplied) or undefined.
 */
export async function ensureFolder(
  args: EnsureFolderArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const { orgId, title, uid: desiredUid, confirm } = args;
  if (!title) throw new Error("title is required");

  const me = await grafanaAdminRequest(cfg, "GET", "/api/user");
  const originalOrg = typeof me.orgId === "number" ? me.orgId : undefined;

  try {
    await grafanaAdminRequest(cfg, "POST", `/api/user/using/${orgId}`);

    const list = (await grafanaAdminRequest(
      cfg,
      "GET",
      "/api/folders?limit=1000",
    )) as unknown as FolderSummary[];
    const existing = (list ?? []).find((f) => f.title === title);

    const plannedActions: string[] = [];
    if (!existing) {
      plannedActions.push(
        `create folder '${title}'` +
          (desiredUid ? ` (uid ${desiredUid})` : ""),
      );
    }

    console.log(
      `[ensureFolder] org=${orgId} title='${title}' existed=${!!existing} ` +
        `confirm=${confirm}`,
    );
    for (const a of plannedActions) console.log(`  - ${a}`);
    if (plannedActions.length === 0) {
      console.log(`  (folder already exists, uid=${existing?.uid})`);
    }

    if (!confirm || existing) {
      if (!confirm && !existing) {
        console.log(
          `[ensureFolder] DRY RUN — re-run with confirm:true to create`,
        );
      }
      const handle = await context.writeResource(
        "folder",
        `${orgId}-${title}`,
        {
          grafanaUrl: cfg.grafanaUrl,
          orgId,
          title,
          uid: existing?.uid ?? (desiredUid || undefined),
          existed: !!existing,
          mutated: false,
          plannedActions,
          ensuredAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    }

    const body: Record<string, unknown> = { title };
    if (desiredUid) body.uid = desiredUid;
    const created = await grafanaAdminRequest(
      cfg,
      "POST",
      "/api/folders",
      body,
    );
    const uid = created.uid as string | undefined;
    console.log(`[ensureFolder] created folder uid=${uid}`);

    const handle = await context.writeResource("folder", `${orgId}-${title}`, {
      grafanaUrl: cfg.grafanaUrl,
      orgId,
      title,
      uid,
      existed: false,
      mutated: true,
      plannedActions,
      ensuredAt: new Date().toISOString(),
    });
    return { dataHandles: [handle] };
  } finally {
    if (originalOrg !== undefined && originalOrg !== orgId) {
      try {
        await grafanaAdminRequest(
          cfg,
          "POST",
          `/api/user/using/${originalOrg}`,
        );
      } catch (_e) { /* best-effort restore */ }
    }
  }
}

interface OrgSummary {
  id: number;
  name: string;
}

/**
 * Core of `listOrgs`, extracted so tests can drive it directly. Lists every
 * org visible to the server admin (`GET /api/orgs`) — a read-only discovery
 * step, no org switch and nothing mutated — and writes an `orgs` snapshot so
 * the id backing a tenant can be referenced via CEL before minting a service
 * account into it.
 */
export async function listOrgs(
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const raw = (await grafanaAdminRequest(
    cfg,
    "GET",
    "/api/orgs",
  )) as unknown as OrgSummary[];
  const orgs = (raw ?? []).map((o) => ({ id: o.id, name: o.name }));

  console.log(`[listOrgs] ${cfg.grafanaUrl} — ${orgs.length} org(s):`);
  for (const o of orgs) console.log(`  - ${o.id}: ${o.name}`);

  const handle = await context.writeResource("orgs", "orgs", {
    grafanaUrl: cfg.grafanaUrl,
    orgs,
    count: orgs.length,
    listedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

interface EnsureOrgArgs {
  name: string;
  confirm: boolean;
}

/**
 * Core of `ensureOrg`, extracted so tests can drive it directly. Ensures a
 * Grafana org of `name` exists and returns its id. Org CRUD is server-admin
 * global, so there is no org switch. Idempotent — matched by name against
 * `GET /api/orgs`, created only when absent. Dry-run unless `confirm`.
 */
export async function ensureOrg(
  args: EnsureOrgArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const { name, confirm } = args;
  if (!name) throw new Error("name is required");

  const raw = (await grafanaAdminRequest(
    cfg,
    "GET",
    "/api/orgs",
  )) as unknown as OrgSummary[];
  const existing = (raw ?? []).find((o) => o.name === name);

  const plannedActions: string[] = [];
  if (!existing) plannedActions.push(`create org '${name}'`);

  console.log(
    `[ensureOrg] ${cfg.grafanaUrl} name='${name}' existed=${!!existing} ` +
      `confirm=${confirm}`,
  );
  for (const a of plannedActions) console.log(`  - ${a}`);
  if (plannedActions.length === 0) {
    console.log(`  (org already exists, id=${existing?.id})`);
  }

  // Dry run, or nothing to do (org already exists): report state, mutate nothing.
  if (!confirm || existing) {
    if (!confirm && !existing) {
      console.log(`[ensureOrg] DRY RUN — re-run with confirm:true to create`);
    }
    const handle = await context.writeResource("org", name, {
      grafanaUrl: cfg.grafanaUrl,
      name,
      orgId: existing?.id,
      existed: !!existing,
      mutated: false,
      plannedActions,
      ensuredAt: new Date().toISOString(),
    });
    return { dataHandles: [handle] };
  }

  const created = await grafanaAdminRequest(cfg, "POST", "/api/orgs", { name });
  const orgId = created.orgId as number | undefined;
  console.log(`[ensureOrg] created org '${name}' id=${orgId}`);

  const handle = await context.writeResource("org", name, {
    grafanaUrl: cfg.grafanaUrl,
    name,
    orgId,
    existed: false,
    mutated: true,
    plannedActions,
    ensuredAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

interface EnsureDatasourceArgs {
  orgId: number;
  name: string;
  dsType: "prometheus" | "loki";
  url: string;
  tenant: string;
  isDefault: boolean;
  confirm: boolean;
}

interface DatasourceSummary {
  id?: number;
  uid?: string;
  name?: string;
  type?: string;
  url?: string;
  jsonData?: Record<string, unknown>;
  isDefault?: boolean;
}

/**
 * Core of `ensureDatasource`, extracted so tests can drive it directly. Ensures
 * a proxy-access datasource (`dsType` = prometheus | loki) named `name` exists
 * in `orgId`, pointing at `url`, with the tenant header injected server-side:
 * `X-Scope-OrgID` as httpHeaderName1 in jsonData and its value `tenant` in
 * secureJsonData (which Grafana never returns on GET, so it is always re-sent).
 * This is the query-side tenant wall: the value lives in secureJsonData so an
 * org Viewer can neither read it nor forge a different tenant's id on this
 * datasource. Idempotent by (orgId, name): an existing datasource is updated in
 * place (PUT by uid), never duplicated, and its other jsonData keys are
 * preserved. Dry-run unless `confirm`. The admin's active org is switched for
 * the operation and always restored in the `finally`.
 */
export async function ensureDatasource(
  args: EnsureDatasourceArgs,
  context: ExecuteContext,
): Promise<ExecuteResult> {
  const cfg = context.globalArgs;
  const { orgId, name, dsType, url, tenant, isDefault, confirm } = args;
  if (!name) throw new Error("name is required");
  if (!url) throw new Error("url is required");

  const me = await grafanaAdminRequest(cfg, "GET", "/api/user");
  const originalOrg = typeof me.orgId === "number" ? me.orgId : undefined;

  try {
    await grafanaAdminRequest(cfg, "POST", `/api/user/using/${orgId}`);

    const list = (await grafanaAdminRequest(
      cfg,
      "GET",
      "/api/datasources",
    )) as unknown as DatasourceSummary[];
    const existing = (list ?? []).find((d) => d.name === name);

    // Tenant header: the NAME lives in jsonData, the VALUE in secureJsonData.
    // Merge onto any existing jsonData so out-of-band keys survive; only
    // httpHeaderName1 is owned here. The value is always re-sent because
    // Grafana does not return secureJsonData on GET.
    const jsonData: Record<string, unknown> = { ...(existing?.jsonData ?? {}) };
    const secureJsonData: Record<string, unknown> = {};
    if (tenant) {
      jsonData.httpHeaderName1 = "X-Scope-OrgID";
      secureJsonData.httpHeaderValue1 = tenant;
    }

    const body: Record<string, unknown> = {
      name,
      type: dsType,
      access: "proxy",
      url,
      isDefault,
      jsonData,
      ...(tenant ? { secureJsonData } : {}),
    };

    const plannedActions: string[] = [];
    if (!existing) {
      plannedActions.push(
        `create ${dsType} datasource '${name}' -> ${url}` +
          (tenant ? ` (X-Scope-OrgID=${tenant})` : ""),
      );
    } else {
      plannedActions.push(
        `update ${dsType} datasource '${name}' (uid ${existing.uid}) -> ${url}` +
          (tenant ? ` (X-Scope-OrgID=${tenant})` : ""),
      );
    }

    console.log(
      `[ensureDatasource] org=${orgId} name='${name}' type=${dsType} ` +
        `existed=${!!existing} confirm=${confirm}`,
    );
    for (const a of plannedActions) console.log(`  - ${a}`);

    if (!confirm) {
      console.log(
        `[ensureDatasource] DRY RUN — re-run with confirm:true to apply`,
      );
      const handle = await context.writeResource(
        "datasource",
        `${orgId}-${name}`,
        {
          grafanaUrl: cfg.grafanaUrl,
          orgId,
          name,
          dsType,
          url,
          tenant,
          isDefault,
          uid: existing?.uid,
          existed: !!existing,
          mutated: false,
          plannedActions,
          ensuredAt: new Date().toISOString(),
        },
      );
      return { dataHandles: [handle] };
    }

    let uid = existing?.uid;
    if (!existing) {
      const created = await grafanaAdminRequest(
        cfg,
        "POST",
        "/api/datasources",
        body,
      );
      // POST /api/datasources returns the created row either at top level or
      // nested under `datasource` across Grafana versions; read uid from the
      // nested object when present.
      const ds = (created.datasource as DatasourceSummary | undefined) ??
        (created as DatasourceSummary);
      uid = ds.uid;
      console.log(`[ensureDatasource] created datasource uid=${uid}`);
    } else {
      await grafanaAdminRequest(
        cfg,
        "PUT",
        `/api/datasources/uid/${existing.uid}`,
        body,
      );
      console.log(`[ensureDatasource] updated datasource uid=${existing.uid}`);
    }

    const handle = await context.writeResource(
      "datasource",
      `${orgId}-${name}`,
      {
        grafanaUrl: cfg.grafanaUrl,
        orgId,
        name,
        dsType,
        url,
        tenant,
        isDefault,
        uid,
        existed: !!existing,
        mutated: true,
        plannedActions,
        ensuredAt: new Date().toISOString(),
      },
    );
    return { dataHandles: [handle] };
  } finally {
    if (originalOrg !== undefined && originalOrg !== orgId) {
      try {
        await grafanaAdminRequest(
          cfg,
          "POST",
          `/api/user/using/${originalOrg}`,
        );
      } catch (_e) { /* best-effort restore */ }
    }
  }
}

// --- Model ------------------------------------------------------------------

/**
 * The `@shrug/grafana-admin/instance` model: Grafana control-plane operations
 * authenticated as the server admin (basic auth). Currently
 * `ensureServiceAccount` (idempotent, dry-run by default), which the community
 * `@keeb/grafana/instance` SA-token model cannot do.
 */
export const model = {
  type: "@shrug/grafana-admin/instance",
  version: "2026.11.18.1",
  description:
    "Grafana control-plane over admin basic-auth: list orgs, idempotently ensure an org, a tenant-scoped datasource (X-Scope-OrgID in secureJsonData), a service account (and optionally mint its token), a webhook (e.g. ntfy) contact point, or a folder. Dry-run by default; confirm:true to apply.",
  globalArguments: GlobalArgsSchema,
  resources: {
    "serviceAccount": {
      description:
        "State + plan for an ensured service account (never stores the token secret)",
      schema: ServiceAccountSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "contactPoint": {
      description:
        "State + plan for an ensured webhook (e.g. ntfy) contact point",
      schema: ContactPointSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "folder": {
      description:
        "State + plan for an ensured Grafana folder (returns its uid)",
      schema: FolderSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "orgs": {
      description:
        "Read-only snapshot of all orgs visible to the server admin (GET /api/orgs)",
      schema: OrgsSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
    "org": {
      description:
        "State + plan for an ensured org (created by name when absent; returns its id)",
      schema: EnsuredOrgSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "datasource": {
      description:
        "State + plan for an ensured datasource in an org (tenant header in secureJsonData)",
      schema: DatasourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    listOrgs: {
      description:
        "List every org visible to the server admin (GET /api/orgs). Read-only discovery — use it to find the org id backing a tenant before ensuring a service account into it.",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<ExecuteResult> => listOrgs(context),
    },
    ensureOrg: {
      description:
        "Idempotently ensure a Grafana org of the given name exists and return its id (org CRUD is server-admin global). Dry-run unless confirm:true; matched by name, created only when absent. A dedicated org per tenant is the query-side tenant boundary.",
      arguments: z.object({
        name: z.string().describe(
          "Org name (match key for idempotency), e.g. AcmeCorp",
        ),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to create — otherwise a read-only dry run"),
      }),
      execute: (
        args: { name: string; confirm: boolean },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => ensureOrg(args, context),
    },
    ensureDatasource: {
      description:
        "Idempotently ensure a proxy-access datasource (prometheus | loki) exists in an org, pointing at url, with the X-Scope-OrgID tenant header injected server-side (value stored in secureJsonData so org Viewers cannot read or forge it). Dry-run unless confirm:true; matched by name within the org, updated in place (never duplicated).",
      arguments: z.object({
        orgId: z.number().describe(
          "Target Grafana org id the datasource belongs to",
        ),
        name: z.string().describe(
          "Datasource name (match key for idempotency within the org)",
        ),
        dsType: z
          .enum(["prometheus", "loki"])
          .describe("Grafana datasource type"),
        url: z.string().describe(
          "Backend URL Grafana proxies to (e.g. the Mimir/Loki query endpoint)",
        ),
        tenant: z
          .string()
          .default("")
          .describe(
            "X-Scope-OrgID value to scope reads to (e.g. acme); empty = no tenant header",
          ),
        isDefault: z
          .boolean()
          .default(false)
          .describe("Mark this the org's default datasource"),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to apply — otherwise a read-only dry run"),
      }),
      execute: (
        args: {
          orgId: number;
          name: string;
          dsType: "prometheus" | "loki";
          url: string;
          tenant: string;
          isDefault: boolean;
          confirm: boolean;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => ensureDatasource(args, context),
    },
    ensureServiceAccount: {
      description:
        "Idempotently ensure a service account with the given role exists in an org, optionally minting a token. Dry-run unless confirm:true; the minted secret is printed once and never persisted.",
      arguments: z.object({
        orgId: z.number().describe(
          "Target Grafana org id (e.g. 1 = Main Org.)",
        ),
        name: z.string().describe(
          "Service account name (match key for idempotency)",
        ),
        role: Role.default("Editor").describe("Org role for the SA"),
        mintToken: z
          .boolean()
          .default(false)
          .describe(
            "Also mint an API token (secret printed once to the run log)",
          ),
        tokenName: z
          .string()
          .default("")
          .describe("Token name; defaults to '<name>-token' when minting"),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Rotate an existing token of tokenName (delete + recreate)",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to apply — otherwise a read-only dry run"),
      }),
      execute: (
        args: {
          orgId: number;
          name: string;
          role: z.infer<typeof Role>;
          mintToken: boolean;
          tokenName: string;
          force: boolean;
          confirm: boolean;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> =>
        ensureServiceAccount(
          {
            ...args,
            tokenName: args.tokenName || `${args.name}-token`,
          },
          context,
        ),
    },
    configureWebhookContactPoint: {
      description:
        "Idempotently ensure a generic webhook-type contact point (e.g. pointing at an ntfy topic URL) in an org, keyed by name. Dry-run unless confirm:true; an existing point of the same name is updated in place, never duplicated.",
      arguments: z.object({
        orgId: z.number().default(1).describe(
          "Target Grafana org id (e.g. 1 = Main Org.)",
        ),
        name: z.string().describe(
          "Contact point name (match key for idempotency; alert rules route to it by name)",
        ),
        url: z.string().describe(
          "Webhook target URL — e.g. the ntfy topic URL https://ntfy.example/<topic>",
        ),
        httpMethod: z
          .enum(["POST", "PUT"])
          .default("POST")
          .describe("HTTP method Grafana uses to call the webhook"),
        disableResolveMessage: z
          .boolean()
          .default(false)
          .describe("Suppress the follow-up 'resolved' notification"),
        title: z
          .string()
          .default("")
          .describe(
            "Optional Grafana notification title template (left unset if empty)",
          ),
        message: z
          .string()
          .default("")
          .describe(
            "Optional Grafana notification message/body template (left unset if empty)",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to apply — otherwise a read-only dry run"),
      }),
      execute: (
        args: {
          orgId: number;
          name: string;
          url: string;
          httpMethod: "POST" | "PUT";
          disableResolveMessage: boolean;
          title: string;
          message: string;
          confirm: boolean;
        },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => configureWebhookContactPoint(args, context),
    },
    ensureFolder: {
      description:
        "Idempotently ensure a Grafana folder of the given title exists in an org and return its uid (alert rules need a folderUID). Dry-run unless confirm:true; matched by title, created only when absent.",
      arguments: z.object({
        orgId: z.number().default(1).describe(
          "Target Grafana org id (e.g. 1 = Main Org.)",
        ),
        title: z.string().describe(
          "Folder title (match key for idempotency)",
        ),
        uid: z
          .string()
          .default("")
          .describe(
            "Optional desired folder uid when creating (Grafana assigns one if empty)",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to create — otherwise a read-only dry run"),
      }),
      execute: (
        args: { orgId: number; title: string; uid: string; confirm: boolean },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => ensureFolder(args, context),
    },
  },
  checks: {
    "admin-authenticates": {
      description:
        "Verify the Grafana admin basic-auth credentials work (GET /api/user) before mutating",
      labels: ["live"],
      appliesTo: [
        "ensureServiceAccount",
        "configureWebhookContactPoint",
        "ensureFolder",
      ],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        try {
          const me = await grafanaAdminRequest(
            context.globalArgs,
            "GET",
            "/api/user",
          );
          if (typeof me.login !== "string") {
            return {
              pass: false,
              errors: [
                "GET /api/user returned no login — unexpected admin identity",
              ],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `Grafana admin auth failed at ${context.globalArgs.grafanaUrl}: ` +
              (e instanceof Error ? e.message : String(e)),
            ],
          };
        }
      },
    },
  },
};
