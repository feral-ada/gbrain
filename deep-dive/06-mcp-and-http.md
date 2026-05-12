# Instance 6 — MCP / HTTP / OAuth / Admin SPA

GBrain exposes its ~47 operations through three external surfaces: stdio MCP (`gbrain serve`, local-only), HTTP MCP with OAuth 2.1 (`gbrain serve --http` + admin SPA for self-hosted shared brains), and the thin-client outbound HTTP path that lets `gbrain init --mcp-only` installs proxy every non-localOnly op to a remote `gbrain serve --http`. All three share the same `dispatchToolCall` seam in `src/mcp/dispatch.ts`. The HTTP surface carries the bulk of the security model — OAuth 2.1 with PKCE, client-credentials, refresh rotation, scope hierarchy, two-tier rate limiting, an audit log, and a React 19 admin SPA that authenticates via HttpOnly cookies. v0.26.9 was a hardening sweep for OAuth (F1–F15) and v0.31.1/v0.31.3 followed up to fix engine-aware SQL, thin-client routing, and stdio shutdown plumbing.

---

## 1. Stdio MCP server (`src/mcp/server.ts`, `src/mcp/dispatch.ts`)

`startMcpServer(engine)` (`src/mcp/server.ts:11`) spins up `@modelcontextprotocol/sdk`'s `Server` against `StdioServerTransport`. Two handlers:

- `ListToolsRequestSchema` → `buildToolDefs(operations)` from `src/mcp/tool-defs.ts:13`. Pure mapping: name, description, JSON Schema for params, required-list. Same shape used by the subagent tool registry (`src/core/minions/tools/brain-allowlist.ts`) — byte-for-byte equivalence pinned by `test/mcp-tool-defs.test.ts`.
- `CallToolRequestSchema` → `dispatchToolCall` with hardcoded `remote: true`, `takesHoldersAllowList: ['world']`, `sourceId: process.env.GBRAIN_SOURCE || 'default'`, `metaHook: getBrainHotMemoryMeta` (`src/mcp/server.ts:36-47`). Stdio has no per-token auth (local pipe) so it forces public `'world'` takes-holder filter; operators wanting full visibility use `gbrain call` which sets `remote: false`.

Lifecycle (`src/mcp/server.ts:56-71`): single `shutdown(reason, code)` closure with `shuttingDown` idempotency guard. Triggers: `stdin.end`, `stdin.close`, `transport.onclose`, SIGTERM, SIGINT, SIGHUP. Always `engine.disconnect()` before `process.exit(code)`. `handleToolCall` (`src/mcp/server.ts:78-97`) is the trusted local backdoor used by `gbrain call`: `remote: false`, accepts `opts.sourceId` (v0.31.8 D22).

### `dispatch.ts` — single source of truth

`dispatchToolCall(engine, name, params, opts)` (`src/mcp/dispatch.ts:218`):

1. Look up op by name; emit `{error:'unknown_tool'}` JSON envelope on miss (`src/mcp/dispatch.ts:225-235` — JSON not plain string, so `JSON.parse(content)` always works; v0.31 e2e tests parse content).
2. `validateParams(op, safeParams)` (`src/mcp/dispatch.ts:171`) — required-field check + type narrowing.
3. `buildOperationContext(engine, params, opts)` (`src/mcp/dispatch.ts:195`) — 9-field `OperationContext`: `engine`, `config`, `logger`, `dryRun: !!params.dry_run`, `remote: opts.remote ?? true` (defaults to **untrusted**), `takesHoldersAllowList`, `sourceId`, `auth`.
4. Run `op.handler(ctx, params)`; wrap `OperationError` and unexpected throws in identical `{content:[{type:'text',text:JSON-string}], isError:true}` envelopes (`src/mcp/dispatch.ts:265-278`).
5. Best-effort `_meta.brain_hot_memory` via `opts.metaHook` — wrapped in its own try/catch (`src/mcp/dispatch.ts:255-263`) so meta-hook crash degrades to "no _meta" instead of failing the tool call. v0.31 eD3.

`summarizeMcpParams(opName, params)` (`src/mcp/dispatch.ts:128`) is the F8 PII redactor. Returns `{redacted:true, kind, declared_keys, unknown_key_count, approx_bytes}`. Two structural defenses (`src/mcp/dispatch.ts:88-126`):
- **Allow-list intersection**: declared keys come from `op.params` (same set `validateParams` reads). Attacker-controlled keys (`put_page {"private/sensitive": ...}`) get counted as `unknown_key_count` but never named in logs.
- **1KB byte bucketing** via `bucketBytes(n)` (`src/mcp/dispatch.ts:121`): blocks size-based binary-search side channel.

---

## 2. HTTP MCP server with OAuth 2.1 (`src/commands/serve-http.ts`, 1083 LOC)

`runServeHttp(engine, options)` (`src/commands/serve-http.ts:167`) — Express 5 app combining MCP SDK auth router with admin endpoints, SSE feed, and bearer-auth-protected `/mcp`. Boot sequence:

- Engine-aware SQL via `sqlQueryForEngine(engine)` (`src/commands/serve-http.ts:182`, see §6). Replaces v0.22.7 postgres.js singleton.
- `GBrainOAuthProvider({sql, tokenTtl, dcrDisabled: !enableDcr})` (`src/commands/serve-http.ts:188`).
- `sweepExpiredTokens()` runs once at startup, non-blocking (`src/commands/serve-http.ts:196`).
- 32-byte hex bootstrap token + sha256 hash; in-memory `adminSessions: Map<sessionId, expiresAt>` and `sseClients: Set<Response>`.
- `app.set('trust proxy', 'loopback')` for Caddy/Tailscale on localhost.

### Endpoint catalog

| Path | Method | Auth | Notes |
|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | none | SDK metadata; intercepted to add `client_credentials` to `grant_types_supported` (`src/commands/serve-http.ts:325-336`). |
| `/authorize` | GET/POST | per OAuth | Auth-code w/ PKCE; SDK-routed to `oauthProvider.authorize` (`src/core/oauth-provider.ts:234`). |
| `/token` | POST | client creds | Custom CC handler (`src/commands/serve-http.ts:261-279`) runs BEFORE SDK router. CC → `exchangeClientCredentials`; auth_code/refresh fall through to SDK. Rate-limited 50/15min. |
| `/register` | POST | none (DCR) | Reachable only when `--enable-dcr`. Routed through `dcrDisabled` constructor option (F12). |
| `/revoke` | POST | client | SDK-routed to `oauthProvider.revokeToken`. F4 client-bound. |
| `/mcp` | POST | bearer + scope | `requireBearerAuth({verifier: oauthProvider})`. Per-request fresh `Server` + `StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`). |
| `/health` | GET | none | Liveness only (`probeLiveness` race vs `SELECT 1`). v0.28.10 split. |
| `/admin/login` | POST | bootstrap token | Constant-time `safeHexEqual` (`src/commands/serve-http.ts:358-361`). Sets HttpOnly cookie. |
| `/admin/auth/:nonce` | GET | nonce | Magic-link redemption. Single-use nonce (D11/D12). Rate-limited 10/min/IP. |
| `/admin/api/issue-magic-link` | POST | bootstrap | Mints nonce → `{url, expires_in: 300}`. |
| `/admin/api/sign-out-everywhere` | POST | admin cookie | `adminSessions.clear()`. |
| `/admin/api/agents` | GET | admin cookie | Unified view: `oauth_clients` + `access_tokens` legacy keys (`src/commands/serve-http.ts:528-546`). |
| `/admin/api/stats` | GET | admin cookie | 4 cheap counters. |
| `/admin/api/health-indicators` | GET | admin cookie | `expiring_soon`, `error_rate`. |
| `/admin/api/full-stats` | GET | admin cookie | `probeHealth(engine,...)` — v0.28.10 moved off `/health`. |
| `/admin/api/requests` | GET | admin cookie | Filtered paginated `mcp_request_log`. Dynamic WHERE via `engine.executeRaw(sql, params)` since SqlQuery is scalar-only. |
| `/admin/api/api-keys` (GET/POST/revoke) | … | admin cookie | Legacy bearer-token CRUD (`src/commands/serve-http.ts:648-685`). |
| `/admin/api/register-client` | POST | admin cookie | Wraps `registerClientManual('client_credentials', scopes)`. |
| `/admin/api/update-client-ttl` | POST | admin cookie | UPDATE `oauth_clients.token_ttl`. |
| `/admin/api/revoke-client` | POST | admin cookie | Soft-delete client + DELETE `oauth_tokens` for that client_id. |
| `/admin/events` | GET (SSE) | admin cookie | `text/event-stream`; broadcasts every MCP request. |
| `/admin/*` | GET | static | Serves `admin/dist/` SPA + SPA fallback. |

### `/mcp` request handler (`src/commands/serve-http.ts:770-1054`)

Per-request: extract `authInfo` (with `clientName` from JOIN, no N+1); construct stateless `Server` + `StreamableHTTPServerTransport`.

`ListToolsRequestSchema`: returns `mcpOperations.filter(op => !op.localOnly)` mapped. **v0.28.10**: every `tools/list` writes a `mcp_request_log` row.

`CallToolRequestSchema`:
1. Unknown-op path persists with `error_message: 'unknown_operation: <name>'`.
2. Scope check: `op.scope || 'read'` vs `authInfo.scopes` via `hasScope()` (`src/core/scope.ts:71` hierarchy: `admin` ⇒ all, `write` ⇒ {write,read}, `*_admin` ⇒ self only, `read` ⇒ self).
3. **F8 redaction**: `summarizeMcpParams` unless `--log-full-params`. `logParamsObj` passed to `executeRawJsonb` with explicit `::jsonb` cast (v0.31.3 D1 fix, see §6).
4. **F7 trust-boundary**: explicit `remote: true` on `dispatchToolCall` opts (`src/commands/serve-http.ts:935-951`). Pre-fix the inlined OperationContext skipped this field, so `submit_job`'s protected-name guard saw a falsy undefined and let `read+write` OAuth tokens submit `shell` jobs. Closes OAuth-to-RCE.
5. **v0.31 eE1 follow-up**: threads `auth: authInfo` so `whoami` (and any future scope-aware handlers) can introspect.
6. Persistence + SSE broadcast on success / error / unknown / scope-rejected — four paths, all `executeRawJsonb` for JSONB `params`.
7. **F14**: `transport.handleRequest` wrapped in try/catch (`src/commands/serve-http.ts:1041-1053`) → JSON 500 envelope on SDK throws rather than express's HTML page.

`agentName = authInfo.clientName ?? authInfo.clientId` (`src/commands/serve-http.ts:778`) — human-readable name across audit log.

---

## 3. v0.26.9 OAuth hardening pass (F-series)

Across `src/core/oauth-provider.ts` and `src/commands/serve-http.ts`:

| Fix | What it closes | File:line |
|---|---|---|
| **F1** | Client-bound atomic DELETE in auth-code exchange. RFC 6749 §10.5 single-use w/o losing legitimate retries. Pre-fix, wrong-client retry burned the row. | `src/core/oauth-provider.ts:291-329` (DELETE…WHERE client_id AND redirect_uri RETURNING) |
| **F2** | Same atomic-DELETE shape on refresh rotation. RFC 6749 §10.4 stolen-token detection. | `src/core/oauth-provider.ts:343-366` |
| **F3** | Refresh-scope-subset checked against the **stored grant** on the row, NOT the client's currently-allowed scopes. v0.28 uses `hasScope()` so `admin` grant CAN refresh down to `sources_admin`. | `src/core/oauth-provider.ts:376-394` |
| **F4** | Client-bound revoke. RFC 7009 §2.1. | `src/core/oauth-provider.ts:465-481` |
| **F5** | `isUndefinedColumnError` replaces bare `catch {}` in `verifyAccessToken`/`getClient` legacy fallback. Only SQLSTATE 42703 falls through; lock timeouts/network blips throw. | `src/core/oauth-provider.ts:502-508`, `535-539` |
| **F6** | `sweepExpiredTokens()` returns count via `RETURNING 1` + `array.length`. Pre-fix returned 0 on at least one engine. | `src/core/oauth-provider.ts:549-562` |
| **F7** | `remote: true` set explicitly on `/mcp`'s OperationContext. Closes shell-job RCE via OAuth. | `src/commands/serve-http.ts:935-951` |
| **F7b** (D12) | `OperationContext.remote` flipped to REQUIRED in TS type; four flipped call sites use `ctx.remote === false` (trusted-only) or `ctx.remote !== false` (untrust-unless-explicit-false). | (operations.ts handlers) |
| **F7c** | `redirect_uri` validated against value stored at `/authorize` (RFC 6749 §4.1.3). Empty-string treated as MISSING, not wildcard. | `src/core/oauth-provider.ts:312-329` |
| **F8** | `summarizeMcpParams` redacts payloads. `--log-full-params` opt-in with stderr warning. | `src/mcp/dispatch.ts:128`, `src/commands/serve-http.ts:914-918` |
| **F9** | Cookie `Secure` honors `req.secure || issuerUrl.protocol === 'https:'` so Cloudflare-tunnel + reverse-proxy still tag Secure. | `src/commands/serve-http.ts:296-302` |
| **F10** | LRU cap on magic-link nonce store (`NONCE_LRU_CAP=1000`); also caps `consumedNonces`. Defeats nonce-flood OOM. | `src/commands/serve-http.ts:418-428` |
| **F12** | `dcrDisabled` constructor option on `GBrainOAuthProvider`. SDK's `mcpAuthRouter` only wires `/register` when `clientsStore.registerClient` exposed. | `src/core/oauth-provider.ts:216-228` |
| **F14** | try/catch around `transport.handleRequest`; JSON 500 envelope. | `src/commands/serve-http.ts:1041-1053` |
| **F15** | All `/mcp` errors via `buildError`/`serializeError` (`src/core/errors.ts`) so envelope shape identical for OperationError + uncaught exceptions. | `src/commands/serve-http.ts:933-979` |

---

## 4. v0.26.2 `coerceTimestamp` boundary (`src/core/oauth-provider.ts:99-106`)

`postgres.js` with `prepare: false` (auto-detected on Supabase PgBouncer port 6543, see `src/core/db.ts:resolvePrepare`) returns BIGINT as **strings**. Two surfaces broke:

1. MCP SDK `bearerAuth` checks `typeof authInfo.expiresAt === 'number'` and rejects strings → every successful auth-code exchange yielded a token the next request invalidated.
2. RFC 7591 §3.2.1 requires JSON numbers for `client_id_issued_at`/`client_secret_expires_at`.

`coerceTimestamp(value)` returns `Number(value)` for non-null inputs, **throws on non-finite** (NaN/Infinity) so corrupt rows fail loud, returns `undefined` for SQL NULL. Five call sites: `getClient` (L150-151 RFC 7591), `exchangeRefreshToken` (L373), `verifyAccessToken` (L421). NULL `expires_at` is **expired** (fail-closed); schema permits NULL though `issueTokens` always sets it.

---

## 5. v0.28.1 health probe split (`probeHealth` → `probeLiveness`)

`probeHealth(engine, engineName, version, timeoutMs)` (`src/commands/serve-http.ts:55-96`) — original engine-getStats race. `probeLiveness(sql, ...)` (`src/commands/serve-http.ts:107-141`) — v0.28.10 replacement that races `SELECT 1`. Same `ProbeHealthResult` tagged-union; same 3000ms `HEALTH_TIMEOUT_MS` (Fly.io's 5s deadline → 2s headroom for TCP/framing/clock skew).

Why split: `getStats()`'s 6× `count(*)` on 96K-page brains through PgBouncer exceeded `HEALTH_TIMEOUT_MS` → orchestrator restart cascades + advisory-lock pile-ups. v0.28.10:

- `/health` body is `{status, version, engine}` only — no stats spread.
- `/admin/api/full-stats` (`src/commands/serve-http.ts:590-593`) — admin-gated endpoint calls `probeHealth(engine,...)` returning original spread-stats body.
- `?full=true` removed entirely.

Both probes use `try { setTimeout race } finally { clearTimeout }` (timer-cleanup fix; both adversarial reviewers flagged it independently — `src/commands/serve-http.ts:91-95`, `137-141`).

---

## 6. v0.31.3 engine-aware SQL fix (`src/core/sql-query.ts`)

Pre-v0.31.3 every OAuth + admin + auth-CLI SQL site hit the postgres.js singleton `getConn()`, so `gbrain auth` and `gbrain serve --http` silently failed (or wrote to wrong DB) when active engine was PGLite. PR #681.

**`sqlQueryForEngine(engine): SqlQuery`** (`src/core/sql-query.ts:32`) returns a tagged template that:
1. Asserts every value is `SqlValue` (string | number | bigint | boolean | Date | null) via `assertSqlValue` (`src/core/sql-query.ts:44`). Throws loud on object/array — no nested fragments, no `sql.json()`.
2. Walks template, builds positional `$1, $2, ...`.
3. Routes through `engine.executeRaw(sql, params)` — Postgres via postgres.js `unsafe(sql, params)` (real bind), PGLite via embedded `db.query(sql, params)`.

The narrow surface IS the feature (codex finding #7): if it grew `sql.json()`/`sql.unsafe()`/`sql.begin()` it would drift into a partial postgres.js clone.

**`executeRawJsonb(engine, sql, scalarParams, jsonbParams)`** (`src/core/sql-query.ts:107`) — JSONB-write companion. Positional `$N::jsonb` casts; objects passed through. v0.12.0 double-encode bug class doesn't apply because positional binding via `unsafe()` reaches wire protocol with correct type oid (verified by `test/sql-query.test.ts` on PGLite, `test/e2e/auth-permissions.test.ts:67` on Postgres).

Six `mcp_request_log.params` INSERT sites in serve-http.ts (success at L1015-1021, exception-error at L962-967, isError-from-dispatch at L993-999, scope-rejected at L870-876, unknown-op at L838-844, tools/list at L793-799) all go through `executeRawJsonb` → JSONB stores **real objects**. Pre-fix: `params->>'op'` returned encoded string `"search"` (with quotes) instead of `search`. **Migration v46** (`mcp_request_log_params_jsonb_normalize`) backfills pre-v0.31.3 string-shaped rows on first start.

`scripts/check-jsonb-pattern.sh` doesn't fire because `executeRawJsonb(...)` is a method call, not the banned literal-template-tag interpolation.

---

## 7. v0.31.1 thin-client routing (`src/cli.ts`)

`gbrain init --mcp-only` (v0.29.2) installs a thin client with no local brain content. v0.29.2/v0.30.0 only refused 9 obvious local-only commands; ~25 others silently opened empty PGLite. v0.31.1 fixes the silent-empty-results class.

### Routing seam (`src/cli.ts:150-157`)

BEFORE `connectEngine`:
```ts
const cfgPre = loadConfig();
if (isThinClient(cfgPre)) {
  if (op.localOnly) refuseThinClient(command, cfgPre!.remote_mcp!.mcp_url);
  await runThinClientRouted(op, params, cfgPre!, cliOpts);
  return;
}
```

`isThinClient(cfg)` (config.ts) returns true iff `cfg.remote_mcp` is set.

### `runThinClientRouted` (`src/cli.ts:212-309`)

Per-op timeout default (ENG-4): 180s for `think`, 30s otherwise; user `--timeout=Ns` wins. SIGINT handler aborts in-flight HTTP cleanly (exits 130). `printIdentityBannerBestEffort` runs before each call. Then `callRemoteTool(cfg, op.name, params, {timeoutMs, signal})`, unpack via `unpackToolResult`, hand to the SAME `formatResult` the local-engine path uses.

Error rendering: **exhaustive TS `never` switch** over `RemoteMcpError.reason` (`src/cli.ts:247-296`) — adding a new variant fails compilation until the dispatcher knows what to render. Cases: `config`, `discovery`, `auth`, `auth_after_refresh`, `network` (sub-tag dispatch on `e.detail?.kind`: `'timeout'`/`'aborted'`/`'unreachable'`), `tool_error` (sub-tag on `e.detail?.code === 'missing_scope'`), `parse`.

ENG-2 renderer parity: local-engine path runs `JSON.parse(JSON.stringify(rawResult))` (`src/cli.ts:168`) → renderers see same shape on both paths. Kills Date/bigint/Buffer drift.

### `refuseThinClient` (`src/cli.ts:678-690`)

Emits pinpoint refusal hint from `THIN_CLIENT_REFUSE_HINTS` (`src/cli.ts:655-670`) keyed by command. Falls back to canonical generic. Exits 1.

### `THIN_CLIENT_REFUSED_COMMANDS` (`src/cli.ts:631-643`)

`{sync, embed, extract, migrate, apply-migrations, repair-jsonb, orphans, integrity, serve, dream, transcripts, storage, takes, sources}`. `doctor` is **NOT** in the set — routed to `runRemoteDoctor` (`src/cli.ts:847-857`). Per-subcommand splits for `takes`/`sources` are v0.31.x TODO.

### `callRemoteTool` and `RemoteMcpError` (`src/core/mcp-client.ts`)

`callRemoteTool(config, toolName, args, opts)` (`src/core/mcp-client.ts:283-374`) — outbound transport. Wraps MCP SDK `Client` + `StreamableHTTPClientTransport` with:

- **OAuth `client_credentials` minting + token caching** (`tokenCache: Map`, in-process, 30s safety margin vs clock skew, `src/core/mcp-client.ts:33-203`).
- **401 retry once**: drop cache, mint fresh, retry. Second 401 → `auth_after_refresh` (`src/core/mcp-client.ts:328-365`).
- **CDX-4 error funnel** (`src/core/mcp-client.ts:367-373`): outermost catch normalizes ANY thrown value to `RemoteMcpError` via `toRemoteMcpError(e, mcpUrl)` (`src/core/mcp-client.ts:94-120`). No plain Error (undici, AbortError, JSON parse) escapes.
- **`buildAbortController(opts)`** (`src/core/mcp-client.ts:248-270`) composes external `signal` (SIGINT) with `timeoutMs` into one controller.

`RemoteMcpErrorReason = 'config'|'discovery'|'auth'|'auth_after_refresh'|'network'|'tool_error'|'parse'` (`src/core/mcp-client.ts:56-63`). Stable union. `RemoteMcpErrorDetail.kind: 'timeout'|'aborted'|'unreachable'` sub-tag on `network`. `RemoteMcpErrorDetail.code` on `tool_error` carries server-supplied codes (e.g. `missing_scope`).

`extractToolErrorCode(message)` (`src/core/mcp-client.ts:129-143`): JSON parse first (server-side `{"error":{"code":"...","message":"..."}}`), regex fallback `/missing[_\s-]?scope|scope.+(insufficient|required)|forbidden|access.+denied/i`.

`unpackToolResult<T>(res)` (`src/core/mcp-client.ts:382-396`): JSON.parses first content item's `text`. Throws `RemoteMcpError('parse', ...)` on unexpected shape.

### Identity banner (`src/cli.ts:339-415`)

`get_brain_identity` op returns `{version, engine, page_count, chunk_count, last_sync_iso}`. 60s in-process TTL via `identityCache: Map<mcpUrl, CachedIdentity>`. Suppressed by `--quiet`, `GBRAIN_NO_BANNER=1`, non-TTY (default). 2s timeout. Failure swallowed (observability, not load-bearing). Output to **stderr**: `[thin-client → host · brain: 102k pages, 265k chunks · vX.Y.Z]`.

### `gbrain remote {ping,doctor}` (`src/commands/remote.ts`)

`ping` (`src/commands/remote.ts:105-181`) submits `autopilot-cycle` with `data:{phases:['sync','extract','embed']}`, polls `get_job` with backoff curve (1s × 30s, 5s × 5min, 10s after; default 15min, `--timeout` overrides). Exits on terminal state. `doctor` (`src/commands/remote.ts:202-229`) calls `run_doctor` MCP op, renders `DoctorReport`, exits 0/1.

### `gbrain remote doctor` checks (`src/core/doctor-remote.ts`)

`collectRemoteDoctorReport(config, opts)` (`src/core/doctor-remote.ts:76-239`):
1. **config_integrity** — URL regex on `issuer_url`/`mcp_url`.
2. **oauth_credentials** — secret resolution (`GBRAIN_REMOTE_CLIENT_SECRET` env wins, then config).
3. **oauth_discovery** — RFC 8414 `/.well-known/oauth-authorization-server`.
4. **oauth_token** — round-trip mint via `mintClientCredentialsToken`.
5. **mcp_smoke** — `initialize` round-trip via `smokeTestMcp`.
6. **oauth_client_scopes_probe** (CDX-5) — `probeScopes(config)` (`src/core/doctor-remote.ts:330-360`) calls `get_brain_identity` (read tier) + `get_health` (admin tier; `engine.getHealth` is SELECT but op requires admin per `operations.ts:1370`). `buildScopeCheck` (`src/core/doctor-remote.ts:363-433`): `'fail'` on missing read, `'warn'` on missing admin (paste-ready `gbrain auth register-client` hint), `'ok'` when both succeed. Other probe errors `'ok' + inconclusive:true` so transient noise doesn't flap.
7. **thin_client_upgrade_drift** (v0.31.11) — `get_brain_identity` → compare local `VERSION` via `safeCompare`/`driftLevel`. Patch drift not flagged. Network errors `'ok' + inconclusive:true`.

`GBRAIN_DOCTOR_SKIP_SCOPE_PROBE=1` env (or `opts.skipScopeProbe`) skips 6+7 — fixtures that mock `/mcp` at JSON-RPC initialize level only (SDK Client hangs on shape mismatch).

---

## 8. v0.31.3 stdio cleanup (`src/commands/serve.ts`)

Pre-v0.31.3 stdio MCP held PGLite write-lock indefinitely after Claude Desktop / Cursor / launchd-managed gateways disconnected → 5-minute stale-lock wait on next start. Origin PR #591 (@Aragorn2046), rebased: @seungsu-kr (Bun ppid workaround).

`runServe(engine, args, opts)` (`src/commands/serve.ts:61-114`) dispatches `--http` to `runServeHttp`; stdio path calls `installStdioLifecycle` **before** `startMcpServer` so an early stdin EOF still triggers graceful release.

`installStdioLifecycle(engine, args, opts)` (`src/commands/serve.ts:127-275`):

- **`beginShutdown(reason)`** (`src/commands/serve.ts:145-183`): single closure with `shuttingDown` idempotency; clears watchdog; races `engine.disconnect()` against `CLEANUP_DEADLINE_MS = 5_000ms`; forces `process.exit(0)` past deadline (lock dir is advisory).
- **Signals**: SIGTERM, SIGINT, SIGHUP all funnel into `beginShutdown`. SIGHUP added because Aragorn observed Claude Desktop on macOS / hermes-agent restart sending it instead of stdin close.
- **Stdin EOF**: `'end'`/`'close'` listeners (skipped on TTY). MCP SDK's `StdioServerTransport` only listens for `'data'`/`'error'`.
- **Parent-watchdog**: 5s `setInterval` polling `readLiveParentPid()` (`src/commands/serve.ts:294-308`) — `spawnSync('ps', ['-o', 'ppid=', '-p', PID])` because Bun's `process.ppid` is cached at process creation and **does not refresh** on reparent (oven-sh/bun#30305). Captures `initialParentPid` once; fires `'parent-died'` on **any change**, not just reparent-to-PID-1 (codex #3 — covers launchd/systemd subreaper case). Skipped when `initialParentPid === 1`.
- **Watchdog probe**: `probeWatchdogAvailable()` (`src/commands/serve.ts:325-337`) one-shot at install time. When `ps` unavailable (stripped containers, busybox), watchdog is **NOT installed** and loud stderr emits: `[gbrain serve] watchdog disabled: ps unavailable…`. Pre-fix per-tick fallback returned cached `process.ppid` → watchdog claimed installed but never fired.
- **Optional `--stdio-idle-timeout <seconds>`**: opt-in safety net for parents that leak pipe without closing. Strict `Number()` parsing (`src/commands/serve.ts:339-369`) — rejects empty/whitespace/non-integer/negative loud.

Tests: `test/serve-stdio-lifecycle.test.ts` pins 22 cases. Closes #413, #446.

---

## 9. Admin SPA (`admin/`)

React 19 + Vite + TypeScript SPA built into `admin/dist/` (committed for self-contained binaries), served by serve-http.ts (`express.static` at `/admin`). 65KB gzip per CLAUDE.md.

`admin/package.json` (21 LOC): `react@^19.1.0`, `react-dom@^19.1.0`, `vite@^6.3.3`, `@vitejs/plugin-react@^4.4.1`. No state library, no router (hash routing), no UI framework.

Layout (`admin/src/App.tsx:8-83`): hash-routed pages (`#dashboard`, `#agents`, `#log`, `#login`); `Page` type union; sidebar with nav items + "Sign out everywhere" button (calls `/admin/api/sign-out-everywhere` then navigates to login).

### Screens

| Screen | File | LOC | Purpose |
|---|---|---|---|
| Login | `admin/src/pages/Login.tsx` | 96 | Bootstrap-token paste form. Constant-time hex compare server-side. **No browser-side token cache** (D11/D12). |
| Dashboard | `admin/src/pages/Dashboard.tsx` | 137 | 3 metric cards (connected_agents, requests_today, active_tokens) + live SSE feed (last 50 events). 30s metric refresh. EventSource auto-reconnect. |
| Agents | `admin/src/pages/Agents.tsx` | 633 | Sortable agent table; ApiKeyCreateModal, ApiKeyTokenModal, RegisterModal, CredentialsModal (Copy + Download JSON + yellow "shown only once"), AgentDrawer (Details/Activity/Config Export + Revoke). |
| RequestLog | `admin/src/pages/RequestLog.tsx` | 150 | Filterable paginated `mcp_request_log` reader. |

Login hardened (`admin/src/pages/Login.tsx:4-15`): no `localStorage`, no `sessionStorage`, no React state beyond form-submit cycle. HttpOnly cookie set by `/admin/login` is the only session credential. Closing the tab ends the session.

### `admin/src/api.ts` (37 LOC)

`apiFetch(path, options)` adds `credentials: 'same-origin'` + `Content-Type: application/json`. **401 → redirect `#login`** (no token cache to retry from). Exports `api` object with method-per-endpoint.

`admin/src/lib/scope-constants.ts` (22 LOC): mirror of server-side `ALLOWED_SCOPES` for RegisterModal scope checkboxes.

### Magic-link flow (D11+D12, `src/commands/serve-http.ts:386-493`)

Trust model: bootstrap token = long-term server admin secret (printed to stderr at startup, lives in terminal scrollback). Magic-link URLs use **one-time nonces** NOT the bootstrap token, so it never appears in a URL → no leakage via browser history, proxy logs, Referer.

Flow:
1. Agent calls `POST /admin/api/issue-magic-link` with `Authorization: Bearer <bootstrapToken>`.
2. Server mints 32-byte hex nonce, stores in `magicLinkNonces` Map (5-min TTL), returns `{url: <baseUrl>/admin/auth/<nonce>, expires_in: 300}`.
3. User clicks link. `GET /admin/auth/:nonce` (rate-limited 10/min/IP) validates → marks `consumedNonces` → sets HttpOnly + SameSite=Strict + Secure cookie → redirects `/admin/`.

`pruneExpiredNonces()` (`src/commands/serve-http.ts:409-429`) runs on every issue/redeem; F10 LRU caps both `magicLinkNonces` and `consumedNonces` at 1000.

---

## 10. Rate limiting (`src/mcp/rate-limit.ts` + `src/mcp/http-transport.ts`)

`RateLimiter` (`src/mcp/rate-limit.ts:46-124`) — token-bucket with bounded LRU + TTL prune.

- `Bucket = {tokens, lastRefillMs, lastTouchedMs}`. Two timestamps because `lastTouchedMs` updates on every check (even when refill produces 0 tokens), so an exhausted attacker can't reset their bucket by hammering past the TTL — exactly the bucket-reset attack the `lastRefillMs`-only shape would have allowed (`src/mcp/rate-limit.ts:38-40, 95-109`).
- LRU: `Map.delete + set` moves a key to end on every check; `evictIfOver` drops oldest (front of iteration order).
- `prune(now)` walks until fresh entry, breaks (insertion order = recency).
- `Retry-After` (`src/mcp/rate-limit.ts:87-92`) from next-token accrual: `msPerToken - (now - lastRefillMs)`.

`buildDefaultLimiters(clock)` (`src/mcp/rate-limit.ts:135-142`) returns two-bucket pipeline: `ip` (30/60s default, `GBRAIN_HTTP_RATE_LIMIT_IP`) + `token` (60/60s default, `GBRAIN_HTTP_RATE_LIMIT_TOKEN`). Shared LRU cap (`GBRAIN_HTTP_RATE_LIMIT_LRU=10000`).

Pipeline in `src/mcp/http-transport.ts:232-278`:
1. **Pre-auth IP bucket** fires BEFORE DB lookup → actually caps brute-force load against `access_tokens`, not just response codes.
2. **Body cap** (1 MiB default, env `GBRAIN_HTTP_MAX_BODY_BYTES`, `readBodyWithCap` stream-counts so chunked transfers w/o Content-Length still capped — `src/mcp/http-transport.ts:72-101`).
3. **Auth lookup** (`validateToken`, `src/mcp/http-transport.ts:153-187`).
4. **Post-auth token-id bucket** limits runaway authed clients.
5. **Parse JSON-RPC body** + dispatch.

`/token` endpoint in serve-http.ts has its own limiter via `express-rate-limit` (50/15min, `src/commands/serve-http.ts:240-246`).

`http-transport.ts` is the **legacy bearer-auth** transport (v0.22.7 predecessor of the OAuth `serve-http.ts` path). Still wired through `sqlQueryForEngine(engine)` so it works on PGLite. OAuth path supersedes it for `gbrain serve --http`; legacy `access_tokens`-issued tokens grandfather to `read+write+admin` scopes via `verifyAccessToken` fallback (`src/core/oauth-provider.ts:435-456`).

---

## Drift from CLAUDE.md

- **`OperationContext` field count**: CLAUDE.md's v0.22.7 dispatch.ts annotation says "5-field"; the actual shape at `src/mcp/dispatch.ts:200-209` is 9 fields (added `takesHoldersAllowList`, `sourceId`, `auth` across v0.28/v0.31). The "5-field" phrasing is stale; sequential hardening waves grew the shape.
- **Startup banner contents**: CLAUDE.md says startup logging "prints port, engine, configured issuer URL (honors `--public-url`), registered-client count, DCR status." The actual ASCII banner box (`src/commands/serve-http.ts:1062-1081`) prints all of these AND the bootstrap token AND token TTL — the documented list is incomplete.
- **`mcp_request_log` write sites**: CLAUDE.md correctly states v0.31.3 routes JSONB writes through `executeRawJsonb`. Cross-checked: **six** call sites in serve-http.ts (success at L1015-1021, exception-error at L962-967, isError-from-dispatch at L993-999, scope-rejected at L870-876, unknown-op at L838-844, tools/list at L793-799), not the four implied. v0.28.10 coverage extension is similarly slightly understated.
- **`gbrain auth` engine fix**: CLAUDE.md describes v0.31.3 routing every SQL through `sqlQueryForEngine`. Verified, AND `auth.ts:60` calls `engine.connect(engineConfig)` explicitly inside `withConfiguredSql` because v0.32 `createEngine` returns a disconnected instance and `PostgresEngine.sql` getter would otherwise crash with the misleading "No database connection" error. This v0.32 follow-up fix is documented in the auth.ts code comment but NOT in CLAUDE.md.
- **`http-transport.ts` status**: the file (365 LOC at `src/mcp/http-transport.ts`) is the legacy bearer-auth transport from v0.22.7. CLAUDE.md mentions it by way of v0.22.7 history but doesn't note that it's no longer reachable from any CLI path — `runServe` (`src/commands/serve.ts:74-95`) routes `--http` to `runServeHttp` (the OAuth path), and the only consumer of `startHttpTransport` is its own test files. From the user's perspective it's dead code, kept alive only because the OAuth path's `verifyAccessToken` legacy fallback (`src/core/oauth-provider.ts:435-456`) reuses the `access_tokens` table the legacy path created. Worth flagging in the synthesis report for the instance-10 cross-cut.
- **`whoami` op auth thread**: CLAUDE.md's serve-http.ts annotation mentions the v0.31 D12/eE1 refactor moving dispatch into `dispatchToolCall`. The follow-up fix described in CLAUDE.md ("forgot to pass authInfo; whoami fell through to the unknown_transport throw because ctx.auth was undefined") is implemented at `src/commands/serve-http.ts:945` (the `auth: authInfo` line) — accurate, and the corresponding stdio path at `src/mcp/server.ts:36-47` does **not** pass `auth` (no per-token auth on stdio by design). That asymmetry isn't called out in CLAUDE.md but is correct behavior.
