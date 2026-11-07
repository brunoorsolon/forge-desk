# HTTP API

The Forge Desk server (`forge-desk serve`, or `npm start`) exposes a small API next to the web UI. Planning reads tracker state; opt-in release publication can create approved tags and releases. All paths are at the root (there is no base-path option). The examples assume a local server on port 8080 started with the demo config:

```sh
FD_CONFIG=config.demo.yaml npm start
```

Contents:

- [Endpoints](#endpoints)
- [Common behaviour](#common-behaviour)
- [Authentication](#authentication)
- [All-source sweeps](#all-source-sweeps)
- [Account preferences](#account-preferences)
- [Snapshot schema](#snapshot-schema)
- [Examples](#examples)

## Endpoints

| Method | Path                                                | Description                                                                             | Success                                  |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| GET    | `/healthz`                                          | Liveness check. **No authentication.**                                                  | `200` `{"status":"ok"}`                  |
| GET    | `/api/views`                                        | The configured views                                                                    | `200` array of view summaries            |
| GET    | `/api/projects`                                     | Configured project catalog and policy status                                            | `200` catalog                            |
| GET    | `/api/projects/:source/:owner/:repo/snapshot`       | Project snapshot and freshness                                                          | `200` scope response                     |
| GET    | `/api/sources/:source/snapshot`                     | All projects in a source                                                                | `200` scope response                     |
| POST   | `/api/projects/:source/:owner/:repo/refresh`        | Start/join a protected project recheck                                                  | `200` scope response                     |
| POST   | `/api/sources/:source/refresh`                      | Start/join a protected source recheck                                                   | `200` scope response                     |
| GET    | `/api/projects/:source/:owner/:repo/export.:format` | Project export, optional `?refresh=1`                                                   | `200` file                               |
| GET    | `/api/sources/:source/export.:format`               | Source export, optional `?refresh=1`                                                    | `200` file                               |
| POST   | `/api/refresh`                                      | Start/join a protected all-source sweep                                                 | `200` sweep status                       |
| GET    | `/api/refresh`                                      | Current/most recent sweep, without starting work                                        | `200` sweep status or `null`             |
| GET    | `/api/preferences`                                  | Application account preferences                                                         | `200` available/unavailable state        |
| POST   | `/api/preferences/favorites`                        | Add a catalog project                                                                   | `200` authoritative preferences          |
| DELETE | `/api/preferences/favorites/:source/:owner/:repo`   | Remove a favorite                                                                       | `200` authoritative preferences          |
| PUT    | `/api/preferences/remembered-project`               | Remember a catalog project                                                              | `200` authoritative preferences          |
| GET    | `/api/settings`                                     | Settings for the web UI and the running version                                         | `200` `{"refreshMinutes":5,...}`         |
| GET    | `/api/views/:id/snapshot`                           | The plan and layout of a view                                                           | `200` snapshot with `ETag`, or `304`     |
| POST   | `/api/views/:id/refresh`                            | Force a refetch from the tracker, ignoring the cache                                    | `200` snapshot with `ETag`               |
| GET    | `/api/views/:id/export.:format`                     | The snapshot rendered as a file: `json`, `md`, `mmd` (Mermaid) or `dot`                 | `200` text with `Content-Disposition`    |
| POST   | `/api/webhooks/github`                              | Webhook receiver for GitHub issue and pull-request events (only with a secret)          | `202` `{"invalidated":[...]}`            |
| POST   | `/api/webhooks/gitea`                               | Webhook receiver for Gitea / Forgejo issue and pull-request events (only with a secret) | `202` `{"invalidated":[...]}`            |
| GET    | `/api/session`                                      | The signed-in user and session CSRF token (only with a login configured)                | `200` `{"username","csrfToken"}`         |
| GET    | `/api/releases/repositories`                        | Configured release repositories and their capability (releases only)                    | `200` array of capabilities              |
| POST   | `/api/releases/plans/:planId/publish`               | Approve a stored plan digest and start publication (releases only)                      | `202` durable job and `statusUrl`        |
| POST   | `/api/releases/jobs/:jobId/reconcile`               | Inspect a publication through reads only (releases only)                                | `202` reconciliation job and `statusUrl` |
| GET    | `/api/releases/jobs/:jobId/receipt`                 | Human-readable publication evidence (releases only)                                     | `200` plain text                         |
| GET    | `/login`                                            | The login page (only with a login configured). **No authentication.**                   | `200` HTML                               |
| POST   | `/login`                                            | Form login: `username` and `password`, form-encoded                                     | `303` to the UI, with session cookie     |
| POST   | `/logout`                                           | Ends the session and clears the cookie                                                  | `303` to the login page                  |
| GET    | `/` and other paths                                 | The web UI (static files)                                                               | `200` HTML/JS/CSS                        |

### `GET /api/views`

Returns one summary per configured view:

```json
[
  {
    "id": "demo",
    "title": "Acme demo roadmap",
    "source": "demo",
    "kind": "fixture",
    "repos": ["acme/api", "acme/web"]
  }
]
```

`kind` is the provider kind of the view's source (`github`, `gitea` or `fixture`).

### Project catalog and scope reads

`GET /api/projects` returns `{ sources: [{ id, kind, projects: [{ source, repo }], policy }] }`.
Sources retain configuration order; each project's lowercase `owner/repo` is sorted and distinct.
`policy` is `{ status: "usable" }` or `{ status: "conflict", conflict }`, where `conflict`
is `{ source, differingSettings, views, explanation }`. Sources without views have an empty
project list. The catalog is the union of named-view repositories, including repositories with no open issues; release-only and dependency-only repositories are not catalog projects. A catalog
conflict is returned in this successful response, not as a route error. No source tokens are returned.

- `GET /api/projects/:source/:owner/:repo/snapshot`
- `GET /api/sources/:source/snapshot`

Both return `200` with the scope read response `{ scope, snapshot, freshness, job }`.
`scope` is `{ kind: "project", source, repo }` (canonical lowercase `owner/repo`) or
`{ kind: "source", source }`. Source IDs identify separate catalogs even if two sources point
at the same forge. Snapshot GETs are cache-first and do not interpret `refresh=1`; use the
protected refresh POST for an explicit recheck. The query flag belongs to scope exports. The snapshot is the
existing snapshot shape, or `null` while loading or unavailable. Its `viewId` is
`project:<source>/<owner>/<repo>` or `source:<source>` and `fetchedAt` is the oldest contributing
repository check, not computation time. `freshness` reports `computedAt`, each repository's
`lastCheckedAt`, state, partial coverage, error and cooldown end, plus outside-issue counts and age.
`freshness` has this exact shape:

```ts
interface ScopeFreshness {
  computedAt: string | null;
  repositories: {
    project: { source: string; repo: string };
    lastCheckedAt: string | null;
    state: 'fresh' | 'stale' | 'updating' | 'invalidated' | 'delayed' | 'failed' | 'unavailable';
    partial: boolean;
    error: string | null;
    delayedUntil: string | null;
  }[];
  outsideIssues: { count: number; oldestObservedAt: string | null; provisionalCount: number };
}
```

All timestamps are ISO UTC strings. Partial dependency coverage is independent of freshness;
last-good data and its original check time survive a failed refresh. A verified empty listing
produces a real empty snapshot; missing/unavailable data does not.

`job` is an active refresh job or `null`. Its common fields are `id`, `scope`, `trigger`
(`interactive` or `scheduled`), `state` (`queued`, `running`, `completed`, `partial`, `failed`),
`queuedAt`, nullable `startedAt`, `finishedAt`, `delayedUntil` and `error`. Scope jobs additionally
expose `priority` (`interactive` or `sweep`) and `units`. Each unit identifies a repository
(`{ kind: "repository", project }`) or targeted dependency (`{ kind: "outside-issue", source, key }`)
and includes `state` (`queued`, `checking`, `checked`, `failed`), nullable `startedAt`, `finishedAt`,
`lastCheckedAt`, `error`, and boolean `partial`. The complete contracts are in
[`src/core/scope.ts`](../src/core/scope.ts).

Cached data returns immediately; stale or invalidated data starts a paced background job. A first
read waits at most 15 seconds, returning a null snapshot and live job when still loading. A known
provider cooldown is reported immediately. With zero cache TTL the read revalidates instead of
serving cached observations; a cooldown returns `503` with `code: "source-cooldown"` and
`delayedUntil`. Scope reads have no `ETag` or `304`: freshness can change independently of plan content.

Unknown sources and projects return `404` with `unknown-source` or `unknown-project`; policy
conflicts return `409` with `policy-conflict` and the explanation. All these routes use the existing
planning login when configured, and are open otherwise. Responses are `Cache-Control: no-store`, with no CORS headers. Scope errors use
`{ code, error }`; a cooldown also includes `delayedUntil`. Closing the runtime returns
`503` with `code: "server-closing"`.

### Explicit scope refresh

- `POST /api/projects/:source/:owner/:repo/refresh`
- `POST /api/sources/:source/refresh`

Send no body. Both start or join a paced recheck even when observations are fresh, wait up to
the same 15-second bound, and return `200` with `{ scope, snapshot, freshness, job }` just like snapshot reads.
A project refresh lists only that repository and looks up the outside issues its plan needs.
A source refresh covers its entire configured catalog, including empty projects. Concurrent
requests join queued or running work rather than duplicating upstream requests. A timeout
leaves the job running; failures retain last-good observations with their original check time.

Every refresh launch requires `x-forge-desk-request: 1`. A supplied `Origin` must match
`server.publicOrigin` by host and port, or the request's `Host` when no public origin is configured.
With a login configured, scripts use Basic credentials without a session cookie; browser sessions
must also send their Origin and the session-bound `x-csrf-token` from `GET /api/session`.
Session cookies and Authorization headers cannot be combined. Without a login, the launch header
and Origin rules still apply. The routes do not enable CORS.

Access failures return `401` (`unauthenticated`) or `403` (`missing-launch-header`,
`forbidden-origin`, `missing-csrf`, `invalid-csrf`, `mixed-credentials`). The scope `404`, `409`
and zero-TTL cooldown `503` responses are the same as snapshot reads. Closing the scope runtime
rejects new work with `503` and `code: "server-closing"`. Named-view refresh behavior is unchanged.

### Scope exports

- `GET /api/projects/:source/:owner/:repo/export.:format`
- `GET /api/sources/:source/export.:format`

Successful exports return `200`. Formats are the same `json`, `md`, `mmd` and `dot` as named views; an unknown format returns `404 { "error": "Not found" }` without fetching. JSON remains a Snapshot, not a
ScopeResponse. All formats include freshness and dependency coverage warnings. Mermaid and DOT
include those warnings as line comments; named-view/CLI output is unchanged. Filenames replace
scope ID separators with hyphens.

A download uses existing observations even when stale, without starting a background refresh.
A cold download fetches its scope; `?refresh=1` (or `true`) explicitly rechecks first. Zero TTL
always revalidates. Export revalidation shares providers and observations but is not paced, like
named-view and CLI traffic; the provider's ordinary cooldown still applies. If no snapshot can be
returned, the route answers `503` with `code: "scope-unavailable"` and the scope response, never
an empty fabricated plan. With caching enabled, existing last-good data is retained with warnings on failed revalidation.
Identity/policy errors, zero-TTL cooldown and shutdown use the snapshot `404`/`409`/`503` codes.
Exports use ordinary planning authentication, not the refresh-launch header/CSRF gate, even with
`refresh=1`. Only `1` and `true` trigger explicit revalidation; other query values are ignored.

### All-source sweeps

- `POST /api/refresh` starts a sweep or joins the one already queued/running. Send no body.
  It returns `200` with the current `SweepStatus` immediately, without waiting for completion.
- `GET /api/refresh` returns `200` with the current or most recent `SweepStatus`, or JSON `null`
  before any sweep. This read starts no work.

Both use `Cache-Control: no-store` and send no CORS headers. The POST uses exactly the
[refresh-launch protection](#explicit-scope-refresh) above, including the launch header,
Origin, session CSRF and Basic-auth rules and their `401`/`403` codes. The GET uses ordinary
planning authentication: with a configured login, missing credentials return `401`
`{"error":"Unauthorized"}`; otherwise it is open.

The status fields are:

| Field                     | Shape / meaning                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                      | Sweep identifier. Joining keeps the same ID, trigger and original start time.                                           |
| `trigger`                 | `interactive` for a manual launch, `scheduled` for startup or the timer.                                                |
| `state`                   | `queued`, `running`, `completed`, `partial`, `failed` or `skipped`.                                                     |
| `startedAt`, `finishedAt` | ISO UTC timestamps; finish is `null` while active.                                                                      |
| `skipReason`              | Present as `caching-disabled` when zero TTL prevents sweep work.                                                        |
| `sources`                 | In configuration order; each entry is `{ source, state, delayedUntil, error, policyConflict, projects }`.               |
| Source `state`            | `queued`, `running`, `completed`, `partial`, `failed`, `conflict` or `delayed`.                                         |
| `delayedUntil`            | ISO UTC cooldown end or `null`. One delayed source does not stop the others.                                            |
| `policyConflict`          | The catalog conflict object described above, or `null`.                                                                 |
| `projects`                | Catalog order; entries `{ project: { source, repo }, state, lastCheckedAt, error }`.                                    |
| Project `state`           | `queued`, `checking`, `checked` or `failed`.                                                                            |
| `lastCheckedAt`, `error`  | Last successful upstream check or `null`, and error string or `null`; failure retains an earlier successful check time. |

A source policy conflict is recorded inside the `200` sweep status, not returned as an HTTP
`409` for the whole sweep. Progress and failures belong to the status; a successful POST
means launched/joined, not that every source refreshed successfully. Status is in memory
and resets on restart.

With `refresh.sweepHours > 0`, server startup launches a scheduled sweep and the next timer
runs that many hours after completion. `0` disables automatic sweeps, not manual launches.
With `cache.ttlSeconds: 0`, manual or startup launches finish as `skipped` with
`skipReason: "caching-disabled"`, no sources and no upstream requests; no further timer is
scheduled. See [quota and pacing](DEPLOYMENT.md#background-sweeps-and-api-quota) before enabling sweeps.

### Account preferences

These four routes store the one application account's favorites and remembered project.
They are separate from the planning cache and release storage. All responses are
`Cache-Control: no-store`, with no CORS headers.

| Method | Path                                              | Request                                       | Success                                                  |
| ------ | ------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/preferences`                                | No body                                       | `200` available or unavailable response below            |
| POST   | `/api/preferences/favorites`                      | JSON `{ "source": "gh", "repo": "acme/api" }` | `200` full authoritative available response after commit |
| DELETE | `/api/preferences/favorites/:source/:owner/:repo` | Path names the favorite; no body              | `200` full authoritative available response after commit |
| PUT    | `/api/preferences/remembered-project`             | JSON `{ "source": "gh", "repo": "acme/api" }` | `200` full authoritative available response after commit |

An available response has this shape (the on-disk `version` field is not exposed):

```json
{
  "available": true,
  "revision": 7,
  "favorites": [{ "source": "gh", "repo": "acme/api", "inCatalog": true }],
  "rememberedProject": { "source": "gh", "repo": "acme/api" }
}
```

`rememberedProject` can be `null`. Favorites are unique, retained in insertion order and capped
at 200. Repository names are normalized to lowercase; source IDs retain their configured identity.
Each committed change increments `revision`; adding an existing favorite, removing an absent one,
or remembering the already remembered project is a no-op and keeps the revision. A duplicate add
does not move a favorite. The mutation response, not the client's optimistic state, is authoritative.

POST and PUT accept **only** `source` and `repo`, matching the configuration ID and `owner/repo`
grammars. They do not accept a username, profile owner, storage path, revision or extra fields.
The body limit is **1 KiB (1,024 bytes)**. DELETE takes the same project identity from the path
and rejects a body. Add/remember requires membership in `/api/projects`, independently of forge
health or policy usability. A favorite that leaves the catalog remains with `inCatalog: false`
and can still be removed. The remembered project is retained as its reference, without an
`inCatalog` field; setting it to `null` is not a supported mutation.

An unavailable GET still returns `200`, for example:

```json
{
  "available": false,
  "reason": "storage-not-configured",
  "message": "Preference storage is not configured."
}
```

| `reason`                 | Meaning                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `login-disabled`         | No application login; stored data is neither opened nor exposed.                                                                        |
| `storage-not-configured` | `preferences.dir` / `FD_PREFERENCES_DIR` is unset.                                                                                      |
| `storage-missing`        | The configured directory does not exist. A missing `preferences.json` in a valid directory instead means an empty profile.              |
| `store-locked`           | Another process owns the directory, ownership was lost, or the runtime is closing.                                                      |
| `unreadable`             | Storage or locking cannot be safely used: permissions, filesystem/platform/helper, file I/O, or uncertain rollback. Repair and restart. |
| `corrupt`                | The file is invalid UTF-8/JSON or fails the profile schema.                                                                             |
| `unsupported-version`    | The file declares a schema version other than the supported version 1. It is not overwritten or silently migrated.                      |

Preference errors are `{ "code": "...", "error": "..." }`, with `reason` also present for
`preferences-unavailable`. Values and filesystem paths are not echoed in errors.

| Status | Code                                                                    | Cause                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid-request`                                                       | Malformed JSON/project reference, unexpected fields, unsupported content type, DELETE body, or a body over 1 KiB.                                                                                                                               |
| `401`  | `unauthenticated`                                                       | Missing, expired or invalid application credentials when login is configured.                                                                                                                                                                   |
| `403`  | `forbidden-origin`, `missing-csrf`, `invalid-csrf`, `mixed-credentials` | Request protection failed.                                                                                                                                                                                                                      |
| `409`  | `not-in-catalog`                                                        | Adding or remembering a project outside the configured catalog.                                                                                                                                                                                 |
| `409`  | `favorites-limit`                                                       | Adding a new favorite beyond the 200-entry limit.                                                                                                                                                                                               |
| `503`  | `preferences-unavailable`                                               | Mutations are unavailable; `reason` is one of the values above.                                                                                                                                                                                 |
| `500`  | `save-failed`                                                           | No successful durable commit was acknowledged. Ordinary failures preserve the prior profile; if rollback durability is uncertain, storage becomes unavailable until repaired and restarted. Read/reconcile before retrying an uncertain result. |

**Access:** with a configured login, GET requires a live application session or explicit Basic
authentication. Browser mutations also require a matching `Origin` and the live session's
`x-csrf-token` from `GET /api/session`. Scripts use Basic auth **without** a session cookie;
Origin and CSRF need not be sent, but an Origin that is sent must match. On reads as well as
writes, an Authorization header together with any application session cookie is rejected,
as is a foreign Origin. No `x-forge-desk-request` launch header is required for preferences.

The trusted host and port come from `server.publicOrigin` when configured, otherwise the
request's `Host`; forwarded headers do not establish trust. These planning checks compare
host/port rather than the scheme-sensitive `releases.publicOrigin` rule. Without a configured
login, GET returns `login-disabled` and mutations return `503 preferences-unavailable` with that
reason, even when a directory exists. Re-enabling login with the same directory restores the
profile. Neither setting a preference directory nor a public origin enables login or releases.

For volume preparation, recovery and the single-writer limit, see
[deployment](DEPLOYMENT.md#personal-preferences).

### `GET /api/settings`

Returns the settings the web UI reads at startup:

```json
{ "refreshMinutes": 5, "version": "2.0.1" }
```

`refreshMinutes` is `ui.refreshMinutes` (or `FD_REFRESH_MINUTES`): periodic reads use the snapshot route for the open project/source or named view and respect the shared cache. Scope checks pause while the tab is hidden or Releases is open; while a scope job is active, visible scope browsing checks progress every two seconds after the prior response. `0` disables periodic freshness polling, not active-job progress reads. Explicit refresh uses the corresponding POST route.

`version` is the running server's version. The theme menu shows it at the bottom.

### `GET /api/views/:id/snapshot`

| Parameter       | Where  | Description                                                                                                                                      |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | path   | The view id.                                                                                                                                     |
| `refresh`       | query  | `1` or `true` bypasses the cache and refetches (concurrent refreshes of a view share one fetch). Any other value is ignored.                     |
| `If-None-Match` | header | An earlier `ETag`. When it matches the current content hash, the server answers `304` with no body. (`*` and weak `W/"..."` forms are accepted.) |

Response headers: `ETag: "<contentHash>"`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`. The `ETag` is the snapshot's [content hash](DETERMINISM.md#the-content-hash): it changes when the plan or layout changes, and **not** when only `fetchedAt` changes, so a refresh that finds nothing new still answers `304` to a client that sends the last `ETag`. A tracker-side edit changes a node's `updatedAt` and so the hash, even when the order does not change.

### `POST /api/views/:id/refresh`

Same response as the snapshot endpoint (always `200` with a body, `ETag` header), after forcing a tracker revalidation. Send no body. GitHub reads reuse stored responses only after the tracker confirms they are unchanged; this does not bypass the shared rate-limit cooldown.

### `GET /api/views/:id/export.:format`

| `:format` | Content-Type                       | `Content-Disposition`              | Content                                                                          |
| --------- | ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `json`    | `application/json; charset=utf-8`  | `inline; filename="<viewId>.json"` | The full snapshot, indented, ending in a newline                                 |
| `md`      | `text/markdown; charset=utf-8`     | `inline; filename="<viewId>.md"`   | Waves as tables (with a Priority column), unschedulable issues, cycles, warnings |
| `mmd`     | `text/plain; charset=utf-8`        | `inline; filename="<viewId>.mmd"`  | A Mermaid `flowchart LR`                                                         |
| `dot`     | `text/vnd.graphviz; charset=utf-8` | `inline; filename="<viewId>.dot"`  | A Graphviz `digraph`, one `rank=same` group per wave                             |

`?refresh=1` works here too. Exports have no `ETag`. Any other extension answers `404`. The CLI produces the same text: `forge-desk plan <viewId> -f md|json|mermaid|dot`.

### `POST /api/webhooks/github` and `POST /api/webhooks/gitea`

Receivers for the tracker's webhooks: a verified delivery drops the cached snapshot of every view whose repositories include the repository named in the payload, so the next request refetches. They exist only when a webhook secret is configured (`webhooks` in the config, or `FD_WEBHOOK_SECRET`); otherwise they answer `404` like any unknown path. Setup: [DEPLOYMENT.md](DEPLOYMENT.md#webhooks).

For project/source browsing, the delivery also invalidates the repository's observations in every configured source of the endpoint's provider kind (GitHub or Gitea/Forgejo), including targeted outside issues. Derived plans using those observations, including All projects and external dependency context, show stale data until rechecked. Delivery itself starts no upstream work; the next read of an affected scope refreshes it. A fetch started before the delivery cannot clear its invalidation. The response's `invalidated` list still contains only named-view IDs, and named-view matching is unchanged.

- **Authentication** is the signature, not basic auth: these two `POST` paths (and nothing else) are exempt from basic auth. The signature is the HMAC-SHA256 of the raw request body, keyed with the secret, compared in constant time.
  - `/api/webhooks/github`: header `X-Hub-Signature-256: sha256=<hex>`.
  - `/api/webhooks/gitea`: header `X-Gitea-Signature: <hex>` or `X-Forgejo-Signature: <hex>` (plain hex, no prefix), or `X-Hub-Signature-256: sha256=<hex>` (Gitea and Forgejo send that one too). One valid signature is enough.
- **Body:** JSON only (`Content-Type: application/json`); other content types answer `415`. The limit is 1 MiB (`413` above it). Configure GitHub webhooks with content type `application/json`, not `application/x-www-form-urlencoded`.
- **Events:** a `ping` (`X-GitHub-Event`, `X-Gitea-Event` or `X-Forgejo-Event` equal to `ping`) answers `200` `{"ok":true}` and invalidates nothing. Any other event reads `repository.full_name` (compared in lower case), invalidates the matching views and answers `202` `{"invalidated":["<viewId>", ...]}` with the ids sorted. An unknown repository, or a payload without `repository.full_name`, answers `202` `{"invalidated":[]}`. The event type is not otherwise inspected, so subscribe to the issue and pull-request events needed to keep the plan and **In progress** status current (see the deployment guide).

| Status | When                                           | Body                            |
| ------ | ---------------------------------------------- | ------------------------------- |
| `200`  | Verified `ping`                                | `{"ok":true}`                   |
| `202`  | Verified delivery                              | `{"invalidated":["demo"]}`      |
| `400`  | Verified delivery whose body is not valid JSON | `{"error":"Invalid JSON body"}` |
| `401`  | Signature missing, malformed or wrong          | `{"error":"Invalid signature"}` |
| `404`  | No webhook secret is configured                | `{"error":"Not found"}`         |
| `413`  | Body larger than 1 MiB                         | `{"error":"<message>"}`         |
| `415`  | Content type other than `application/json`     | `{"error":"<message>"}`         |

```sh
BODY='{"action":"opened","repository":{"full_name":"acme/api"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$FD_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST http://localhost:8080/api/webhooks/github \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: sha256=$SIG" \
  --data "$BODY"
```

Each accepted delivery is logged at info level (event, repository, invalidated views); the secret and the signature are never logged.

### Static UI

Everything else is served from the built web UI directory (`dist/web`). A `GET` for an unknown path that does not start with `/api/` and that accepts `text/html` falls back to `index.html` (single-page app); other unknown paths answer `404` `{"error":"Not found"}`. If the web UI has not been built, `/` shows a short "The web UI is not built" page and the API still works.

## Common behaviour

The table below describes legacy planning/named-view errors. Scope, sweep, preference and
release routes have the additional statuses and structured codes documented in their sections.

| Status | When                                                                                                              | Body                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `200`  | Success                                                                                                           | See above                                                   |
| `304`  | `If-None-Match` matches the named-view snapshot's `ETag`                                                          | none (headers `ETag`, `Cache-Control`)                      |
| `401`  | The login is enabled and there is no valid session cookie or basic-auth header                                    | `{"error":"Unauthorized"}`                                  |
| `404`  | Unknown view id, unknown export format, or unknown path                                                           | `{"error":"Unknown view: nope"}` or `{"error":"Not found"}` |
| `502`  | The tracker could not be reached or answered with an error (bad token, rate limit, network, repository not found) | `{"error":"<message>"}`, with tokens redacted               |
| `500`  | Unexpected internal error                                                                                         | `{"error":"Internal Server Error"}`                         |

- Every response under `/api/` carries `Cache-Control: no-store`. Caching is done by the server (see `cache.ttlSeconds`); named-view snapshots also support `ETag`. Scope responses always carry fresh status metadata and do not use `304`.
- Successful fetches are cached in memory per view for `cache.ttlSeconds` (default 300). The snapshot's `fetchedAt` tells you when the data was read. A failed fetch is not cached.
- Concurrent requests for the same view share one fetch.
- Planning requests to the tracker are `GET`s. Only explicitly approved release publication can create remote tags and releases; webhook receivers only invalidate cached planning data.
- The cache can also be dropped by [webhooks](#post-apiwebhooksgithub-and-post-apiwebhooksgitea); the TTL remains as a safety net.

## Authentication

When `server.basicAuth` (or `FD_BASIC_AUTH`) is configured, **every** path except `/healthz`, `/login` and `/logout` requires a session cookie from the login page or an HTTP basic-auth header with the same credentials, including the web UI and the exports. The only other exception is the pair of `POST /api/webhooks/*` endpoints (when enabled), which require a valid signature instead. Use it over TLS (see [DEPLOYMENT.md](DEPLOYMENT.md#login)).

Scripts send basic auth preemptively; there is no `WWW-Authenticate` challenge, because it would make browsers show their own dialog instead of the login page:

```sh
curl -u admin:change-me http://localhost:8080/api/views
```

The preference and refresh-launch gates return their specific `unauthenticated` errors above. For ordinary planning routes, without credentials, a browser page load (`GET` with `Accept: text/html`) is redirected to the login page, and everything else gets:

```text
HTTP/1.1 401 Unauthorized
content-type: application/json; charset=utf-8
cache-control: no-store

{"error":"Unauthorized"}
```

### Release routes

When `releases.enabled` is true, the release routes exist and require the application login plus the release-specific proof below; when releases are disabled they are not registered at all (404). Release responses are `Cache-Control: no-store` and never contain a release token, SSH key, Authorization header, credential-bearing URL or private filesystem path.

Two caller kinds are accepted:

- **Browser.** A live session cookie, a `Host` header equal to `releases.publicOrigin`, and an `Origin` header equal to that origin when one is sent. A request that changes state (`POST`, `PUT`, `PATCH`, `DELETE`) must send that `Origin` and the session-bound `x-csrf-token` value returned by `GET /api/session`. Forwarded headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, ...) never decide access.
- **CLI.** An explicit `Authorization` header with the same basic-auth credentials and no session cookie. A request that sends both is rejected, and an `Origin` it does supply must still match the configured origin.

Foreign origins, a missing or invalid credential or CSRF proof, and the webhook signature exemptions never grant release access.

`GET /api/releases/repositories` reports one entry per configured release repository: its allowlist `id`, `repo`, `source`, `forge`, `capability` (`available` or `blocked`) and sanitized `blockers` (`{ code, message }`). A forge outage or unsupported server blocks that repository's capability without stopping Planning or `/healthz`:

```json
[
  {
    "id": "app",
    "repo": "example/app",
    "source": "gt",
    "forge": "https://gitea.example.com/",
    "capability": "blocked",
    "blockers": [{ "code": "network-error", "message": "GET /api/v1/user failed: fetch failed" }]
  }
]
```

### Publication, reconciliation and receipts

`POST /api/releases/plans/:planId/publish` accepts only JSON `{ "digest": "<64 lowercase hex characters>" }`, with a 1 KiB body limit and a bounded stored plan ID. The server derives the approver from the authenticated application login, persists approval intent, and starts publication independently of the connection. The `202` body contains the durable job fields and `statusUrl`; it means accepted, not published. Duplicate or lost-response retries return the same job without restarting execution, even after expiry. Poll `GET /api/releases/jobs/:jobId` for runtime blockers and the final outcome.

`POST /api/releases/jobs/:jobId/reconcile` accepts no body. It inspects the original publication and returns a reconciliation job, sharing concurrent requests for that publication. It never repeats a tag push or release create. A missing effect requires a fresh recovery plan and approval, not a repeated publication request.

`GET /api/releases/jobs/:jobId/receipt` returns `text/plain; charset=utf-8` for a publication job, joining its immutable plan and latest durable receipt. Missing or failed finalization remains visible as unavailable evidence or an artifact failure, never successful publication. Preparation jobs have no publication receipt.

These routes use stable `{ "code": "...", "error": "..." }` errors: invalid input or excessive body size (`400`), missing login (`401`), rejected origin or CSRF proof (`403`), unknown resources (`404`), stale/ineligible plans or unresolved attempts (`409`), expired new approval (`410`), and unavailable execution (`503`). Runtime failures after durable acceptance belong to the job. IDs are at most 128 ASCII letters, digits, dots, underscores or hyphens and begin with a letter or digit; the router can reject overlong paths before admission. Every response is `Cache-Control: no-store`.

## Snapshot schema

A snapshot is the JSON document returned by named-view snapshot/refresh routes and every `export.json` route. Project/source snapshot and refresh routes wrap it in `ScopeResponse.snapshot`; sweep and preference routes return their own contracts. The authoritative TypeScript definitions are in [`src/core/types.ts`](../src/core/types.ts) (`Snapshot`, `Plan`, `PlanNode`, `Layout`, ...).

| Field            | Description                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewId`         | The view id                                                                                                                                                                                                                                                                                                                           |
| `title`          | The view title                                                                                                                                                                                                                                                                                                                        |
| `fetchedAt`      | ISO timestamp of the fetch. **Not** part of the hash                                                                                                                                                                                                                                                                                  |
| `contentHash`    | SHA-256 hex of the canonical JSON of `{ plan, layout }`                                                                                                                                                                                                                                                                               |
| `priorityLabels` | The view's configured `ordering.priorityLabels`, in rank order (index 0 is the most urgent). `plan.nodes[].priority` indexes into it, and `priority === priorityLabels.length` means the issue has no priority label. **Not** part of the hash: changing the configured labels already changes the hash through the `priority` values |
| `orderingMode`   | `priority` or `waves`: the view's `ordering.mode`. In `priority` mode `plan.order` can interleave waves; in `waves` mode it runs wave by wave. **Not** part of the hash on its own: `plan.order` already reflects it, so changing the mode changes the hash whenever it changes the order                                             |
| `plan`           | The dependency plan (below)                                                                                                                                                                                                                                                                                                           |
| `layout`         | Coordinates for drawing the graph (below)                                                                                                                                                                                                                                                                                             |

### `plan`

| Field           | Description                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewId`        | The view id                                                                                                                                                                                                                                                                              |
| `nodes`         | One entry per issue in the plan, sorted by key (see below)                                                                                                                                                                                                                               |
| `edges`         | `{ from, to, sources }`: `from` must be closed before `to` can start. `sources` is a sorted subset of `native`, `body`, `sub-issue`                                                                                                                                                      |
| `order`         | Keys of all schedulable issues in execution order                                                                                                                                                                                                                                        |
| `waves`         | `waves[i]` are the keys of parallel wave `i` (0-based), in `order` position                                                                                                                                                                                                              |
| `cycles`        | Each dependency cycle as a list of keys                                                                                                                                                                                                                                                  |
| `unschedulable` | Keys of issues in a cycle or blocked by one                                                                                                                                                                                                                                              |
| `criticalPath`  | The longest dependency chain, in execution order                                                                                                                                                                                                                                         |
| `warnings`      | `{ code, message, issues }`. Codes: `cycle`, `blocked-by-cycle`, `self-reference`, `dangling-reference`, `external-unresolved`, `native-unsupported`, `fetch-error`, `repository-unlisted`, `stale-data`, `dependency-provisional` ([meaning and fixes](PREREQUISITES.md#warning-codes)) |
| `stats`         | `total`, `ready`, `blocked`, `unschedulable`, `external`, `edges`, `waves`                                                                                                                                                                                                               |

A node has: `key` (`owner/repo#number`, lowercase), `repo`, `number`, `title`, `url`, `labels`, `assignees`, `milestone` (or `null`), `updatedAt` (the issue's last-update timestamp, or `null` when the provider does not report one), `external` (boolean), `status` (`ready`, `blocked`, `in-cycle` or `blocked-by-cycle`), `wave` and `order` (0-based, `null` when unschedulable), `blockedBy` and `blocks` (keys of open direct prerequisites and dependents), `parents` and `children` (keys of the `Parent:` hierarchy; never dependencies), `closingPullRequests` (`{ key, number, title, url }[]`, open pull requests that declare a closing keyword for this issue, sorted by `key`), `priority` (index in `priorityLabels`, or `priorityLabels.length`) and `remainingDepth`.

### `layout`

`width` and `height` of the drawing; `nodes` (`key`, `x`, `y`, `width`, `height`, `layer`, `row`) and `edges` (`from`, `to`, `points`: two `{x, y}` anchors, source right-middle to target left-middle). All numbers are integers. How they are computed: [DETERMINISM.md](DETERMINISM.md#layout).

Abridged real output (a five-issue view):

```json
{
  "viewId": "mini",
  "title": "mini",
  "fetchedAt": "2026-09-29T09:03:17.028Z",
  "contentHash": "de98c03f071976a7c072a1e71ac7f16c16d5b3fa43b90f65061d0f725e45ef8d",
  "priorityLabels": ["P0", "P1", "P2"],
  "orderingMode": "priority",
  "plan": {
    "viewId": "mini",
    "nodes": [
      {
        "key": "acme/app#2",
        "repo": { "owner": "acme", "repo": "app" },
        "number": 2,
        "title": "API",
        "url": "https://fixture.local/acme/app/issues/2",
        "labels": [],
        "assignees": [],
        "milestone": null,
        "updatedAt": null,
        "external": false,
        "status": "blocked",
        "wave": 1,
        "order": 2,
        "blockedBy": ["acme/app#1"],
        "blocks": ["acme/app#5"],
        "parents": [],
        "children": [],
        "closingPullRequests": [],
        "priority": 3,
        "remainingDepth": 2
      }
    ],
    "order": ["acme/app#4", "acme/app#1", "acme/app#2", "acme/app#3", "acme/app#5"],
    "waves": [["acme/app#4", "acme/app#1"], ["acme/app#2", "acme/app#3"], ["acme/app#5"]],
    "criticalPath": ["acme/app#1", "acme/app#2", "acme/app#5"]
  }
}
```

## Examples

Health check:

```sh
curl -s http://localhost:8080/healthz
```

```json
{ "status": "ok" }
```

List the views:

```sh
curl -s http://localhost:8080/api/views
```

Get the snapshot and read a few fields (requires `jq`):

```sh
curl -s http://localhost:8080/api/views/demo/snapshot | jq '{hash: .contentHash, stats: .plan.stats, order: .plan.order[:3]}'
```

Show the response headers (`ETag`, `Cache-Control`):

```sh
curl -sI http://localhost:8080/api/views/demo/snapshot
```

Conditional request: only download when the plan changed. When the `ETag` still matches, the server answers `304` with no body (use the `ETag` of your own last response):

```sh
curl -s -o /dev/null -D - -H 'If-None-Match: "1181a20e638836c9b73543250bb11eaf0a77e5b0735529275c36d30e8acb2d21"' http://localhost:8080/api/views/demo/snapshot
```

```text
HTTP/1.1 304 Not Modified
etag: "1181a20e638836c9b73543250bb11eaf0a77e5b0735529275c36d30e8acb2d21"
cache-control: no-store
```

Force a refetch from the tracker:

```sh
curl -s -X POST http://localhost:8080/api/views/demo/refresh -o /dev/null -w '%{http_code}\n'
```

```sh
curl -s 'http://localhost:8080/api/views/demo/snapshot?refresh=1' | jq -r .fetchedAt
```

Download exports:

```sh
curl -s http://localhost:8080/api/views/demo/export.md -o demo.md
```

```sh
curl -s http://localhost:8080/api/views/demo/export.mmd -o demo.mmd
```

```sh
curl -s http://localhost:8080/api/views/demo/export.dot | dot -Tsvg -o demo.svg
```

(`dot` is Graphviz.) Unknown view:

```sh
curl -si http://localhost:8080/api/views/nope/snapshot
```

```text
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8
cache-control: no-store

{"error":"Unknown view: nope"}
```
