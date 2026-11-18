# @shrug/grafana-ext

Two swamp-native fills for gaps the community
[`@keeb/grafana`](https://github.com/keeb/swamp-grafana) model leaves open:

1. **`@shrug/grafana-admin/instance`** -- Grafana *control-plane* over server
   **admin basic-auth**. `ensureServiceAccount` idempotently creates (or
   role-patches) a service account in a given org and optionally mints its API
   token. A `@keeb/grafana` SA token is org-scoped and can't create *other*
   SAs, so bootstrapping dashboard-push service accounts otherwise means a
   one-off `curl` against the admin API -- this replaces it.
2. **`queryLogs`** (an `export const extension` on `@keeb/grafana/instance`) --
   the Loki sibling of the model's `queryMetrics`. Same Bearer SA token, same
   datasource-proxy pattern, LogQL instead of PromQL. Keeps "swamp-native reads"
   whole: metrics *and* logs off the one instance model.

> `queryLogs` requires the `@keeb/grafana` extension to be installed (it merges
> into that model's `instance` type). Pull it first:
> `swamp extension pull @keeb/grafana`.

## ensureServiceAccount

Dry-run by default -- it reports the plan and mutates nothing until
`confirm:true`. Minting a token is a second opt-in (`mintToken:true`); the
secret is printed to the run log **once** (Grafana never reveals it again) and
is deliberately not persisted in swamp data.

```bash
# Instance (admin basic-auth; password resolved from a vault via CEL)
swamp model create @shrug/grafana-admin/instance grafana-admin \
  --global-arg 'grafanaUrl=https://grafana.example.com' \
  --global-arg 'adminPassword=${{ vault.get("<vault>", "grafana/admin-password") }}'

# Dry run -- what would happen?
swamp model method run grafana-admin ensureServiceAccount \
  --input orgId:json=1 --input name=dashboards --input role=Editor

# Apply + mint the token (secret printed once)
swamp model method run grafana-admin ensureServiceAccount \
  --input orgId:json=1 --input name=dashboards --input role=Editor \
  --input mintToken:json=true --input confirm:json=true
```

Idempotent: re-running ensures the SA + role; a token is only minted when
`mintToken:true` and one named `tokenName` (default `<name>-token`) does not
already exist. `force:true` rotates (delete + recreate) an existing token. The
admin's active org is switched to `orgId` for the operation and restored
afterward.

| Argument     | Default        | Meaning                                             |
| ------------ | -------------- | --------------------------------------------------- |
| `orgId`      | --              | Target org id (e.g. 1 = Main Org.)                  |
| `name`       | --              | Service account name (idempotency match key)        |
| `role`       | `Editor`       | `Viewer` \| `Editor` \| `Admin`                     |
| `mintToken`  | `false`        | Also mint an API token (secret printed once)        |
| `tokenName`  | `<name>-token` | Token name                                          |
| `force`      | `false`        | Rotate an existing token of `tokenName`             |
| `confirm`    | `false`        | Must be true to apply -- otherwise a read-only plan  |

## queryLogs

Merges into the existing `@keeb/grafana/instance` type -- use it on any instance
of that model:

```bash
swamp model method run my-grafana queryLogs \
  --input 'query={service_name=~".+"} |= `error`' \
  --input start=1h --input limit:json=50
```

Auto-discovers the Loki datasource (or pass `datasourceName` to disambiguate),
runs a LogQL `query_range` over the DS proxy, logs the lines, and snapshots the
raw result into a `logResult` resource.

| Argument         | Default    | Meaning                                    |
| ---------------- | ---------- | ------------------------------------------ |
| `query`          | --          | LogQL query string                         |
| `start`          | `1h`       | Range start (ISO8601 or relative `15m`)    |
| `end`            | now        | Range end (ISO8601 or relative)            |
| `limit`          | `100`      | Max log lines                              |
| `direction`      | `backward` | `backward` (newest-first) or `forward`     |
| `datasourceName` | first Loki | Loki datasource name to disambiguate       |

## Tests

```bash
deno test extensions/models/
```

## License

MIT (c) Neil Hanlon
