---
name: minion-orchestrator
version: 1.0.0
description: |
  Unified Minions skill for both deterministic shell jobs and LLM subagent
  orchestration. Use when: gbrain jobs submission/monitoring, shell/background
  tasks, spawning subagents, checking progress, steering running work,
  pausing/resuming, parallel fan-out. Replaces split minion skills with one
  durable, observable, steerable queue interface.
triggers:
  - "gbrain jobs"
  - "submit a shell job"
  - "shell job"
  - "run shell command in background"
  - "deterministic background task"
  - "spawn agent"
  - "background task"
  - "run in background"
  - "check on agent"
  - "agent progress"
  - "what's running"
  - "steer agent"
  - "change direction"
  - "tell the agent"
  - "pause agent"
  - "stop agent"
  - "resume agent"
  - "parallel tasks"
  - "fan out"
  - "do these in parallel"
tools:
  - submit_job
  - get_job
  - list_jobs
  - cancel_job
  - pause_job
  - resume_job
  - replay_job
  - send_job_message
  - get_job_progress
  - get_job_stats
mutating: true
---

# Minion Orchestrator

## Contract

Minions is a Postgres-native job queue for durable, observable background work.
This single skill handles two lanes:
- Deterministic shell jobs (`gbrain jobs submit shell ...`)
- LLM subagent jobs (spawn/steer/pause/resume/replay)

Every background task goes through Minions. No in-memory subagent spawning.

Guarantees:
- Jobs survive gateway restart (Postgres-backed)
- Every job has structured progress, token accounting, and session transcripts
- Running agents can be steered mid-flight via inbox messages
- Jobs can be paused, resumed, or cancelled at any time
- Parent-child DAGs with configurable failure policies

## Route the Request: Shell Job vs Subagent

| Condition | Action |
|---|---|
| User asks for deterministic command/script run | Shell job (`name="shell"`) |
| User asks to "run in minions" + explicit command/argv | Shell job (`cmd` or `argv`) |
| User asks for research/reasoning/iterative agent | Subagent job (`name="subagent"`) |
| User asks to steer/pause/resume an agent | Subagent job lifecycle tools |
| Single simple operation under ~30s | Consider inline execution first |
| Needs restart durability/observability | Submit as Minion job |
| Parallel work (2+ streams) | Parent + child Minion jobs |

If intent is ambiguous, ask one clarification:
"Do you want a deterministic shell command job, or an LLM agent job?"

## Shell Jobs (Deterministic Scripts)

Use for reproducible command execution, ETL steps, cron work, and scriptable
tasks where no LLM reasoning loop is needed.

### Submit

Command string form:
```
submit_job name="shell" data={"cmd":"echo hello","cwd":"/abs/path"}
```

Argv form (no shell expansion):
```
submit_job name="shell" data={"argv":["bash","-lc","echo hello"],"cwd":"/abs/path"}
```

Queue/lifecycle options still apply (`queue`, `priority`, `max_attempts`,
`delay`, timeout/retry knobs exposed by the jobs interface).

### Monitor

```
list_jobs --name shell --status active
get_job ID
get_job_progress ID
```

Check structured result fields (exit code, stdout/stderr tails, attempts,
timings) from `get_job`.

### Control

```
cancel_job id=ID
replay_job id=ID
```

Use idempotency keys for recurring shell workloads to avoid duplicate runs.

## Subagent Jobs (LLM Orchestration)

Use for open-ended reasoning, tool-using research, and fan-out synthesis.

## Phase 1: Submit

```
submit_job name="research" data={"prompt":"Research Acme Corp revenue","tools":["search","web_search"]}
```

Options:
- `queue` — queue name (default: 'default')
- `priority` — lower = higher priority (default: 0)
- `max_attempts` — retry limit (default: 3)
- `delay` — ms delay before eligible

For parallel work, submit a parent then children:
```
submit_job name="orchestrate" data={"task":"research 5 companies"}
# Returns parent_id

submit_job name="research" data={"company":"Acme"} parent_job_id=PARENT_ID
submit_job name="research" data={"company":"Beta"} parent_job_id=PARENT_ID
submit_job name="research" data={"company":"Gamma"} parent_job_id=PARENT_ID
```

Parent auto-enters `waiting-children` and unblocks when all children finish.

## Phase 2: Monitor

```
list_jobs --status active          # what's running?
get_job ID                         # full details + logs + tokens
get_job_progress ID                # structured progress snapshot
get_job_stats                      # health dashboard
```

Progress includes: step count, total steps, message, token usage, last tool called.

## Phase 3: Steer

Send a message to redirect a running agent:
```
send_job_message id=ID payload={"directive":"focus on revenue, skip headcount"}
```

The agent handler reads inbox messages on each iteration and injects them as
context. Messages are acknowledged (read receipts tracked).

Only the parent job or admin can send messages (sender validation).

## Phase 4: Lifecycle

```
pause_job id=ID                    # freeze without losing state
resume_job id=ID                   # pick up where it left off
cancel_job id=ID                   # hard stop
replay_job id=ID                   # re-run with same or modified params
replay_job id=ID data_overrides={"depth":"deep"}  # replay with changes
```

## Phase 5: Review Results

```
get_job ID                         # result, token counts, transcript
```

Token accounting: every job tracks `tokens_input`, `tokens_output`, `tokens_cache_read`.
Child tokens roll up to parent automatically on completion.

## Output Format

When reporting job status to the user:

```
Job #ID (name) — status
Progress: step/total — last action
Tokens: input_count in / output_count out (+ cache_read cached)
Runtime: Xs
Children: N pending, M completed
```

When reporting completion:

```
Job #ID completed in Xs
Tokens used: input / output / cache_read
Result: <summary>
```

When reporting batch status (parent with children):

```
Parent #ID — waiting-children
  #A research(Acme) — active, 3/5 steps, 2.5k tokens
  #B research(Beta) — completed, 1.8k tokens
  #C research(Gamma) — paused
Total tokens so far: 4.3k
```

## Anti-Patterns

- Don't spawn a Minion for a single search query (use search tool directly)
- Don't fire-and-forget without checking results
- Don't spawn > 5 concurrent agents without checking `get_job_stats` first
- Don't use `sessions_spawn` with `runtime: "subagent"` when Minions is available
- Don't poll `get_job` in a tight loop (use `get_job_progress` for lightweight checks)

## Tools Used

- Submit a background job (submit_job)
- Get job details (get_job)
- List jobs with filters (list_jobs)
- Cancel a job (cancel_job)
- Pause a job (pause_job)
- Resume a paused job (resume_job)
- Replay a completed/failed job (replay_job)
- Send sidechannel message (send_job_message)
- Get structured progress (get_job_progress)
- Get job queue stats (get_job_stats)
