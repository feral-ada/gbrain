# Instance 3 — AI Gateway, Search, Retrieval, Eval Capture, Cross-Modal Eval

GBrain's AI surface is one seam, not a stack of provider clients. Every chat, embedding, expansion, and multimodal call walks through `src/core/ai/gateway.ts`. Search is a hybrid pipeline (keyword + vector + RRF + source-boost + dedup) where the SQL-layer ranking is a set of pure string builders that both engines consume identically. Eval capture is fire-and-forget at the op layer. Cross-modal eval is three different-provider frontier models scoring an output. Every layer has a narrow seam with explicit reset semantics for tests; every layer fails closed where it counts.

## 1. Unified AI gateway

The gateway is module-scoped state behind a `configureGateway(config)` call. Pre-connect callers (rare bootstrap paths like `gbrain --version`) hit `configureGateway` synchronously; post-connect callers go through `reconfigureGatewayWithEngine(engine)` so DB-backed config keys (`models.tier.*`, `models.default`, per-task overrides) actually take effect.

The gateway never reads `process.env` at call time (`src/core/ai/gateway.ts:17`). Every env value is snapshotted into `AIGatewayConfig.env` (`src/core/ai/types.ts:263`) once at configure time. This is Codex C3, and it kills a whole class of "rotate the key, nothing happens" bugs because rotation goes through `configureGateway` which clears `_modelCache` (`gateway.ts:264`), `_shrinkState`, and `_extendedModels`.

`configureGateway` (`gateway.ts:253-279`) is the construction-time validator. After populating `_config` it (1) registers every model id from `embedding_model`, `embedding_multimodal_model`, `expansion_model`, `chat_model`, and `chat_fallback_chain` into `_extendedModels` (`gateway.ts:268-277`) via `registerExtendedModel`. The registry is the v0.31.12 escape hatch: recipes ship a fixed `models:` array, but users may opt into an arbitrary id via config. The registry lets `assertTouchpoint` skip its native-recipe allowlist throw for those ids; the provider's 404 surfaces at HTTP call time. (2) Calls `warnRecipesMissingBatchTokens()` (`gateway.ts:364-384`), printing once-per-process stderr for any embedding recipe missing `max_batch_tokens` and not carrying `no_batch_cap: true`. OpenAI is suppressed as the canonical "fast path is intentional" recipe (`gateway.ts:371`).

`reconfigureGatewayWithEngine(engine)` (`gateway.ts:300-337`) is async: re-resolves expansion via `resolveModel(engine, {tier: 'utility', configKey: 'models.expansion'})` and chat via `tier: 'reasoning'`. Embedding is deliberately NOT re-resolved (would invalidate the vector index). When `resolveModel` returns a bare id, `prefixWithProviderFrom` (`gateway.ts:340-344`) carries the existing provider prefix forward.

Test seams: `__setEmbedTransportForTests(fn)` (`gateway.ts:406`) and `__setChatTransportForTests(fn)` (`gateway.ts:421`) drive the public `embed()` / `chat()` entry points with stubbed transports, no `mock.module(...)` required. `resetGateway()` (`gateway.ts:387`) clears every module-scoped Map and restores transports.

## 2. Recipe + touchpoint model

Recipes are pure data declarations (`src/core/ai/types.ts:146-237`). Each carries `id`, `tier: 'native' | 'openai-compat'`, `implementation`, `auth_env`, an optional `aliases` map, and `touchpoints` with up to three keys: `embedding`, `expansion`, `chat`. Optional overrides: `resolveAuth?(env)` returns `{headerName, token}` so Azure can use `api-key:` instead of `Authorization: Bearer` (`gateway.ts:163-192`); `resolveOpenAICompatConfig?(env)` returns `{baseURL, fetch?}` for Azure's deployment + api-version template.

`EmbeddingTouchpoint` (`types.ts:26-102`) carries the v0.28.7 / v0.28.11 adaptive-batching fields:

- `max_batch_tokens?: number` — when set, gateway pre-splits at `max_batch_tokens × safety_factor / chars_per_token` characters AND turns on the recursive-halving safety net (`gateway.ts:776-780`). Unset = single `embedMany()` call (OpenAI fast path).
- `chars_per_token?: number` — defaults to 4 (`DEFAULT_CHARS_PER_TOKEN`, `gateway.ts:128`). Voyage declares 1.
- `safety_factor?: number` — defaults to 0.8 (`DEFAULT_SAFETY_FACTOR`, `gateway.ts:130`). Voyage declares 0.5 due to dense payloads.
- `multimodal_models?: string[]` — v0.28.11. Model-level allowlist for recipes that mix text-only + multimodal models; pre-flight check at `gateway.ts:987-992` closes the Voyage-text-only-into-multimodal-endpoint footgun.
- `no_batch_cap?: true` — explicit opt-out of the missing-cap warning for dynamic-cap recipes (Ollama, LiteLLM, llama-server).

Concrete recipes: **Anthropic** (`recipes/anthropic.ts:8-48`) chat + expansion only, models `claude-opus-4-7`/`claude-sonnet-4-6`/`claude-haiku-4-5-20251001`, `supports_subagent_loop: true`, `supports_prompt_cache: true`; reverse alias `claude-sonnet-4-6-20250929 -> claude-sonnet-4-6` rescues stale v0.31.6 configs. **OpenAI** (`recipes/openai.ts`) embedding `text-embedding-3-large`/`-small` default 1536 dims with options `[256,512,768,1024,1536,3072]`, no `max_batch_tokens`. **Voyage** (`recipes/voyage.ts:15-56`) openai-compatible over `https://api.voyageai.com/v1`, twelve models, `max_batch_tokens: 120_000`, `chars_per_token: 1`, `safety_factor: 0.5` (60K-char pre-split budget), `multimodal_models: ['voyage-multimodal-3']`. **Google** (`recipes/google.ts`) `gemini-embedding-001` at 768 default dims with `[768, 1536, 3072]` options.

## 3. Four-tier model routing

`src/core/model-config.ts:25` declares `ModelTier = 'utility' | 'reasoning' | 'deep' | 'subagent'`. `TIER_DEFAULTS` (`model-config.ts:68-73`): utility → Haiku, reasoning → Sonnet-4-6, deep → Opus-4-7, subagent → Sonnet-4-6.

`resolveModel(engine, opts)` (`model-config.ts:125-193`) walks 8 steps: CLI flag → new-key config → deprecated-key config → `models.default` → `models.tier.<tier>` → `GBRAIN_MODEL` env → `TIER_DEFAULTS[tier]` → caller-supplied fallback. Aliases resolve through `resolveAlias` (`model-config.ts:228-245`) with depth-2 cycle break; `DEFAULT_ALIASES` (`model-config.ts:51-57`) maps `opus/sonnet/haiku/gemini/gpt`.

Subagent enforcement is three layers. Layer 1: `MinionQueue.add()` rejects subagent jobs whose `data.model` resolves non-Anthropic. Layer 2: `enforceSubagentAnthropic(resolved, tier, source)` (`model-config.ts:205-217`) fires inside `resolveModel` when `tier === 'subagent'` and `isAnthropicProvider(resolved)` is false; emits once-per-(source, model) stderr warn and FALLS BACK to `TIER_DEFAULTS.subagent`. Layer 3: doctor's `subagent_provider` check warns on explicit non-Anthropic config.

`isAnthropicProvider` (`model-config.ts:85-97`) handles both `provider:model` form (lowercased prefix compare) and bare ids (`claude-` prefix). Conservative; warns on Anthropic-typo rather than silently routing `gpt-5` into the Anthropic tool-loop.

## 4. Embedding pipeline

`src/core/embedding.ts` is a thin shim. `embedBatch(texts, options)` paginates at `BATCH_SIZE = 100` (`embedding.ts:40`), the v0.28.7 revert from 50. Outer paginator is strictly about progress-callback granularity now.

Gateway `embed(texts)` (`gateway.ts:763-790`): resolve provider, truncate each text to `MAX_CHARS = 8000` (`gateway.ts:44, 768`), branch on `max_batch_tokens`. Voyage path calls `splitByTokenBudget(truncated, floor(max_batch_tokens × effectiveSafetyFactor(recipe)), charsPerToken)` (`gateway.ts:778-780`). OpenAI path: one batch. Each sub-batch goes through `embedSubBatch` (`gateway.ts:896-934`).

Adaptive shrink-on-miss: `_shrinkState` (`gateway.ts:121`) is a `Map<recipeId, {factor, consecutiveSuccesses}>`. On `isTokenLimitError(err)` (regex set at `gateway.ts:835-842`: `/max.*allowed.*tokens.*batch/i`, `/batch.*too.*many.*tokens/i`, `/token.*limit.*exceeded/i`), `shrinkOnMiss(recipe)` halves the factor (floor `SHRINK_FLOOR = 0.05`, `gateway.ts:124`) and recursively halves the batch at `mid = ceil(N/2)` (`gateway.ts:927-929`). On success, `recordSubBatchSuccess` increments `consecutiveSuccesses`; after `SHRINK_HEAL_AFTER = 10` (`gateway.ts:126`), the factor heals by ×1.5 toward the declared ceiling. `MIN_SUB_BATCH = 1` (`gateway.ts:722`); single-item batches that still fail throw `normalizeAIError`.

Dim parity is asserted post-call (`gateway.ts:911-917`) with an actionable `gbrain migrate --embedding-model X --embedding-dimensions Y` hint.

### Multimodal

`embedMultimodal(inputs)` (`gateway.ts:963-1101`) prefers `cfg.embedding_multimodal_model ?? cfg.embedding_model` (`gateway.ts:970-972`) so brains using OpenAI for text can route images through Voyage. Two pre-flight gates: `supports_multimodal: true` (`gateway.ts:975`) AND `multimodal_models.includes(parsed.modelId)` when declared (`gateway.ts:987-992`). Today Voyage-only. POSTs to `<baseUrl>/multimodalembeddings` in batches of `MULTIMODAL_BATCH_SIZE = 32` (`gateway.ts:945`), inputs wrapped as `{content: [{type: 'image_base64', image_base64: 'data:<mime>;base64,<data>'}]}` (`gateway.ts:1032-1041`). Fixed return dim 1024 (`gateway.ts:1024, 1089`).

### Voyage compat shim

`voyageCompatFetch` (`gateway.ts:541-653`): outbound forces `encoding_format: 'base64'` (Voyage rejects 'float') and translates OpenAI's `dimensions` → Voyage's `output_dimension`. Drops `Content-Length` so fetch recomputes.

Inbound has two OOM-defense layers. Layer 1 (`gateway.ts:591-600`): pre-parse `Content-Length` check vs `MAX_VOYAGE_RESPONSE_BYTES = 256 * 1024 * 1024` (`gateway.ts:140`). The pre-fix code did `await resp.clone().json()` first; a compromised endpoint could OOM the worker. Layer 2 (`gateway.ts:613-624`): per-embedding base64 cap (`0.75 × base64 length` decoded estimate vs the same 256MB ceiling) for the chunked-transfer case where `Content-Length` is absent. Inbound shape rewrite (`gateway.ts:602-643`): decode base64 strings to `number[]` for the SDK Zod schema; patch missing `usage.prompt_tokens`.

### Stale-only fast path

`gbrain embed --stale` starts with `engine.countStaleChunks()` (single `SELECT count(*) WHERE embedding IS NULL`). On a fully-embedded brain that's a 1-line short-circuit. When stale chunks exist, `engine.listStaleChunks()` returns ONLY the chunks needing embeddings, eliminating the page-walk that previously pulled every chunk's 1536-float embedding over the wire to discard most of it.

## 5. Hybrid search orchestration

`src/core/search/hybrid.ts:211-410` is the top-level orchestrator. Cathedral II shape: `Promise<SearchResult[]>` return; capture-side metadata rides through optional `onMeta?: (meta: HybridSearchMeta) => void` (`hybrid.ts:208`).

Pipeline: (1) `innerLimit = min(limit * 2, MAX_SEARCH_LIMIT)` (`hybrid.ts:218`) over-fetches for dedup. (2) `detail = opts?.detail ?? autoDetectDetail(query)` (`hybrid.ts:221`). (3) `keywordResults = engine.searchKeyword(query, searchOpts)` — always runs (`hybrid.ts:258`). (4) Three early-exit paths each call `runPostFusionStages` (`hybrid.ts:136-187`): (a) embedding unavailable (`hybrid.ts:280-287`), (b) vector lists empty after embed failure (`hybrid.ts:317-328`), (c) main hybrid path (`hybrid.ts:344-347`). v0.29.1 codex pass-2 #4 fix: post-fusion runs on all three so salience='on' doesn't silently no-op on embed failure. (5) `expand` → `embed` → `engine.searchVector` per query variant (`hybrid.ts:292-315`); embed failure → keyword-only fallback. (6) `rrfFusion(allLists, RRF_K, applyBoost)` (`hybrid.ts:417-459`); `RRF_K = 60` (`hybrid.ts:20`); each result accumulates `1 / (60 + rank)`. Normalize by max, then `COMPILED_TRUTH_BOOST = 2.0` (`hybrid.ts:21`) for compiled_truth chunks unless `detail === 'high'` (`hybrid.ts:333`). (7) `cosineReScore` blends `0.7 × normRrf + 0.3 × cosine` (`hybrid.ts:495`); DB error non-fatal. (8) Post-fusion runs backlink + salience + recency mutate-in-place; each is independent try/catch. (9) Two-pass expansion when `walkDepth > 0 || nearSymbol` (`hybrid.ts:358-391`): `expandAnchors` walks `code_edges_chunk + code_edges_symbol` up to `walkDepth` hops (cap `MAX_WALK_DEPTH = 2`); neighbors get score decayed by `1/(1+hop)`; per-page dedup cap lifts to `min(10, walkDepth * 5)`. (10) `dedupResults` five-layer pipeline. (11) Auto-escalate (`hybrid.ts:404-406`): if `detail='low'` returned 0, retry with 'high'; inner call's onMeta fires once.

### Boost coefficients

- `BACKLINK_BOOST_COEF = 0.05` (`hybrid.ts:31`); multiplier `1 + 0.05 × log(1 + count)`. 10 backlinks → ~1.12; 100 → ~1.23.
- Salience: `k = 0.30` for strong, `0.15` for on (`hybrid.ts:64`); factor `1 + k × log(1 + score)`, capped logarithmically.
- Recency: per-prefix `coefficient × halflifeDays / (halflifeDays + days_old)`; strong multiplies coefficient by 1.5; evergreen (halflife=0 or coef=0) contributes 0 (`hybrid.ts:112`).

### Dedup pipeline

`src/core/search/dedup.ts:37-70` five layers: (1) `dedupBySource` top 3 chunks per page by score (`dedup.ts:76-93`), composite `(source_id, slug)` page key (`dedup.ts:32-35`); (2) `dedupByTextSimilarity` Jaccard at `COSINE_DEDUP_THRESHOLD = 0.85` (`dedup.ts:99-124`); (3) `enforceTypeDiversity` max `MAX_TYPE_RATIO = 0.6` per type (`dedup.ts:129-143`); (4) `capPerPage` at `MAX_PER_PAGE = 2` (`dedup.ts:148-162`); (5) `guaranteeCompiledTruth` swaps in the best compiled_truth chunk from pre-dedup for pages missing one (`dedup.ts:168-208`).

## 6. Source-aware ranking

`src/core/search/sql-ranking.ts` is pure SQL string builders consumed by both engines via their "unsafe" SQL tag. User-controlled inputs (env vars, caller-supplied prefixes) are LIKE-pattern escaped (`%`, `_`, `\`) AND SQL-string escaped (single-quote doubling) before inlining (`sql-ranking.ts:20-33`). The slug column is engine-supplied, never user input.

`buildSourceFactorCase(slugColumn, boostMap, detail)` (`sql-ranking.ts:53-75`) emits `(CASE WHEN <col> LIKE 'prefix%' THEN <factor> ... ELSE 1.0 END)`. Longest-prefix-match wins via `b[0].length - a[0].length` sort (`sql-ranking.ts:66`): `media/articles/` (1.1) wins over `media/x/` (0.7) regardless of caller order. `detail === 'high'` returns literal `'1.0'` (`sql-ranking.ts:62`); loose-string guard handles `'HIGH'`/`'high '` from untyped MCP/JSON callers (`sql-ranking.ts:61`).

`buildHardExcludeClause(slugColumn, prefixes)` (`sql-ranking.ts:94-102`) emits `AND NOT (col LIKE 'p1%' OR col LIKE 'p2%' ...)`. The doc comment (`sql-ranking.ts:80-93`) calls out why: `NOT LIKE ALL(array)` means "doesn't match every pattern" (wrong semantics for set-exclusion), `NOT LIKE ANY` is non-standard, OR-chain wrapped in NOT is unambiguous and indexable.

`buildVisibilityClause(pageAlias, sourceAlias)` (`sql-ranking.ts:128-130`) is v0.26.5's two-filter fragment: page soft-delete (`p.deleted_at IS NULL`) AND source archive (`NOT s.archived`). NOT bypassed by `detail='high'`; soft-deleted stays hidden.

### Source-type boosts (concrete numbers)

`DEFAULT_SOURCE_BOOSTS` (`src/core/search/source-boost.ts:16-40`): originals/ 1.5, writing/ 1.4, concepts/ 1.3, people/companies/deals/ 1.2, meetings/ 1.1, media/articles/ 1.1, media/repos/ 1.1, yc/ 1.0, civic/ 1.0, daily/ 0.8, media/x/ 0.7, openclaw/chat/ 0.5.

`DEFAULT_HARD_EXCLUDES` (`source-boost.ts:46-51`): test/, archive/, attachments/, .raw/.

Env overrides: `GBRAIN_SOURCE_BOOST="prefix:factor,..."` parsed by `parseSourceBoostEnv` (`source-boost.ts:61-73`) with negative/non-finite filtering; `GBRAIN_SEARCH_EXCLUDE="prefix,..."` by `parseHardExcludesEnv` (`source-boost.ts:82-85`). `resolveHardExcludes` (`source-boost.ts:105-116`) computes `union(defaults, env, exclude_slug_prefixes) - include_slug_prefixes`.

### Two-stage CTE for vector

Per CLAUDE.md, `searchVector` in postgres-engine is a two-stage CTE: inner CTE keeps `ORDER BY cc.embedding <=> vec` so HNSW stays usable; outer SELECT re-ranks by `raw_score × source_factor`. Inner LIMIT scales with offset to preserve pagination. PGLite mirrors the shape.

## 7. Intent + expansion

`autoDetectDetail(query)` (`src/core/search/query-intent.ts:251-253`) routes through `classifyQuery(query).suggestedDetail`. Priorities (`query-intent.ts:232-238`): full-context → temporal → event → entity → general. Mapping: entity → low, temporal/event → high, general → undefined.

v0.29.1 classifier (`classifyQuery`, `query-intent.ts:192`) emits orthogonal `intent`/`suggestedSalience`/`suggestedRecency`. Canonical patterns ("what is X canonically") push recency='off' UNLESS explicit temporal bound present ("right now", "today", "since X"); the D6 narrow exception (`query-intent.ts:18-22`).

`expandQuery(query)` (`src/core/search/expansion.ts:56-87`) is the sanitization wrapper around `gateway.expand`. The boundary is deliberate: gateway is provider-agnostic, sanitization lives in `search/` not `ai/` (`expansion.ts:3-11`).

`sanitizeQueryForPrompt` (`expansion.ts:22-34`) strips code fences, HTML tags, leading injection-keyword sequences (`/^(\s*(ignore|forget|disregard|override|system|assistant|human)[\s:]+)+/gi`), excess whitespace. Caps at `MAX_QUERY_CHARS = 500`. Logs that stripping happened but NEVER logs the query text itself.

`sanitizeExpansionOutput` (`expansion.ts:39-54`) validates LLM output: strip control chars, dedup case-insensitively, cap at 2 alternatives. Original query stays the first entry (`expansion.ts:79-83`); only the sanitized copy goes to the LLM channel.

`MIN_WORDS = 3` gate (`expansion.ts:16, 60`): short queries skip the LLM call entirely. CJK text counts non-space characters (`expansion.ts:58-59`).

## 8. Eval-capture for BrainBench-Real

`src/core/eval-capture.ts:152-171` is the op-layer wrapper. `query` and `search` ops fire `void captureEvalCandidate(engine, ctx)` after returning. Fire-and-forget; caller does not await (`eval-capture.ts:149-150`).

`classifyCaptureFailure(err)` (`eval-capture.ts:129-142`) narrows Postgres SQLSTATE: `23514` CHECK violation, `42501` RLS reject, `42P01` undefined table (pre-v25), `53300/08006/08003` DB down. Scrubber exceptions classify by `err.name`. Reason persists via `engine.logEvalCaptureFailure(reason)` so doctor's `eval_capture` check sees drops cross-process.

Failure-of-failure: last-resort `console.warn` and drop (`eval-capture.ts:167-169`).

Three-layer gating: (1) `isEvalCaptureEnabled(config)` (`eval-capture.ts:192-196`): `config.eval.capture === true` on, `=== false` off, else `process.env.GBRAIN_CONTRIBUTOR_MODE === '1'` on, else off. Default-off as of v0.25.0. (2) `isEvalScrubEnabled(config)` (`eval-capture.ts:206-208`): defaults true; independent of capture so `CONTRIBUTOR_MODE` doesn't disable scrubbing accidentally. (3) PII scrubber regex families.

`src/core/eval-capture-scrub.ts:77-104` runs six families in order: emails first (so email-host doesn't get caught by phone regex), then phones, SSN (after phones; `+1-555-XX` shouldn't look like dashes-only SSN), JWT (distinctive `eyJ` prefix), bearer tokens, credit cards. CC matches go through Luhn (`scrub.ts:55-68`) before redaction — the false-positive guard. SSN regex requires dashes (`scrub.ts:40`). Phone regex uses negative lookbehind/lookahead `(?<!\d)...(?!\d)` to avoid matching in the middle of longer integers. Possessive-quantifier-free patterns plus outer try/catch contain ReDoS.

`captureEvalCandidate` keys rows by `(slug, source_id)` composite; multi-source brains don't conflate same-slug pages.

## 9. Cross-modal eval

`src/core/cross-modal-eval/runner.ts:118-186` orchestrator. Default cycles 3 in TTY, 1 in non-TTY (T11=B); clamped to [1, 3] (`runner.ts:297-302`).

`DEFAULT_SLOTS` (`runner.ts:46-50`): `openai:gpt-4o` / `anthropic:claude-opus-4-7` / `google:gemini-1.5-pro`. Three different families so blind spots don't correlate.

Per-cycle (`runner.ts:199-212`): `Promise.allSettled([callSlot(A), callSlot(B), callSlot(C)])`. Bare allSettled, no rate-leases (T4=A). Each fulfilled → `parseModelJSON(result.text)` (the 4-strategy fallback chain at `src/core/eval-shared/json-repair.ts`; `cross-modal-eval/json-repair.ts:16-17` is the re-export shim that preserves `ParsedModelResult` type re-export). Each rejected → `{ok: false, modelId, error: errorMessage(reason)}`.

`aggregate` (`src/core/cross-modal-eval/aggregate.ts:66-143`) thresholds (`aggregate.ts:60-64`): `PASS_MEAN_THRESHOLD = 7`, `PASS_FLOOR_THRESHOLD = 5`, `MIN_SUCCESSES_FOR_VERDICT = 2`.

Pass criterion (Q2=A): `(successes >= 2) AND (every dim mean >= 7) AND (every dim min across models >= 5)`.

Inconclusive guard (Q3=A regression guard, `aggregate.ts:73-86`): when `successes.length < 2`, return verdict 'inconclusive' BEFORE computing dimensions. The v1 `.mjs` version had `Object.values({}).every(...) === true` for empty arrays — empty scores map silently PASSed. The inconclusive short-circuit and the pinned regression test guard the empty-array PASS bug.

Cycles stop early on PASS or INCONCLUSIVE (`runner.ts:178`). The 3-cycle ladder is for marginal FAIL cases.

`estimateCost(slots, cycles, maxTokens)` (`runner.ts:321-364`): Anthropic prices read from `ANTHROPIC_PRICING` in `src/core/anthropic-pricing.ts:23-34` — the v0.31.12 fix that killed the drift trap. Opus 4.7 corrected from $15/$75 (Opus 4 generation) to $5/$25 (`anthropic-pricing.ts:27`). Non-Anthropic models still live inline (`runner.ts:336-345`). Missing-model rows print stderr note rather than silently zero (`runner.ts:351-353`).

`receiptName(slug, content)` (`receipt-name.ts:41-47`) emits `<slug>-<sha8>.json`; sha8 is the first 8 hex of SHA-256 of skill content. Multi-cycle receipts append `.cycle<N>` (`runner.ts:148-149`). `findReceiptForSkill` (`receipt-name.ts:53-98`) returns 'found' / 'stale' / 'missing'; the status drives skillify-check item 11 as informational only (T7=C).

`writeReceipt` (`receipt-write.ts:13-17`) wraps `writeFileSync` with `mkdirSync({recursive: true})` because `gbrainPath()` does NOT auto-mkdir (T5 correction).

## 10. Drift between CLAUDE.md and code

A handful of small drifts noted while reading:

- `MAX_CHARS = 8000` confirmed at `gateway.ts:44`. `DEFAULT_CHAT_MODEL` is `anthropic:claude-sonnet-4-6` (`gateway.ts:48`). `DEFAULT_EXPANSION_MODEL` is `anthropic:claude-haiku-4-5-20251001` (`gateway.ts:47`). All match CLAUDE.md.
- Cross-modal `DEFAULT_SLOTS` matches CLAUDE.md exactly (`runner.ts:46-50`).
- `anthropic-pricing.ts` header says "as of 2026-05-01" (`anthropic-pricing.ts:6`) while recipe `price_last_verified` for Anthropic is `'2026-05-10'` (`anthropic.ts:22`). A 9-day skew between the constant table and the recipe declaration. Operationally fine (both advisory; budget meter consults `ANTHROPIC_PRICING`) but worth flagging if anyone audits price freshness from a single date.
- `embedBatch` `BATCH_SIZE = 100` confirmed at `embedding.ts:40`; fast path skips the inner loop when no progress callback and batch fits (`embedding.ts:47-49`). Matches the v0.28.7 revert claim.
- `_extendedModels` registry is threaded through all three resolve paths (`gateway.ts:657, 1112, 1315`); `assertTouchpoint`'s 4th-arg path (`model-resolver.ts:85-119`) only fires for native recipes (`model-resolver.ts:105`) so openai-compat recipes like Ollama / LiteLLM still accept arbitrary model ids unconditionally.
- `effectiveSafetyFactor` (`gateway.ts:848-852`) reads `_shrinkState.get(recipe.id)?.factor ?? declared`; only `safety_factor` is shrunk on miss, not `chars_per_token`. Correct: `chars_per_token` is a tokenizer-density constant per provider, not runtime-adaptive.
- Voyage recipe comment at `voyage.ts:51` flags a TODO to reclassify HTTP 400 from transient. The v0.28.11 `multimodal_models` pre-flight (`gateway.ts:987-992`) narrows the surface but doesn't fix the underlying classification.

The single most load-bearing seam in this layer is the gateway's `_extendedModels` registry combined with `assertTouchpoint`'s 4th-arg path. It cleanly separates "source-code typo" (still fail-fast) from "config-derived choice" (provider 404 surfaces at the doctor probe). The structural fix for the v0.31.6 phantom-model class is the registry, not loosening the validator.
