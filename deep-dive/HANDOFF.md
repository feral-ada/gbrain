# Handoff: GBrain deep-dive

**Date:** 2026-05-12.

Paste this doc into a fresh Claude Code session to bring it up to speed on
the gbrain deep-dive and what the user is doing next.

## Where the deep-dive lives

- **Repo:** `feral-ada/gbrain`
- **Branch:** `claude/explore-repo-analysis-38beg`
- **Commit:** `a39e339` — "docs: add 10-instance deep-dive analysis of gbrain codebase"
- **Path:** `deep-dive/` (10 markdown files, 246 KB total)
- **Local clone on the gbrain-side host:** `/home/user/gbrain`

`deep-dive/00-overview.md` is the entry point. It points at the 9 topic
reports:

```
deep-dive/
  00-overview.md            entry point — read this first
  01-foundation.md          ethos, vibe, philosophy
  02-architecture-core.md   ops contract, engines, migrations, trust boundary
  03-ai-search-retrieval.md AI gateway, recipes, hybrid search, cross-modal eval
  04-cycle-dream-hot-memory 11-phase cycle, synthesize, patterns, hot memory
  05-minions.md             job queue, subagents, zombie defense
  06-mcp-and-http.md        stdio + HTTP MCP, OAuth 2.1, admin SPA, thin-client
  07-commands-catalog.md    every CLI command with flags
  08-skills.md              skills system, resolver, skillpack, routing eval
  09-tests-ci-scripts.md    test tiers, CI gates, scripts, version mgmt
```

The deep-dive was produced by ten Claude instances reading gbrain at
VERSION `0.32.0`. Treat it as the canonical record of "what gbrain is"
through that version.

## What gbrain is (in one paragraph)

GBrain is a Postgres-native personal knowledge brain. Single Bun-compiled
binary that is simultaneously a CLI (~75 commands), an MCP server (stdio +
HTTP), and a library, plus ~42 fat-markdown skills that teach an agent how
to use it. Two engines: PGLite (Postgres 17.5 in WASM, zero-config default)
and PostgresEngine (Supabase or self-hosted). The contract is one big
`Operation` record file (`src/core/operations.ts`) that drives every
transport. Trust pivots on `OperationContext.remote: boolean` (REQUIRED in
TypeScript, fail-closed comparisons). The maintenance loop is `runCycle` —
eleven phases shared across `gbrain dream`, the autopilot daemon, and the
Minions job handler. Quality is gated by a cross-modal eval (three
different-provider frontier models score every output). Thin-client mode
(v0.31) deploys the stack as a remote team brain.

## What the user is doing next

Building `feral-ada/LM-liquid-metal` — a private runtime that uses **GitHub
as its execution substrate.** Currently slim. The user wants gbrain's
findings to inform LM-liquid-metal's shape.

Workflow: two parallel Claude Code sessions.
- One session has access to the gbrain repo (and the deep-dive at
  `deep-dive/`).
- One session has access to `feral-ada/LM-liquid-metal`.
- The user brokers context between them.

## How each session should use this doc

**The LM-liquid-metal session** treats this doc as starting context. It
already knows the deep-dive exists and what's in it. When the user pastes
specific deep-dive sections (or a topic report) the LM session can pair
those findings against LM's actual code. Use the pattern tiers below as
the framework for "what to apply / what to skip / what to avoid."

**The gbrain session** is where the deep-dive content lives. If the user
asks for excerpts from a topic report, read from
`/home/user/gbrain/deep-dive/<NN>-*.md` and paste back exactly what's
needed. Don't re-read the whole gbrain codebase to rederive findings the
deep-dive already captured.

## Pattern tiers (substrate-agnostic findings from gbrain)

**Tier A — almost certain to transfer regardless of LM's shape:**

- Contract-first operations: one record drives every transport. Compiler-
  enforced trust field (`OperationContext.remote`). See `02-architecture-core.md`.
- Fail-closed trust comparisons at pivot sites: `ctx.remote === false` for
  trusted-only, `!== false` for untrust-unless-explicit-false. See `02` + `06`.
- Failure-first test logging: per-shard fail block written to a known path,
  loud stderr banner with absolute path, survives `| head` / `| tail`. See `09`.

**Tier B — transfers cleanly if LM touches that surface:**

- Multi-tier model resolution chain (8 tiers) with `models doctor` startup
  probe — relevant if LM makes LLM calls. See `03`.
- Three-layer subagent provider enforcement (queue reject + runtime fallback
  + doctor warn) — relevant if LM spawns tool-loops. See `05`.
- Two-phase tool persistence + replay reconciliation — relevant if jobs can
  crash mid-execution. For GitHub substrate the persistence layer could be
  an issue/PR body, an Action artifact, or a state file in the repo. See `05`.
- OAuth 2.1 RFC-to-the-section compliance (F1-F15 hardening checklist) —
  relevant if LM exposes an HTTP MCP surface. See `06`.

**Tier C — gbrain-specific, probably DON'T copy:**

- PGLite/Postgres engine factory (wrong abstraction for GitHub substrate).
- Forward-reference schema bootstrap (specific to gbrain's migration history).
- `~/.gbrain` global state directory (LM should keep state per-repo).

**Tier D — pitfalls from gbrain's history worth checking against LM:**

- **Doc drift as a bug class.** Auto-generate any doc that enumerates code
  surface (op counts, phase counts, method counts) from the code itself.
  Hand-maintained indexes lie within months.
- **JSON double-encode** (gbrain v0.12.0 + v0.31.3, recurred). Decide
  encoding ONCE at the wire; never re-encode at write sites.
- **Silent empty-results in remote / thin-client mode** (gbrain v0.31.1).
  Audit every code path for "what does this do when the backend is empty?"
  up front. Gbrain shipped 25 silent-empty-result commands before catching
  the class.
- **Phantom model IDs that silently no-op** (gbrain v0.31.12). Probe every
  model on startup. Classify failures into `{model_not_found, auth,
  rate_limit, network, unknown}`. Don't trust the config.
- **Multi-provider tool-loop abstraction is a footgun.** Pick one tool-loop
  provider. Anthropic, OpenAI, Gemini tool APIs are not equivalent (caching
  semantics, tool-result framing, loop termination signals all differ).

## State at handoff

- Pushed (commit `a39e339`): all 10 deep-dive files on the analysis branch.
- Not pushed: any LM-side analysis. The LM-liquid-metal session will
  produce that against its own code with this doc + relevant deep-dive
  excerpts as input.
- Open question: where the eventual cross-reference report lives. Default
  is `deep-dive/10-lm-cross-reference.md` on the gbrain analysis branch,
  but the LM-liquid-metal repo itself is more natural once LM matures.
  Decide when there's something concrete to write.
