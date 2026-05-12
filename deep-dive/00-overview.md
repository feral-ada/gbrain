# GBrain Deep-Dive: Synthesis

## What this deep-dive is

Ten Claude instances read gbrain at `/home/user/gbrain` (VERSION 0.32.0) with a long context window; nine wrote topic reports, this is the synthesis. Read 00 first, then dip into 01-09 by interest.

## The one-page picture of GBrain

GBrain is a Postgres-native personal knowledge brain. Single Bun-compiled binary that is simultaneously a CLI (~75 commands), an MCP server (stdio + HTTP), and a library, plus ~42 fat-markdown skills that teach an AI agent how to use it. README pitch: "your AI agent is smart but forgetful; gbrain gives it a brain." It is the production substrate behind the author's actual AI agents (quoted at 17,888 pages, 21 cron jobs autonomous) and sold as a mod for an agent platform (OpenClaw, Claude Code, Cursor, Codex). Recommended install is a one-liner pasted to an agent that clones, inits, loads ~30 skills in ~30 minutes.

The foundation is the `BrainEngine` interface with two implementations: **PGLiteEngine** (Postgres 17.5 in WASM, zero-config default) and **PostgresEngine** (postgres.js against Supabase or self-hosted). `gbrain migrate --to supabase|pglite` moves a whole brain between them, embeddings and all. The factory is 27 lines: dynamic-import so PGLite WASM never loads in a Postgres-only process. This seam is the line between "Postgres-required tool" and "2-second laptop brain."

Above the engine sits `src/core/operations.ts`, 61 contract-first `Operation` records driving both CLI and MCP server. Adding an op edits one file. `OperationContext.remote: boolean` is REQUIRED in TypeScript (v0.26.9). Four trust-pivot call sites use fail-closed comparison: `ctx.remote === false` for trusted-only, `ctx.remote !== false` for untrust-unless-explicit-false. The v0.26.9 HTTP MCP shell-job RCE lived in the field's absence.

Two orthogonal axes organise everything. **Brain** = which database (your `host` plus optional `mounts` of team brains). **Source** = which content repo inside one database (slugs are unique per source, not globally). Both resolve through the same 6-tier chain. Cross-brain queries are deliberately latent-space, the agent re-queries as needed.

The maintenance loop is the **dream cycle**, eleven phases (lint, backlinks, sync, synthesize, extract, patterns, recompute_emotional_weight, consolidate, embed, orphans, purge) sharing one `runCycle` primitive across `gbrain dream`, autopilot daemon, and the Minions handler. Background work runs on **Minions**: a Postgres-native BullMQ-inspired queue with FOR UPDATE SKIP LOCKED, three timeout layers, two-phase tool persistence for crash-resilient subagents, three layers of zombie defence (in-process SIGCHLD, tini-as-PID-1, container tini), and three layers of trust gating.

Quality is gated by **cross-modal eval** (v0.27.x): three different-provider frontier models score each output, pass requires every dimension mean at-least-7 and every model's min dimension at-least-5. The v0.31 **thin-client mode** (`gbrain init --mcp-only`) makes the stack deployable as a remote team brain: every op routes through MCP/OAuth, refusals carry pinpoint hints.

## The historical motion

117 versions in 35 days (v0.1.0 on 2026-04-05, v0.32.0 on 2026-05-10). ~3.3 versions per day on average.

**v0.1.0 was already substantial**: 25+ CLI commands, MCP server, 3-tier chunking, hybrid search with RRF, OpenAI embeddings, Postgres + pgvector HNSW, page versions, 6 fat-markdown skills. The project did not start small.

Inflection points, in order:

- **v0.7.0 (2026-04-11), PGLite default + bidirectional engine migration.** Most consequential single release. `gbrain init` defaulted to embedded WASM. The line between "Postgres-required" and "2-second laptop brain."
- **v0.10.0-0.11.0, Minions becomes an agent runtime.** Postgres-native queue, no Redis, depth caps, cascade-cancel via recursive CTE, idempotency keys, `child_done` inbox.
- **v0.12.0, "The graph wires itself."** Auto-link on every put_page. Typed relationships via deterministic regex, zero LLM calls. P@5 jumped 22% to 49% on the same corpus.
- **v0.15.0-0.16.0, AGENTS.md + durable subagents.** LLM loops that survive worker crashes via two-phase tool persistence + replay reconciliation.
- **v0.17.0, `gbrain dream`.** Maintenance cycle as first-class command. 6 phases at launch, 11 by v0.31.
- **v0.18.0-0.19.0, Multi-source brains + tree-sitter code chunking + Skillify loop.** Skills become a real dev loop with scaffolding, audits, routing eval.
- **v0.21.0-0.22.0, Code Cathedral II + source-aware ranking.** Call-graph edges, two-pass retrieval. Curated content outranks bulk via two-stage CTE that preserves HNSW.
- **v0.23.0, Dream synthesize + patterns.** Conversation transcripts become brain pages overnight.
- **v0.26.0, OAuth 2.1 + HTTP MCP + React admin SPA.** Production multi-agent. Followed by v0.26.5 destructive-guard, v0.26.6 schema parity gate, v0.26.7 test-isolation foundation, v0.26.9 OAuth hardening pass.
- **v0.27.0-0.32.0, Pluggable embedding providers.** Vercel AI SDK as the seam, 14 recipes by v0.32.
- **v0.31.0-0.31.1, Hot memory + thin-client mode.** Per-turn facts extraction with `_meta.brain_hot_memory` auto-injection; thin-client routing works for every op surface.

**Recurring bug classes** (the "fix waves") teach the system: JSONB double-encode (v0.12.0, v0.31.3), forward-reference schema bootstrap (10+ wedge incidents, finally killed v0.22.6.1), PGLite-vs-Postgres drift (closed v0.26.6 with a real parity-gate test), OAuth scope leaks (F1-F15 hardening pass), zombie process accumulation (v0.28.1 three-layer fix), silent thin-client empty-results (v0.31.1), Anthropic model ID 404s that silently no-op'd fact extraction (v0.31.12, with `gbrain models doctor` shipped as the structural probe).

**Contributors.** ~57 distinct human handles credited. The community-PR workflow is explicit: external PRs never merge directly. Maintainer cherry-picks into a "fix wave" collector branch, closes superseded PRs with thank-yous, ships one PR with `Co-Authored-By` trailers. v0.32.0 consolidated 17 community embedding PRs into 5 recipes plus docs.

**Velocity.** Last 7 days: 12 versions. Two-thirds features, one-third fix waves. Clear upward arc, not noodling.

## What's strong

1. **Contract-first operations.** One `Operation` record drives CLI + MCP + JSON schemas + scope enforcement + redaction + agent help. Adding an op edits one file.
2. **Trust-boundary discipline.** `OperationContext.remote` is REQUIRED in TS. Four call sites use explicit fail-closed comparison. The compiler catches transports that forget.
3. **Three-layer subagent provider enforcement.** Queue rejects non-Anthropic subagent submits, runtime falls back to Anthropic default, doctor warns at config time. The Anthropic tool-loop cannot accidentally route to OpenAI.
4. **Forward-reference schema bootstrap.** `applyForwardReferenceBootstrap()` probes for needed columns before replaying SCHEMA_SQL. Killed a bug class that bit 10+ times over 2 years. CI test fails if anyone adds a forward reference without extending the probe.
5. **Cross-engine schema parity gate.** `test/e2e/schema-drift.test.ts` initialises both engines and diffs `information_schema.columns`. Two-table allowlist; everything else must reach PGLite via the schema or a migration's `sqlFor.pglite` branch.
6. **Source-aware ranking without killing HNSW.** Two-stage CTE keeps the index usable; outer SELECT re-ranks. LIKE meta-character escape covers `%`, `_`, AND `\`. Single-quote SQL-literal doubling. Longest-prefix-match wins. Taste.
7. **Test isolation as a lint.** Four rules enforced by `scripts/check-test-isolation.sh` on every non-serial unit file. Allow-list must shrink, never grow.
8. **OAuth 2.1 compliance to the section level.** RFC 6749 §10.4/§10.5 (atomic DELETE...RETURNING with client_id), §6 (refresh scope subset checked against stored grant), §4.1.3 (redirect_uri rebind), RFC 7009 §2.1 (client-bound revoke), RFC 7591 §3.2.1 (numeric issued-at via `coerceTimestamp` that throws on NaN).
9. **Failure-first test logging.** `bun run test` writes per-shard failure blocks and emits a stderr banner with absolute log path. Survives `| head` and `| tail`. Distinguishes wedged shards from failed assertions.
10. **`runCycle` as a single primitive.** One file answers "what does my brain do overnight." PgBouncer-safe row-level lock, file-lock with PID-liveness on PGLite. Shared across cron, daemon, queue handler.

## What's not strong (be honest)

1. **Surface area is enormous.** ~75 commands, 61 ops, 11 cycle phases, 42 skills, 14 embedding providers, 4 model tiers, 5 test command tiers, 2 engines, 2 axes, 3 transports, 3 soft-delete states. The "thin-harness ~200 lines" rhetoric is at odds with the binary size and the cognitive load of operating it.
2. **CLAUDE.md is the index, not the truth, and it lags.** "~47 operations" is now 61. "9-phase cycle" doc-comment is two phases stale. "40 BrainEngine methods" is from pre-v0.18, reality is 79. `docs/architecture/infra-layer.md` reads as a v0.4 snapshot. README contradicts itself on skill count (29/34/42 in the same file).
3. **gbrain.yml + sources + brains overlap conceptually.** Three plausible mechanisms for "publish my essays separately" with different semantics and only-partial composition.
4. **3650 tests but the serial quarantine keeps growing in spirit.** The intra-file parallelism sweep has been a v0.26 follow-up for a while. `mock.module` files cannot be fixed without changing production code for testability.
5. **Multi-provider dependency surface.** OpenAI for default embeddings, Anthropic hard-required for the subagent tool-loop, optional Google/Voyage/Groq. Hot-memory fact extraction silently no-op'd for two releases because of one phantom model ID. `gbrain models doctor` is the structural answer but shipped after the bug.
6. **`~/.gbrain` global state.** Config, audit, friction, sync-failures, checkpoint, integrity log, integrations heartbeat, rollback, eval receipts, upgrade-errors, OAuth bootstrap, autopilot lock all live under one directory. `GBRAIN_HOME` exists but the production user has one global mutable directory.
7. **CLAUDE.md drift is its own bug class.** Every sub-report flagged 5-10 specific drifts. The aggregate becomes fiction that agents read as authoritative.
8. **No published BrainBench scores between v0.22 and now.** Hot memory injection, salience boost, recency decay, two-stage CTE, call-graph edges all landed since the v0.22 benchmark. The headline retrieval numbers have not been refreshed.

## What I would build next

1. **Refresh BrainBench and publish the numbers.** Same v0.22 corpus on v0.32 stack. Headline the v0.33 release with a real before/after.
2. **Auto-generate CLAUDE.md per-file annotations** from JSDoc + the operations array + the migrations registry. Same for the phase-order comment in `cycle.ts` (`// generated from ALL_PHASES`).
3. **One-line thin-client install.** Bootstrap-link flow for client provisioning ("scan this QR to claim a client") so team-brain deployment doesn't require pasting credentials.
4. **First-class image round-trip from screenshots.** Voyage multimodal is wired. The user-facing surface is `gbrain ingest screenshot.png` + a skill.
5. **Burn down the 75-file test-isolation allow-list with a codemod.** Mechanical `process.env = ...` to `withEnv(...)` rewrite plus canonical PGLite block application. Pays back every CI run thereafter.

## How to navigate this deep-dive

- **01-foundation.md** : Ethos, vibe, who it's for, "thin-harness fat-skills" essay summary.
- **02-architecture-core.md** : Operations registry, engine interface, migrations, SQL adapter, trust boundary.
- **03-ai-search-retrieval.md** : AI gateway, recipes, model tiers, embeddings, hybrid search, dedup, source-boost, cross-modal eval.
- **04-cycle-dream-hot-memory.md** : 11-phase cycle, synthesize, patterns, consolidate, emotional weight, anomalies, facts.
- **05-minions.md** : Queue state machine, locks, timeouts, subagent persistence, replay, plugins, audit JSONL, zombie defence.
- **06-mcp-and-http.md** : Stdio + HTTP MCP, OAuth 2.1, admin SPA, F1-F15 hardening, rate limiting, thin-client routing.
- **07-commands-catalog.md** : Every `gbrain X` subcommand with flags and call site. CLI reference.
- **08-skills.md** : Skills, resolver, skillpack, skillify, routing eval, filing audit, read/write skills-dir split.
- **09-tests-ci-scripts.md** : Test tiers, CI vs local, failure-first logging, pre-checks, isolation lint, local CI gate, version management.

## Sources of truth

- **5 minutes** : this overview.
- **30 minutes** : this + `01-foundation.md` + the topic report matching your interest.
- **2 hours** : all ten reports plus `git log --oneline | head -100` to see the velocity yourself.

CLAUDE.md is the index, not the truth. When in doubt, the code at `/home/user/gbrain` at VERSION 0.32.0 is the truth.
