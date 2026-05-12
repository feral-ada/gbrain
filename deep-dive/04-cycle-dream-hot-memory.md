# Instance 4 — Cycle, Dream, and Hot-Memory Layer Deep-Dive

Scope: `src/core/cycle.ts`, `src/core/cycle/**`, `src/core/transcripts.ts`,
`src/core/facts/**`, `src/commands/dream.ts`, plus the v0.29/v0.31 CLIs
that compose these primitives.

---

## 1. The cycle primitive — ELEVEN phases, not nine

The headline finding upstream (the prior Instance 4) said "TEN" phases in
`ALL_PHASES`. The actual count is **eleven**. Source of truth:
`src/core/cycle.ts:61-83`. The full list, in declaration order, is:

```
1.  lint
2.  backlinks
3.  sync
4.  synthesize
5.  extract
6.  patterns
7.  recompute_emotional_weight   (v0.29)
8.  consolidate                  (v0.31, new)
9.  embed
10. orphans
11. purge                        (v0.26.5)
```

The `CyclePhase` union at `src/core/cycle.ts:56-59` lists all eleven, and
the runner block (`src/core/cycle.ts:863-1161`) has a guarded
`if (phases.includes(...))` block for each one. Lock semantics are in
`NEEDS_LOCK_PHASES` at `src/core/cycle.ts:93-105`: ten of the eleven
phases acquire the lock (only `orphans` skips — it is read-only and
report-only).

The doc comment at `src/core/cycle.ts:13-28` shows a nine-phase ASCII
diagram. That diagram lags the code. The comment was last updated for the
v0.29 wave (`recompute_emotional_weight` is in it) but never refreshed
for v0.26.5 `purge` or v0.31 `consolidate`. The numbered comments
attached to each phase block in the runner are also inconsistent
("Phase 8: embed" at `:1097`, "Phase 9: orphans" at `:1118`, "Phase 9:
purge" at `:1139` — `embed` and `consolidate` both call themselves
"Phase 8" in adjacent blocks because the original v0.23-era prose was
never re-numbered). The bug is purely cosmetic; `ALL_PHASES` is the only
behaviorally-meaningful list.

CLAUDE.md text drift: the project docstring at the top of CLAUDE.md
("9 phases in v0.29") was extended in the v0.31.12 wave to mention
`consolidate` indirectly via the per-file annotations, but the headline
phase-count claim is still v0.29-era. The "Architecture" section
references "47 shared operations (v0.29 adds get_recent_salience,
find_anomalies, get_recent_transcripts)" without bumping to the v0.31
surface.

### Composition order rationale

The order is semantically driven, not historical. The runner's comments
at `src/core/cycle.ts:1000-1004` and `:1069-1072` give the explicit
reasoning:

- **lint** + **backlinks** are pure-filesystem and run first so the DB
  picks up the canonical text in the next phase.
- **sync** materializes the filesystem to DB; both pre-DB phases must
  precede it.
- **synthesize** generates new pages from transcripts; runs after sync
  so cross-references see fresh state (`src/core/cycle.ts:941-974`).
- **extract** materializes wikilinks and timeline edges from sync +
  synthesize output. Subagent put_page sets `ctx.remote=true`, so
  auto-link only fires for trusted-workspace writes; extract is the
  canonical materialization path
  (`src/core/cycle.ts:1001-1004`).
- **patterns** must run AFTER extract so the graph state is fresh
  (`src/core/cycle.ts:1000-1004`).
- **recompute_emotional_weight** sees union(sync, synthesize) for
  incremental mode (`src/core/cycle.ts:1029-1067`).
- **consolidate** (v0.31) runs after patterns so the graph is fresh and
  BEFORE embed so the new takes get embedded in the same cycle
  (`src/core/cycle.ts:1069-1072`).
- **embed** reindexes everything written by the prior phases.
- **orphans** is read-only and last.
- **purge** is last-of-last; the 72h-old soft-deletes get dropped after
  the rest of the cycle has had a chance to see them
  (`src/core/cycle.ts:1139-1142`).

### Coordination locks

Postgres path acquires a row in `gbrain_cycle_locks` with a 30-min TTL
via `INSERT ... ON CONFLICT ... WHERE ttl_expires_at < NOW() RETURNING`
(`src/core/cycle.ts:250-287`). Crashed holders auto-release: the next
acquirer's UPDATE branch fires once the TTL expires. PgBouncer-safe
because the lock is row-level, not session-level
`pg_try_advisory_lock`.

PGLite + null-engine path uses a file lock at `~/.gbrain/cycle.lock`
holding `{pid}\n{iso-timestamp}`
(`src/core/cycle.ts:336-397`). Staleness is mtime > 30 min OR PID is
not alive on this host (uses `process.kill(pid, 0)` with the three-way
ESRCH/EPERM/success interpretation so PID 1 cousins are still
respected, `src/core/cycle.ts:348-361`).

`yieldBetweenPhases` (`src/core/cycle.ts:186-192`) is awaited between
every phase and refreshes the lock TTL + Minions worker job lock.
`yieldDuringPhase` (`src/core/cycle.ts:194-200`) is the in-phase
keepalive that synthesize + patterns + consolidate call during long
LLM waits.

### Three callers

1. `gbrain dream` CLI — `src/commands/dream.ts:278` calls `runCycle`
   directly.
2. `gbrain autopilot` daemon (inline fallback when minions queue is
   unavailable) — `src/commands/autopilot.ts:341-342`.
3. Minions `autopilot-cycle` handler — `src/commands/jobs.ts:1070-1084`
   registers the handler that delegates to `runCycle` and passes
   `signal` + `yieldBetweenPhases` from the job context.

### AbortSignal propagation

`CycleOpts.signal` is the Minions worker's per-job abort signal
(`src/core/cycle.ts:226`). `checkAborted(signal)` at
`src/core/cycle.ts:437-444` fires between every phase. The v0.22.1
change closed the "98-waiting-0-active" wedge where a timed-out
autopilot-cycle handler ignored the abort and ran until the worker
deadlocked.

---

## 2. Synthesize phase — full pipeline

File: `src/core/cycle/synthesize.ts` (1004 lines). The flow is:

**Step 1 — Discover transcripts.** `discoverTranscripts({corpusDir,
meetingTranscriptsDir, ...})` is called for the configured corpus dirs
(`dream.synthesize.session_corpus_dir`,
`dream.synthesize.meeting_transcripts_dir`). Date filters + minChars +
exclude patterns + the `dream_generated` self-consumption guard run
inside `transcript-discovery.ts:153-194`.

**Step 2 — Haiku verdict cache.** Each candidate transcript hits a
`dream_verdicts` table keyed on `(file_path, content_hash)`. Cache
hits avoid the Haiku call entirely; cache misses run Haiku with a
"worth processing?" prompt (`judgeSignificance` is exported and the
verdict model is configurable via `dream.synthesize.verdict_model`,
default `claude-haiku-4-5-20251001`). The verdict is persisted ONLY on
success — codex finding #2 from the v0.23 review: a `dream_verdicts`
write on a cap-hit chunk would mean raising the chunk cap later
wouldn't retry.

**Step 3 — Model-aware chunking (v0.30.2).** `splitTranscriptByBudget`
(`src/core/cycle/synthesize.ts:136`) splits oversized transcripts at
paragraph boundaries using a 3-tier ladder: `## Topic:` → `---` → `\n`.
The back-half search window is seeded with a deterministic offset
derived from the content hash so identical inputs produce identical
chunks across retries. Per-chunk char budget is computed from
`MODEL_CONTEXT_TOKENS[resolvedModel] × 0.9 × 3.5 chars/token`
(`:53-99`). Non-Anthropic model IDs fall back to a 180K-token safe
default with a once-per-process stderr warning (`:101-110`). Operator
overrides via `dream.synthesize.max_prompt_tokens` (floor 100K) and
`dream.synthesize.max_chunks_per_transcript` (default 24).

**Step 4 — Subagent fan-out.** One Sonnet subagent per chunk (or per
transcript for single-chunk cases) submitted to Minions with
`allowed_slug_prefixes` sourced from
`skills/_brain-filing-rules.json`'s `dream_synthesize_paths.globs`.
The subagent receives a tool registry derived in
`src/core/minions/tools/brain-allowlist.ts` — `put_page` schema is
namespace-restricted to the allow-list, and the `OperationContext`
threads `allowedSlugPrefixes` so even if the subagent tries to write
elsewhere, `operations.ts:put_page` rejects it.

**Step 5 — Idempotency.** Job key shape:
- single-chunk: `dream:synth:<filePath>:<hash16>`
- multi-chunk:  `dream:synth:<filePath>:<hash16>:c<i>of<n>`

D8 (`hasLegacySingleChunkCompletion` at `:817-832`) probes the legacy
shape before submitting chunked children, so upgrades from
pre-v0.30.2 brains skip re-spending Sonnet on already-synthesized
transcripts. Returns `already_synthesized_legacy_single_chunk`.

**Step 6 — Slug collection.** After all children resolve, the
orchestrator queries `subagent_tool_executions` (NOT
`pages.updated_at` — codex finding #2 from the v0.23 review) for every
put_page slug each child wrote. `collectChildPutPageSlugs`
(`:734-806`) rewrites bare hash-6 slugs to `<hash6>-c<idx>` for
chunked children so the summary lists each chunk's output distinctly.

**Step 7 — Reverse-write.** `reverseWriteSlugs` (`:836-859`)
iterates each slug, reads the DB row via `engine.getPage` +
`engine.getTags`, and calls `renderPageToMarkdown` (`:869-885`).
**Critical:** this stamps `dream_generated: true` and
`dream_cycle_date: <today>` into frontmatter
(`:870-874`). That marker is what
`isDreamOutput` in `transcript-discovery.ts` reads to refuse
re-feeding dream output into the next cycle.

**Step 8 — Summary index.** `writeSummaryPage` (`:889-950`) builds a
`dream/YYYY-MM-DD` page listing every written slug, stamps the same
`dream_generated` marker into the summary's own frontmatter, writes
via direct `engine.putPage` (bypasses the put_page op's namespace
logic — orchestrator trust), AND dual-writes to disk.

**Step 9 — Cooldown.** On success, `dream.synthesize.last_completion_ts`
is updated. Failure leaves the cooldown alone so the next run retries.

**Hard guarantees** (from the module docstring at `:13-22`):
- Subagent never gets fs-write access.
- Allow-list source-of-truth is `_brain-filing-rules.json`; trust comes
  from `PROTECTED_JOB_NAMES` blocking MCP submission of `subagent`
  jobs.
- Edited transcripts produce content-hash-suffixed slugs, so re-runs
  never overwrite the prior version.

---

## 3. Patterns phase — DREAM_GENERATED ASYMMETRY (probable bug)

File: `src/core/cycle/patterns.ts` (332 lines). Same general shape as
synthesize: single Sonnet subagent, allow-list from
`_brain-filing-rules.json`, reads reflections from the last
`dream.patterns.lookback_days` window (default 30), names a pattern
only when `≥ dream.patterns.min_evidence` reflections support it
(default 3). Runs AFTER extract so the graph is materialized.

**The bug surface**: `patterns.ts:268-280` —

```ts
function renderPageToMarkdown(page: Page, tags: string[]): string {
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}
```

The frontmatter is passed through **unmodified**. Compare with
`synthesize.ts:869-885` which spreads in `dream_generated: true` and
`dream_cycle_date: today()`.

**Consequence**: pattern pages reverse-written to disk lack the
`dream_generated: true` marker. If a user moves a pattern page back
into a corpus dir (`personal/`, `meetings/`, or a custom
`session_corpus_dir`), `discoverTranscripts` will NOT skip it — the
v0.23.2 self-consumption guard only checks for the frontmatter marker.
The synthesize subagent then ingests the pattern page as a new
transcript and writes more pages from it, kicking off the loop.

The eligibility predicate in
`src/core/facts/eligibility.ts:61-63` also reads
`frontmatter.dream_generated === true` for the anti-loop check on
facts extraction. Pattern pages, lacking the marker, are not exempt
from fact extraction — which may or may not be intended, but is
asymmetric with how synthesize-written pages are treated.

This is a small, low-blast-radius fix (one frontmatter spread, two
lines) but worth surfacing.

---

## 4. Transcript discovery + dream-loop guard — .md/.txt ASYMMETRY (probable bug)

Two functions read transcripts from the configured corpus dirs:

### `discoverTranscripts` — accepts .txt AND .md

`src/core/cycle/transcript-discovery.ts:121-139` defines
`listTextFiles(dir)`:

```ts
function listTextFiles(dir: string): string[] {
  ...
  for (const name of entries) {
    if (!name.endsWith('.txt') && !name.endsWith('.md')) continue;
    ...
  }
}
```

Line 130 explicitly accepts both extensions. The function's own
docstring at line 145 says "Skips files that: - aren't `.txt`" — the
docstring is stale; the code is the truth.

### `listRecentTranscripts` — accepts ONLY .txt

`src/core/transcripts.ts:85-86`:

```ts
for (const name of entries) {
  if (!name.endsWith('.txt')) continue;
```

Hardcoded `.txt`. The docstring at lines 51-52 reinforces it ("filter
to `.txt` files"). This is what `gbrain transcripts recent` reads
(`src/commands/transcripts.ts`) and what the
gated `get_recent_transcripts` MCP op reads (per the CLAUDE.md note,
local-only).

### Consequence

A user whose `dream.synthesize.session_corpus_dir` is a directory of
`.md` transcripts (perfectly reasonable — many session-recorders emit
markdown) will see:

- `gbrain dream` runs fine. Synthesize discovers their files and
  processes them.
- `gbrain transcripts recent` returns an empty list.
- The MCP `get_recent_transcripts` op (when called via local CLI
  bridge) returns an empty list.

Hot-memory / agent-facing surfaces silently degrade because of one
hardcoded extension check that drifted from its sibling. Fix is
trivial — `transcripts.ts:86` should mirror
`transcript-discovery.ts:130`.

### Dream-loop guard

`isDreamOutput(content, bypass?)` lives at
`transcript-discovery.ts` and is exported. The marker regex
`DREAM_OUTPUT_MARKER_RE` anchors at the frontmatter opener `---\n`
(BOM and CRLF tolerated), scans the first 2000 chars for
`dream_generated: true` with case-insensitive value and word boundary
on `true`. Both `discoverTranscripts` (`:177-180`) and
`readSingleTranscript` (`:217-222`) call it, emit a `[dream] skipped
<basename>: dream_generated marker (self-consumption guard)` stderr
line, and skip the file.

`listRecentTranscripts` ALSO calls `isDreamOutput` at line 113 —
silently, without the stderr breadcrumb. Same gate, different verbosity
contract.

The `--unsafe-bypass-dream-guard` flag plumbs through
`runCycle.synthBypassDreamGuard` → `SynthesizePhaseOpts.bypassDreamGuard`
→ both discovery functions. Never auto-applied for `--input` so any
caller can't silently re-trigger the loop bug
(`src/commands/dream.ts`).

---

## 5. Salience scoring — `computeEmotionalWeight`

File: `src/core/cycle/emotional-weight.ts` (142 lines). Pure function,
no DB. Returns a 0..1 score from a page's tags + active takes.

**Formula** (`:73-78`, capped at 1.0):

1. **Tag emotion boost** — max 0.5, fires when any page tag is in the
   high-emotion set (`:107-114`). Case-insensitive match. Binary, not
   summed: one tag triggers the full 0.5.
2. **Take density** — max 0.3, 0.1 per active take, capped at 0.3
   (`:117`).
3. **Take avg weight** — max 0.1, average of clamp01(take.weight)
   scaled by 0.1 (`:120-124`).
4. **User-holder ratio** — max 0.1, fraction of active takes by the
   user holder (default `'garry'`) scaled by 0.1 (`:127-131`).

**HIGH_EMOTION_TAGS seed list** (`:27-43`): family, marriage, wedding,
loss, death, grief, relationship, love, mental-health, health,
illness, birth, children, kids, parents. The docstring at `:23-26`
flags this as anglocentric and personal-life-biased on purpose; users
override unconditionally via `emotional_weight.high_tags` (JSON
array). The override path is read at the consume site
(`recompute-emotional-weight.ts:52-65`); bad JSON falls back silently
to the seed list.

**User holder override** via `emotional_weight.user_holder` config key
(`recompute-emotional-weight.ts:53`).

Empty inputs return exactly 0.0 (`:103-104` + the cap at
`:133-134`).

---

## 6. Anomaly detection — `computeAnomaliesFromBuckets`

File: `src/core/cycle/anomaly.ts` (128 lines). Pure stats helpers.

**`meanStddev`** (`:38-46`): sample stddev with the n-1 denominator
(not n; `:44`). Returns `(0, 0)` for empty input
(`:39`); single-sample baseline returns `mean, 0` (`:42`) — explicit
guard against `NaN` from a `0/0` variance.

**`computeAnomaliesFromBuckets`** (`:71-123`):

For each `today` cohort:

1. Group baseline samples by `(cohort_kind, cohort_value)` via the
   unit-separator `\x1f` byte (`:80, :126`).
2. Compute `(mean, stddev)` over baseline samples.
3. **stddev > 0 path**: `isAnomaly = count > mean + sigma*stddev`,
   `sigma_observed = (count - mean) / stddev`
   (`:97-100`).
4. **stddev == 0 fallback** (zero-variance baseline OR empty
   baseline): `isAnomaly = count > mean + 1`,
   `sigma_observed = count - mean` as a finite sort proxy
   (`:101-106`). Brand-new cohorts (no baseline rows) get `mean=0,
   stddev=0` so they fire at `count >= 2`.

Returns top `limit` (default 20) sorted by `sigma_observed`
descending. `page_slugs` capped at 50 per cohort (`:117`).

**Cohort kinds in v1**: tag, type (`:17`). Year cohort is deferred to
v0.30 pending proper frontmatter date-field detection
(`:9`). CLAUDE.md says v0.30; not verified beyond the code comment.

---

## 7. `recompute_emotional_weight` phase — two-round-trip orchestrator

File: `src/core/cycle/recompute-emotional-weight.ts` (134 lines). The
phase exists because computing emotional weight per-row at query time
turned out to be expensive on 50K-page brains; the v0.29 redesign
materializes the score into a column.

**Two SQL round-trips total** regardless of brain size
(`:6-10`):

1. `engine.batchLoadEmotionalInputs(slugs?)` — single CTE-shaped read
   with per-table pre-aggregates so a page × N tags × M takes never
   produces N×M rows.
2. `engine.setEmotionalWeightBatch(rows)` — composite-keyed
   `UPDATE FROM unnest($1::text[], $2::text[], $3::real[])` keyed on
   `(slug, source_id)` so multi-source brains can't get cross-source
   fan-out.

Between them, `computeEmotionalWeight` runs per-row as a pure
function call.

**Modes**:

- **Incremental**: `affectedSlugs` is non-empty → only those slugs are
  recomputed (`:69-74`). Empty array short-circuits to zero-work
  success.
- **Full**: `affectedSlugs` undefined OR null → walk every page in the
  brain.

The cycle's runner at `cycle.ts:1049-1055` computes
`incremental = union(syncPagesAffected, synthesizeWrittenSlugs)` if
either anchor is set; else passes `undefined` and the phase walks the
full brain. Users hit the full path on first upgrade via
`gbrain dream --phase recompute_emotional_weight`.

**Failure handling**: catch-all returns
`status: 'fail'` with code `RECOMPUTE_EMOTIONAL_WEIGHT_FAIL`
(`:100-116`) so the cycle continues to the next phase rather than
aborting the whole run.

`dryRun` mode reports the would-write count without touching the DB
(`:86-92`).

---

## 8. Hot-memory (facts) layer — eight modules, queue-first

The facts layer is the v0.31 "hot memory" feature. CLAUDE.md's per-file
section covers most of it, but the layer is larger than the headline
summary implies. Eight modules under `src/core/facts/`:

1. **`eligibility.ts`** (73 lines, single-rule predicate) —
   `isFactsBackstopEligible(slug, parsed)` returns `{ok:true}` or
   `{ok:false, reason:string}`. Rejects:
   - `null/undefined` parsed (`reason: 'no_parsed_page'`)
   - `wiki/agents/*` slugs (`'subagent_namespace'`) —
     `:60`
   - `frontmatter.dream_generated === true` (`'dream_generated'`) —
     `:61-63`, the anti-loop guard
   - body < 80 chars (`'too_short'`) — `:65-66`
   - type not in `ELIGIBLE_TYPES` AND slug not in `RESCUE_SLUG_PREFIXES`
     — `:68-70`. The rescue list (`meetings/`, `personal/`, `daily/`)
     covers the case where a `meetings/2026-05-09-foo.md` page
     defaulted to `type: note` but the directory says it's a meeting.

2. **`backstop.ts`** (337 lines, the pipeline funnel) —
   `runFactsBackstop(parsedPage, ctx)` replaces five divergent
   implementations of the same pipeline. Two modes:
   - **`'queue'` (default)** — fire-and-forget via
     `getFactsQueue().enqueue`. Caller awaits the enqueue + microtask
     schedule (`:142-176`). Used by sync, put_page, file_upload,
     code_import.
   - **`'inline'`** — await the full pipeline, return truthful
     `{inserted, duplicate, superseded, fact_ids}` counts. Used by the
     explicit `extract_facts` MCP op so tool-call responses have real
     numbers.
   `notabilityFilter: 'high-only'` is the v0.31.2 sync-only filter
   (`:62`, used at `src/commands/sync.ts:891`). Other callers default
   to `'all'`.

3. **`queue.ts`** (206 lines) — process-singleton `FactsQueue` class.
   Cap **100 entries**, drop-oldest-on-overflow with counter
   increment (`:89-105`). Per-session in-flight cap of **1** so burst
   chat doesn't fan out 50 parallel Haiku calls (`:75, :151-157`).
   AbortSignal threading from server SIGTERM with a 5s grace period
   for in-flight extractions (`:73-83, :128-143`). Counters:
   `enqueued`, `completed`, `dropped_overflow`, `dropped_shutdown`,
   `failed` (`:62-68`). Failure-path errors are absorbed (queue
   surface is fire-and-forget); `console.warn` to stderr at
   `:174-175`.

4. **`classify.ts`** (226 lines) — `cosineSimilarity(a, b)` at
   `:44-57` (handles non-normalized embeddings). `classifyAgainstCandidates`
   implements the D12+D13 decision tree:
   - **Cheap fast-path**: top-candidate cosine ≥ 0.95 → DUPLICATE, skip
     LLM entirely (`:80, :30-31`).
   - LLM classifier (Haiku): duplicate | supersede | independent.
   - **Failure fallback**: on LLM error/timeout/refusal, cosine ≥ 0.92
     → DUPLICATE; else INSERT (`:32-33`).

5. **`decay.ts`** (63 lines, halflife model) — exported
   `HALFLIFE_DAYS: Record<FactKind, number>` at `:25-31`:
   - `event`: 7 days
   - `commitment`: 90 days
   - `preference`: 90 days
   - `belief`: 365 days
   - `fact`: 365 days
   `effectiveConfidence(fact, now)` = `confidence × exp(-age_days /
   halflife_days)`, clamped to [0,1]. Expired or past-`valid_until`
   facts return 0 (`:45-46`).

6. **`extract.ts`** (287 lines) — `extractFactsFromTurn` is the
   Haiku-driven extractor. Pipeline (`:7-17`):
   1. Sanitize via `INJECTION_PATTERNS` (shared with the takes/think
      sanitizer at `src/core/think/sanitize.ts`).
   2. Anti-loop check — if the page is `dream_generated:true`, skip.
   3. `gateway.chat()` with the extraction prompt.
   4. 4-strategy JSON parse fallback.
   5. Sanitize each fact text on the way OUT.
   6. Synchronous per-fact `gateway.embed()` so classifier paths have
      embeddings immediately.
   7. Return `NewFact[]` for the caller to insert.
   Kill-switch via `isFactsExtractionEnabled(engine)` reading the
   `facts.extraction_enabled` config row (defaults to TRUE, `:41-46`).
   Model resolves via `resolveModel` with tier `'reasoning'` (default
   `anthropic:claude-sonnet-4-6`, `:54-65`) — extraction is Sonnet,
   not Haiku, because notability judgment needs the smarter model.

7. **`absorb-log.ts`** (111 lines) — `writeFactsAbsorbLog(engine, ref,
   reason, detail, sourceId)`. Six stable reason codes
   (`FACTS_ABSORB_REASONS` at `:30-37`): `gateway_error`,
   `parse_failure`, `queue_overflow`, `queue_shutdown`,
   `embed_failure`, `pipeline_error`. Writes one row to the existing
   `ingest_log` table with `source_type='facts:absorb'`. The doctor's
   `facts_extraction_health` check reads these grouped by reason.

8. **`meta-hook.ts`** (132 lines) — `getBrainHotMemoryMeta(name, ctx,
   opts)` returns the `_meta.brain_hot_memory` payload for an MCP
   tool-call response.
   - **Skipped tool calls** (`:47`): `recall`, `extract_facts`,
     `forget_fact` — the agent doesn't need the brain's hot memory
     wrapped around its own recall response.
   - **Cache key**: `${sourceId}::${sessionId ?? '_'}::${allowListHash}`
     (`:53`). Visibility-aware via `takesHoldersAllowList` so entries
     don't bleed across token tiers.
   - **TTL**: 30s default (`DEFAULT_TTL_MS = 30_000` at `:21`),
     refreshed on extraction event via `bumpHotMemoryCache`
     (`:112-120`).
   - **Top-K**: default 10, capped at 25 (`:22, :56`).
   - **Visibility**: `remote === false` → all rows; remote → `['world']`
     only (`:66`).
   - **Sort**: by `effectiveConfidence` desc before truncation
     (`:87-88`).
   - Best-effort; failures degrade to no `_meta` rather than failing
     the tool call (module docstring `:7-8`).

### Trust model (the boundary every caller crosses)

- `runFactsBackstop` defaults to `'queue'` mode (fire-and-forget) —
  `backstop.ts:122`. Latency contract holds even under 50-page sync
  bursts.
- Sync passes `notabilityFilter: 'high-only'` so HIGH lands now,
  MEDIUM waits for the dream cycle to run notability re-judgment, LOW
  is dropped at the LLM layer
  (`src/commands/sync.ts:891`).
- Eligibility rejects `wiki/agents/*` slugs and any frontmatter with
  `dream_generated: true` — anti-loop, anti-subagent-scratch
  (`eligibility.ts:60-63`).
- Cosine dedup at 0.95 cheap-path threshold, `findCandidateDuplicates`
  top-k=5 (`backstop.ts:105-108`).
- Queue cap = 100, drop-oldest-on-overflow, per-session inflight = 1.

---

## 9. Consolidate phase (v0.31) — facts → takes promotion

File: `src/core/cycle/phases/consolidate.ts` (239 lines). The v0.31
phase that closes the hot-memory loop: hot facts get promoted into
durable `takes` rows on entity pages, and the facts themselves are
marked consolidated (never DELETEd — they remain the audit trail).

**Position**: AFTER `patterns` (graph fresh) and BEFORE `embed` (so
the new takes get embedded in the same cycle) —
`src/core/cycle.ts:1069-1095`.

**Algorithm** (`:1-22, :41-199`):

1. Pull every `(source_id, entity_slug)` bucket of unconsolidated
   active facts (`consolidated_at IS NULL AND expired_at IS NULL`),
   gated to `count >= minFactsPerBucket` (default 3). Uses the partial
   `idx_facts_unconsolidated` index.
2. For each bucket:
   - Re-fetch via `engine.listFactsByEntity` (returns active only;
     `:90-95`).
   - **Age gate**: oldest fact must be at least `minOldestAgeMs` old
     (default 24h; `:101-108`). Locks against same-day churn.
   - **Cluster**: greedy cosine clustering at threshold 0.85
     (`:111, :211-232`). Iterates facts sorted by `valid_from DESC`;
     each fact joins the first cluster whose head member's embedding
     is within threshold. Facts without embeddings cluster alone and
     fall out of the cycle (only clusters of size ≥ 2 produce takes;
     `:129`).
   - **Resolve entity_slug → page_id**. If the page is missing in this
     source, skip the cluster (no auto-page-creation in v0.31; the
     take needs a home — `:114-118`).
   - **Pick the take claim**: v0.31 ships with the highest-confidence
     fact's text (deterministic; `:130-133`). v0.32 will swap to
     Sonnet synthesis (TODO comment at `:11-13, :131-132`).
   - **INSERT into takes** via `engine.addTakesBatch` with
     `kind='fact'`, `holder='self'`, `weight=clamp01(avgWeight)`,
     `since_date` = earliest `valid_from`, `source` = comma-joined
     unique source-sessions truncated to 200 chars
     (`:135-160`).
   - **UPDATE contributing facts** via `engine.consolidateFact(f.id,
     takeId)` to set `consolidated_at = now()` and
     `consolidated_into = takeId` (`:176-180`).

**Totals**: contributes `facts_consolidated` and
`consolidate_takes_written` to the `CycleReport.totals`
(`src/core/cycle.ts:170-173, :1233-1235`).

`row_num` starts at `MAX(row_num) + 1` for the page so takes append
deterministically (`:121-126, :172`).

Phase returns `status: 'ok'` regardless of whether any facts were
consolidated (`:186` — the ternary is `factsConsolidated > 0 ? 'ok'
: 'ok'`, a redundant expression but explicit-by-intent). Fail returns
class `ConsolidateScanFailed` code `consolidate_scan_failed`
(`:71-82`) on the initial bucket-scan query.

---

## 10. Drift from CLAUDE.md (the audit)

CLAUDE.md is hand-maintained and lags. Items I verified against code:

1. **Phase-count headline lags by two.** CLAUDE.md's "Architecture"
   section and the `runCycle` per-file annotation describe nine
   phases. Code has eleven. The doc comment at
   `src/core/cycle.ts:13-28` is also nine-phase. The `ALL_PHASES`
   array at `:61-83` is the truth.

2. **Patterns reverse-write does not stamp `dream_generated`.**
   `src/core/cycle/patterns.ts:268-280` passes frontmatter through
   unmodified. Synthesize stamps the marker at
   `src/core/cycle/synthesize.ts:869-885`. Asymmetry. CLAUDE.md's
   per-file annotation for `patterns.ts` does not mention the marker
   either way. **Probable bug** — fix is two lines.

3. **`listRecentTranscripts` only accepts `.txt`.**
   `src/core/transcripts.ts:86` hardcodes the extension. Sibling
   `discoverTranscripts` (`transcript-discovery.ts:130`) accepts both
   `.txt` AND `.md`. CLAUDE.md's per-file annotation for
   `transcripts.ts` says ".txt transcripts"; not flagged as an
   asymmetry. **Probable bug** — `.md` users see synthesize work but
   the salience CLI returns empty.

4. **Facts layer is eight modules, not the four CLAUDE.md headlines.**
   The CLAUDE.md tour mentions extract, classify, decay, queue, and
   meta-hook but does not surface `eligibility.ts` as a separately
   testable single-source-of-truth predicate, nor does it frame
   `backstop.ts` as the "five-divergent-implementations consolidator"
   it is per its module docstring (`:18`). `absorb-log.ts` lands
   inside an annotation but its stable reason-code set is not in the
   tour.

5. **Consolidate phase exists but is annotated only as a per-file
   `phases/consolidate.ts` mention.** CLAUDE.md's per-file block for
   `cycle.ts` itself does not list `consolidate` in the canonical
   phase-order comment block. Only the cycle.ts source-of-truth
   comment at `:69-77` calls it out.

6. **TTL on the hot-memory cache is 30s by default**
   (`meta-hook.ts:21`); CLAUDE.md's claim matches. **Verified.**

7. **Queue cap = 100**, per-session inflight = 1, drop-oldest on
   overflow — `queue.ts:74-75`. CLAUDE.md's claim matches. **Verified.**

8. **Cosine dedup threshold = 0.95** for the cheap fast-path,
   `backstop.ts:105`. CLAUDE.md says "Cosine dedup at 0.95 threshold,
   top-k=5"; `DEDUP_CANDIDATE_LIMIT = 5` at `:108`. **Verified.**

9. **Halflife table** (`decay.ts:25-31`): event 7d, commitment 90d,
   preference 90d, belief 365d, fact 365d. Not in CLAUDE.md's facts
   tour; should be (it's the load-bearing knob for
   `effectiveConfidence` ordering in `_meta.brain_hot_memory`).

10. **`extract.ts` uses Sonnet, not Haiku**, despite the v0.31
    docstring at `extract.ts:2` calling it "turn-extractor (Haiku)".
    `getFactsExtractionModel` at `:53-65` resolves via tier
    `'reasoning'` with fallback `anthropic:claude-sonnet-4-6`. The
    module docstring is stale (drifted with the v0.31.12 model-tier
    rework). The CLAUDE.md note for `extract.ts` correctly says "Haiku
    for the extraction prompt" — both drifted in the same direction
    away from the actual default. **Doc drift.**

11. **Synthesize's `verdict_model` IS Haiku** (default
    `claude-haiku-4-5-20251001`), via
    `dream.synthesize.verdict_model`. Operator can swap it. CLAUDE.md
    states this in the synthesize.ts annotation correctly. **No drift.**

12. **`recompute_emotional_weight` is two SQL round-trips.** Verified
    at `recompute-emotional-weight.ts:6-10, :76-94`. CLAUDE.md claim
    matches.

13. **Anomaly stats use sample stddev (n-1)** at `anomaly.ts:44`.
    CLAUDE.md claim matches.

14. **Three callers of runCycle**: dream, autopilot, jobs handler.
    Verified at `dream.ts:278`, `autopilot.ts:341-342`,
    `jobs.ts:1070-1084`. CLAUDE.md claim matches.

15. The numbered "Phase N:" comments inside the runner block
    (`cycle.ts:902, :913, :941, :976, :1000, :1029, :1069, :1097,
    :1118, :1139`) are inconsistent — `embed` and `consolidate` are
    both labeled "Phase 8" in adjacent blocks; `orphans` and `purge`
    are both labeled "Phase 9". Cosmetic-only, but noisy when reading
    the file top-to-bottom. (Mentioned earlier in §1; flagging again
    here as a doc-drift finding.)

---

## Final note on the prior Instance 4's findings

The prior agent reported "TEN entries" in `ALL_PHASES`; the array has
**eleven** entries. The phase the prior summary did not surface is
`purge` (`src/core/cycle.ts:82`), which was added in v0.26.5 alongside
the destructive-guard wave. Otherwise the prior findings hold
verbatim: `consolidate` is between `patterns` and `embed`, the
`dream_generated` stamping is asymmetric between synthesize and
patterns, the `.md`/`.txt` discovery/listing asymmetry exists,
runFactsBackstop defaults to queue mode, eligibility rejects
`wiki/agents/*` + `dream_generated:true`, queue cap is 100, cosine
dedup 0.95/top-k 5, and the `_meta.brain_hot_memory` cache key is
visibility-aware with 30s TTL.
