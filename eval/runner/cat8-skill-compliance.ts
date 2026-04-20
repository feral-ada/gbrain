/**
 * Cat 8 — Skill Behavior Compliance.
 *
 * Replays inbound signals through the agent adapter (Sonnet + gbrain tools)
 * and measures four structural iron-laws:
 *
 *   - **brain_first_compliance** — did the agent call search/get_page
 *     BEFORE producing its final answer? Threshold (informational): >0.95.
 *   - **back_link_compliance** — every `dry_run_put_page` intent has
 *     at least one markdown back-link in its compiled_truth. Threshold: >0.90.
 *   - **citation_format** — timeline entries in dry_run writes follow the
 *     canonical `- **YYYY-MM-DD** | Source — Summary` pattern; final
 *     answers cite slugs in markdown or backticks. Threshold: >0.95.
 *   - **tier_escalation** — complex probes get tool calls (not just direct
 *     answers from general knowledge); simple probes stay light. Threshold: >0.80.
 *
 * v1 verdict is `baseline_only` — the 10-probe calibration that would
 * set thresholds requires real Opus runs against the Day 3b amara-life-v1
 * corpus. Once κ > 0.7 calibration lands, enableThreshold can flip on.
 *
 * All metrics are computed from `tool_bridge_state` + `made_dry_run_writes`
 * + the final answer text. NO judge call needed for Cat 8 — everything is
 * deterministic from the transcript.
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import {
  runAgentLoop,
  type AgentAdapterState,
  type AgentRunConfig,
  type AgentRunResult,
} from './adapters/claude-sonnet-with-tools.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type ProbeTier = 'simple' | 'complex';

export interface SkillComplianceProbe {
  /** Stable id, e.g. "sig-0001". */
  id: string;
  /** The inbound signal text — what a user/agent would paste to the brain. */
  text: string;
  /**
   * Tier hint for the tier_escalation metric.
   *   - simple: direct fact lookup, expected to resolve in ≤2 tool calls
   *   - complex: multi-hop, synthesis, or dry_run writes expected
   */
  tier: ProbeTier;
  /**
   * If true, the probe expects the agent to perform at least one dry_run
   * write. Used by tier_escalation: a complex probe that never writes is a
   * failure.
   */
  expects_dry_run_write?: boolean;
}

export interface SkillCompliancePerProbe {
  probe_id: string;
  tier: ProbeTier;
  brain_first: AgentRunResult['brain_first_ordering'];
  brain_first_compliant: boolean;
  dry_run_writes: number;
  back_link_compliant: boolean;
  citation_format_compliant: boolean;
  tier_escalation_correct: boolean;
  stop_reason: AgentRunResult['stop_reason'];
  total_cost_usd: number;
}

export interface Cat8Report {
  schema_version: 1;
  ran_at: string;
  total_probes: number;
  brain_first_compliance: number;
  back_link_compliance: number;
  citation_format: number;
  tier_escalation: number;
  per_probe: SkillCompliancePerProbe[];
  total_cost_usd: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
}

export interface Cat8Config extends Omit<AgentRunConfig, 'client'> {
  /** Agent Sonnet client. Default uses ANTHROPIC_API_KEY lazy singleton. */
  client?: Anthropic;
  /** Thresholds override. Default: design-doc METRICS.md numbers. */
  thresholds?: {
    brain_first_compliance?: number;
    back_link_compliance?: number;
    citation_format?: number;
    tier_escalation?: number;
  };
  /** When false (default in v1), verdict is always baseline_only. */
  enableThreshold?: boolean;
  /** Bounded concurrency across probes. Default 4. */
  concurrency?: number;
}

export interface RunCat8Options extends Cat8Config {
  probes: SkillComplianceProbe[];
  state: AgentAdapterState;
}

// ─── Compliance checks ───────────────────────────────────────────────

const CITATION_TIMELINE_RE = /^- \*\*\d{4}-\d{2}-\d{2}\*\*\s*\|\s*.+?\s*[—-]\s*.+$/m;
const MD_LINK_OR_BACKTICK_SLUG_RE = /(\[[^\]]+\]\(([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)|`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`)/i;

function finalAnswerCiteCount(text: string): number {
  const md = /\[[^\]]+\]\(([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)/g;
  const bt = /`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`/g;
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) slugs.add(m[1]);
  while ((m = bt.exec(text)) !== null) slugs.add(m[1]);
  return slugs.size;
}

function scoreBrainFirst(result: AgentRunResult): boolean {
  return result.brain_first_ordering === 'brain_before_answer';
}

function scoreBackLinkCompliance(result: AgentRunResult): boolean {
  const writes = result.tool_bridge_state.made_dry_run_writes;
  if (writes.length === 0) return true; // vacuous
  // Every dry_run_put_page write must have back-links. dry_run_add_link
  // and dry_run_add_timeline_entry are link writes themselves and always
  // satisfy this metric.
  for (const w of writes) {
    if (w.tool_name === 'dry_run_put_page' && w.has_back_links === false) return false;
  }
  return true;
}

function scoreCitationFormat(result: AgentRunResult): boolean {
  // 1. Timeline entries in any dry_run write must match the canonical format.
  for (const w of result.tool_bridge_state.made_dry_run_writes) {
    if (w.citation_format_ok === false) return false;
  }

  // 2. If the final answer makes any factual claims (non-trivial length),
  //    it must cite at least one slug. Keep this permissive — a terse
  //    answer like "I don't know" shouldn't be penalized.
  const text = result.final_answer.trim();
  if (text.length >= 80) {
    if (!MD_LINK_OR_BACKTICK_SLUG_RE.test(text)) return false;
  }
  return true;
}

function scoreTierEscalation(probe: SkillComplianceProbe, result: AgentRunResult): boolean {
  const brainCalls = Object.entries(result.tool_bridge_state.count_by_tool)
    .filter(([name]) => BRAIN_READ_TOOLS.has(name))
    .reduce((sum, [, n]) => sum + n, 0);
  const writes = result.tool_bridge_state.made_dry_run_writes.length;

  if (probe.tier === 'simple') {
    // Simple probes should use LITTLE tooling. One brain read is enough.
    // We're lenient: any brain read at all passes. (A simple probe that
    // makes zero brain calls fails brain_first anyway.)
    return brainCalls >= 1;
  }

  // Complex probes: must use brain + must satisfy expects_dry_run_write
  if (probe.expects_dry_run_write) {
    return brainCalls >= 1 && writes >= 1;
  }
  // Complex without explicit write expectation: ≥2 tool calls total
  // (multi-hop signal).
  return brainCalls >= 2;
}

const BRAIN_READ_TOOLS = new Set([
  'search',
  'query',
  'get_page',
  'list_pages',
  'get_backlinks',
  'get_links',
  'get_timeline',
  'get_tags',
  'traverse_graph',
  'resolve_slugs',
  'get_chunks',
  'get_stats',
]);

// ─── Runner ──────────────────────────────────────────────────────────

async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function runCat8(opts: RunCat8Options): Promise<Cat8Report> {
  const concurrency = opts.concurrency ?? 4;
  const thresholds = {
    brain_first_compliance: 0.95,
    back_link_compliance: 0.9,
    citation_format: 0.95,
    tier_escalation: 0.8,
    ...opts.thresholds,
  };

  const perProbe = await runConcurrently(opts.probes, concurrency, async probe => {
    const result = await runAgentLoop(probe.id, probe.text, opts.state, {
      client: opts.client,
      model: opts.model,
      maxTokens: opts.maxTokens,
      turnCap: opts.turnCap,
      systemPrompt: opts.systemPrompt,
      maxRetries: opts.maxRetries,
    });
    const score: SkillCompliancePerProbe = {
      probe_id: probe.id,
      tier: probe.tier,
      brain_first: result.brain_first_ordering,
      brain_first_compliant: scoreBrainFirst(result),
      dry_run_writes: result.tool_bridge_state.made_dry_run_writes.length,
      back_link_compliant: scoreBackLinkCompliance(result),
      citation_format_compliant: scoreCitationFormat(result),
      tier_escalation_correct: scoreTierEscalation(probe, result),
      stop_reason: result.stop_reason,
      total_cost_usd: result.total_cost_usd,
    };
    void finalAnswerCiteCount; // exported below for test visibility
    return score;
  });

  const total = perProbe.length;
  const brain = perProbe.filter(p => p.brain_first_compliant).length;
  const back = perProbe.filter(p => p.back_link_compliant).length;
  const cite = perProbe.filter(p => p.citation_format_compliant).length;
  const tier = perProbe.filter(p => p.tier_escalation_correct).length;
  const metrics = {
    brain_first_compliance: total === 0 ? 0 : brain / total,
    back_link_compliance: total === 0 ? 0 : back / total,
    citation_format: total === 0 ? 0 : cite / total,
    tier_escalation: total === 0 ? 0 : tier / total,
  };

  let verdict: 'pass' | 'fail' | 'baseline_only';
  if (!opts.enableThreshold) {
    verdict = 'baseline_only';
  } else {
    const allPass =
      metrics.brain_first_compliance >= thresholds.brain_first_compliance &&
      metrics.back_link_compliance >= thresholds.back_link_compliance &&
      metrics.citation_format >= thresholds.citation_format &&
      metrics.tier_escalation >= thresholds.tier_escalation;
    verdict = allPass ? 'pass' : 'fail';
  }

  return {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    total_probes: total,
    brain_first_compliance: metrics.brain_first_compliance,
    back_link_compliance: metrics.back_link_compliance,
    citation_format: metrics.citation_format,
    tier_escalation: metrics.tier_escalation,
    per_probe: perProbe,
    total_cost_usd: perProbe.reduce((sum, p) => sum + p.total_cost_usd, 0),
    verdict,
  };
}

// Exports for tests
export {
  scoreBrainFirst,
  scoreBackLinkCompliance,
  scoreCitationFormat,
  scoreTierEscalation,
  finalAnswerCiteCount,
};
