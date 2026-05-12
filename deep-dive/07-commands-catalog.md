# Instance 7 — Commands & CLI surface

## 1. cli.ts dispatch model

`src/cli.ts:43` `main()` is the single entrypoint.

1. **Global flag parser** — `parseGlobalFlags` (`src/core/cli-options.ts:46`) strips `--quiet`, `--progress-json`, `--progress-interval=<ms>`, `--timeout=<ms|s|m>` from argv BEFORE the subcommand is read. Result stashed via `setCliOptions()` (`cli-options.ts:159-167`) so any bulk command later reads it via `getCliOptions()`. Helper `childGlobalFlags()` (`cli-options.ts:186`) propagates flags to subprocesses.
2. **Built-ins** short-circuit at `cli.ts:53-67`: `--help`, `-h`, `version`, `--tools-json` (`commands/tools-json.ts`).
3. **DX alias**: `ask` → `query` (`cli.ts:73`).
4. **Per-command --help**: `printOpHelp` (`cli.ts:1341`) for shared ops, `printCliOnlyHelp` (`cli.ts:188`) for CLI-only commands not in `CLI_ONLY_SELF_HELP` (`cli.ts:34-41`).
5. **`CLI_ONLY` set** (`cli.ts:30`) enumerates ~75 commands that bypass the shared-operation layer and route through `handleCliOnly` (`cli.ts:692`). The shared-op path (used by get/put/list/search/tags/timeline/etc.) calls `op.handler(ctx, params)` and JSON-round-trips the result for renderer parity (`cli.ts:166-170`).
6. **Thin-client routing seam** (`cli.ts:145-157` for shared ops; `cli.ts:692-702` for CLI-only): `isThinClient(cfg)` triggered when `~/.gbrain/config.json` has `remote_mcp` set. `localOnly` shared ops → `refuseThinClient` (`cli.ts:678`) with the pinpoint-hint table at `cli.ts:655-670`. Routable shared ops → `runThinClientRouted` (`cli.ts:212`) → `callRemoteTool` + `unpackToolResult` + the SAME `formatResult` the local path uses. Default timeout 30s (180s for `think`); `--timeout=Ns` overrides. DB-bound CLI-only commands in `THIN_CLIENT_REFUSED_COMMANDS` (`cli.ts:631-643`) are refused outright. `doctor` is intentionally NOT in this set — thin-client doctor routes to `runRemoteDoctor` (`cli.ts:847-857`).
7. **No-DB bypasses** inside `handleCliOnly`: `init`, `auth`, `remote`, `upgrade`, `post-upgrade`, `check-update`, `integrations`, `providers`, `resolvers`, `integrity`, `publish`, `check-backlinks`, `frontmatter`, `lint`, `check-resolvable`, `mounts`, `routing-eval`, `skillify`, `skillpack`, `friction`, `claw-test`, `report`, `apply-migrations`, `repair-jsonb`, `skillpack-check`, `smoke-test` (`cli.ts:704-844`). Three special no-DB eval cases: `eval cross-modal` (`cli.ts:920-923`), `eval takes-quality replay` (`cli.ts:931-934`), `eval longmemeval` (`cli.ts:939-943`) — exit before `connectEngine()`.
8. **`doctor` and `dream`** open the engine in try/catch so filesystem checks run when the DB is unreachable (`cli.ts:858-877`, `cli.ts:896-913`).
9. **Engine connect** for everything else: `connectEngine()` (`cli.ts:1255`) → `loadConfig()` → `configureGateway(buildGatewayConfig(cfg))` → `createEngine(toEngineConfig(cfg))` → `connectWithRetry` → `hasPendingMigrations` probe → `engine.initSchema()` if needed → `loadConfigWithEngine(merged)` → `reconfigureGatewayWithEngine(engine)` to re-stamp tier-resolved chat/expansion model. `--no-retry-connect` / `GBRAIN_NO_RETRY_CONNECT=1` skip retry.
10. **OperationContext build** (`makeContext`, `cli.ts:489`): resolves `sourceId` via `resolveSourceId(engine, explicit)` (6-tier chain), sets `remote: false` (local CLI trusted), threads `cliOpts` from the singleton.
11. **Result rendering** (`formatResult`, `cli.ts:520`): custom renderers for `get_page`, `list_pages`, `search`, `query`, `get_tags`, `get_stats`, `get_health`, `get_timeline`, `get_versions`; default → pretty JSON.
12. **Engine teardown**: every CLI-only branch except `serve` and `autopilot` calls `engine.disconnect()` in finally (`cli.ts:1211-1213`).

## 2. Command catalog

### Setup, identity, upgrade

| command | flags | description | load-bearing call |
|---|---|---|---|
| `init` | `--pglite`, `--supabase`, `--mcp-only`, `--url`, `--key`, `--path`, `--migrate-only`, `--force`, `--non-interactive`, `--json` + model overrides | Create a brain (PGLite default; `--mcp-only` thin-client). | `runInit` (`commands/init.ts:13`) → `engine.initSchema()` + `saveConfig()` |
| `migrate --to <pglite\|supabase>` | `--to`, `--from`, `--no-embed`, `--dry-run` | Bidirectional engine migration; copies pages + chunks + embeddings. | `runMigrateEngine` (`commands/migrate-engine.ts:77`) |
| `check-update` | `--json` | Probe GitHub releases for a newer version. | `runCheckUpdate` (`commands/check-update.ts:120`) |
| `apply-migrations` | `--yes`, `--non-interactive`, `--force-retry <v>`, `--dry-run`, `--json` | Run the orchestrated migration ledger. | `runApplyMigrations` (`commands/apply-migrations.ts:276`) |
| `repair-jsonb` | `--dry-run`, `--json` | Repair v0.12.0 double-encoded JSONB rows. PGLite no-ops. | `runRepairJsonbCli` (`commands/repair-jsonb.ts:143`) |

`upgrade` / `post-upgrade` / `auth` / `remote` / `serve` / `serve-http` are Instance 6.

### Sync, import, export, embed, extract

| command | flags | description | load-bearing call |
|---|---|---|---|
| `sync` | `--repo`, `--watch`, `--interval N`, `--dry-run`, `--full`, `--no-pull`, `--no-embed`, `--skip-failed`, `--retry-failed`, `--all`, `--workers N`, `--source` | Git→brain incremental sync. `--all` iterates every source. `gbrain-sync` writer-lock. | `runSync` (`commands/sync.ts:1069`) → `performSync` (same:282) |
| `import <dir>` | `--no-embed`, `--workers N` | Bulk-import a markdown dir. Resumable via checkpoint. | `runImport` (`commands/import.ts:37`) |
| `export` | `--dir`, `--restore-only`, `--repo`, `--type`, `--slug-prefix` | Export brain to markdown; `--restore-only` repopulates missing `db_only`. | `runExport` (`commands/export.ts:11`) |
| `embed` | `<slug>` OR `--all` OR `--stale` OR `--slugs ...`, `--dry-run` | Generate/refresh OpenAI embeddings. | `runEmbed` (`commands/embed.ts:94`) → `engine.upsertChunks` + `embedBatch` |
| `extract <links\|timeline\|all>` | `--source fs\|db`, `--type T`, `--since DATE`, `--dry-run`, `--json` | Extract knowledge-graph edges. | `runExtract` (`commands/extract.ts:355`) → `engine.addLinksBatch`/`addTimelineEntriesBatch` |
| `reconcile-links` | `--dry-run`, `--json` | Recompute doc↔impl edges for markdown citing code files. | `runReconcileLinksCli` (`commands/reconcile-links.ts:159`) |
| `reindex-code` | `--source`, `--yes`, `--dry-run`, `--json` | Explicit code-page reindex with cost preview. | `runReindexCodeCli` (`commands/reindex-code.ts:243`) |
| `reindex-frontmatter` | `--repo`, `--dry-run`, `--json` | Alias for `gbrain backfill effective_date`. | `reindexFrontmatterCli` (`commands/reindex-frontmatter.ts:80`) |
| `backfill <kind\|list>` | sub-specific | Generic backfill dispatcher (v0.30.1). | `runBackfillCommand` (`commands/backfill.ts:117`) |

### Quality / health / hygiene

| command | flags | description | load-bearing call |
|---|---|---|---|
| `doctor` | `--json`, `--fast`, `--fix`, `--dry-run`, `--locks`, `--index-audit`, `--skills-dir` | Health check across resolver/skills/schema/RLS/embeddings/queue/sync_failures/migrations. | `runDoctor` (`commands/doctor.ts:406`) |
| `integrity` (subs: `check\|auto\|review\|extract`) | `--confidence`, `--review-lower`, `--limit`, `--fresh`, `--skip-bare-tweet`, `--skip-urls`, `--type`, `--json` | Bare-tweet detection, dead-link detection, three-bucket repair. | `runIntegrity` (`commands/integrity.ts:193`) |
| `orphans` | `--json`, `--count`, `--include-pseudo` | Pages with zero inbound wikilinks. | `runOrphans` (`commands/orphans.ts:206`) → `engine.findOrphanPages` |
| `check-backlinks <check\|fix> [dir]` | `--dry-run` | Find/fix missing back-links across brain. | `runBacklinks` (`commands/backlinks.ts:227`) |
| `lint <dir\|file>` | `--fix`, `--dry-run` | Catch LLM artifacts, placeholder dates, bad frontmatter. | `runLint` (`commands/lint.ts:288`) |
| `features` | `--json`, `--auto-fix` | Scan brain usage; recommend unused features. | `runFeatures` (`commands/features.ts:216`) |
| `frontmatter <validate\|audit\|generate\|install-hook>` | sub-specific | Frontmatter audit + auto-generation + git pre-commit hook. | `runFrontmatter` (`commands/frontmatter.ts:31`) |
| `report` | `--type`, `--content`, `--brain-dir` | Save a timestamped report under `reports/`. | `runReport` (`commands/report.ts:16`) |
| `friction <log\|render\|list\|summary>` | `--severity`, `--phase`, `--message`, `--run-id`, `--redact`, `--json` | Append-only JSONL friction-log for claw-test loop. | `runFriction` (`commands/friction.ts:24`) |
| `claw-test` | `--scenario`, `--keep-tempdir`, `--list-agents`, `--live`, `--agent` | Scripted CI gate or live friction-discovery harness. | `runClawTest` (`commands/claw-test.ts:57`) |
| `notability-eval <mine\|review\|help>` | `--repo` + sub-specific | Sample paragraphs / hand-confirm tiers for the notability gate eval. | `runNotabilityEval` (`commands/notability-eval.ts:315`) |

### Search & graph

| command | flags | description | load-bearing call |
|---|---|---|---|
| `graph-query <slug>` | `--type`, `--depth N`, `--direction in\|out\|both`, `--json` | Edge-typed traversal. Thin-client routable. | `runGraphQuery` (`commands/graph-query.ts:69`) → `engine.traversePaths` |
| `code-def <symbol>` | `--lang`, `--json` | Find a symbol's definition. | `runCodeDef` (`commands/code-def.ts:91`) |
| `code-refs <symbol>` | `--lang`, `--json` | Find references; bypasses `DISTINCT ON (slug)`. | `runCodeRefs` (`commands/code-refs.ts:89`) |
| `code-callers <symbol>` | `--json` | Who calls this? | `runCodeCallers` (`commands/code-callers.ts:32`) |
| `code-callees <symbol>` | `--json` | What does this call? | `runCodeCallees` (`commands/code-callees.ts:26`) |

### Files & storage

| command | flags | description | load-bearing call |
|---|---|---|---|
| `files <list\|upload\|upload-raw\|sync\|verify\|mirror\|unmirror\|redirect\|restore\|clean\|signed-url\|status>` | `--page`, `--type`, `--no-pointer`, `--dry-run`, `--yes` | Pluggable file storage (S3 / Supabase / local) + .redirect.yaml. | `runFiles` (`commands/files.ts:45`) |
| `storage status` | `--repo`, `--json` | Storage tier status (db_tracked vs db_only). | `runStorage` (`commands/storage.ts:36`) |
| `publish <page.md>` | `--password`, `--out` | Shareable HTML; strips private data; optional AES-256. | `runPublish` (`commands/publish.ts:330`) |

### Config & integrations

| command | flags | description | load-bearing call |
|---|---|---|---|
| `config <show\|get\|set>` | — | Brain config CRUD over the DB-plane `config` table. | `runConfig` (`commands/config.ts:12`) |
| `integrations <list\|show\|status\|doctor\|stats\|test>` | sub-specific | Integration recipe management. SSRF guards on http checks. | `runIntegrations` (`commands/integrations.ts:854`) |
| `providers <list\|test\|env\|explain>` | sub-specific | AI provider/recipe inspection + reachability. | `runProviders` (`commands/providers.ts:53`) |
| `models [doctor\|help]` | `--json`, `--skip=<provider>` | Routing dashboard or 1-token reachability probe. v0.31.12. | `runModels` (`commands/models.ts:218`) |
| `resolvers <list\|describe>` | sub-specific | Inspect URL/X resolvers. | `runResolvers` (`commands/resolvers.ts:37`) |
| `mounts <add\|list\|remove>` | sub-specific | Manage `~/.gbrain/mounts.json` for additional brains. | `runMounts` (`commands/mounts.ts:354`) |

### Sources & pages

`sources` (`commands/sources.ts:485+`) dispatches 13 subcommands: `add`, `list`, `remove`, `rename`, `default`, `attach`, `detach`, `federate`, `unfederate`, `archive`, `restore`, `purge`, `archived`. Common flags: `--path`, `--url`, `--name`, `--federated`/`--no-federated`, `--yes`, `--confirm-destructive`, `--dry-run`, `--keep-storage`. `pages purge-deleted` (`runPages`, `commands/pages.ts:78`) is the operator escape hatch (`--older-than`, `--dry-run`, `--json`). `repos` is a DEPRECATED alias for `sources` (`cli.ts:1198-1208`).

### Eval / measurement

`eval` is a sub-dispatcher (`runEvalCommand`, `commands/eval.ts:23`):

| sub-subcommand | description |
|---|---|
| `eval` (bare) | Single-run IR metrics or A/B comparison via `runEval` from `core/search/eval.ts`. |
| `eval export` | Stream `eval_candidates` as NDJSON to stdout (schema_version 1). `runEvalExport` (`commands/eval-export.ts:109`). |
| `eval prune --older-than DUR` | Retention cleanup. Refuses without `--older-than`. `runEvalPrune` (`commands/eval-prune.ts:83`). |
| `eval replay --against FILE` | Replay captured NDJSON; set-Jaccard@k + top-1 stability + latency Δ. `runEvalReplay` (`commands/eval-replay.ts:350`). |
| `eval cross-modal` | Multi-model quality gate. NO-DB. Instance 3. |
| `eval longmemeval <dataset.jsonl>` | LongMemEval on in-memory PGLite. NO-DB. Instance 3. |
| `eval takes-quality <run\|trend\|regress>` | Sample takes, score with multi-model panel. `runEvalTakesQuality` (`commands/eval-takes-quality.ts:126`). |
| `eval takes-quality replay <receipt>` | Replay a receipt JSON without a brain. NO-DB. |

### Skills surface (Instance 8 owns deep dive)

`skillify` (subs: `scaffold`, `check`), `skillpack` (subs: `list`, `install`, `uninstall`, `diff`, `check`), `skillpack-check`, `check-resolvable`, `routing-eval`.

### Jobs / agents / autopilot (Instance 5 owns deep dive)

`jobs <submit|list|get|cancel|retry|delete|prune|stats|smoke|work|supervisor>`, `agent`, `agent-logs`, `autopilot`, `book-mirror`.

### Memory (Instance 4 owns deep dive)

`dream`, `salience`, `anomalies`, `transcripts recent`, `recall`, `forget`, `takes <list|search|add|update|supersede|resolve|scorecard|calibration>`, `think`.

### MCP / HTTP / OAuth (Instance 6 owns deep dive)

`serve`, `serve --http`, `auth <create|list|revoke|permissions|register-client|revoke-client|test>`, `upgrade`, `post-upgrade`, `remote <ping|doctor>`.

### Misc

| command | description | load-bearing call |
|---|---|---|
| `call <tool> '<json>'` | Raw MCP-tool invocation through the CLI. | `runCall` (`commands/call.ts:14`) |
| `smoke-test` | Run `scripts/smoke-test.sh` (8 checks with auto-fix). | `cli.ts:880-893` shells out |
| `tools-json` | Print MCP tool discovery JSON. | `printToolsJson` (`commands/tools-json.ts`) |

## 3. Bulk-progress reporter (`src/core/progress.ts`)

Every bulk command threads the same reporter. Public surface:

- `createProgress(opts)` (`progress.ts:437`) — mode resolution at `progress.ts:90`: `auto` → TTY ? `human-tty` (`\r`-rewriting) : `human-plain`; `json` → JSONL; `quiet` → silent. Always writes to **stderr** so stdout stays clean for `--json` payloads.
- `startHeartbeat(reporter, note, intervalMs=1000)` (`progress.ts:453`) — try/finally cleanup; used by single long-running queries (`orphans.ts`, `markdown_body_completeness` in `doctor.ts`, `repair-jsonb.ts`).
- `ProgressReporter` (`progress.ts:38`): `start(phase, total?)`, `tick(n?, note?)`, `heartbeat(note)`, `finish(note?)`, `child(phase, total?)`.
- **JSON event schema** stable from v0.15.2, additive only: `{event: "start"|"tick"|"heartbeat"|"finish"|"abort", phase: "<snake.dot.path>", ...}`.
- **Singleton signal coordinator** (`progress.ts:62-84`): one process-level SIGINT/SIGTERM handler emits `abort` events for live phases without swallowing the signal.
- **EPIPE defense** on both sync throws and stream `'error'` events.
- **Wiring pattern**: `createProgress(cliOptsToProgressOptions(getCliOptions()))`. Threaded through 14+ commands.
- **CI guard**: `scripts/check-progress-to-stdout.sh` fails the build if any new code writes `\r` progress to stdout.
- **Minion handlers** pass `job.updateProgress` as the `onProgress` callback (DB-backed primary progress channel for jobs).

## 4. Drift from CLAUDE.md

1. **`gbrain sync --install-cron`** is in the `cli.ts:1391` help-text block but `runSync` does NOT parse `--install-cron` — only `--watch`/`--interval`. The persistent-daemon path lives in `autopilot --install`.
2. **`gbrain ingest`** is referenced in several skill names but there is no `commands/ingest.ts`. The "ingest" surface is the `ingest` shared op in `src/core/operations.ts`.
3. **`gbrain auth` is registered twice** in `handleCliOnly` (`cli.ts:710-714` and `cli.ts:748-752`). First wins; dead code but drift.
4. **`gbrain models doctor` flag-order sensitivity**: `commands/models.ts:220` reads `args[1]` to detect the subcommand. `gbrain models --json doctor` is interpreted as the default subcommand.
5. **Thin-client subcommand routing** for `transcripts`/`storage`/`takes`/`sources` is wholesale refused via `THIN_CLIENT_REFUSED_COMMANDS`; per-subcommand routing is a v0.31.x follow-up TODO.
6. **Brain-axis (`--brain`)** routing described in CLAUDE.md is not a parsed top-level flag in `parseGlobalFlags`; resolved inside `connectEngine()`.
7. **Exit-code conventions**: `runFriction` and `runClawTest` `process.exit()` themselves; most other CLI-only commands let `await` return and rely on outer try/finally.
