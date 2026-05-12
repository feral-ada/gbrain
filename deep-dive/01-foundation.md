# 01 — Foundation & Vibe

This is Instance 1 of the 10-part GBrain deep dive. It covers what GBrain is,
who it's for, the design ethos, the two-axis brain × source mental model, the
pluggable engine story, and the release-cadence inflection points. Every
behavioral claim cites a file:line. A "Drift from CLAUDE.md" section at the
bottom lists what I couldn't verify.

Workspace: `/home/user/gbrain` at `VERSION` `0.32.0`
(`/home/user/gbrain/VERSION:1`).

---

## 1. What GBrain is — one paragraph

GBrain is a Postgres-native personal knowledge brain with hybrid RAG search,
shipped as a CLI + MCP server + library, plus a fat-skills bundle that teaches
an AI agent how to use it (`package.json:3`,
`/home/user/gbrain/README.md:1-9`). The headline framing in the README is "your
AI agent is smart but forgetful; GBrain gives it a brain"
(`README.md:3`). It is the production brain behind Garry Tan's OpenClaw and
Hermes deployments — quoted at "17,888 pages, 4,383 people, 723 companies, 21
cron jobs running autonomously" with an 11-day origin story
(`README.md:5`, `README.md:813-819`). GBrain is a mod for an agent platform
(OpenClaw, Hermes, Claude Code, Cursor) more than a stand-alone tool: the
recommended install path is to paste a one-liner into the agent and let the
agent clone, install, init the brain, load 34 skills, and configure cron jobs
in ~30 minutes (`README.md:23-37`). The licence is MIT, copyright 2026 Garry
Tan (`LICENSE:1-21`).

Positioning vs siblings: GStack teaches agents how to *code*; GBrain teaches
agents *everything else* — brain ops, signal detection, content ingestion,
enrichment, cron scheduling, reports, identity, access control
(`CLAUDE.md` repo intro; mirrored at `README.md:462-468`). The two repos are
designed to compose via `hosts/gbrain.ts`, the bridge that tells GStack's
coding skills to check the brain first (`README.md:466`).

---

## 2. Who it's for

Three concentric audiences, ordered from primary to tertiary:

1. **The agent** — every CLI surface is auto-JSON when stdout is not a TTY,
   `gbrain --tools-json` exposes the full op contract, and
   `INSTALL_FOR_AGENTS.md` is written as instructions *to* the agent
   (`INSTALL_FOR_AGENTS.md:1-5`, "Read this entire file, then follow the
   steps. Ask the user for API keys when needed.").
2. **The agent operator (i.e. the user)** — answers ~3 questions about API
   keys; otherwise the agent does the install and the maintenance
   (`README.md:37`, `INSTALL_FOR_AGENTS.md:34-44`).
3. **The contributor** — separate dev-loop documentation,
   `CONTRIBUTING.md`, and a contributor opt-in
   (`GBRAIN_CONTRIBUTOR_MODE=1`) to enable retrieval-eval capture without
   surprising production users (`CONTRIBUTING.md:195-235`).

The `AGENTS.md` file is the non-Claude-agent operating protocol. Claude
Code uses `CLAUDE.md` automatically; everyone else (Codex, Cursor, OpenClaw,
Aider, Continue) starts at `AGENTS.md` (`AGENTS.md:1-6`). It carries a
recommended read order: `AGENTS.md` → `CLAUDE.md` → `brains-and-sources.md`
→ `brain-routing.md` → `RESOLVER.md` (`AGENTS.md:17-27`).

---

## 3. The two-axis mental model: brain × source

`docs/architecture/brains-and-sources.md` is the canonical reference for the
two orthogonal axes that organise every query and every write
(`brains-and-sources.md:1-5`):

- **Brain — WHICH DATABASE.** A brain is one database (PGLite file,
  self-hosted Postgres, or Supabase). Each brain has its own `pages` table,
  embeddings, OAuth surface, lifecycle, backups, access control
  (`brains-and-sources.md:18-31`). Brains are enumerated as `host` (your
  default, in `~/.gbrain/config.json`) and `mounts` (additional brains
  registered in `~/.gbrain/mounts.json` via `gbrain mounts add <id>`,
  v0.19+) (`brains-and-sources.md:25-31`).
- **Source — WHICH REPO INSIDE THE DATABASE** (v0.18.0+). A source is a
  named content repo *inside* one brain. Every `pages` row carries a
  `source_id`. Slugs are unique *per source*, not globally — `topics/ai`
  can exist under `source=wiki` and `source=gstack` simultaneously and
  they're different pages (`brains-and-sources.md:34-42`).

Both axes follow the same 6-tier resolution chain
(`brains-and-sources.md:190-200`). For brain: `--brain <id>` →
`GBRAIN_BRAIN_ID` env → `.gbrain-mount` dotfile → longest-prefix mount path
match → reserved (`brains.default` v2) → `host`. For source: `--source <id>`
→ `GBRAIN_SOURCE` env → `.gbrain-source` dotfile → longest-prefix source
path match → `sources.default` config → `default`.

Rule of thumb: **if the data owner changes, it's a brain boundary; if the
data owner stays the same but the topic/repo changes, it's a source
boundary** (`brains-and-sources.md:55-56`).

The doc spells out four explicit topologies: single-person developer (one
brain, one source); personal brain with multiple repos (one brain, N
federated sources); personal + one team mount; CEO-class user mounting
several team brains, where each team brain is itself multi-source
(`brains-and-sources.md:60-188`). Cross-brain queries are **not
deterministic** in v0.19 — the agent sees the brain list and re-queries as
needed; latent-space federation is by design ("YOUR JOB, not the DB's,"
`brains-and-sources.md:184-186, 213-217`).

The two-repo split is a separate (orthogonal) concern: brain repo (world
knowledge: `people/`, `companies/`, `concepts/`, …) vs agent repo
(operational config: `SOUL.md`, `USER.md`, `skills/`, `cron/`)
(`docs/guides/repo-architecture.md:1-50`). The Hard Rule:
**never write knowledge to the agent repo**
(`repo-architecture.md:101-108`). GBrain only indexes the brain repo; the
agent repo is replaceable, the brain repo is permanent
(`repo-architecture.md:110-122`).

---

## 4. The thin-harness / fat-skills philosophy

Two ethos essays anchor the project's worldview, both signed by Garry Tan.

### THIN_HARNESS_FAT_SKILLS.md (April 2026)

The argument: the bottleneck for AI agent productivity is not model
intelligence; it's whether the model understands your schema
(`THIN_HARNESS_FAT_SKILLS.md:32`). Five definitions fit on an index card
(`THIN_HARNESS_FAT_SKILLS.md:31-80`):

1. **Skill File** — a reusable markdown procedure that teaches the model
   *how* to do something. Markdown is code.
   "A skill file is a method call. It takes parameters."
   (`THIN_HARNESS_FAT_SKILLS.md:38-46`)
2. **Harness** — the program that runs the LLM. Runs the model in a loop,
   reads/writes files, manages context, enforces safety. About 200 lines.
   That's the "thin." (`THIN_HARNESS_FAT_SKILLS.md:50-54`)
3. **Resolver** — a routing table for context. When task type X appears,
   load document Y first. (`THIN_HARNESS_FAT_SKILLS.md:58-64`)
4. **Latent vs. Deterministic** — every step is one or the other.
   "Latent space is where intelligence lives. Deterministic is where trust
   lives." Models hallucinate when forced to do deterministic work in
   latent space (the "seat 800 people" example).
   (`THIN_HARNESS_FAT_SKILLS.md:68-74`)
5. **Diarization** — the model reads everything about a subject and writes
   a structured profile. Not a SQL query, not RAG.
   (`THIN_HARNESS_FAT_SKILLS.md:78-80`)

Three layers: **fat skills on top, thin CLI harness in the middle (~200
lines), deterministic foundation underneath** (queryDB, readDoc, search,
timeline) (`THIN_HARNESS_FAT_SKILLS.md:84-92`). The agent decision guide at
the bottom (`THIN_HARNESS_FAT_SKILLS.md:187-209`) is the authoritative "skill
or code?" cheat sheet for contributors: lookups + status checks + same-input
same-output ⇒ code; needs judgment, asks questions, adapts ⇒ skill.

### MARKDOWN_SKILLS_AS_RECIPES.md (April 2026)

The "Homebrew for Personal AI" essay is the distribution corollary. If
skills are fat markdown, and models can implement from markdown, then
skills are distributable software. A skill file is simultaneously
documentation, specification, package, and source code — four artifacts
collapsed into one (`MARKDOWN_SKILLS_AS_RECIPES.md:153-162`). The package
is markdown, the runtime is a sufficiently smart model, the package
manager is your AI agent, the app store is a git repo
(`MARKDOWN_SKILLS_AS_RECIPES.md:184`).

Two enabling shifts (`MARKDOWN_SKILLS_AS_RECIPES.md:80-103`): context
windows hit a million tokens (a meeting-ingestion recipe with all
references is unrealistic at 8K, marginal at 128K, comfortable at 1M); and
models crossed the judgment threshold (Opus 4.6 can reliably interpret
"intelligence dossier crossed with a therapist's notes" vs "LinkedIn
scrape").

### HOMEBREW_FOR_PERSONAL_AI.md (design doc)

The 10-star vision for the integration system. Two primitives:
**senses** (data inputs: voice-to-brain, email-to-brain, X-to-brain,
calendar-to-brain) and **reflexes** (automated responses: meeting-prep,
entity-enrich, dream-cycle, deal-tracker)
(`HOMEBREW_FOR_PERSONAL_AI.md:13-37`). Recipe format is YAML frontmatter +
markdown body, with `requires:` declaring a dependency graph and
`health_checks:` running on `gbrain integrations doctor`
(`HOMEBREW_FOR_PERSONAL_AI.md:48-95`). Four key design decisions
(`HOMEBREW_FOR_PERSONAL_AI.md:139-155`):

1. GBrain is deterministic infrastructure; cross-sense correlation is the
   *agent's* job.
2. Agents ARE the runtime — no npm packages or Docker images, the recipe
   markdown IS the installer.
3. Very opinionated defaults — ship Garry's exact production setup.
4. Agent-readable outputs — every CLI has `--json`, the agent is the
   primary consumer.

### How the philosophy lands in the code

The architecture diagram in `docs/architecture/infra-layer.md` formalises
this: GBrain CLI is the thin harness (same input → same output), skills
(ingest/query/maintain/enrich/briefing/migrate/setup) are fat skills,
recipes (voice-to-brain, email-to-brain) are fat skills that install
infrastructure (`infra-layer.md:94-105`).

---

## 5. The engine pluggability story

GBrain abstracts every storage operation behind a `BrainEngine` interface
(`/home/user/gbrain/src/core/engine.ts`, the file is hundreds of lines of
pure interface — first ~150 are types `engine.ts:25-160`). Two production
implementations:

- **PGLiteEngine** (`src/core/pglite-engine.ts`, 3322 LOC) — embedded
  Postgres 17.5 compiled to WASM, zero-config default. The headline pitch:
  "your brain runs locally with zero infrastructure … same search quality
  as Supabase, same pgvector HNSW, same pg_trgm fuzzy matching, same
  tsvector full-text search. No server, no subscription. `gbrain init` and
  you're running in 2 seconds." (CHANGELOG v0.7.0,
  `/home/user/gbrain/CHANGELOG.md:8317-8319`).
- **PostgresEngine** (`src/core/postgres-engine.ts`, 3463 LOC) — postgres.js
  + pgvector against any real Postgres (Supabase Pro is the recommended
  managed option, but self-hosted works too). Suggested when the brain
  exceeds 1000 files (`README.md:48-49`, `INSTALL_FOR_AGENTS.md:46-50`).

The factory at `src/core/engine-factory.ts:1-27` is the surgical seam: a
single `createEngine(config)` function that *dynamically imports* the
selected engine — "Uses dynamic imports so PGLite WASM is never loaded for
Postgres users" (`engine-factory.ts:3-5`). Switch on `config.engine`
(`'pglite' | 'postgres'`); throws an actionable error for unknown values
including a redirect for `'sqlite'` (`engine-factory.ts:21-26`).

`gbrain migrate --to supabase|pglite` (`src/commands/migrate-engine.ts`,
referenced in `CLAUDE.md`) does bidirectional engine migration:
"Embeddings copy directly, no re-embedding needed" (CHANGELOG v0.7.0
`L8319`). This is the core "outgrow local without lock-in" promise
(`README.md:660-665`).

`docs/ENGINES.md` is the engine-author guide; `docs/SQLITE_ENGINE.md`
holds a reference design for a SQLite engine that is "designed and ready
for implementation" but not built (`CONTRIBUTING.md:191-193`).

The architectural payoff for end users: "PGLite: embedded Postgres, no
server, zero config. When your brain outgrows local (1000+ files,
multi-device), `gbrain migrate --to supabase` moves everything"
(`README.md:665`).

The architectural payoff for contributors: every public surface
(operations, search, embedding, sync) is one interface; tests can run
against PGLite in-memory without a Docker container
(`CONTRIBUTING.md:65-76`).

---

## 6. Architecture (data + control flow, in two paragraphs)

`docs/architecture/infra-layer.md` is the one-page systems diagram. The
ingest pipeline is: input → file resolution (local → `.redirect` →
`.supabase` → error) → markdown parser (gray-matter frontmatter, body,
compiled_truth + timeline split) → SHA-256 content hash idempotency → 3-tier
chunking (recursive 300w/50w-overlap, semantic with cosine similarity +
Savitzky-Golay smoothing, LLM-guided via Claude Haiku) → OpenAI
text-embedding-3-large (1536 dim) batch 100 with backoff → atomic DB
transaction → search available immediately (`infra-layer.md:7-28`).

Search is hybrid by RRF: optional Haiku query expansion → vector (HNSW
cosine) and keyword (tsvector ts_rank) in parallel → RRF merge
(score = Σ 1/(60 + rank)) → 4-layer dedup (best 3 chunks per page,
Jaccard > 0.85, no type > 60%, max 2 chunks per page) → top N
(`infra-layer.md:30-56`). The 10-table schema (pages, content_chunks,
links, tags, timeline_entries, page_versions, raw_data, files, ingest_log,
config) is documented at `infra-layer.md:78-92`. Title weighted A,
compiled_truth B, timeline C in tsvector.

The contract-first foundation: `src/core/operations.ts` defines every
operation; CLI and MCP server are both *generated* from the same source.
Adding an op means editing one file
(`CONTRIBUTING.md:170-182`). I count **60 operations** in the file at
v0.32.0 (verified via `grep -E "^  name: '"
/home/user/gbrain/src/core/operations.ts | wc -l` → 60 unique names).
Examples: `get_page`, `put_page`, `delete_page`, `restore_page`,
`purge_deleted_pages`, `list_pages`, `search`, `query`, `takes_list`,
`takes_search`, `takes_scorecard`, `takes_calibration`, `think`, `add_tag`,
`remove_tag`, `get_tags`, `add_link`, `remove_link`, `get_links`,
`get_backlinks`, `traverse_graph`, `add_timeline_entry`, `get_timeline`,
`get_stats`, `get_health`, `get_brain_identity`, `run_doctor`,
`get_versions`, `revert_version`, `sync_brain`, `put_raw_data`,
`get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`,
`get_ingest_log`, `file_list`, `file_upload`, `file_url`, `submit_job`,
`get_job`, `list_jobs`, `cancel_job`, `retry_job`, `get_job_progress`,
`pause_job`, `resume_job`, `replay_job`, `send_job_message`,
`find_orphans`, `get_recent_salience`, `find_anomalies`,
`get_recent_transcripts`, `whoami`, `sources_add`, `sources_list`,
`sources_remove`, `sources_status`, `extract_facts`, `recall`,
`forget_fact`. Trust boundary: `OperationContext.remote` distinguishes
trusted local CLI (`remote: false`) from untrusted MCP (`remote: true`);
the field is *required* in TypeScript so the compiler catches transports
that forget to set it (per `CLAUDE.md` v0.26.9 entry).

Public package exports map (`package.json:10-28`) commits to the surface
that downstream consumers (notably the sibling `gbrain-evals` repo) build
on: `gbrain` (entry), `./engine`, `./types`, `./operations`,
`./pglite-engine`, `./engine-factory`, `./minions`, `./link-extraction`,
`./import-file`, `./transcription`, `./embedding`, `./config`,
`./markdown`, `./backoff`, `./search/hybrid`, `./search/expansion`,
`./extract`. Removing any of these is a breaking change for downstream
consumers (`CLAUDE.md` "BrainBench — in a sibling repo" section).

---

## 7. Release-cadence inflection points (5–7 highlights, plus a few extras)

The CHANGELOG starts at `v0.1.0` (2026-04-05) and reaches `v0.32.0`
(2026-05-10) — 35 days, ~80 versioned releases (counting micro and
fixwave suffixes) (`CHANGELOG.md:5559, 8559`). The cadence is intense:
v0.1 → v0.32 in ~5 weeks. I picked the inflection releases — the ones
that introduced or repositioned a *capability class*, not just a fix:

1. **v0.7.0 (2026-04-11) — PGLite default + bidirectional engine migration.**
   "Your brain now runs locally with zero infrastructure" (PGLite, Postgres
   17.5 in WASM); `gbrain init` defaults to PGLite, suggests Supabase at
   1000+ files; `gbrain migrate --to supabase|pglite` is bidirectional with
   embeddings copied directly (`CHANGELOG.md:8315-8323`). This is the line
   between "Postgres-required tool" and "zero-config personal brain."

2. **v0.10.0 (2026-04-14) — Minions (job queue) + 24 skills.** A
   BullMQ-inspired Postgres-native job queue lands inside GBrain, with no
   Redis or external dependencies; same release jumps the skill count from
   8 to 24 by porting the production OpenClaw skill set
   (`CHANGELOG.md:8093-8101`). This is the pivot from "tool" to
   "agent runtime + opinionated skills."

3. **v0.12.0 (2026-04-18) — The graph wires itself.** "Your brain stops
   being grep." Every `put_page` extracts entity references and creates
   typed links (`attended`, `works_at`, `invested_in`, `founded`,
   `advises`) with zero LLM calls. New `gbrain graph-query` command;
   backlink-boosted hybrid search. The benchmark inflection: P@5 went from
   22.1% to 49.1% on the same corpus across v0.11 → v0.12
   (`CHANGELOG.md:7861-7868`, `README.md:7`, `README.md:543`).

4. **v0.16.0 (2026-04-20) — Durable subagents (`gbrain agent run`).** LLM
   loops survive crashes. Every Anthropic turn persists to
   `subagent_messages`; every tool call is a two-phase ledger row
   (`pending` → `complete | failed`). Replay on worker restart picks up
   from the last committed turn. Fan-out manifests + aggregator. This is
   "OpenClaw dies daily, gbrain agents do not" (`CHANGELOG.md:6876-6884`).

5. **v0.17.0 (2026-04-22) — `gbrain dream`** (the maintenance cycle as
   first-class command). 6-phase composable cycle in `runCycle`; lint →
   backlinks → sync → extract → embed → orphans, with autopilot and `dream`
   sharing the same primitive (`CHANGELOG.md:6531-6539`). Later expanded:
   v0.23 added `synthesize` + `patterns` (`CHANGELOG.md:4301-4309`); v0.29
   added `recompute_emotional_weight` and salience/anomalies; by v0.31 the
   cycle is 11 phases (lint → backlinks → sync → synthesize → extract →
   patterns → recompute_emotional_weight → consolidate → embed → orphans →
   purge) (`README.md:782-787`).

6. **v0.18.0 (2026-04-22) — Multi-source brains.** A single database can
   now hold many sources (`wiki`, `gstack`, `essays`, …); slugs are unique
   per source, not globally; per-source `federated=true|false` controls
   default cross-recall (`CHANGELOG.md:6430-6438`). The `sources` primitive
   is the foundation that v0.19+ "mounts" (multi-brain) builds on.

7. **v0.21.0 (2026-04-25) — Code Cathedral II.** Code becomes a graph (was
   first-class chunks in v0.19.0). Call-graph edges (callers, callees,
   parent scope), chunk-grain FTS replaces page-grain internally, two-pass
   retrieval. `gbrain code-callers`, `code-callees`, `code-def`,
   `code-refs`. 8 languages with structural edges, 165-language tree-sitter
   coverage (`CHANGELOG.md:5618-5626`). This is the moment GBrain becomes a
   serious GStack mod (`README.md:125-139`).

8. **v0.26.0 (2026-04-25) — Multi-agent MCP via OAuth 2.1 + admin
   dashboard.** `gbrain serve --http` ships a production OAuth 2.1 server
   with an embedded React admin UI (~65KB gzip), 30 ops scope-tagged
   (`read | write | admin`), `sync_brain` and `file_upload` marked
   `localOnly`. Client credentials, PKCE, refresh rotation, optional DCR
   (`CHANGELOG.md:3653-3661`). Plus the v0.26.5 destructive-guard wave
   (soft-delete with 72h TTL purge phase, page + source) and v0.26.9 OAuth
   hardening (F1-F12 fixes from a single hardening pass).

9. **v0.27.0 (2026-04-28) — Pluggable embedding providers via Vercel AI
   SDK.** `src/core/ai/gateway.ts` becomes the single AI seam. OpenAI stays
   default, but Gemini, Ollama, Voyage, Anthropic, and any
   OpenAI-compatible endpoint are one config key away. Fixes the silent
   silent-drop bug where non-OpenAI brains returned zero vectors on every
   `put_page` (`CHANGELOG.md:2846-2854`). v0.32.0 (the current release) is
   the discoverability follow-up — 14 recipes, doctor advisory
   (`CHANGELOG.md:5-13`).

10. **v0.31.0 / v0.31.1 (2026-05-08) — Hot Memory + thin-client mode.**
    v0.31.0 ships cross-session facts queryable in real time
    (`gbrain recall <entity>`); MCP carries a `_meta.brain_hot_memory`
    payload so the agent reaches for it automatically without waiting for
    the dream cycle (`CHANGELOG.md:934-940`). v0.31.1 finally makes
    `gbrain init --mcp-only` actually work — every read/write/admin op
    routes through MCP, refused commands carry pinpoint hints
    (`CHANGELOG.md:800-808`). This is the line between "single-machine
    brain" and "team-deployable brain with thin clients."

The v0.20.0 (2026-04-23) release is also notable as a *negative*
inflection: BrainBench (the eval harness + 5MB corpus) moved *out* into
a sibling `gbrain-evals` repo so gbrain stays the knowledge-brain
CLI/library and 99% of users don't pull the eval tree on `bun install`
(`CHANGELOG.md:6084-6092`).

---

## 8. The vibe

A few details that show what the project *feels* like:

- **Voice.** README leads with "Built by the President and CEO of Y
  Combinator to run his actual AI agents" (`README.md:5`). CHANGELOG
  release headlines are two-line bold verdicts in the GStack/Garry voice
  ("Your code is now first-class in the brain.";
  "The graph wires itself."), with `CLAUDE.md` mandating that voice in a
  detailed style guide (`CLAUDE.md` "CHANGELOG voice + release-summary
  format" section).
- **Privacy discipline.** CLAUDE.md mandates "never reference real people,
  companies, funds, or private agent names in any public-facing artifact."
  Public docs use `alice-example`, `acme-example`, `fund-a` placeholders.
  The forbidden-name rule is enforced by `scripts/check-privacy.sh` in
  `bun run verify` (`AGENTS.md:71-75`, `CLAUDE.md` "Privacy rule" section).
  A specific banned word is `Wintermute`: the public phrasing is
  "your OpenClaw" or "Garry's OpenClaw."
- **Responsible disclosure.** Security gaps are described functionally,
  *not* by enumerating attack surface (`CLAUDE.md` "Responsible-disclosure
  rule"). Release notes don't list which tables had RLS off; the doctor
  output names the specifics post-upgrade.
- **Test posture.** 5 distinct test commands in `package.json:37-50` —
  `test` (parallel fast loop), `verify` (CI gate, ~12s),
  `test:full` (everything), `test:slow`, `test:e2e`,
  `test:serial` — each with explicit semantics
  documented in `CLAUDE.md`. The `verify` gate runs 9 shell pre-checks
  (privacy, jsonb double-encode, progress-on-stdout, test-isolation, wasm
  embedded, admin build, admin scope drift, cli executable, typecheck)
  before the tests fire (`package.json:39`).
- **Self-installing.** The `postinstall` hook runs
  `gbrain apply-migrations --yes --non-interactive` automatically; if it
  can't find the binary it prints a fix-up message pointing at issue #218
  (`package.json:59`). This is the "ship canonically, not advisory"
  posture from CLAUDE.md.
- **Agent-readable everything.** Every command emits JSON when stdout
  isn't a TTY (gh CLI convention); `--tools-json` exposes the full op
  contract so an agent can introspect at runtime (`README.md:135`,
  `CLAUDE.md` repeated).
- **Opinionated tooling pin.** Bun ≥1.3.10 (`package.json:108-110`).
  Engine assumption is one Bun runtime end-to-end; the binary is built
  via `bun --compile` with the WASM grammars embedded
  (`package.json:31-32`).

---

## 9. Drift from CLAUDE.md (verified contradictions and unverifiable claims)

CLAUDE.md is explicitly described as "the index, not the truth"
(`AGENTS.md:18-19`). The drift below is what I caught reading just the
foundation files; the synthesis instance (10) will catch the rest.

1. **Operation count.** CLAUDE.md says `src/core/operations.ts` defines
   "~47 shared operations" and "v0.29 adds `get_recent_salience`,
   `find_anomalies`, `get_recent_transcripts`" (`CLAUDE.md` "Architecture"
   section, also `infra-layer.md:73` says "31 ops"). The actual file at
   v0.32.0 has **60 operations** (verified: `grep -E "^  name: '"
   /home/user/gbrain/src/core/operations.ts | wc -l` → 60 unique names
   listed above in section 6). v0.30+ added `takes_*` (4),
   `whoami`/`sources_*` (4), `extract_facts`/`recall`/`forget_fact` (3),
   `get_brain_identity`, `run_doctor`, `restore_page`, `purge_deleted_pages`,
   `pause_job`/`resume_job`/`replay_job`/`send_job_message`,
   `traverse_graph`, `think` — none reflected in the "~47" CLAUDE.md
   number or the "31 ops" infra-layer.md number.

2. **Skill count.** CLAUDE.md "Skills" section says "GBrain ships 29
   skills." README at line 9 says "34 skills." README line 141 says
   "GBrain ships 34 skills organized by skills/RESOLVER.md." The
   architecture diagram in `README.md:480-484` says "29 skills" — the
   README contradicts itself. Could not verify the actual count (Instance
   8 owns the skills tree).

3. **Engine count.** README architecture diagram at `README.md:472-486`
   says "29 skills" and the Architecture section heading promises a
   diagram, but the count of supported engines is consistent: PGLite
   (default) + Postgres (Supabase or self-hosted). SQLite is "designed
   and ready for implementation" per `CONTRIBUTING.md:191-193`, not
   shipped.

4. **`infra-layer.md` is stale.** It was clearly written around the v0.4-
   v0.7 era. References "31 ops" (now 60), "10 tables" (likely more by
   v0.32 — instance 2 will count), no mention of the dream cycle,
   minions, OAuth, sources, takes, hot memory, code chunkers. The
   description of the data pipeline is still mostly accurate
   (chunkers + RRF + dedup), but the surface it covers is a small slice
   of the v0.32 system.

5. **`HOMEBREW_FOR_PERSONAL_AI.md` roadmap is aspirational.** The roadmap
   table at `HOMEBREW_FOR_PERSONAL_AI.md:130-136` projects v0.7.0 →
   v1.0.0 with senses + reflexes + community recipes + reflex rules
   engine landing by v1.0.0. Actual current release is v0.32.0 with the
   recipe system shipping but no formal "reflex rules engine" surface
   visible from the foundation docs. The vision doc has not been updated
   since around v0.7.

6. **CLAUDE.md says `infra-layer.md` describes "Shared infrastructure
   documentation"** — true, but not a warning that it's a v0.4-era
   snapshot. Anyone reading it as current state will misroute
   architectural questions.

7. **Default chat model history.** CLAUDE.md and CHANGELOG describe a
   v0.31.6 → v0.31.12 incident where `claude-sonnet-4-6-20250929` was the
   chat default and 404'd on every call. Verified in the v0.31.12
   CHANGELOG entry (`CHANGELOG.md:121-130`). Not drift, but worth flagging
   that the *current* chat default per `model-config.ts` /
   `gateway.ts:DEFAULT_CHAT_MODEL` should be `anthropic:claude-sonnet-4-6`
   (no date suffix) — instance 3 owns verification.

8. **CLAUDE.md says "Schema migration v34 (`destructive_guard_columns`)
   adds `pages.deleted_at`"** but I couldn't verify the migration version
   number from foundation docs alone. Instance 2 owns the migration
   ledger.

9. **`README.md:825` says "29 standalone instruction sets (25 ship in the
   curated `gbrain skillpack install` bundle)."** This is inconsistent
   with `README.md:9` ("34 skills") and `README.md:141` ("GBrain ships
   34 skills"). The README has at least three different skill counts in
   the same file.

10. **CONTRIBUTING.md at line 41 lists the project structure** and shows
    `skills/RESOLVER.md` only, not `AGENTS.md`. AGENTS.md (at the repo
    root, separate file from `skills/AGENTS.md`) ships with v0.15
    (CHANGELOG `L7213`). The CONTRIBUTING.md project-structure block
    pre-dates v0.15 and has not been refreshed.

11. **Audience targeting drift.** README leads with "Built by the
    President and CEO of Y Combinator" (`README.md:5`), but CLAUDE.md
    contains an explicit "never auto-merge PRs that … 'neutralize' the
    founder perspective" rule (`CLAUDE.md` Community PR guardrails). The
    privacy rule banning real names contrasts with the README *prominently*
    naming Garry — instance 10 should confirm this is intentional (a
    public founder identifies himself; private contacts get pseudonyms).
