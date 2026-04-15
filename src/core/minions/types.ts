/**
 * Minions — BullMQ-inspired Postgres-native job queue for GBrain.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *
 *   const worker = new MinionWorker(engine);
 *   worker.register('sync', async (job) => {
 *     await runSync(engine, job.data);
 *     return { pages_synced: 42 };
 *   });
 *   await worker.start();
 */

// --- Status & Type Unions ---

export type MinionJobStatus =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'dead'
  | 'cancelled'
  | 'waiting-children';

export type BackoffType = 'fixed' | 'exponential';

export type ChildFailPolicy = 'fail_parent' | 'remove_dep' | 'ignore' | 'continue';

// --- Job Record ---

export interface MinionJob {
  id: number;
  name: string;
  queue: string;
  status: MinionJobStatus;
  priority: number;
  data: Record<string, unknown>;

  // Retry
  max_attempts: number;
  attempts_made: number;
  attempts_started: number;
  backoff_type: BackoffType;
  backoff_delay: number;
  backoff_jitter: number;

  // Stall detection
  stalled_counter: number;
  max_stalled: number;
  lock_token: string | null;
  lock_until: Date | null;

  // Scheduling
  delay_until: Date | null;

  // Dependencies
  parent_job_id: number | null;
  on_child_fail: ChildFailPolicy;

  // Results
  result: Record<string, unknown> | null;
  progress: unknown | null;
  error_text: string | null;
  stacktrace: string[];

  // Timestamps
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

// --- Input Types ---

export interface MinionJobInput {
  name: string;
  data?: Record<string, unknown>;
  queue?: string;
  priority?: number;
  max_attempts?: number;
  backoff_type?: BackoffType;
  backoff_delay?: number;
  backoff_jitter?: number;
  delay?: number; // ms delay before eligible
  parent_job_id?: number;
  on_child_fail?: ChildFailPolicy;
}

export interface MinionWorkerOpts {
  queue?: string;
  concurrency?: number; // default 1
  lockDuration?: number; // ms, default 30000
  stalledInterval?: number; // ms, default 30000
  maxStalledCount?: number; // default 1
  pollInterval?: number; // ms, default 5000 (for PGLite fallback)
}

// --- Job Context (passed to handlers) ---

export interface MinionJobContext {
  id: number;
  name: string;
  data: Record<string, unknown>;
  attempts_made: number;
  /** Update structured progress (not just 0-100). */
  updateProgress(progress: unknown): Promise<void>;
  /** Append a log message to the job's stacktrace array. */
  log(message: string): Promise<void>;
  /** Check if the lock is still held (for long-running jobs). */
  isActive(): Promise<boolean>;
}

export type MinionHandler = (job: MinionJobContext) => Promise<unknown>;

// --- Errors ---

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

// --- Row Mapping ---

export function rowToMinionJob(row: Record<string, unknown>): MinionJob {
  return {
    id: row.id as number,
    name: row.name as string,
    queue: row.queue as string,
    status: row.status as MinionJobStatus,
    priority: row.priority as number,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data ?? {}) as Record<string, unknown>,
    max_attempts: row.max_attempts as number,
    attempts_made: row.attempts_made as number,
    attempts_started: row.attempts_started as number,
    backoff_type: row.backoff_type as BackoffType,
    backoff_delay: row.backoff_delay as number,
    backoff_jitter: row.backoff_jitter as number,
    stalled_counter: row.stalled_counter as number,
    max_stalled: row.max_stalled as number,
    lock_token: (row.lock_token as string) || null,
    lock_until: row.lock_until ? new Date(row.lock_until as string) : null,
    delay_until: row.delay_until ? new Date(row.delay_until as string) : null,
    parent_job_id: (row.parent_job_id as number) || null,
    on_child_fail: row.on_child_fail as ChildFailPolicy,
    result: row.result ? (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as Record<string, unknown> : null,
    progress: row.progress ? (typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress) : null,
    error_text: (row.error_text as string) || null,
    stacktrace: row.stacktrace ? (typeof row.stacktrace === 'string' ? JSON.parse(row.stacktrace) : row.stacktrace) as string[] : [],
    created_at: new Date(row.created_at as string),
    started_at: row.started_at ? new Date(row.started_at as string) : null,
    finished_at: row.finished_at ? new Date(row.finished_at as string) : null,
    updated_at: new Date(row.updated_at as string),
  };
}
