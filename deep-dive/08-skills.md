# Instance 8 — Skills / Skillpack / Skillify / Conventions

Deep dive into the fat-skills surface gbrain ships. ~42 skills + 7 conventions + 4 cross-cutting rule files + scaffold/check/install infrastructure backed by ~1.6K LOC of installer code.

## 1. Per-skill index

### Always-on (no trigger phrase; every message)

| Skill | First triggers | writes_to | Purpose |
|---|---|---|---|
| `signal-detector` (`skills/signal-detector/SKILL.md:1`) | "every inbound message (always-on)" | people/ companies/ concepts/ | Ambient capture: original-thinking + entity detection on every message; spawned as cheap parallel sub-agent. |
| `brain-ops` (`skills/brain-ops/SKILL.md:1`) | "any brain read/write/lookup/citation" | people/ companies/ deals/ concepts/ meetings/ | The core read-enrich-write cycle. Brain-first lookup, source attribution, back-linking. |

### Brain operations

| Skill | First triggers | writes_to | Purpose |
|---|---|---|---|
| `query` (`skills/query/SKILL.md:1`) | "what do we know about", "tell me about" | n/a (read-only) | 3-layer search + synthesis + citation propagation. |
| `enrich` (`skills/enrich/SKILL.md:1`) | "enrich", "create person page" | people/ companies/ | Tiered enrichment protocol; person/company compiled-truth pages. |
| `repo-architecture` (`skills/repo-architecture/SKILL.md:1`) | "where does this go", "filing rules" | n/a | Decision protocol for where pages get filed — by primary subject. |
| `citation-fixer` (`skills/citation-fixer/SKILL.md:1`) | "fix citations", "citation audit" | (mutating) | Audit + fix citation format; v0.25.1 extends to tweet/post URL backfill via X API. |
| `data-research` (`skills/data-research/SKILL.md:1`) | "research", "track" | (mutating) | YAML-recipe parameterized email-to-tracker pipeline. |
| `publish` (`skills/publish/SKILL.md:1`) | "share this page", "publish page" | n/a | Code+skill pair — AES-256-GCM HTML, zero LLM calls. |
| `frontmatter-guard` (`skills/frontmatter-guard/SKILL.md:1`) | "validate frontmatter", "check frontmatter" | (mutating) | YAML validation/auto-repair on brain pages; wraps `gbrain frontmatter`. |

### Content & media ingestion

| Skill | First triggers | writes_to | Purpose |
|---|---|---|---|
| `idea-ingest` (`skills/idea-ingest/SKILL.md:1`) | "shares a link or URL", "read this" | people/ concepts/ sources/ | Links/articles/tweets with mandatory author people-page. |
| `media-ingest` (`skills/media-ingest/SKILL.md:1`) | "watch this video", "process this YouTube link" | (mutating) | Video/audio/PDF/book/screenshot/repo with entity extraction. |
| `meeting-ingestion` (`skills/meeting-ingestion/SKILL.md:1`) | "meeting transcript", "process this meeting" | meetings/ people/ companies/ | Transcript → page with attendee enrichment + entity propagation + timeline merge. |
| `ingest` (`skills/ingest/SKILL.md:1`) | "ingest this", "save this to brain" | people/ companies/ concepts/ | Thin router. |
| `voice-note-ingest` (`skills/voice-note-ingest/SKILL.md:1`) | "voice note", "ingest this voice memo" | voice-notes/ originals/ concepts/ people/ companies/ ideas/ personal/ | Exact-phrasing preservation; decision-tree routing. |
| `book-mirror` (`skills/book-mirror/SKILL.md:1`) | "personalized version of this book", "mirror this book" | media/books/ | v0.25.1 flagship: 2-column chapter analysis. Sanctioned `media/books/<slug>-personalized.md` exception. |
| `article-enrichment` (`skills/article-enrichment/SKILL.md:1`) | "enrich this article", "enrich brain pages" | media/articles/ | Wall-of-text → executive summary + verbatim quotes + insights. |
| `strategic-reading` (`skills/strategic-reading/SKILL.md:1`) | "strategic reading", "read this through the lens of" | concepts/ projects/ | Read source through one strategic problem; produce applied playbook. |
| `concept-synthesis` (`skills/concept-synthesis/SKILL.md:1`) | "concept synthesis", "synthesize my concepts" | concepts/ | Dedupe raw stubs → tiered intellectual map T1 Canon → T4 Riff. |
| `perplexity-research` (`skills/perplexity-research/SKILL.md:1`) | "perplexity research", "what's new about" | research/ | Brain context → Perplexity → what is NEW vs already-known. |
| `archive-crawler` (`skills/archive-crawler/SKILL.md:1`) | "crawl my archive", "find gold in my archive" | originals/ personal/ ideas/ | Universal archivist with mandatory `gbrain.yml archive-crawler.scan_paths:` allow-list. |
| `academic-verify` (`skills/academic-verify/SKILL.md:1`) | "verify this academic claim", "check this study" | concepts/ | Trace claim → publication → methodology → raw data → replication. |
| `brain-pdf` (`skills/brain-pdf/SKILL.md:1`) | "make pdf from brain", "brain pdf" | n/a | Render brain page → publication-quality PDF via gstack make-pdf. |

### Operational

| Skill | First triggers | writes_to | Purpose |
|---|---|---|---|
| `daily-task-manager` (`skills/daily-task-manager/SKILL.md:1`) | "add task", "complete task" | ops/tasks.md | Task lifecycle (P0..P3, defer, complete). |
| `daily-task-prep` (`skills/daily-task-prep/SKILL.md:1`) | "morning prep", "prepare for today" | n/a | Calendar + open threads + active tasks prep. |
| `briefing` (`skills/briefing/SKILL.md:1`) | "daily briefing", "morning briefing" | n/a | Today's meetings + active deals + citation tracking. |
| `cron-scheduler` (`skills/cron-scheduler/SKILL.md:1`) | "schedule a job", "cron" | (mutating) | Staggering, quiet hours, idempotency contracts. |
| `reports` (`skills/reports/SKILL.md:1`) | "save report", "load latest report" | reports/{job}/ | Timestamped report save/load with keyword routing. |
| `skill-creator` (`skills/skill-creator/SKILL.md:1`) | "create a skill", "new skill" | (mutating) | Generate conformant SKILL.md scaffold + MECE check. |
| `skillify` (`skills/skillify/SKILL.md:1`) | "skillify this", "skillify" | (mutating) | Meta-skill: orchestrates the 11-step audit. |
| `skillpack-check` (`skills/skillpack-check/SKILL.md:1`) | "skillpack check", "is gbrain healthy" | n/a | Agent-readable JSON health. |
| `smoke-test` (`skills/smoke-test/SKILL.md:1`) | "smoke test", "run smoke tests" | (mutating) | Post-restart fixes; extensible via `~/.gbrain/smoke-tests.d/*.sh`. |
| `cross-modal-review` (`skills/cross-modal-review/SKILL.md:1`) | "second opinion", "cross-modal review" | n/a | Second-model quality gate; refusal-routing chain. |
| `testing` (`skills/testing/SKILL.md:1`) | "validate skills", "test skills" | n/a | Skill validation + daily test-suite regression intel. |
| `webhook-transforms` (`skills/webhook-transforms/SKILL.md:1`) | "set up webhook", "process webhook event" | (mutating) | External-event → brain signal pipeline. |
| `minion-orchestrator` (`skills/minion-orchestrator/SKILL.md:1`) | "gbrain jobs submit", "submit a gbrain job" | (mutating) | v0.20.4 unified shell + LLM-subagent job skill. |
| `ask-user` (`skills/ask-user/SKILL.md:1`) | "present options", "ask before proceeding" | n/a | Choice-gate pattern; platform-agnostic. |

### Setup & migration

| Skill | First triggers | writes_to | Purpose |
|---|---|---|---|
| `setup` (`skills/setup/SKILL.md:1`) | "set up gbrain", "initialize brain" | (mutating) | Auto-provision Supabase/PGLite + AGENTS.md injection + first import. |
| `cold-start` (`skills/cold-start/SKILL.md:1`) | "cold start", "fill my brain" | people/ companies/ meetings/ daily/ media/ conversations/ sources/ | Day-1 bootstrap pipeline via ClawVisor. |
| `migrate` (`skills/migrate/SKILL.md:1`) | "migrate from", "import from obsidian" | (mutating) | Universal Obsidian/Notion/Logseq/Roam/CSV/JSON migration. |
| `maintain` (`skills/maintain/SKILL.md:1`) | "brain health", "check backlinks", "run dream" | (mutating) | Health + extraction + dream-cycle skill. |
| `soul-audit` (`skills/soul-audit/SKILL.md:1`) | "soul audit", "customize agent" | SOUL.md/USER.md/ACCESS_POLICY.md/HEARTBEAT.md | 6-phase interactive interview. |

### Deprecated

`skills/install/SKILL.md:1` — Deprecated stub pointing at `setup/`.

`skills/manifest.json:1-225` ships 42 entries with `version: 0.25.1`. `loadOrDeriveManifest` (`src/core/skill-manifest.ts:112`) auto-derives from `skillsDir/*/SKILL.md` when manifest.json is absent.

## 2. RESOLVER routing model

**Two-filename policy** (`src/core/resolver-filenames.ts:19`): `RESOLVER_FILENAMES = ['RESOLVER.md', 'AGENTS.md'] as const`. First-match wins; `RESOLVER.md` precedes `AGENTS.md` at the same directory.

**v0.19 — both filenames accepted natively.** `findResolverFile(dir)` (`resolver-filenames.ts:27`) returns the first match. OpenClaw uses `AGENTS.md` at workspace root; gbrain-native ships `RESOLVER.md` in `skills/`.

**v0.31.7 — multi-file merge.** `findAllResolverFiles(dir)` (`resolver-filenames.ts:42`) returns BOTH. The merge is in `checkResolvable` (`src/core/check-resolvable.ts:261-264`):

```ts
const allResolverPaths = [
  ...findAllResolverFiles(skillsDir),
  ...findAllResolverFiles(join(skillsDir, '..')),
];
```

Dedup by `skillPath` first-occurrence-wins (`check-resolvable.ts:289-301`). The OpenClaw shape that motivated this: skillpack installs thin `skills/RESOLVER.md` (~40 entries); the real dispatcher is `../AGENTS.md` (200+). Pre-v0.31.7 only the first file was read; CLAUDE.md cites 37/224 → 200/224 reachable post-fix.

**resolveWorkspaceSkillsDir** (`src/core/repo-root.ts:63`) tries `workspace/skills/<resolver>` first, falls back to `workspace/<resolver>` (root-only AGENTS.md).

**Disambiguation rules** (`skills/RESOLVER.md:91-98`): most-specific wins, URL → content type, chaining explicit per skill, doubt → ask-user.

**Overlap whitelist** (`check-resolvable.ts:104-108`): `ingest`, `signal-detector`, `brain-ops` are exempt from MECE overlap warnings (always-on routers).

## 3. Skillpack install + uninstall

Source: `src/core/skillpack/installer.ts` (~1.6K LOC), `bundle.ts`.

### Managed-block design (`installer.ts:259-320`)

Rewrites a fence inside the workspace's resolver file. The cumulative-slugs receipt (`RECEIPT_RE` `installer.ts:271`) is sorted, comma-separated, with the gbrain version that wrote it. `parseReceipt` (`installer.ts:284`) reads back.

### Install semantics (`applyManagedBlock` `installer.ts:441-535`)

1. Prior cumulative slugs come from the receipt; pre-v0.19 fences fall back to row-extracted slugs (`installer.ts:466-470`).
2. **Single-skill install: union(prior, installed)** — per-skill installs accumulate (`installer.ts:482-483`).
3. **`install --all` prunes** — drops slugs no longer in the bundle (`installer.ts:485-493`). `prunedSlugs` tracked so unknown-row detector doesn't resurrect.
4. **Unknown-row warn-and-preserve** (`installer.ts:497-522`): row in fence not in `newCumulative` ∪ `bundleSlugs` ∪ `prunedSlugs` is user-added — preserve and stderr-warn.
5. First-v0.19 install (no receipt yet) skips unknown-row check (`installer.ts:508`).

### Per-file diff protection (`applyInstall` `installer.ts:364-439`)

`planInstall` computes `entryOutcomes[]` with byte-equality (`installer.ts:154-162`). Outcomes: `wrote_new` / `skipped_identical` / `wrote_overwrite` (with `--overwrite-local`) / `skipped_locally_modified` (default when diverged).

`--force` only bypasses the top-level "skill dir exists" gate. Per-file diff bypass is `--overwrite-local`.

### Lockfile (`installer.ts:180-253`)

`.gbrain-skillpack.lock` holds the PID. 10-minute stale threshold; `--force-unlock` overrides. `installer.ts:211-217` clamps age to >= 0 for the fast-CI just-written-future-mtime edge.

### v0.25.1 uninstall (`installer.ts:684-832`)

`gbrain skillpack uninstall <name>` — inverse with two symmetric safeguards:

- **D8 — refuse user-added** (`installer.ts:714-722`): if slug isn't in cumulative-slugs receipt, throw `UninstallError(user_added_slug)`. Pre-v0.19 fence with no receipt → fall back to row-extracted slugs.
- **D11 — content-hash guard** (`installer.ts:742-781`): pre-scan ALL files for divergence BEFORE any `unlink`. **Atomic-refusal contract** (`installer.ts:744-746`): "do NOT unlink ANY file until we've confirmed every file is removable." Bypass with `--overwrite-local`.

`applyManagedBlockUninstall` (`installer.ts:842-907`) rebuilds fence with slug dropped from cumulative-slugs; symmetric unknown-row preservation.

### Post-install advisory (`post-install-advisory.ts:45-80`)

Every `gbrain init`/`upgrade` ends by printing the v0.25.1 recommended-set diff against the workspace's receipt. Skills in recommended set NOT in receipt are listed with descriptions and the install command. No-op when no workspace, when everything's installed, or on pre-v0.19 fence with no receipt.

## 4. Skillify scaffold + check loop

### `gbrain skillify scaffold <name>` (`src/core/skillify/generator.ts:66`)

Pure file-tree generator. `planScaffold` → `applyScaffold`. Produces 5 artifacts:

1. `skills/<name>/SKILL.md`
2. `skills/<name>/scripts/<name>.mjs`
3. `skills/<name>/routing-eval.jsonl`
4. `test/<name>.test.ts`
5. Resolver row appended under `## Uncategorized` (`generator.ts:150-172`)

Every stub embeds `SKILLIFY_STUB: replace before running check-resolvable --strict`. `check-resolvable` (`check-resolvable.ts:524-559`) warns on any committed sentinel — D-CX-9 gate.

Idempotency (`generator.ts:8`): `--force` regenerates STUB files but NEVER re-appends resolver rows. `detectExistingResolverRow` (`generator.ts:130-148`) matches across delimiters.

Naming rule (`generator.ts:45`): `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` — lowercase-kebab-case only.

### `gbrain skillify check [path]` (`src/commands/skillify-check.ts:188-300`)

11-item audit (promoted from `scripts/skillify-check.ts` to `src/commands/` in D-CX-2):

| # | Item | Required | Source |
|---|---|---|---|
| 1 | SKILL.md exists | yes | `skillify-check.ts:197` |
| 2 | Code file exists at target | yes | `:198` |
| 3 | Unit tests exist | yes | `:200-207` |
| 4 | Integration tests (E2E) | no | `:209-218` |
| 5 | LLM evals | no | `:220-229` |
| 6 | Resolver entry | yes | `:231` |
| 7 | Resolver trigger eval (heuristic) | no | `:233-243` |
| 8 | `check-resolvable` gate | no (cached) | `:245-248` |
| 9 | E2E test required-gate | yes | `:250` |
| 10 | Brain filing (only when script writes pages) | no | `:252-272` |
| 11 | Cross-modal eval receipt (informational) | no | `:274-284` |

Item 8 spawns `gbrain check-resolvable --json` cached per process (`skillify-check.ts:87-117`). Item 11 reads `gbrainPath('eval-receipts')/<slug>-<sha8>.json` via `findReceiptForSkill` (informational; missing/stale receipts surface as text, never fail).

### `gbrain skillpack-check`

Agent-readable health JSON. Wraps `check-resolvable --json` + `doctor --json` + migration ledger. Exit 0/1/2 cron-friendly.

## 5. Filing audit (Check 6)

Source: `src/core/filing-audit.ts:182-249`.

**Scope (D-CX-7):** scan skills with `writes_pages: true` ONLY. `mutating: true` alone is exempted.

**Rule shape** (`skills/_brain-filing-rules.json:5-144`): JSON array of `{kind, directory, examples?, description?}`. v1.0.0 ships 24 rules plus `sources_dir` special case.

**Audit rule** (`filing-audit.ts:222-244`): missing `writes_to:` → warning. Unknown directory → warning.

**Warning-only as of v0.19**, per `check-resolvable.ts:561-578`. D-CX-3 + D-CX-5. `--strict` mode promotes warnings to exit 1.

**Frontmatter parser** (`filing-audit.ts:123-165`) supports both inline (`writes_to: [a, b]`) and block (`writes_to:\n  - a`) shapes.

**The `dream_synthesize_paths` allow-list** (`_brain-filing-rules.json:155-164`) is the v0.23 trusted-workspace allow-list for `gbrain dream`'s synthesize phase. The dream cycle threads it as `allowed_slug_prefixes` to every subagent.

## 6. Routing eval (Check 5)

Source: `src/core/routing-eval.ts`.

**Two-layer design** (`routing-eval.ts:1-31`):
- **Layer A (structural):** always runs, no LLM. `normalizeText` (`:98`: lowercase + non-alphanumeric → space + collapse) then substring match.
- **Layer B (LLM tie-break):** accepted as `--llm` flag for forward compat; `RunRoutingEvalOptions` parameter is `_opts` (underscored, ignored at `routing-eval.ts:327`). Runs Layer A only.

**Fixture shape** (`routing-eval.ts:36-55`): JSONL at `skills/<name>/routing-eval.jsonl`. `{intent, expected_skill: string|null, ambiguous_with?: string[]}`. Always-on (`signal-detector`, `brain-ops`, `ingest` — `ALWAYS_ON_SKILLS` `:163`) auto-allowed.

**Fixture linter** (`routing-eval.ts:207-253`): D-CX-6 rejects fixtures where `normalizedIntent === phrase` exactly (copy-paste tautology). Does NOT reject intents merely containing trigger words.

**Outcomes** (`routing-eval.ts:336-376`): `pass` / `missed` / `ambiguous` / `false_positive`. Surfaces in `check-resolvable` as warnings via `routing_miss` / `routing_ambiguous` / `routing_false_positive` / `routing_fixture_lint` issue types (`check-resolvable.ts:480-522`).

**Loader** (`routing-eval.ts:267-313`) walks `<skillsDir>/<entry>/routing-eval.jsonl`. Skips `_`/`.` dirs. Malformed lines surface via `LoadResult.malformed[]`.

## 7. Read-path vs write-path skills-dir split (v0.31.7)

Source: `src/core/repo-root.ts`.

`SkillsDirSource` (`repo-root.ts:39-47`) ladder:

| Tier | Source | Location |
|---|---|---|
| 0 | `env_explicit` | `$GBRAIN_SKILLS_DIR` |
| 1 | `openclaw_workspace_env(_root)` | `$OPENCLAW_WORKSPACE/{skills/,}{RESOLVER\|AGENTS}.md` |
| 2 | `openclaw_workspace_home(_root)` | `~/.openclaw/workspace/...` |
| 3 | `repo_root` | walked-up gbrain repo cwd ancestor |
| 4 | `cwd_skills` | `./skills/` |
| 5 (read-only) | `install_path` | walk from this module's `import.meta.url` |

**Two entry points:**

- `autoDetectSkillsDir` (`repo-root.ts:110`) — tiers 0..4. Write-path callers (skillpack install, skillify scaffold, post-install-advisory).
- `autoDetectSkillsDirReadOnly` (`repo-root.ts:195`) — tiers 0..5. Adds tier-5 install-path fallback gated by `isGbrainRepoRoot` (`repo-root.ts:167`). Read-path callers (doctor, check-resolvable, routing-eval).

**Why the split:** without it, `bun install -g github:garrytan/gbrain && cd ~ && gbrain skillpack install` would silently target the bundled gbrain repo's `skills/`. Read-only callers don't write, so the fallback is safe.

**D6 --fix safety gate** (`src/commands/check-resolvable.ts:291-299`): when `detected.source === 'install_path'`, refuse `--fix` with stderr pointing at `$GBRAIN_SKILLS_DIR / $OPENCLAW_WORKSPACE / --skills-dir`. `autoFixDryViolations` writes to SKILL.md files; without this gate it would mutate gbrain's own install tree.

## 8. Cross-cutting conventions

| File | Purpose | Highlights |
|---|---|---|
| `skills/_brain-filing-rules.md` | Human filing rules; companion to `.json`. | "PRIMARY SUBJECT determines where it goes." Sanctioned `media/<format>/<slug>` exception. Iron Law back-linking. v0.32+ takes attribution rules. |
| `skills/_brain-filing-rules.json` | Canonical machine-readable. | 24 rules + `dream_synthesize_paths.globs`. |
| `skills/_friction-protocol.md` | Friction-log usage. | 4 severities (blocker/error/confused/nit). Drives claw-test feedback loop. |
| `skills/_output-rules.md` | Output quality bar. | Deterministic links only. No slop. Exact phrasing. Titles < 60 chars. |
| `conventions/quality.md` | Citations + back-links + notability gate. | 6 citation formats, 4-tier precedence, MANDATORY back-linking. |
| `conventions/brain-first.md` | Lookup chain. | Tool inventory, 5-step MANDATORY order. |
| `conventions/brain-routing.md` | Two-axes routing. | Brain (database) vs source (repo). |
| `conventions/cron-via-minions.md` | Cron architecture. | Cron submits Minion jobs, not native agentTurn. |
| `conventions/model-routing.md` | Two concerns: internal tier system (v0.31.12+) + subagent spawn routing. | 4 tiers (utility/reasoning/deep/subagent). 8-step priority chain. |
| `conventions/salience-and-recency.md` | v0.29.1 query ranking. | Orthogonal: salience (mattering) vs recency (age). |
| `conventions/subagent-routing.md` | Native vs Minions choice. | 3 modes; read `~/.gbrain/preferences.json` first. |
| `conventions/test-before-bulk.md` | Never bulk without testing 3-5 first. | Read → hone → test → check → fix → bulk. |
| `conventions/cross-modal.yaml` | Review pairs + refusal routing. | Refusal chain: primary → deepseek → qwen → groq. Silent_switch. |

DRY detector (`check-resolvable.ts:189-199` `CROSS_CUTTING_PATTERNS`) matches inlined Iron Law / citation format / notability gate prose. Suppression via `DRY_PROXIMITY_LINES = 40` (`check-resolvable.ts:204`). `extractDelegationTargets` (`check-resolvable.ts:221-236`) parses both blockquote callouts AND inline backticks.

## 9. Skill manifest + drift

`loadOrDeriveManifest(skillsDir)` (`src/core/skill-manifest.ts:112`):

1. If `manifest.json` parses AND `skills[]` is a valid array, use verbatim.
2. Otherwise walk `skillsDir/*/SKILL.md`, parse `name:` from frontmatter, fall back to dirname (`deriveManifest` `skill-manifest.ts:67-103`).
3. Returns `{skills, derived: boolean}` for `--verbose` surface.

Dotfile + underscore-prefixed dirs excluded (`skill-manifest.ts:82`).

**Drift detection** between bundled skills and user local edits happens at install time via per-file byte-equality (`installer.ts:154-162`), NOT via a hash manifest. The "skill-manifest.json" referenced in older docs IS `openclaw.plugin.json` (`bundle.ts:60-104`). `test/skillpack-sync-guard.test.ts` ensures bundled skills stay byte-identical to `skills/` source.

## 10. Skill migrations

Directory: `skills/migrations/v<X.Y.Z>.md`. 24 files at this writing, spanning v0.5.0 → v0.29.1.

**Role in upgrade:** auto-update agent reads these after `gbrain upgrade` runs `apply-migrations`. TS orchestrators in `src/commands/migrations/*.ts` handle mechanical work; the markdown covers judgment work (content edits, plugin-handler registration where shell-exec would be RCE).

**Frontmatter shape** (e.g. `v0.10.3.md:1-16`):
```yaml
---
version: 0.x.y
feature_pitch: {headline, description, recipe?, tiers?}
auto_execute:                   # optional, rare
  - cmd: gbrain ...
    description: ...
---
```

**Inflection-point migrations:** v0.5.0 (live sync), v0.10.3/v0.12.0/v0.13.0 (knowledge graph), v0.11.0 (Minions), v0.14.0 (shell-jobs), v0.15.2 (progress reporter), v0.17.0 (dream cycle), v0.18.0 (multi-source), v0.19.0/v0.21.0 (Code Cathedral I/II), v0.22.4 (Frontmatter Guard), v0.22.14 (worker self-monitoring), v0.23.0 (dream synthesize+patterns), v0.25.1 (skills wave + uninstall), v0.27.1 (multimodal), v0.28.0 (Takes + Think), v0.29.1 (salience+recency).

From v0.14.2 onward the runner owns ledger writes (`src/commands/migrations/*.ts` returns `OrchestratorResult`; `apply-migrations.ts` persists).

## Drift from CLAUDE.md

1. **Skill count.** CLAUDE.md says "29 skills" in the Skills paragraph and "42" in the scope-baseline table. Internally inconsistent; the 42 reflects reality. The 29 figure is pre-v0.25.1.

2. **Routing-eval `--llm`.** CLAUDE.md describes it as "emits stderr notice and runs structural only." Confirmed at `src/core/routing-eval.ts:319-327` — `RunRoutingEvalOptions {llm?}` is accepted but the `runRoutingEval` parameter is `_opts` (underscored, ignored). The stderr notice itself lives in `src/commands/routing-eval.ts`.

3. **Delegation callout shapes.** CLAUDE.md emphasizes `> **Convention:** see [path](path).` as canonical. The actual regex (`check-resolvable.ts:226`) accepts `> **Convention:**`, `> **Filing rule:**`, AND inline backticks. Broader than CLAUDE.md describes, not contradictory.

4. **Migration filename phrasing.** CLAUDE.md says "migration files use the version they shipped FROM as their filename." Contents read as "migrating TO that version" (the version that ships the change). Worth a one-word doc fix ("INTRODUCED IN" or "shipped WITH" would be clearer).

5. **`OVERLAP_WHITELIST` ≠ `ALWAYS_ON_SKILLS` duplication.** `check-resolvable.ts:104-108` and `routing-eval.ts:163` each define an independent set of `{ingest, signal-detector, brain-ops}`. CLAUDE.md doesn't note the duplication. A shared `src/core/always-on-skills.ts` constant would fix the DRY violation.

6. **Manifest version stamp.** `skills/manifest.json:3` is `"version": "0.25.1"` while the repo is presumably v0.31.x. No automated sync. Downstream consumers reading manifest.json for "what gbrain version shipped these skills" get stale data.

7. **`install/` deprecated stub.** `skills/install/SKILL.md` is a one-paragraph deprecation pointer to `setup/`. Not in `manifest.json`. Not in `RESOLVER.md`. But still on disk and `loadOrDeriveManifest` would pick it up via the auto-derive path (no `_` prefix). On any OpenClaw deployment without manifest.json, this dead skill would silently appear in routing reports.
