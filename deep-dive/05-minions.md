# Instance 5 — Minions: jobs, subagents, supervisor

GBrain's Minions subsystem is a Postgres-native, BullMQ-inspired job queue that gbrain uses for every background-work surface: `sync`, `embed`, `extract`, `lint`, `import`, `backlinks`, `autopilot-cycle`, `shell`, `subagent`, `subagent_aggregator`. The contract is `MinionQueue` (writer + reader of `minion_jobs`) plus `MinionWorker` (in-process Promise pool with per-job AbortController + lock renewal). `MinionSupervisor` wraps the worker as a child process with crash-respawn + DB liveness probes. The trust posture is layered: `PROTECTED_JOB_NAMES` gates submission; `allowed_slug_prefixes` narrows `put_page` per subagent; the brain-tool allow-list bounds what an LLM loop can call. Three layers of zombie-reap defense (in-process SIGCHLD, tini-as-PID-1, container tini) keep descendant processes from holding DB connection slots after exit.

---

## 1. Queue state machine

Statuses (`src/core/minions/types.ts:18-27`): `waiting | active | completed | failed | delayed | dead | cancelled | waiting-children | paused`. `TERMINAL_STATUSES` set lives at `src/core/minions/queue.ts:34` (`completed | failed | dead | cancelled`). `waiting-children` is the parent state while children are still non-terminal; `delayed` is retry-with-backoff or `delay_until` timer; `paused` clears the lock so the worker's `AbortController` fires.

### Submission (`queue.ts:68-302`, `add()`)

Wrapped in `engine.transaction()`. Atomic checks:

1. Trust gate: `isProtectedJobName(jobName)` whitelist (line 81); only trusted callers passing `{allowProtectedSubmit: true}` can submit `shell | subagent | subagent_aggregator`.
2. v0.31.12 layer-1 enforcement (line 87-107): `subagent` jobs whose `data.model` resolves through `isAnthropicProvider()` to a non-Anthropic provider are rejected at the queue boundary — lazy-imports `model-config.ts` to avoid pulling engine types into queue's eager-load.
3. Idempotency fast path (line 118-124): unique partial index lookup short-circuits before any other work.
4. `maxWaiting` backpressure (line 145-182): `pg_advisory_xact_lock` keyed on `(name, queue)` serializes count+insert; coalesces a repeat submission by returning the most-recent waiting row; emits a `logBackpressureCoalesce` audit line.
5. Parent lock + depth/cap (line 184-212): `SELECT FOR UPDATE` on `parent_job_id`; depth bounded by `maxSpawnDepth` (default 5, `queue.ts:31`); `max_children` enforced under lock so two concurrent submitters can't both see capacity-1.
6. Insert with `ON CONFLICT (idempotency_key) DO NOTHING` (line 240-247); `max_stalled` is conditionally appended only when the caller passes a value, otherwise the schema DEFAULT (5 since v0.14.3) wins. Codex iter-3 footgun note: re-submission via idempotency-key does NOT update the existing row's `max_stalled` — the second submitter can't mutate the first submitter's durability semantics (line 222-226).
7. Parent flip to `waiting-children` (line 292-298) only from non-terminal, non-already-`waiting-children` states.

### Claim (`queue.ts:542-567`, `claim()`)

Single `UPDATE ... WHERE id = (SELECT id FROM minion_jobs ... FOR UPDATE SKIP LOCKED LIMIT 1)`. Filters on `name = ANY($4)` so a worker only claims jobs whose handler is registered. Order: `priority ASC, created_at ASC`. The same UPDATE sets `timeout_at = now() + timeout_ms` when the job has a deadline so `handleTimeouts()` doesn't re-read `timeout_ms`.

### Three timeout layers

- **Per-job timeout** (`worker.ts:567-593`): `setTimeout(timeout_ms)` fires `abort.abort(new Error('timeout'))` when `timeout_ms` is set. Cooperative — handlers ignoring `signal` aren't killed from JS.
- **30-second grace-then-evict safety net** (v0.22.1, `worker.ts:579-591`): if the handler doesn't resolve within 30s of abort, the worker force-evicts from `inFlight` (frees slot) and best-effort marks `dead` in DB. Closes the "98 waiting / 0 active" 2026-04-24 production incident where a wedged handler blocked the entire concurrency pool.
- **Wall-clock timeout** (`queue.ts:654-714`, `handleWallClockTimeouts`): Layer 3 kill shot. DB-side sweep flips status to `dead` when `now - started_at > timeout_ms * 2` (or `2 * lockDuration * max_stalled` when no per-job timeout). Catches jobs blocked on file locks where `FOR UPDATE SKIP LOCKED` stall sweeps skip the row.

### Stall detection (`queue.ts:992-1027`, `handleStalled()`)

Single CTE — three composed statements: `SELECT FOR UPDATE SKIP LOCKED WHERE lock_until < now()` → `requeued` for rows where `stalled_counter + 1 < max_stalled`, → `dead_lettered` for rows where the sum reaches the cap. Order in `worker.ts:177-198`: stalled sweep BEFORE timeout sweep so requeued jobs aren't immediately dead-lettered (`handleTimeouts` filters `lock_until > now()`).

### Cancel + cascade (`queue.ts:373-451`)

Recursive CTE walks descendants up to depth 100; sets `status = 'cancelled'`, clears lock, fires `child_done(outcome='cancelled')` into each non-root parent's inbox so aggregators don't hang. Resolve sweep flips parents `waiting-children → waiting` once their last open child is terminal. Honest scope (line 359-367): re-parenting during cancel isn't fully covered.

---

## 2. Lock + TTL semantics

### `max_stalled` default (DEFAULT 5 since v0.14.3)

Schema column carries the default; the queue layer doesn't hardcode. `scripts/check-jsonb-pattern.sh` is a CI grep guard that fails if anyone reintroduces `max_stalled INTEGER NOT NULL DEFAULT 1`. `MinionJobInput.max_stalled` (`types.ts:113`) is optional; `add()` clamps caller values to `[1, 100]` (`queue.ts:227-230`) and omits the column when unset so the schema default kicks in.

### Lock renewal (`worker.ts:553-560`)

Per-job `setInterval(lockDuration / 2)` calls `queue.renewLock(jobId, lockToken, lockDuration)`. On token mismatch (another worker reclaimed), fires `abort.abort(new Error('lock-lost'))` so the handler bails. Token-fenced UPDATEs everywhere (`completeJob`, `failJob`, `updateProgress`, `readInbox`, `updateTokens`) match `WHERE lock_token = $X AND status = 'active'`.

### 30-second grace-then-evict (v0.22.1, `worker.ts:579-591`)

After `abort.abort(...)`, if the handler doesn't exit within 30s, the worker:
1. Removes the job from `inFlight` (frees the concurrency slot),
2. Calls `failJob(... 'handler ignored abort signal (force-evicted)', 'dead')` best-effort,
3. Logs a loud warning.

The handler is still running in JS — the worker just stops waiting on it. Layered with `handleWallClockTimeouts` so even if the worker dies mid-eviction, the DB sweep evicts the row.

---

## 3. Three trust layers

### Layer 1: `PROTECTED_JOB_NAMES` (`src/core/minions/protected-names.ts:15-23`)

Pure, side-effect-free constant module — queue core imports it without loading any handler. Members: `shell`, `subagent`, `subagent_aggregator`. `isProtectedJobName(name)` does `name.trim()` first so `' shell '` can't bypass (matches the trim-and-check in `queue.ts:77-87`).

The gate fires in `MinionQueue.add()`: only callers passing the explicit 4th arg `{allowProtectedSubmit: true}` (SEPARATE `TrustedSubmitOpts`, NOT folded into `opts` so `{...userOpts}` spread can't sneak the flag in — `queue.ts:21-27`) can insert. CLI (`jobs.ts:267-268`, `agent.ts:162`) sets it; MCP/HTTP transports never do.

### Layer 2: `allowedSlugPrefixes` (v0.23 trusted-workspace)

`SubagentHandlerData.allowed_slug_prefixes` (`types.ts:438-451`) flows through `buildBrainTools({allowedSlugPrefixes})` → `namespacedPutPageSchema` (`brain-allowlist.ts:110-134`):

- When unset/empty: `put_page.slug` schema gets `pattern: ^wiki/agents/<subagentId>/.+` plus matching server-side check.
- When set (cycle synthesize/patterns phases only): model is told the allowed prefixes in plain English (no JSONSchema regex — globs aren't expressible cleanly), and the OperationContext is threaded with `allowedSlugPrefixes` so server-side `matchesSlugAllowList` in `operations.ts` enforces it.

Trust comes from PROTECTED_JOB_NAMES gating subagent submission. MCP cannot reach this field.

### Layer 3: `allowed_tools` (handler-level seam)

`SubagentHandlerData.allowed_tools` (`types.ts:419`) is the per-job whitelist. `filterAllowedTools(registry, allowedTools)` (`brain-allowlist.ts:252-273`) intersects against the derived `BRAIN_TOOL_ALLOWLIST` registry by tool name (accepts both `brain_query` and bare `query`). Unknown names THROW at load — silent ignores would mask typos. Empty array: no tools.

The book-mirror skill uses Layer 3 explicitly: subagents get `allowed_tools: ['get_page', 'search']` so untrusted EPUB content can't issue `put_page`. The final operator-trust write happens CLI-side, not from the subagent.

---

## 4. Zombie defense (v0.28.1, three layers)

### Layer 1: in-process SIGCHLD reaper (`src/core/zombie-reap.ts`)

`installSigchldHandler()` registers a no-op listener for SIGCHLD. Bun (like Node) only auto-reaps when SOMETHING is listening — without this, every shell job, embed batch, and subagent child becomes a zombie at exit. Idempotent: `process.listeners('SIGCHLD').includes(reapHandler)` short-circuits because EventEmitter doesn't dedupe by reference (line 24). Windows guard at line 23. Called once at module load from `src/cli.ts:3-4`. Test escape: `_uninstallSigchldHandlerForTests()` (line 34).

### Layer 2: tini-as-PID-1 (`src/core/minions/spawn-helpers.ts`)

Pure helpers consumed by both `supervisor.ts` and `autopilot.ts` — resolves the DRY violation and makes the tini wrapping testable without `mock.module()`.

- `detectTini()` (line 24-38): `execFileSync('which', ['tini'], {env: process.env, timeout: 2000})`. Explicit `env:` because Bun snapshots env at startup; without this, runtime PATH mutations are invisible to `which`.
- `buildSpawnInvocation(tiniPath, cliPath, args)` (line 48-56): when `tiniPath` is non-empty returns `{cmd: tiniPath, args: ['--', cliPath, ...args]}` — making tini PID 1 of the worker subtree. When empty, bare invocation.

`MinionSupervisor` resolves once at construction (`supervisor.ts:162`) and reuses across every respawn. `runAutopilot` does the same (`autopilot.ts:164`). Catches zombies from native-addon descendants that the JS-side SIGCHLD handler can't reach.

### Layer 3: container-level tini

The container's own tini (mentioned in `spawn-helpers.ts:9-10`) handles hard Bun crashes where layers 1+2 are gone. Not gbrain code; AlphaClaw's containerization choice.

---

## 5. Subagent handler (`src/core/minions/handlers/subagent.ts:129-577`)

### Two-phase tool persistence

Every tool dispatch writes two rows in `subagent_tool_executions`:
1. `persistToolExecPending` (line 644-662): INSERT row with `status='pending'` + `ON CONFLICT (job_id, tool_use_id) DO NOTHING` (idempotent on replay).
2. After `toolDef.execute(...)`: either `persistToolExecComplete` (line 664-676) or `persistToolExecFailed` (line 678-696, INSERT-or-UPDATE).

The `subagent_messages` row for the assistant turn is persisted BEFORE tool dispatch (line 421-431) so replay sees a consistent state.

### Replay reconciliation (line 235-313)

On resume after crash: load all prior messages + tool executions. If the last persisted message is an assistant with `tool_use` blocks AND no subsequent user message is present, the worker crashed mid-dispatch. Walk every `tool_use`:

- Prior `complete`: synthesize `tool_result` from `prior.output`.
- Prior `failed`: synthesize error `tool_result`.
- Prior `pending` + `idempotent: true`: re-execute (every v0.15 brain tool is idempotent — `brain-allowlist.ts:228`).
- Prior `pending` + non-idempotent: throw (line 282) — refuse to re-run.
- No prior row: dispatch fresh.

Then persist the synthesized user turn (line 304-310) so the next resume sees consistent state.

### Dual-signal abort

Loop checks `ctx.signal.aborted || ctx.shutdownSignal.aborted` at every iteration (line 324, 453). The Anthropic call passes `mergeSignals(ctx.signal, ctx.shutdownSignal)` (line 370-371, `AbortSignal.any` polyfilled at line 713-725). `ctx.signal` fires on timeout/cancel/lock-loss; `ctx.shutdownSignal` fires only on worker process SIGTERM/SIGINT (`worker.ts:625-657`). Most handlers ignore `shutdownSignal` and use the 30s drain; the subagent handler honors it because long LLM calls would block the deploy restart otherwise.

### Anthropic prompt caching (line 346-368)

`system: [{type:'text', text: systemPrompt, cache_control: {type:'ephemeral'}}]` caches the system prompt; `tools` array caches ONLY the last tool def (`if (i === toolDefs.length - 1) def.cache_control = {type:'ephemeral'}` — Anthropic treats `cache_control` as "cache everything up to and including this block").

### v0.30.2 `prompt_too_long` UnrecoverableError (line 372-385)

`isPromptTooLongError(err)` (line 753-774) detects two shapes: `/prompt is too long/i` substring match on `err.message` or `err.error?.message`; OR `status === 400` with `err.error.type === 'invalid_request_error' | 'request_too_large'` AND phrase like "too long | exceed | maximum". When matched, rethrown as `UnrecoverableError(...)` so the worker (`worker.ts:698-706`) routes the job straight to `dead` on first attempt instead of stalling three times before dead-lettering. `gbrain doctor` `queue_health` check surfaces these via `last_error` matching.

### Model resolution (line 155-167)

If `data.model` is non-Anthropic, throws Layer 2 of the v0.31.12 enforcement (defense-in-depth even after queue's Layer 1). Otherwise: `await resolveModel(engine, {tier: 'subagent', configKey: 'models.subagent', fallback: TIER_DEFAULTS.subagent})`.

---

## 6. Rate leases (`src/core/minions/rate-leases.ts`)

Counter-based limiters leak capacity when a worker crashes mid-call; leases are owner-tagged rows in `subagent_rate_leases` with `expires_at` so crash recovery is free.

### `acquireLease(engine, key, ownerJobId, maxConcurrent, opts)` (line 67-107)

Two-phase atomic acquire:
1. `pg_advisory_xact_lock(hashKey(key))` (line 80) — txn-scoped, FNV-1a hashed to int64 (line 40-52). Released on commit/rollback.
2. `DELETE FROM subagent_rate_leases WHERE key=$1 AND expires_at <= now()` — pre-prune stale leases so a crashed owner's lease counts as zero on the next try.
3. `count(*)` for the key. If `>= maxConcurrent`, return `{acquired: false, ...}`.
4. INSERT new lease tagged `owner_job_id` with TTL (default 120s). FK CASCADE on `minion_jobs` ensures any out-of-band job DELETE drops the lease too.

### `renewLeaseWithBackoff(engine, leaseId, ttlMs)` (line 139-152)

Retries with delays `[0, 250, 500, 1000]`. If `renewLease` returns false (lease was pruned), exits immediately — caller must abort. If the DB throws, falls through to next delay. After all 4 attempts, returns false.

### Default key + cap

Subagent handler uses `'anthropic:messages'` (line 56) with `GBRAIN_ANTHROPIC_MAX_INFLIGHT` (default 8). On `acquired: false`, handler throws `RateLeaseUnavailableError` (line 732-737) which the worker treats as a renewable error — job goes back to `delayed` with backoff, NOT terminal fail.

---

## 7. Brain-tool allow-list (`src/core/minions/tools/brain-allowlist.ts`)

13 names as of v0.29 (line 47-66). Read-only: `query`, `search`, `get_page`, `list_pages`, `file_list`, `file_url`, `get_backlinks`, `traverse_graph`, `resolve_slugs`, `get_ingest_log`, `get_recent_salience`, `find_anomalies`. Conditional write: `put_page` (namespace-enforced).

`get_recent_transcripts` is deliberately excluded (line 59-63): every subagent call has `ctx.remote === true` and the v0.29 trust gate on that op rejects remote callers — adding it would always reject and look like a bug. Cycle synthesize phase calls `discoverTranscripts` directly instead.

### Tool-name shape (line 69-77)

Anthropic constraint: `^[a-zA-Z0-9_-]{1,64}$` — no dots. `sanitizeToolName` prefixes with `brain_` and replaces non-conforming chars; throws at load if it doesn't match (line 218-220).

### put_page schema branching (line 110-134)

`namespacedPutPageSchema(op, subagentId, allowedSlugPrefixes?)`:
- Default: adds `pattern: ^wiki/agents/<subagentId>/.+` to slug schema.
- v0.23 trusted: ditches regex (globs don't fit JSONSchema cleanly); describes prefix list to the model. The authoritative check is server-side.

### OperationContext shape (line 178-197)

`viaSubagent: true` (FAIL-CLOSED — put_page enforces namespace), `remote: true` (matches MCP trust boundary so auto-link is skipped unless `allowedSlugPrefixes` set), `subagentId`, `jobId`, `brainId`, `allowedSlugPrefixes`.

Sibling: `src/mcp/tool-defs.ts` (`buildToolDefs(ops)`) emits the identical shape for the MCP server. `test/mcp-tool-defs.test.ts` pins byte-for-byte equivalence.

---

## 8. Plugin loader (`src/core/minions/plugin-loader.ts`)

`GBRAIN_PLUGIN_PATH` is colon-separated absolute paths (like `$PATH`). Each path: a directory containing `gbrain.plugin.json` + a `subagents/` subdir of `*.md` files.

### Strict path policy (`rejectIfNotAbsolute`, line 132-143)

Rejects: remote URLs (`^[a-z][a-z0-9+.-]*://`), `~`-prefixed paths, relative paths. Non-existent paths logged + skipped (don't fail worker startup). `loadSinglePlugin` validates `subagents` field doesn't escape via `../`: `subagentsDir.startsWith(rootDir + path.sep) || subagentsDir === rootDir` (line 184-186).

### Manifest shape

```
{ name, version, plugin_version: "gbrain-plugin-v1", subagents?: "subagents", description? }
```

`SUPPORTED_PLUGIN_VERSION = "gbrain-plugin-v1"` (line 37). Unknown versions rejected.

### DEFS-only constraint

Plugins ship subagent *definitions* only. They cannot declare new tools, cannot extend the allow-list, cannot override agent-safe flags. `allowed_tools` in subagent frontmatter MUST subset the derived registry — validated at load time against `validAgentToolNames` (passed by `jobs.ts:1133-1136`, built from `BRAIN_TOOL_ALLOWLIST` with `brain_` prefix). Validation throws an `error` field so worker startup fails loudly instead of silently disabling a tool.

### Collision policy (line 109-119)

Left-to-right wins (PATH semantics). Warning to stderr names both sides. Plugin-load is non-fatal: warnings collected; worker keeps starting.

### `openclaw.plugin.json` (this repo)

Bundle plugin manifest, NOT a `gbrain-plugin-v1`. Shape: `{name, version, family: 'bundle-plugin', configSchema, mcpServers, skills[], shared_deps[], excluded_from_install[], openclaw.compat.pluginApi}`. This is the OpenClaw bundle/skillpack format, not the subagent plugin contract — different file, different consumer.

---

## 9. Aggregator (`src/core/minions/handlers/subagent-aggregator.ts`)

Claims AFTER all children resolve. The queue layer guarantees this: every terminal child transition (complete/failed/dead/cancelled/timeout) emits a `child_done` message (`queue.ts:414-430, 608-624, 680-696, 778-793, 884-900`) AND flips the parent out of `waiting-children` once all kids are terminal.

### Read-from-inbox (line 43-100)

`messages = await ctx.readInbox()` (`queue.ts:1110-1125` — token-fenced; marks `read_at = now()`). Build `Map<child_id, ChildDoneMessage>`. Walk `expectedIds` (preserves order from `data.children_ids`). Missing children become `outcome: 'failed'` with `error: 'no child_done message observed in inbox'` — honest about what's known.

### Deterministic mixed-outcome summary (line 134-160)

Markdown shape: header → totals → per-child sections. Each child section: `## child <id> (<job_name>) — <outcome>` + optional `> error` + JSON-fenced `result` for completed children. No LLM call in v0.15 (line 18-21) so fan-out runs are reproducible. v0.16+ will add LLM synthesis.

### `summary` shape (line 104-106)

`{complete, failed, dead, cancelled, timeout}` initialized to all zeros so log output is consistent regardless of outcomes seen.

---

## 10. Audit trails (JSONL, ISO-week rotation)

All three audit modules share the pattern: ISO-week filename, append to `~/.gbrain/audit/<prefix>-YYYY-Www.jsonl`, override dir via `GBRAIN_AUDIT_DIR`, best-effort writes (failure to stderr without blocking).

### Shell submission audit (`shell-audit.ts`)

`logShellSubmission({caller, remote, job_id, cwd, cmd_display, argv_display})` (line 59-75). `cmd_display` truncated to 80 chars. NEVER logs `env` values (may contain secrets). `cmd` text MAY contain inline tokens (`curl -H 'Authorization: Bearer ...'`); the guide explicitly tells operators to put secrets in `env:` instead.

Filename: `shell-jobs-YYYY-Www.jsonl`. `computeAuditFilename` (line 37-49) implements proper ISO-8601 week numbering — 2027-01-01 is W53 of year 2026, not W1 of 2027.

Wired from CLI: `jobs.ts:285-298` after every `gbrain jobs submit shell`.

### Subagent submission + heartbeat audit (`subagent-audit.ts`)

Two event types:
- `submission` (line 24-34): `{ts, type:'submission', caller, remote, job_id, parent_job_id?, model, tools_count, allowed_tools[]}`. Emitted from `subagent.ts:188-196` at handler entry.
- `heartbeat` (line 36-50): `{ts, type:'heartbeat', job_id, event, turn_idx, tool_name?, ms_elapsed?, tokens?, error?}`. Events: `llm_call_started | llm_call_completed | tool_called | tool_result | tool_failed`. Emitted at every turn boundary so `gbrain agent logs --follow` has fresh content during 30-second model calls. Never logs prompts or tool inputs (PII risk). DOES log non-identifying operational fields (tokens, duration, model, tool_name).

`error` field trimmed to 200 chars in `logSubagentHeartbeat` (line 86-90).

`readSubagentAuditForJob(jobId, {sinceIso})` (line 98-132) reads current + prior week files, filters by job_id, returns chronological order. Used by `gbrain agent logs <job>` (`agent-logs.ts:14, 71`).

### Backpressure audit (`backpressure-audit.ts`)

`logBackpressureCoalesce({queue, name, waiting_count, max_waiting, returned_job_id})` (line 60-77). Filename: `backpressure-YYYY-Www.jsonl`. Fired one line per `maxWaiting` coalesce event in `queue.ts:170-178`. Math duplicated rather than re-imported from shell-audit so the two best-effort surfaces stay independently rewritable (line 33-39).

---

## Drift from CLAUDE.md

1. **`logBackpressureCoalesce` parameter shape.** CLAUDE.md says the audit logs `(queue, name, waiting_count, max_waiting, returned_job_id, ts)` — code at `backpressure-audit.ts:60-66` adds a sixth field `decision: 'coalesced'` (literal const) before the ts. Future-proofing for additional decision kinds; CLAUDE.md predates the field.

2. **`MinionWorkerOpts.maxStalledCount`.** Field exists in the type (`types.ts:161`, default 1 at `worker.ts:93`) but the worker no longer reads it — the schema-default `max_stalled = 5` per-row is authoritative. Dead field on the public type.

3. **`SubagentHandlerData.brain_id` status.** CLAUDE.md describes v0.19+ connected-brains as a real feature. Code at `types.ts:425-438` and `brain-allowlist.ts:144-156` is explicit that `brain_id` is "PR 0 plumbing only" — stamped onto every tool call's `OperationContext.brainId` for audit, but `ctx.engine` is still the parent engine until "PR 1" wires `BrainRegistry.getBrain(brainId).engine`. The user-facing CLI doesn't expose a `--brain` flag for `gbrain agent run` yet.

4. **PROTECTED_JOB_NAMES count drift in CLAUDE.md.** CLAUDE.md describes the set as just `'shell'` in older v0.14-era passages and `'shell' + 'subagent' + 'subagent_aggregator'` in newer ones. Code (`protected-names.ts:15-23`) has all three.

5. **`autopilot.ts` "5 consecutive crashes" gate.** Not described in CLAUDE.md's autopilot summary. Code at `autopilot.ts:189-192` exits the autopilot supervisor entirely after 5 consecutive crashes within the 5-min stable-run reset window. The sibling `MinionSupervisor` uses `maxCrashes: 10` by default (`supervisor.ts:101`). Two parallel respawn loops with different thresholds — both correct, but worth knowing.

6. **`cancelJob` recursive depth cap.** `queue.ts:382` caps the recursive descendant walk at depth 100 — protects against a malicious cycle but isn't called out in CLAUDE.md.

7. **MaxAttachmentBytes default.** CLAUDE.md doesn't pin the value; code defaults to 5 MiB (`queue.ts:32`). `MinionQueueOpts.maxAttachmentBytes` overrides at construction.

8. **`MinionWorker.constructor` validation.** Worker throws at construction when `stallExitAfterMs <= stallWarnAfterMs` (`worker.ts:110-116`) — a contract noted in CLAUDE.md only obliquely as "must be > stallWarnAfterMs."

9. **`worker.ts` "engine ownership" matches CLAUDE.md.** CLAUDE.md correctly notes that `MinionWorker.start()` no longer disconnects the engine (v0.28.1 fix). The corresponding CLI handler at `jobs.ts:719-731` wraps `worker.start()` in try/finally and calls `engine.disconnect()` in the finally — matches the description.
