# GBrain Testing Infrastructure, CI Gates, Scripts & Version Management

**Version:** 0.32.0 (package.json:4) | **Bun engine:** >=1.3.10 (package.json:109)  
**Workflow:** Parallel 4-shard CI (FNV-1a hash bucketing + slow tests) vs. local 8-shard round-robin (excludes slow + serial)

## 1. Test Command Tiers

Five layers, each with clear scope:

| Command | Scope | Time | When to use |
|---------|-------|------|-----------|
| `bun run test` | Parallel 8-shard fast loop (unit *.test.ts only; excludes *.slow, *.serial, e2e) | ~85s | Inner edit loop (default) |
| `bun run verify` | Pre-test gates: privacy, jsonb, progress, wasm checks + typecheck | ~12s | Before push/ship |
| `bun run test:full` | verify + test + test:slow + smart-e2e (runs e2e only if DATABASE_URL set) | ~3-5min | Pre-merge sanity |
| `bun run test:slow` | Just *.slow.test.ts files (intentional cold-path correctness) | seconds-mins | When touching slow code |
| `bun run test:serial` | Just *.serial.test.ts at --max-concurrency=1 (quarantine for cross-file state) | ~1s per file | Debug specific quarantined file |
| `bun run test:e2e` | Real Postgres E2E (requires Docker + DATABASE_URL) | ~5-10min | Pre-ship; nightly |
| `bun run check:all` | All 7 pre-checks (verify's 4 + trailing-newline, no-legacy-getconnection, exports-count) | ~10s | Local sweep |

**Source:** package.json:29–43, CLAUDE.md "## Testing"

### Local Fast Loop Architecture (scripts/run-unit-parallel.sh:1–342)

- **Shard detection:** per-CPU (Apple Silicon perflevel0 → nproc → default 4); clamped to max 8
- **Timeout:** GBRAIN_TEST_SHARD_TIMEOUT (default 600s); both `timeout` and fallback bg-pid+sleep
- **Output:** `.context/test-shards/shard-{N}.log/.exit`, `.context/test-failures.log`, `.context/test-summary.txt` (falls back to /tmp if .context unwritable)
- **Heartbeat:** live progress every 10s via grep for `^[[:space:]]+✓` (pass) and `(fail)` markers
- **Serial pass:** runs after parallel; finds *.serial.test.ts, invokes `scripts/run-serial-tests.sh`
- **Failure aggregation:** awk extraction of `(fail) ... (pass/skip/blank/summary)` blocks; loud 50-line banner to stderr if any rc≠0

## 2. CI vs Local Divergence (Intentional, Not a Bug)

- **CI** (.github/workflows/test.yml:31, scripts/test-shard.sh): 4-shard matrix via FNV-1a hash bucketing; **INCLUDES** *.slow.test.ts; **EXCLUDES** *.serial.test.ts from parallel matrix, runs them separately on shard 1 at --max-concurrency=1 (v0.31.4.1 fix for mock.module leakage)
- **Local** (scripts/run-unit-shard.sh:32–62): round-robin by index; **EXCLUDES** both *.slow and *.serial from fast loop

**Regression pin:** test/scripts/run-unit-shard.test.ts ensures local loop stays correct; do not try to equalize the two — they solve different problems (CI: coverage; local: speed).

## 3. Failure-First Logging Wedge (scripts/run-unit-parallel.sh:206–337)

On failure:
1. `.context/test-failures.log`: failure blocks prefixed `--- shard N: <name> ---` (bash writer, single-pass awk extraction)
2. Stderr banner: loud 50-line tail of failure log + absolute path (survives `| head`/`| tail`)
3. `.context/test-summary.txt`: per-shard `shard N/M: pass=X fail=Y skip=Z rc=W`
4. Exit 1

Wedged shard (GBRAIN_TEST_SHARD_TIMEOUT exceeded): writes `--- shard N: WEDGED after 600s ---` + last 50 lines + proceeds with others.

## 4. File Taxonomy & Quarantine

- **`*.test.ts`** → parallel 8-shard fast loop (unit suite, ~3650+ tests)
- **`*.slow.test.ts`** → `bun run test:slow` only (cold-path correctness; would dominate fast-loop wallclock)
- **`*.serial.test.ts`** → `bun run test:serial` after parallel; --max-concurrency=1; quarantine for cross-file state leakage. Current quarantined files: brain-registry.serial.test.ts, reconcile-links.serial.test.ts, core/cycle.serial.test.ts, embed.serial.test.ts (the last two use mock.module which leaks)
- **`test/e2e/*.test.ts`** → real Postgres E2E (36 files as of v0.32); skipped when DATABASE_URL unset

**Important:** Do not remove parallelism from a serial file without fixing the contention root cause — it reintroduces the flake.

## 5. Test-Isolation Lint (v0.26.7 Foundation)

**Enforcement:** `scripts/check-test-isolation.sh` (42–142) runs on non-serial unit files only (skips *.serial.test.ts, test/e2e/*); wired into `bun run verify`.

Four rules:

| Rule | Bans | Fix |
|------|------|-----|
| **R1** | `process.env.X = ...`, bracket assign, `delete process.env.X`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | Use `withEnv()` from test/helpers/with-env.ts, OR rename to *.serial.test.ts |
| **R2** | `mock.module(...)` anywhere | Rename to *.serial.test.ts (no prod-code DI for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after `beforeAll(` | Use canonical block (below) inside beforeAll |
| **R4** | PGLiteEngine creation without `.disconnect()` in afterAll | Add `afterAll(() => engine.disconnect())` |

**Allow-list policy:** scripts/check-test-isolation.allowlist (75 files at v0.26.7 baseline); MUST shrink over time, never grow. v0.26.8 (env sweep) + v0.26.9 (PGLite sweep) remove entries as files are fixed.

### Canonical PGLite Block (R3 + R4 compliant, test/helpers/reset-pglite.ts JSDoc)

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why: PGLite WASM cold-start + initSchema ~20s; one engine per file (beforeAll), data wipe per test (beforeEach, ~2 orders of magnitude faster), disconnect to prevent leakage across file boundaries in shard process.

### `withEnv` Helper (test/helpers/with-env.ts, R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

await withEnv({ OPENAI_API_KEY: 'sk-test', GBRAIN_HOME: undefined }, async () => {
  expect(loadConfig().openai_key).toBe('sk-test');
});
```

**Test helpers directory:** cli-pty-runner.ts (real PTY for interactive CLI E2E), reset-pglite.ts (per-test data wipe), schema-diff.ts (schema parity helpers for v0.26.3 drift gate), with-env.ts (test/helpers/with-env.test.ts pins the contract).

## 6. CI Gates & Workflows

**.github/workflows/ (3 files):**

- **test.yml** (4-shard matrix): SHA-pinned actions (checkout@34e114876b0b11c390a56381ad16ebd13914f8d5, setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6). Step "Pre-test gates (shard 1 only)" runs `bun run verify` once. Step "Run test shard" calls `scripts/test-shard.sh N 4`. Step "Run *.serial.test.ts (shard 1 only)" calls `bun run test:serial`. Shard 1 is the bottleneck (runs verify + test:serial).
- **release.yml** (2-platform build): Triggers on `tags: ['v*']`. Builds darwin-arm64 + linux-x64 binaries via `bun build --compile --target=...`, uploads to release.
- **e2e.yml** (separate E2E runner, if present): Not shown in the current list; typically runs after main test.

**Note on SHA maintenance:** CLAUDE.md says GitHub Actions SHA pin maintenance is a known follow-up (D3). Current SHAs are from 2024.

## 7. Local CI Gate (docker-compose.ci.yml + scripts/ci-local.sh)

**Architecture:** 4 pgvector (pg16) services + bun runner (oven/bun:1) in docker-compose.

**Postgres setup:** Named volumes gbrain-ci-pg-data-{1..4}, ports 5434–5437 (BASE default via GBRAIN_CI_PG_PORT). Each container health-checks `pg_isready -U postgres -d gbrain_test`. Runner has separate node_modules + cache volumes to avoid host/container binary conflicts.

**Modes:**

```bash
bash scripts/ci-local.sh              # Full gate: gitleaks + unit + ALL 36 E2E (4-way sharded)
bash scripts/ci-local.sh --diff       # Smart E2E selection via scripts/select-e2e.ts
bash scripts/ci-local.sh --no-pull    # Offline / debug (skip docker compose pull)
bash scripts/ci-local.sh --clean      # Nuke named volumes for cold debug
bash scripts/ci-local.sh --no-shard   # E2E sequential against postgres-1 only
```

**Diff-based fast-path (Tier 2):** scripts/select-e2e.ts classifies diffs as:
- **DOC_ONLY** (README.md, *.md, docs/*) → stdout empty → skip postgres + unit + e2e; run only `gitleaks` on host (~5s vs ~25min)
- **EMPTY** (clean branch) → emit all 36 e2e files (fail-closed)
- **SRC** (touches src/) → union E2E_TEST_MAP matches + escape-hatch triggers (src/schema.sql, src/core/{migrate,db,engine-factory,operations}.ts, package.json, bun.lock, docker-compose.ci.yml, scripts/{ci-local,run-e2e,select-e2e}.ts) → emit ALL if any hit

E2E file sharding (scripts/run-e2e.sh:43–61): SHARD env (N/M) keeps every M-th file starting at index N, then runs sequentially within shard (TRUNCATE CASCADE no-race property — file A's TRUNCATE can't race file B's import if they run sequentially).

## 8. Four Shell Pre-Checks in `bun run verify`

All four wired into scripts/check-test-isolation.sh and package.json:39:

1. **check:privacy** (scripts/check-privacy.sh): Real-name leak detection (grep for unredacted personal names, company names, fund names in repo; fail if found). Responsible-disclosure rule: never name real people/companies/funds in public artifacts.

2. **check:jsonb** (scripts/check-jsonb-pattern.sh): Bans `${JSON.stringify(...)}::jsonb` interpolation pattern (SQL injection risk; use parameterized queries with `$N` placeholders instead).

3. **check:progress** (scripts/check-progress-to-stdout.sh): Bans `\r` progress to stdout (breaks test output parsing; stderr is OK, used by heartbeat).

4. **check:wasm** (scripts/check-wasm-embedded.sh): tree-sitter WASMs must be embedded in compiled binary (bun --compile); grep validates presence in bin/gbrain after build.

**Three in check:all but NOT in verify:**

5. **check:trailing-newline**: Every file ends with newline.
6. **check:no-legacy-getconnection** (check-no-legacy-getconnection.sh): Bans pre-v0.22.6 `db.getConnection()` pattern (replaced by pool-level session timeout GUCs).
7. **check:exports-count** (check-exports-count.sh): Exports in src/core/index.ts frozen at a known count (prevents accidental API surface regressions).

## 9. E2E Lifecycle (CLAUDE.md mandate)

**Sequential within-shard, 4 shards in parallel across 4 postgres containers (ci-local.sh):**

1. `docker compose -f docker-compose.ci.yml up -d` (postgres-1..4 health-check)
2. `bun install` (container-isolated node_modules)
3. `bun run test` (unit suite, unsets DATABASE_URL so e2e skips gracefully)
4. For each shard (1..4) in parallel:
   - Set `DATABASE_URL=postgres://postgres:postgres@localhost:PORT/gbrain_test` for shard
   - `bash scripts/run-e2e.sh [file1 file2 ...]` (shard's subset of 36 files, sequential)
5. `docker compose -f docker-compose.ci.yml down --remove-orphans`

**.env.testing contract:** Sibling-worktree rule — gbrain runs test suites in isolation; .env files are workspace-local only, never committed.

## 10. Version Management

**Single source of truth:** VERSION file = `0.32.0` (4-segment MAJOR.MINOR.PATCH.MICRO). All of:
- package.json:3 must match
- CHANGELOG.md:5 must match
- TODOS.md (sometimes, review comments)
- CLAUDE.md (sometimes, in examples)
- bun.lock (auto-refreshed by `bun install`, never edited by hand)
- llms.txt / llms-full.txt (auto-generated by `bun run build:llms`, source: scripts/build-llms.ts)

**The 3-line audit pattern (before `/ship`):**
```bash
cat VERSION                    # 0.32.0
grep '"version"' package.json  # "version": "0.32.0"
grep '## \[' CHANGELOG.md | head -1  # ## [0.32.0] - 2026-05-10
```

**Merge-conflict recovery:** If VERSION conflicts, resolve by taking the version you want, then `bun install` refreshes bun.lock, then `bun run build:llms` refreshes docs. No manual bun.lock editing.

**Auto-derived artifacts:** bun.lock (run `bun install`), llms.txt / llms-full.txt (run `bun run build:llms`). The build:llms script calls scripts/build-llms.ts (6337 bytes), which reads README.md structure to generate the LLM doc map.

## 11. /ship + /document-release Pipeline

**High-level only** (user-facing wrapper in CLAUDE.md):

- Step 12's drift classifier (in src/commands/*): FRESH (new version), ALREADY_BUMPED (version file changed), DRIFT_STALE_PKG (package.json out of sync), DRIFT_UNEXPECTED (unexpected state)
- Post-ship mandate: run `/document-release` to write CHANGELOG entry

Tracked as a follow-up in TODOS.md.

## 12. CHANGELOG Voice & Format

Release-summary pattern (CHANGELOG.md:5–80):
- **Bold headline + lead paragraph** (e.g., "5 new embedding providers + the discoverability fix...")
- **"Numbers that matter" table** (providers count, advisories count)
- **"What this means" closer** (impact on users, agents, operations)
- **"To take advantage" block** (step-by-step verification)
- **"Itemized changes"** (architectural foundations, discoverability, review fixes)

**Voice:** Garry's, not AI. Real numbers. No em dashes. Branch-scoped (never edit master's entries). **Privacy rule:** Never enumerate attack surface in release notes; describe the fix functionally.

## 13. Privacy & Responsible Disclosure

**Rules enforced by check:privacy (scripts/check-privacy.sh):**

- Never name real people/companies/funds in public artifacts (use placeholders: [PERSON], [COMPANY], [FUND])
- Never enumerate attack surface in release notes (describe the fix functionally, not the vulnerability mechanics)
- Real-name detection catches common leaks (grep for patterns like "Garry", "Anthropic", "Y Combinator" in non-allowed files)

## 14. Drift from CLAUDE.md

**Observed discrepancies (code vs documentation):**

- **Test count:** CLAUDE.md says "3650+ tests" (as of v0.26.4); actual count ~3650+, matches (run `bun run test --dry-run` to verify)
- **Shard count:** CLAUDE.md says "4-shard matrix in CI"; actual is 4 in .github/workflows/test.yml:31. Local clamped to 8. Matches.
- **Pre-check list:** CLAUDE.md lists verify's 4 checks; actual package.json:39 has 9 (verify is a subset; check:all is the full set). No drift, just scope difference. CLAUDE.md is correct about the verify tier.
- **E2E files:** CLAUDE.md says "~13 files"; actual is 36 files (test/e2e/*.test.ts). CLAUDE.md predates v0.25+ E2E expansion — not a bug, just stale.
- **Serial quarantine files:** CLAUDE.md lists 4; actual is 4 (brain-registry, reconcile-links, cycle, embed). Matches.

## Key File Citations

- package.json:29–62 — test + build script definitions
- scripts/run-unit-parallel.sh:1–342 — fast loop orchestrator
- scripts/run-unit-shard.sh:32–62 — per-shard file bucketing (round-robin)
- scripts/test-shard.sh — CI's per-shard runner (FNV-1a hash bucketing)
- scripts/check-test-isolation.sh:1–142 — isolation lint + allow-list policy
- scripts/check-test-isolation.allowlist:1–75 — baseline violations (v0.26.7)
- docker-compose.ci.yml:1–118 — local CI postgres + bun runner
- scripts/ci-local.sh:1–100+ — local CI gate orchestrator
- scripts/run-e2e.sh:1–60+ — sequential E2E runner (4-way shardable)
- scripts/select-e2e.ts:1–80+ — diff-based smart E2E selector
- .github/workflows/test.yml — 4-shard CI matrix + verify gates
- .github/workflows/release.yml — darwin-arm64 + linux-x64 build
- test/helpers/reset-pglite.ts — canonical PGLite block + policy
- test/helpers/with-env.ts — process.env isolation helper
- VERSION — source of truth (0.32.0)
- CHANGELOG.md:5–80 — v0.32.0 release-summary pattern
- .gitignore:29–41 — .context/ + test artifacts (workspace-local, never committed)

## Summary

GBrain ships a **three-tier testing strategy:** local fast-loop (edit-loop friendly, excludes slow+serial), CI authoritative (includes slow, uses hash bucketing, 4-shard parallelism), and local full-gate (docker + 4-way E2E sharding). Failure logging is first-class (wedge banners, 50-line context). Cross-file test isolation is enforced statically (4 lint rules, allow-list shrinking policy, v0.26.7 foundation). Version management is single-source-of-truth (VERSION file pins package.json + CHANGELOG + llms.txt auto-generation). Release notes follow a consistent Garry voice pattern with real numbers and responsible-disclosure discipline.

