# Instance 2 — Architecture Core

GBrain's architecture is contract-first and engine-pluggable. A single `Operation` registry drives both the CLI and the MCP server; a single `BrainEngine` interface is implemented by two engines (PGLite WASM and Postgres + pgvector). Trust, source scoping, and schema bootstrap flow through narrow seams that are deliberately small and explicit.

## 1. Contract-first operations layer

`src/core/operations.ts` is the single source of truth for what gbrain can DO. The `Operation` interface (`src/core/operations.ts:339-363`) carries:

```ts
interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  scope?: 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin';
  localOnly?: boolean;
  cliHints?: { name?: string; positional?: string[]; stdin?: string; hidden?: boolean };
}
```

Both the CLI (`src/cli.ts`) and the MCP server (`src/mcp/server.ts` via `src/mcp/dispatch.ts`) generate their surface from the `OPERATIONS` array. Adding an op once exposes it on both transports. There are 61 ops in the registry (`grep -c "^const [a-z_]+: Operation = "` on `src/core/operations.ts`), exceeding the "~47" rough count in CLAUDE.md (waves added facts ops, takes ops, sources ops, and v0.31 hot-memory ops).

### OperationContext threading

`OperationContext` (`src/core/operations.ts:224-337`) is the seam every handler reads. Beyond the obvious `engine` / `config` / `logger` / `dryRun`, the interesting fields are:

- **`remote: boolean` (REQUIRED as of v0.26.9 / F7b)** — true for MCP/agent-facing callers, false for local CLI. The type system is the first line of defense; the four fail-closed call sites still treat anything that isn't strictly `false` as remote (defense in depth against cast bypass).
- **`auth?: AuthInfo`** — OAuth scopes + `clientName` (resolved at token-verification time to save a per-request DB roundtrip in the /mcp handler, `operations.ts:218`).
- **`viaSubagent` / `subagentId` / `jobId`** — set by the subagent dispatcher. `viaSubagent=true` is the FAIL-CLOSED flag — agent-facing policy is enforced even if `subagentId` is somehow missing.
- **`allowedSlugPrefixes?: string[]`** — v0.23 trusted-workspace allow-list set by `cycle.ts` synthesize/patterns. Trust comes from the submitter being gated by `PROTECTED_JOB_NAMES`, NOT from `remote` (subagent calls always run remote, so basing trust on remote would be incoherent).
- **`takesHoldersAllowList?: string[]`** — per-token visibility filter on takes, threaded by MCP HTTP/stdio dispatch from `access_tokens.permissions.takes_holders`. Defaults to `['world']` on tokens with no permissions row (default-deny on private hunches).
- **`brainId?: string` / `sourceId?: string`** — the two organizational axes. `brainId` identifies the DB (host vs. mounts); `sourceId` scopes per-repo WITHIN a brain. Resolved once at dispatch time from CLI flag / env / dotfile / per-token scope.
- **`cliOpts?`** — resolved `--quiet` / `--progress-json` / `--progress-interval`.

### localOnly + admin ops

The four operations annotated `localOnly: true` are rejected over HTTP transports before the handler runs:

- `sync_brain` (admin)
- `file_upload` (admin)
- `file_list` (admin)
- `file_url` (admin)
- `purge_deleted_pages` (admin, v0.26.5)
- `get_recent_transcripts` (v0.29 — also gated by the handler refusing `ctx.remote === true`)

These are infrastructure / filesystem operations whose blast radius is not bounded by RLS or by per-row checks — they touch shared storage, the user's source tree, or destructive purge paths.

### Trust boundary call sites (v0.26.9 fail-closed)

Four sites flipped from falsy-default to fail-closed semantics:

1. `put_page` allow-list (operations.ts:443-465) — `ctx.viaSubagent === true` enforces namespace OR allow-list match.
2. `file_upload` trust narrowing — `ctx.remote === false` enables loose filesystem semantics; anything else is strict.
3. `submit_job` protected-name guard (operations.ts:~1391) — rejects shell/subagent submissions when `ctx.remote !== false`.
4. Auto-link skip in `put_page` (operations.ts:509) — `ctx.remote !== false && !trustedWorkspace` skips auto-link/timeline because the bare-slug regex can be hijacked by prompt-injected content.

The v0.26.9 hardening pass closed an HTTP MCP shell-job RCE: a `read+write`-scoped OAuth token could submit `shell` jobs because the HTTP request handler's literal context skipped `remote: true` and `submit_job`'s protected-name guard saw a falsy undefined.

## 2. BrainEngine interface

`src/core/engine.ts:251-454` defines what every engine MUST implement. The interface carries `readonly kind: 'postgres' | 'pglite'` (engine.ts:253) — a discriminator that lets `migrate.ts` and other consumers branch without `instanceof` + dynamic imports.

The interface is wide: 79 methods on the canonical engine (count via `grep -c "Promise"` on engine.ts), spanning page CRUD, chunk + embedding management, link / timeline graph ops, source CRUD, ingest log, takes, facts, files, eval-capture, dream verdicts, and engine-private maintenance (`executeRaw`, `reconnect`, `getStats`, `getHealth`).

### Key surfaces

- **Search**: `searchKeyword(query, opts)` + `searchVector(embedding, opts)` both return `Promise<SearchResult[]>`. The two-stage CTE in `searchVector` keeps the inner HNSW-friendly `ORDER BY cc.embedding <=> vec` while the outer SELECT re-ranks by `raw_score * source_factor`.
- **Batch APIs**: `addLinksBatch(LinkBatchInput[])` and `addTimelineEntriesBatch(TimelineBatchInput[])` are the v0.12.1 bulk-insert API. `LinkBatchInput` (engine.ts:55-87) carries `from_source_id` / `to_source_id` / `origin_source_id` so multi-source brains don't fan out incorrect edges via cross-source slug collisions.
- **`PageFilters.sort`** (engine.ts via `PAGE_SORT_SQL` whitelist) is a closed enum: `'updated_desc' | 'updated_asc' | 'created_desc' | 'slug'`. Both engines consume the same whitelist — no string interpolation drift.
- **Emotional weight (v0.29)**: `batchLoadEmotionalInputs(slugs?)` is a CTE-shaped read with per-table aggregates so a page × N tags × M takes never produces N×M rows. `setEmotionalWeightBatch` uses `UPDATE FROM unnest($1::text[], $2::text[], $3::real[])` composite-keyed on `(slug, source_id)`.
- **`clampSearchLimit(limit, default, cap)`**: takes an explicit cap so per-operation caps can be tighter than `MAX_SEARCH_LIMIT`.
- **`ReservedConnection`** (engine.ts:125-127): single dedicated connection isolated from the pool. Postgres backs it with `sql.reserve()`; PGLite is a thin pass-through. Used for session-level GUCs before `CREATE INDEX CONCURRENTLY`, and for write-quiesce designs needing a session-lifetime advisory lock.

## 3. Engine factory

`src/core/engine-factory.ts` is 27 lines. Dynamic `await import('./pglite-engine.ts')` or `await import('./postgres-engine.ts')` based on `config.engine`. The dynamic import is load-bearing: PGLite WASM (~6 MB) is never loaded into a Postgres-only process, and vice versa. `EngineConfig` (`src/core/types.ts`) is a 3-field shape: `engine`, `database_url`, `database_path`. The factory's `default` branch hints SQLite users to use PGLite instead.

## 4. Two engines

### PGLite engine (`src/core/pglite-engine.ts`)

- Embedded Postgres 17.5 via WASM (in-process).
- `connect()` (pglite-engine.ts:134-185) acquires a file lock (`pglite-lock.ts`), tries an optional snapshot fast-restore (`GBRAIN_PGLITE_SNAPSHOT`), then calls `PGlite.create({ dataDir, loadDataDir, extensions: { vector, pg_trgm } })`.
- v0.13.1 error wrap (pglite-engine.ts:164-184): any `PGlite.create()` failure becomes actionable. The macOS 26.3 WASM bug (#223) is named explicitly; the original error message is nested for debugging; the lock is released on failure so the next process can retry cleanly.
- `initSchema()` calls `applyForwardReferenceBootstrap()` BEFORE replaying SCHEMA_SQL (v0.22.6.1). The bootstrap (pglite-engine.ts:251-) probes via a single round-trip `information_schema` query for the specific forward-referenced state the embedded schema blob needs — `pages.source_id`, `links.link_source`, `links.origin_page_id`, `content_chunks.symbol_name`, `content_chunks.language`, `content_chunks.search_vector`, `pages.deleted_at`, `mcp_request_log.agent_name`, `subagent_messages.provider_id`, etc. — and adds only what's missing. Closes the upgrade-wedge bug class that bit users 10+ times across 6 schema versions over 2 years (#239/#243/#266/#357/#366/#374/#375/#378/#395/#396). No-op on fresh installs and modern brains.
- Batch SQL: `addLinksBatch` / `addTimelineEntriesBatch` use multi-row `unnest()` with manual `$N` placeholders.

### Postgres engine (`src/core/postgres-engine.ts`)

- postgres.js with optional Supabase / PgBouncer detection.
- `_savedConfig` (postgres-engine.ts:76) is retained so `reconnect()` can tear down + recreate the pool from saved config; called by the supervisor watchdog after 3 consecutive health-check failures (v0.22.1, #406).
- `_connectionStyle` (postgres-engine.ts:87) tracks 'instance' vs 'module' so `disconnect()` is idempotent (v0.28.1). A second disconnect on an instance-pool engine is a no-op rather than falling through to `db.disconnect()` and clobbering the unrelated module-level singleton. Pinned by `test/e2e/postgres-engine-disconnect-idempotency.test.ts`.
- v0.22.1 statement_timeout scoping: `searchKeyword` / `searchVector` scope `statement_timeout` via `sql.begin` + `SET LOCAL` so the GUC dies with the transaction instead of leaking across the pooled postgres.js connection (contributed by @garagon). A grep guardrail at the source level guards against reintroduced bare `SET statement_timeout`.
- v0.22.1 (#363, @orendi84): `connect()` applies `resolveSessionTimeouts()` from `db.ts` as connection-time **startup parameters** (`statement_timeout`, `idle_in_transaction_session_timeout`) so orphan pgbouncer backends can't hold locks for hours. Startup parameters survive PgBouncer transaction mode (unlike `SET` commands which transaction-mode poolers strip between transactions).
- Two-stage CTE for vector search: inner CTE keeps `ORDER BY cc.embedding <=> vec` so HNSW stays usable; outer SELECT re-ranks by `raw_score * source_factor`. Inner LIMIT scales with offset to preserve pagination contract. Carries `p.source_id` through inner→outer for v0.18 multi-source callers.
- `executeRaw` is a single-statement passthrough — no per-call retry (D3 dropped that as unsound for non-idempotent statements; recovery is supervisor-driven).
- v0.22.1 (#409, @atrevino47): `countStaleChunks()` + `listStaleChunks()` server-side-filter on `embedding IS NULL` for `embed --stale`, eliminating ~76 MB/call client-side pull on a fully-embedded brain.

### Connection management seam (`src/core/db.ts`)

`db.ts` owns the module-level singleton pool (`sql` at db.ts:7). `resolveSessionTimeouts()` (db.ts:119-134) returns the GUCs to apply at connection-startup time:
- `statement_timeout = '5min'` (env override `GBRAIN_STATEMENT_TIMEOUT`)
- `idle_in_transaction_session_timeout = '5min'` (env override `GBRAIN_IDLE_TX_TIMEOUT`)
- `client_connection_check_interval` opt-in only (Postgres 14+; older self-hosted Postgres rejects this startup param).

Set any env var to `'0'` or `'off'` to disable that GUC entirely.

`resolvePrepare(url)` (db.ts:45-64) auto-detects PgBouncer transaction-mode pooling by checking port 6543 (Supabase convention) and forces `prepare: false`. `GBRAIN_PREPARE=true` is the documented escape hatch for direct-Postgres servers bound to 6543. The setting is also accepted as a `?prepare=true|false` URL query param.

`resolvePoolSize(explicit?)` (db.ts:66-74) — explicit > `GBRAIN_POOL_SIZE` env > 10. Lower it to 2 for Supabase transaction pooler to avoid MaxClients crashes during `gbrain upgrade` subprocess spawns.

## 5. Schema + migrations

### Source of truth: `src/schema.sql` → `src/core/schema-embedded.ts`

`src/schema.sql` is the canonical Postgres + pgvector DDL. `src/core/schema-embedded.ts:1-2` carries a banner: `AUTO-GENERATED — do not edit. Run: bun run build:schema`. The build target reads `schema.sql` and emits `SCHEMA_SQL` as a string constant. Compiling the schema into the binary lets `bun --compile` ship a single artifact without the filesystem at runtime.

`src/core/pglite-schema.ts` is a parallel near-duplicate: same tables, no RLS block (PGLite has no role system), and `files` shipping by v0.27.1 (was Supabase-Storage-only pre-v0.27.1). A drift detection test (`test/edge-bundle.test.ts`) catches divergence between the two.

### Migration registry

`src/core/migrate.ts` owns the `MIGRATIONS` array (46 entries as of v0.31.3). The `Migration` interface (migrate.ts:17-58) carries:

```ts
interface Migration {
  version: number;
  name: string;
  sql: string;             // engine-agnostic; '' for handler-only or sqlFor-only
  sqlFor?: { postgres?: string; pglite?: string };
  transaction?: boolean;   // false for CREATE INDEX CONCURRENTLY
  handler?: (engine: BrainEngine) => Promise<void>;
  idempotent?: boolean;    // v0.30.1 default true
  verify?: (engine: BrainEngine) => Promise<boolean>;  // v0.30.1 post-condition probe
}
```

- **`sqlFor.{postgres,pglite}`** branches the SQL by engine. v24 (`rls_backfill_missing_tables`) uses `sqlFor.pglite: ''` to no-op on PGLite — PGLite has no RLS engine and is single-tenant by definition, and v24's ALTERs target subagent tables that don't exist in pglite-schema.ts. v35 (auto-RLS event trigger) does the same: PGLite no-op.
- **`transaction: false`** is required for Postgres `CREATE INDEX CONCURRENTLY` (refused inside a transaction). Ignored on PGLite (no concurrent writers anyway). v14 (`pages_updated_at_index`) uses a handler branching on `engine.kind` to run CONCURRENTLY on Postgres (with pre-drop of any invalid remnant via `pg_index.indisvalid`) and plain `CREATE INDEX` on PGLite.
- **`idempotent: false`** (v0.30.1 / D6) blocks the verify-hook self-healing path from re-running a destructive migration. Default is true (every existing migration was authored with `IF NOT EXISTS` / `ON CONFLICT` guards).
- **`verify`** (opt-in) is the post-condition probe — runs after the migration claims to have applied, returns false if the actual schema state diverges (e.g. partially-committed run on a wedged Supabase pooler). Surfaces `MigrationDriftError` and requires `--skip-verify` to force.

### Ledger states

The runner owns ledger writes (v0.14.2, Bug 3 fix). Orchestrators return `OrchestratorResult` and `apply-migrations.ts` persists a canonical `{version, status, phases}` shape. States:

- `complete` — every phase succeeded.
- `partial` — some phases succeeded, others did not. Three consecutive partials → wedged.
- `retry` marker — written by `gbrain apply-migrations --force-retry <version>`. The next `--yes` run treats the version as fresh.

`statusForVersion` prefers `complete` over `partial` — never regresses. `MigrationRetryExhausted` (migrate.ts:92-109) returns a paste-ready `pg_terminate_backend(<pid>)` command when idle-blocker pile-up triggers retry exhaustion.

### Four representative migrations

- **v34 `destructive_guard_columns` (v0.26.5)** — adds `pages.deleted_at TIMESTAMPTZ` + partial purge index `pages_deleted_at_purge_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL`. Promotes `sources.archived` / `archived_at` / `archive_expires_at` from JSONB keys to real columns; backfills any pre-v0.26.5 JSONB shape. Search and `get_page` filter `WHERE deleted_at IS NULL` by default.
- **v35 `auto_rls_event_trigger` (v0.26.7)** — Postgres event trigger that auto-enables RLS on every new `public.*` table (`ddl_command_end` on `CREATE TABLE`/`CREATE TABLE AS`/`SELECT INTO`), plus one-time backfill on every existing `public.*` table whose comment doesn't match the `^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}` regex. No FORCE (matches v24/v29/schema.sql posture). PGLite no-op via `sqlFor.pglite: ''`. Breaking change: operators with intentionally-RLS-off public tables must add the GBRAIN:RLS_EXEMPT comment BEFORE upgrade.
- **v40 `pages_emotional_weight` (v0.29)** — `ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight REAL NOT NULL DEFAULT 0.0`. Postgres 11+ and PGLite (PG 17.5) treat ADD COLUMN with constant DEFAULT as metadata-only — instant on tables of any size. No index — the salience query orders by a computed score, not raw column.
- **v46 `mcp_request_log_params_jsonb_normalize` (v0.31.3)** — rewrites pre-v0.31.3 rows where `mcp_request_log.params` was stored as a JSON-encoded string (`jsonb_typeof = 'string'`) up to a real JSONB object via `UPDATE ... SET params = params #>> '{}' WHERE jsonb_typeof(params) = 'string'`. Idempotent — second-run finds no string-shaped rows and is a no-op. Closes the bug where `params->>'op'` returned the quoted encoded string `"search"` instead of `search`.

## 6. SQL adapter (`src/core/sql-query.ts`)

`sqlQueryForEngine(engine)` returns a `SqlQuery` (`(strings, ...values) => Promise<rows[]>`) that walks the template, builds `$N` positional SQL, asserts every value is a `SqlValue` (string | number | bigint | boolean | Date | null), and routes through `engine.executeRaw(sql, params)` so Postgres goes via postgres.js's `unsafe(sql, params)` path and PGLite via its embedded `db.query(sql, params)`.

The narrow surface is the feature (sql-query.ts:7-15). Deliberately NOT supported:

- Nested SQL fragments (no postgres.js `sql.fragment` interpolation)
- `sql.json()` (the v0.12.0 double-encode footgun)
- `sql.unsafe()` (the partial-postgres-js-clone trap)
- `sql.begin()` (transactions go through `engine.transaction(...)`)
- Direct JS array binding (no `sql([1,2,3])` shortcut)

Codex finding #7 from the v0.31 plan review argued the adapter should stay scalar-only or it drifts into a partial postgres.js clone. The TypeError on non-scalar input (sql-query.ts:44-65) names the kind (`'array' | 'promise' | typeof value`) so violations are visible immediately.

`executeRawJsonb(engine, sql, scalarParams, jsonbParams)` (sql-query.ts:107-121) is the JSONB-write escape hatch. It composes positional `$N::jsonb` casts in the caller's SQL string and passes JS objects through `engine.executeRaw`. Both postgres.js's `unsafe(sql, params)` and PGLite's `db.query(sql, params)` accept objects for `$N::jsonb` positions and round-trip with `jsonb_typeof = 'object'`. The v0.12.0 double-encode bug doesn't recur because the bug was specific to postgres.js's template-tag auto-stringify path — positional binding through `unsafe()` reaches the wire protocol with the correct type oid.

The v0.31.3 normalization fix (PR #681): every OAuth/admin/auth SQL call routes through `sqlQueryForEngine(engine)` so `gbrain serve --http` works against PGLite brains. The four `mcp_request_log.params` INSERT sites all go through `executeRawJsonb(engine, ...)` so the JSONB column stores real objects, not JSON-encoded strings. Migration v46 normalizes any pre-v0.31.3 string-shaped backlog rows on first start. `scripts/check-jsonb-pattern.sh` is the CI grep guard that fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern.

## 7. SQL utilities (`src/core/utils.ts`)

Three exports matter at the architecture seam:

- **`parseEmbedding(value)`** — throws on unknown input. Used by migration + ingest paths where data integrity matters more than availability.
- **`tryParseEmbedding(value)`** — returns `null` + warns once per process. Used by search/rescore paths where availability matters more than strictness. v0.12.3 added this so one corrupt row skips+warns instead of killing the query.
- **`isUndefinedColumnError(err, column)`** (v0.26.9 / D14) — pattern-matches Postgres SQLSTATE 42703 / "column ... does not exist" with engine-driver shape variation tolerated. Replaces bare `catch {}` blocks in `oauth-provider.ts` so genuine errors (lock timeout, network blip, permission denied) propagate while column-missing falls through to the legacy fallback path.

Also exported: `hashToken`, `generateToken`, `validateSlug`, `contentHash`, `rowToPage`, `rowToChunk`, `rowToSearchResult`, `takeRowToTake`. `readOptionalDate` (utils.ts:46-53) is the three-state read for columns that may or may not be in the SELECT projection (undefined = not selected; null = selected, NULL value; Date = populated).

## 8. Config plane

GBrain has TWO config stores; they are independent.

### File plane (`~/.gbrain/config.json`)

Owned by `src/core/config.ts`. `loadConfig()` (config.ts:125-179) reads the JSON file, merges in env vars (env wins). Returns null if neither file nor env provides a URL.

Read-only at the file plane: `database_url`, `database_path`, `openai_api_key`, `anthropic_api_key`, `embedding_model`, `embedding_dimensions`, `expansion_model`, `chat_model`, `chat_fallback_chain`, `storage`, `eval.capture`, `eval.scrub_pii`, `remote_mcp`.

Precedence: `GBRAIN_DATABASE_URL` > `DATABASE_URL` env > config file. A DATABASE_URL-style env var is always Postgres and overrides file-backed PGLite engine selection (config.ts:139-146); the PGLite `database_path` is cleared when `dbUrl` is set so `toEngineConfig` doesn't pass a stale path through alongside the URL.

`saveConfig(config)` writes the file with mode 0600 (config.ts:247-254). chmodSync follow-up because some platforms don't honor the mode in writeFileSync.

### DB plane (`config` table inside the brain)

`gbrain config set <key> <value>` writes the DB plane. `engine.getConfig(key)` reads it. `loadConfigWithEngine(engine, base)` (config.ts:194-245) overlays DB on top of file/env AFTER `engine.connect()`. Today only the v0.27.1 multimodal flags participate in DB-merge — existing fields (embedding_model, etc.) keep their file/env-only loading because they size the schema and must be stable across engine connect.

Why two stores: schema-sizing flags need to be available at process boot before the engine connects; user-mutable runtime knobs (multimodal toggles, capture toggles) live in the DB so they can flip at runtime without restart.

### GBRAIN_HOME write-site confinement

`configDir()` (config.ts:265-282) honors `GBRAIN_HOME`. Validates that the override is absolute and contains no `..` segments. Returns `${GBRAIN_HOME}/.gbrain` when set, `${homedir()}/.gbrain` otherwise.

`gbrainPath(...segments)` (config.ts:294-296) is the canonical helper. Every gbrain write site uses it: config, audit (`shell-jobs-YYYY-Www.jsonl`, `backpressure-YYYY-Www.jsonl`, `subagent-jobs-YYYY-Www.jsonl`), friction (`friction/<run-id>.jsonl`), sync-failures (`sync-failures.jsonl`), import checkpoint, integrity log, integrations heartbeat, migration rollback, eval receipts, upgrade-errors trail.

`getDbUrlSource()` (config.ts:302-316) is pure introspection — never throws, never connects. Used by `gbrain doctor --fast` so the user gets a precise message ("env:DATABASE_URL" / "config-file" / "config-file-path" / null) instead of a misleading "No database configured".

## 9. Trust boundary

The pivot for security policy is `OperationContext.remote: boolean`:

- **`remote: false`** — local CLI by the owner of the machine. The OS trust boundary applies; gbrain does not re-implement it.
- **`remote: true`** — MCP over stdio/HTTP, OR any agent-facing entry point. Defense in depth: every consumer treats anything that isn't strictly `false` as remote.

The v0.26.9 hardening pass made `remote` a REQUIRED field in TypeScript. Every transport sets it explicitly:

- `src/cli.ts` → `remote: false`
- `src/mcp/server.ts` (stdio) → `remote: true`
- `src/commands/serve-http.ts` → `remote: true` (closed the F7 HTTP shell-job RCE — the request handler's literal context skipped this field for several releases)
- subagent dispatcher → `remote: true`

### Untrusted-workspace allowedSlugPrefixes contract

For the v0.23 dream cycle, subagent calls always have `remote=true` (for auto-link safety). Basing trust on `remote` would always reject. The cycle's synthesize/patterns phases instead thread an `allowedSlugPrefixes: string[]` through the OperationContext. Examples: `["wiki/personal/reflections/*", "wiki/personal/patterns/*"]`.

The prefix grammar (`matchesSlugAllowList`, operations.ts:163-174):
- `<prefix>/*` matches recursive children (`wiki/originals/idea-x`, `wiki/originals/ideas/2026-04-25-idea-y`).
- Bare `<prefix>` matches the exact slug only.

Trust comes from the **submitter** — subagent jobs are gated by `PROTECTED_JOB_NAMES`; MCP cannot submit them. `cycle.ts` synthesize/patterns are the only call sites that set `allowedSlugPrefixes`. When unset, `put_page` falls back to the legacy `wiki/agents/<subagentId>/...` namespace check (operations.ts:458-464). When set, auto-link/timeline post-hook re-enables even though `remote=true` because the allow-list bounds the write surface (operations.ts:506-511).

## 10. Repo-root + skills-dir detection

`src/core/repo-root.ts` is shared by `doctor`, `check-resolvable`, `routing-eval`, `skillpack install`, `skillify scaffold`, and `post-install-advisory`. Zero dependencies.

### `findRepoRoot(startDir = process.cwd())`

Walks up looking for a `skills/` directory containing a recognized resolver file (`RESOLVER.md` or `AGENTS.md`). Returns the directory containing `skills/`, or null after 10 levels (repo-root.ts:15-24). Parameterized `startDir` so tests are hermetic against fixtures.

### `autoDetectSkillsDir` (4-tier shared)

The 4-tier chain (repo-root.ts:110-165), safe for both read and write paths:

1. **`$GBRAIN_SKILLS_DIR`** (tier 0, v0.31.7) — explicit operator override. Docker mounts, CI, monorepo subdirs. Source variant `'env_explicit'`.
2. **`$OPENCLAW_WORKSPACE`** — explicit env wins over repo-root walk. Source variants `'openclaw_workspace_env'` / `'openclaw_workspace_env_root'` (workspace-root AGENTS.md).
3. **`~/.openclaw/workspace`** — user's default OpenClaw deployment. Same two source variants.
4. **`findRepoRoot()` walk** — gbrain's own repo. Source variant `'repo_root'`.
5. **`./skills` fallback** — dev scratch, fixtures. Source variant `'cwd_skills'`.

### `autoDetectSkillsDirReadOnly` (tier-5 install-path)

Wraps the shared function and adds a tier-5 install-path fallback (repo-root.ts:195-219) — walks up from `fileURLToPath(import.meta.url)` looking for a gbrain repo root, gated by `isGbrainRepoRoot` to avoid false-positive on unrelated repos. Source variant `'install_path'`.

### Why the read-path / write-path split matters

`bun install -g github:garrytan/gbrain && cd ~ && gbrain doctor` is the hosted-CLI install pattern. Pre-v0.31.7, `autoDetectSkillsDir` had no install-path fallback, so `gbrain doctor` from `~` warned "Could not find skills directory" and docked the health score. Adding install-path to the SHARED function would have been silent retargeting on write paths — `gbrain skillpack install` from `~` would target the bundled gbrain repo's `skills/` instead of the user's actual workspace.

The read-only variant is safe because read-path callers (`doctor`, `check-resolvable`, `routing-eval`) don't write anything to the resolved path. Write-path callers stay on the shared `autoDetectSkillsDir`.

### D6 `--fix` install-path safety gate

`gbrain doctor --fix` and `gbrain check-resolvable --fix` carry a v0.31.7 D6 safety gate: when `detected.source === 'install_path'`, the command refuses auto-repair with a stderr message pointing at `$GBRAIN_SKILLS_DIR` / `$OPENCLAW_WORKSPACE` / `--skills-dir`. Without this gate, `autoFixDryViolations` would write to SKILL.md files inside the bundled install tree.

The shared function MUST NEVER return `'install_path'` as a source — that's how the read-path/write-path split stays safe. Pinned by an IRON-RULE regression assertion in `test/repo-root.test.ts`.

## 11. Markdown + content seam

`src/core/markdown.ts:61` is `parseMarkdown(content, filePath?, opts?)`. Uses gray-matter for frontmatter (forgiving — returns empty data + original content on most malformed input). The `opts.validate` flag (markdown.ts:21-22) opts into a hardened validation pass that catches everything gray-matter silently swallows: `MISSING_OPEN`, `MISSING_CLOSE`, `YAML_PARSE`, `SLUG_MISMATCH`, `NULL_BYTES`, `NESTED_QUOTES`, `EMPTY_FRONTMATTER`. v0.22.12 (#500) classifies these so doctor's `sync_failures` check can render `[CODE=N, ...]` breakdowns.

`splitBody` (called inside `parseMarkdown`) requires an explicit timeline sentinel: `<!-- timeline -->` (preferred), `--- timeline ---` (decorated), or a plain `---` immediately before a `## Timeline` / `## History` heading. A bare `---` in body text is a markdown horizontal rule, not a separator. The v0.12.3 splitBody bug had truncated pages at the first `---`; the doctor `markdown_body_completeness` check detects damage from that era.

`inferType` auto-types directory-shaped slugs: `/wiki/analysis/` → analysis, `/wiki/guides/` → guide, `/wiki/hardware/` → hardware, `/wiki/architecture/` → architecture, `/writing/` → writing, plus the existing people/companies/deals/topics heuristics.

## 12. Drift from CLAUDE.md

A few things the code is more (or less) than CLAUDE.md claims:

- **Operations count.** CLAUDE.md says "~47 shared operations (v0.29 adds get_recent_salience, find_anomalies, get_recent_transcripts)". Actual count is **61** in `src/core/operations.ts` (grep -c on `^const [a-z_]+: Operation = `). The delta comes from waves CLAUDE.md doesn't fold counts back into — takes ops, facts ops, sources ops, restore_page / purge_deleted_pages, get_brain_identity.
- **BrainEngine method count.** CLAUDE.md says "40 BrainEngine methods" in pglite-engine.ts. Actual interface has **79 methods** on the canonical engine. The "40" appears to be a pre-v0.18 count that never got refreshed across waves that added takes, facts, files, salience, anomalies, dream-verdicts, etc.
- **localOnly + admin ops.** CLAUDE.md lists `sync_brain`, `file_upload`, `file_list`, `file_url` as admin + localOnly. Code confirms those plus **`purge_deleted_pages`** (v0.26.5, admin + localOnly per CLAUDE.md text but worth pinning in the bullet list) and **`get_recent_transcripts`** (v0.29 — `localOnly: true` plus a handler-side `permission_denied` throw for `ctx.remote === true`, double-gated).
- **MIGRATIONS count.** CLAUDE.md text references "v46" and earlier. Actual `MIGRATIONS` array has 46 entries (grep -c `^\s+version: [0-9]+`).
- **`OperationContext.remote` as REQUIRED.** CLAUDE.md notes the v0.26.9 tightening; the engine.ts code reflects it but `viaSubagent`/`subagentId` are still optional. `remote` is the only required-and-narrowed field. The fail-closed pattern (`ctx.remote === false` for trusted-only; `ctx.remote !== false` for untrust-unless-explicit-false) is consistent across the four call sites named in CLAUDE.md.
- **Schema-embedded.ts banner says auto-generated; the generator is `bun run build:schema`** which CLAUDE.md mentions in passing. The build artifact is committed (like `llms-full.txt`) because Bun's `--compile` strips the filesystem at runtime; there's no schema file to read from the binary.
- **PGLite snapshot fast-restore** (pglite-engine.ts:53-117) — Tier 3 optimization not surfaced in CLAUDE.md. `GBRAIN_PGLITE_SNAPSHOT` env var points at a tar dump; a sidecar `.version` file carries the MIGRATIONS hash; on match the snapshot loads and `initSchema()` is a no-op, saving ~1-3s per fresh test PGLite. Mismatch silently falls through to normal init.

The architecture is small at the surface (61 ops, 2 engines, ~5 narrow seams) but each seam carries deliberate hardening — fail-closed trust, type-required `remote`, idempotent-by-default migrations with opt-in verify hooks, engine-aware SQL adapter, forward-reference bootstrap, install-path fallback gated to read-only callers. The complexity lives in the cross-cutting concerns (multi-source scoping, multi-brain mounts, trusted-workspace allow-list, JSONB-vs-string round-trip) more than in any single primitive.
