/**
 * Cat 9 — End-to-End Workflows.
 *
 * Replays ~50 scripted scenarios across 5 workflows through the agent
 * adapter, then scores each answer via judge.ts's rubric. Threshold
 * (informational): >80% pass rate per workflow.
 *
 * Workflows (canonical per TODOS.md and design-doc):
 *   - meeting_ingestion
 *   - email_to_brain
 *   - daily_task_prep
 *   - briefing
 *   - sync
 *
 * Each scenario carries its own rubric (3-5 criteria, weights 1-2). The
 * rubric lives in `eval/data/gold/personalization-rubric.json` alongside
 * ground-truth slugs. The runner resolves slugs to full
 * GroundTruthPage[] before handing evidence to the judge.
 *
 * v1 verdict is baseline_only. Thresholds flip on after the 10-probe
 * Haiku-vs-hand-score calibration (κ > 0.7) lands alongside Day 3b corpus.
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import {
  runAgentLoop,
  type AgentAdapterState,
  type AgentRunConfig,
  type AgentRunResult,
} from './adapters/claude-sonnet-with-tools.ts';
import {
  scoreAnswer,
  type JudgeEvidence,
  type JudgeResult,
  type JudgeConfig,
  type RubricCriterion,
  type GroundTruthPage,
} from './judge.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type WorkflowId =
  | 'meeting_ingestion'
  | 'email_to_brain'
  | 'daily_task_prep'
  | 'briefing'
  | 'sync';

export const ALL_WORKFLOWS: readonly WorkflowId[] = [
  'meeting_ingestion',
  'email_to_brain',
  'daily_task_prep',
  'briefing',
  'sync',
] as const;

export interface WorkflowScenario {
  id: string;
  workflow: WorkflowId;
  text: string;
  /** Slugs that resolve to GroundTruthPage objects for the judge. */
  ground_truth_slugs: string[];
  rubric: RubricCriterion[];
}

export interface Cat9PerScenario {
  scenario_id: string;
  workflow: WorkflowId;
  judge_result: JudgeResult;
  pass: boolean;
  agent_stop_reason: AgentRunResult['stop_reason'];
  agent_cost_usd: number;
}

export interface WorkflowRollup {
  workflow: WorkflowId;
  total: number;
  passed: number;
  pass_rate: number;
}

export interface Cat9Report {
  schema_version: 1;
  ran_at: string;
  total_scenarios: number;
  overall_pass_rate: number;
  per_workflow: WorkflowRollup[];
  per_scenario: Cat9PerScenario[];
  total_cost_usd: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
}

export interface Cat9Config extends Omit<AgentRunConfig, 'client'> {
  agentClient?: Anthropic;
  judgeClient?: Anthropic;
  judge?: Omit<JudgeConfig, 'client'>;
  /** Pass-rate threshold per workflow. Default 0.80. */
  passRateThreshold?: number;
  /** When false (default in v1), verdict is baseline_only. */
  enableThreshold?: boolean;
  concurrency?: number;
}

export interface RunCat9Options extends Cat9Config {
  scenarios: WorkflowScenario[];
  state: AgentAdapterState;
  pagesBySlug: Map<string, GroundTruthPage>;
}

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

/**
 * Build a JudgeEvidence object for a scenario given the agent's run result.
 * Exported for tests — they verify the contract assembly in isolation.
 */
export function buildEvidence(
  scenario: WorkflowScenario,
  runResult: AgentRunResult,
  pagesBySlug: Map<string, GroundTruthPage>,
): JudgeEvidence {
  const ground_truth_pages: GroundTruthPage[] = [];
  for (const slug of scenario.ground_truth_slugs) {
    const page = pagesBySlug.get(slug);
    if (page) ground_truth_pages.push(page);
  }

  return {
    schema_version: 1,
    probe: {
      id: scenario.id,
      query: scenario.text,
      category: 9,
    },
    final_answer_text: runResult.final_answer,
    evidence_refs: runResult.evidence_refs,
    tool_call_summary: {
      count_by_tool: runResult.tool_bridge_state.count_by_tool,
      saw_poison_items: runResult.tool_bridge_state.saw_poison_items,
      brain_first_ordering: runResult.brain_first_ordering,
      made_dry_run_writes: runResult.tool_bridge_state.made_dry_run_writes.map(w => ({
        slug: w.slug,
        has_back_links: w.has_back_links,
        citation_format_ok: w.citation_format_ok,
        tool_name: w.tool_name,
      })),
    },
    ground_truth_pages,
    rubric: scenario.rubric,
  };
}

export async function runCat9(opts: RunCat9Options): Promise<Cat9Report> {
  const concurrency = opts.concurrency ?? 4;
  const passRateThreshold = opts.passRateThreshold ?? 0.8;

  const perScenario = await runConcurrently(opts.scenarios, concurrency, async scenario => {
    // Step 1: run the agent loop.
    const agentResult = await runAgentLoop(scenario.id, scenario.text, opts.state, {
      client: opts.agentClient,
      model: opts.model,
      maxTokens: opts.maxTokens,
      turnCap: opts.turnCap,
      systemPrompt: opts.systemPrompt,
      maxRetries: opts.maxRetries,
    });

    // Step 2: build evidence, score with judge.
    const evidence = buildEvidence(scenario, agentResult, opts.pagesBySlug);
    const judgeResult = await scoreAnswer(evidence, {
      ...opts.judge,
      client: opts.judgeClient,
    });

    const score: Cat9PerScenario = {
      scenario_id: scenario.id,
      workflow: scenario.workflow,
      judge_result: judgeResult,
      pass: judgeResult.verdict === 'pass',
      agent_stop_reason: agentResult.stop_reason,
      agent_cost_usd: agentResult.total_cost_usd,
    };
    return score;
  });

  // Per-workflow rollup
  const byWorkflow = new Map<WorkflowId, Cat9PerScenario[]>();
  for (const w of ALL_WORKFLOWS) byWorkflow.set(w, []);
  for (const s of perScenario) byWorkflow.get(s.workflow)!.push(s);

  const per_workflow: WorkflowRollup[] = [];
  for (const [workflow, scenarios] of byWorkflow) {
    const total = scenarios.length;
    const passed = scenarios.filter(s => s.pass).length;
    per_workflow.push({
      workflow,
      total,
      passed,
      pass_rate: total === 0 ? 0 : passed / total,
    });
  }

  const totalPassed = perScenario.filter(s => s.pass).length;
  const overallPassRate = perScenario.length === 0 ? 0 : totalPassed / perScenario.length;

  let verdict: 'pass' | 'fail' | 'baseline_only';
  if (!opts.enableThreshold) {
    verdict = 'baseline_only';
  } else {
    const allWorkflowsPass = per_workflow
      .filter(w => w.total > 0) // ignore empty workflows
      .every(w => w.pass_rate >= passRateThreshold);
    verdict = allWorkflowsPass ? 'pass' : 'fail';
  }

  const totalCost =
    perScenario.reduce((sum, s) => sum + s.agent_cost_usd + s.judge_result.cost_usd, 0);

  return {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    total_scenarios: perScenario.length,
    overall_pass_rate: overallPassRate,
    per_workflow,
    per_scenario: perScenario,
    total_cost_usd: totalCost,
    verdict,
  };
}
