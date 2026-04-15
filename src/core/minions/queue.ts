/**
 * MinionQueue — Postgres-native job queue inspired by BullMQ.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *   const status = await queue.getJob(job.id);
 *   await queue.prune({ olderThan: new Date(Date.now() - 30 * 86400000) });
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionJob, MinionJobInput, MinionJobStatus } from './types.ts';
import { rowToMinionJob } from './types.ts';

const MIGRATION_VERSION = 5;

export class MinionQueue {
  constructor(private engine: BrainEngine) {}

  /** Verify minion_jobs table exists (migration v5+). Call before first operation. */
  async ensureSchema(): Promise<void> {
    const ver = await this.engine.getConfig('version');
    const current = parseInt(ver || '1', 10);
    if (current < MIGRATION_VERSION) {
      throw new Error(
        `minion_jobs table not found (schema version ${current}, need ${MIGRATION_VERSION}). Run 'gbrain init' to apply migrations.`
      );
    }
  }

  /** Submit a new job. Returns the created job record. */
  async add(name: string, data?: Record<string, unknown>, opts?: Partial<MinionJobInput>): Promise<MinionJob> {
    if (!name || name.trim().length === 0) {
      throw new Error('Job name cannot be empty');
    }
    await this.ensureSchema();

    const status: MinionJobStatus = opts?.delay ? 'delayed' : (opts?.parent_job_id ? 'waiting-children' : 'waiting');
    const delayUntil = opts?.delay ? new Date(Date.now() + opts.delay) : null;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_jobs (name, queue, status, priority, data, max_attempts, backoff_type,
        backoff_delay, backoff_jitter, delay_until, parent_job_id, on_child_fail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        name.trim(),
        opts?.queue ?? 'default',
        status,
        opts?.priority ?? 0,
        JSON.stringify(data ?? {}),
        opts?.max_attempts ?? 3,
        opts?.backoff_type ?? 'exponential',
        opts?.backoff_delay ?? 1000,
        opts?.backoff_jitter ?? 0.2,
        delayUntil?.toISOString() ?? null,
        opts?.parent_job_id ?? null,
        opts?.on_child_fail ?? 'fail_parent',
      ]
    );
    return rowToMinionJob(rows[0]);
  }

  /** Get a job by ID. Returns null if not found. */
  async getJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      'SELECT * FROM minion_jobs WHERE id = $1',
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** List jobs with optional filters. */
  async getJobs(opts?: {
    status?: MinionJobStatus;
    queue?: string;
    name?: string;
    limit?: number;
    offset?: number;
  }): Promise<MinionJob[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(opts.status);
    }
    if (opts?.queue) {
      conditions.push(`queue = $${idx++}`);
      params.push(opts.queue);
    }
    if (opts?.name) {
      conditions.push(`name = $${idx++}`);
      params.push(opts.name);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM minion_jobs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );
    return rows.map(rowToMinionJob);
  }

  /** Remove a job. Only terminal statuses can be removed. */
  async removeJob(id: number): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `DELETE FROM minion_jobs WHERE id = $1 AND status IN ('completed', 'dead', 'cancelled', 'failed') RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /** Cancel a waiting, active, or delayed job. */
  async cancelJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL,
        finished_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('waiting', 'active', 'delayed', 'waiting-children')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Re-queue a failed or dead job for retry. */
  async retryJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', error_text = NULL,
        lock_token = NULL, lock_until = NULL, delay_until = NULL,
        finished_at = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'dead')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Prune old jobs in terminal statuses. Returns count of deleted rows. */
  async prune(opts?: { olderThan?: Date; status?: MinionJobStatus[] }): Promise<number> {
    const statuses = opts?.status ?? ['completed', 'dead', 'cancelled'];
    const olderThan = opts?.olderThan ?? new Date(Date.now() - 30 * 86400000);

    const rows = await this.engine.executeRaw<{ count: string }>(
      `WITH pruned AS (
         DELETE FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2
         RETURNING id
       )
       SELECT count(*)::text as count FROM pruned`,
      [statuses, olderThan.toISOString()]
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /** Get job statistics. */
  async getStats(opts?: { since?: Date }): Promise<{
    by_status: Record<string, number>;
    by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number; avg_duration_ms: number | null }>;
    queue_health: { waiting: number; active: number; stalled: number };
  }> {
    const since = opts?.since ?? new Date(Date.now() - 86400000);

    // Status counts
    const statusRows = await this.engine.executeRaw<{ status: string; count: string }>(
      `SELECT status, count(*)::text as count FROM minion_jobs GROUP BY status`
    );
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.status] = parseInt(r.count, 10);

    // Type breakdown (within time window)
    const typeRows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT name,
        count(*)::text as total,
        count(*) FILTER (WHERE status = 'completed')::text as completed,
        count(*) FILTER (WHERE status = 'failed')::text as failed,
        count(*) FILTER (WHERE status = 'dead')::text as dead,
        avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
       FROM minion_jobs WHERE created_at >= $1
       GROUP BY name ORDER BY total DESC`,
      [since.toISOString()]
    );
    const by_type = typeRows.map(r => ({
      name: r.name as string,
      total: parseInt(r.total as string, 10),
      completed: parseInt(r.completed as string, 10),
      failed: parseInt(r.failed as string, 10),
      dead: parseInt(r.dead as string, 10),
      avg_duration_ms: r.avg_duration_ms != null ? Math.round(r.avg_duration_ms as number) : null,
    }));

    // Queue health: stalled = active with expired lock
    const stalledRows = await this.engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_jobs WHERE status = 'active' AND lock_until < now()`
    );
    const stalled = parseInt(stalledRows[0]?.count ?? '0', 10);

    return {
      by_status,
      by_type,
      queue_health: {
        waiting: by_status['waiting'] ?? 0,
        active: by_status['active'] ?? 0,
        stalled,
      },
    };
  }

  /** Claim the next waiting job for a worker. Token-fenced, filters by registered names. */
  async claim(lockToken: string, lockDurationMs: number, queue: string, registeredNames: string[]): Promise<MinionJob | null> {
    if (registeredNames.length === 0) return null;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        status = 'active',
        lock_token = $1,
        lock_until = now() + ($2::double precision * interval '1 millisecond'),
        attempts_started = attempts_started + 1,
        started_at = COALESCE(started_at, now()),
        updated_at = now()
       WHERE id = (
         SELECT id FROM minion_jobs
         WHERE queue = $3 AND status = 'waiting' AND name = ANY($4)
         ORDER BY priority ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [lockToken, lockDurationMs, queue, registeredNames]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Complete a job (token-fenced). Returns null if token mismatch. */
  async completeJob(id: number, lockToken: string, result?: Record<string, unknown>): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'completed', result = $1,
        finished_at = now(), lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $2 AND status = 'active' AND lock_token = $3
       RETURNING *`,
      [result ? JSON.stringify(result) : null, id, lockToken]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Fail a job (token-fenced). Sets delayed for retry or dead/failed for terminal. */
  async failJob(
    id: number,
    lockToken: string,
    errorText: string,
    newStatus: 'delayed' | 'failed' | 'dead',
    backoffMs?: number
  ): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        status = $1, error_text = $2, attempts_made = attempts_made + 1,
        stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($3::text),
        delay_until = CASE WHEN $1 = 'delayed' THEN now() + ($4::double precision * interval '1 millisecond') ELSE NULL END,
        finished_at = CASE WHEN $1 IN ('failed', 'dead') THEN now() ELSE NULL END,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $5 AND status = 'active' AND lock_token = $6
       RETURNING *`,
      [newStatus, errorText, errorText, backoffMs ?? 0, id, lockToken]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Update job progress (token-fenced). */
  async updateProgress(id: number, lockToken: string, progress: unknown): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET progress = $1, updated_at = now()
       WHERE id = $2 AND status = 'active' AND lock_token = $3
       RETURNING id`,
      [JSON.stringify(progress), id, lockToken]
    );
    return rows.length > 0;
  }

  /** Renew lock (token-fenced). Returns false if token mismatch (job was reclaimed). */
  async renewLock(id: number, lockToken: string, lockDurationMs: number): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET lock_until = now() + ($1::double precision * interval '1 millisecond'), updated_at = now()
       WHERE id = $2 AND lock_token = $3 AND status = 'active'
       RETURNING id`,
      [lockDurationMs, id, lockToken]
    );
    return rows.length > 0;
  }

  /** Promote delayed jobs whose delay_until has passed. Returns promoted jobs. */
  async promoteDelayed(): Promise<MinionJob[]> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', delay_until = NULL,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE status = 'delayed' AND delay_until <= now()
       RETURNING *`
    );
    return rows.map(rowToMinionJob);
  }

  /** Detect and handle stalled jobs. Single CTE, no off-by-one. Returns affected jobs. */
  async handleStalled(): Promise<{ requeued: MinionJob[]; dead: MinionJob[] }> {
    const rows = await this.engine.executeRaw<Record<string, unknown> & { action: string }>(
      `WITH stalled AS (
        SELECT id, stalled_counter, max_stalled
        FROM minion_jobs
        WHERE status = 'active' AND lock_until < now()
        FOR UPDATE SKIP LOCKED
      ),
      requeued AS (
        UPDATE minion_jobs SET
          status = 'waiting', stalled_counter = stalled_counter + 1,
          lock_token = NULL, lock_until = NULL, updated_at = now()
        WHERE id IN (SELECT id FROM stalled WHERE stalled_counter + 1 < max_stalled)
        RETURNING *, 'requeued' as action
      ),
      dead_lettered AS (
        UPDATE minion_jobs SET
          status = 'dead', stalled_counter = stalled_counter + 1,
          error_text = 'max stalled count exceeded',
          lock_token = NULL, lock_until = NULL, finished_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM stalled WHERE stalled_counter + 1 >= max_stalled)
        RETURNING *, 'dead' as action
      )
      SELECT * FROM requeued UNION ALL SELECT * FROM dead_lettered`
    );

    const requeued: MinionJob[] = [];
    const dead: MinionJob[] = [];
    for (const r of rows) {
      const job = rowToMinionJob(r);
      if (r.action === 'requeued') requeued.push(job);
      else dead.push(job);
    }
    return { requeued, dead };
  }

  /** Check if all children of a parent are done. If so, unblock parent. */
  async resolveParent(parentId: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
       WHERE id = $1 AND status = 'waiting-children'
         AND NOT EXISTS (
           SELECT 1 FROM minion_jobs
           WHERE parent_job_id = $1
             AND status NOT IN ('completed', 'dead', 'cancelled')
         )
       RETURNING *`,
      [parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Fail the parent when a child fails with fail_parent policy. */
  async failParent(parentId: number, childId: number, errorText: string): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'failed',
        error_text = $1, finished_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'waiting-children'
       RETURNING *`,
      [`child job ${childId} failed: ${errorText}`, parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Remove a child's dependency on its parent. */
  async removeChildDependency(childId: number): Promise<void> {
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`,
      [childId]
    );
  }
}
