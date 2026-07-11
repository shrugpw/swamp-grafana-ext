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

// --- Model ------------------------------------------------------------------

/**
 * The `@shrug/grafana-admin/instance` model: Grafana control-plane operations
 * authenticated as the server admin (basic auth). Currently
 * `ensureServiceAccount` (idempotent, dry-run by default), which the community
 * `@keeb/grafana/instance` SA-token model cannot do.
 */
export const model = {
  type: "@shrug/grafana-admin/instance",
  version: "2026.07.11.1",
  description:
    "Grafana control-plane over admin basic-auth: idempotently ensure a service account (and optionally mint its token) in a given org. Dry-run by default; confirm:true to apply.",
  globalArguments: GlobalArgsSchema,
  resources: {
    "serviceAccount": {
      description:
        "State + plan for an ensured service account (never stores the token secret)",
      schema: ServiceAccountSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
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
  },
  checks: {
    "admin-authenticates": {
      description:
        "Verify the Grafana admin basic-auth credentials work (GET /api/user) before mutating",
      labels: ["live"],
      appliesTo: ["ensureServiceAccount"],
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
