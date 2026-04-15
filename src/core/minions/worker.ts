/**
 * MinionWorker — In-process job worker with BullMQ-inspired patterns.
 *
 * Usage:
 *   const worker = new MinionWorker(engine);
 *   worker.register('sync', async (job) => { ... });
 *   worker.register('embed', async (job) => { ... });
 *   await worker.start(); // polls until SIGTERM
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionJob, MinionJobContext, MinionHandler, MinionWorkerOpts } from './types.ts';
import { UnrecoverableError } from './types.ts';
import { MinionQueue } from './queue.ts';
import { calculateBackoff } from './backoff.ts';
import { randomUUID } from 'crypto';

export class MinionWorker {
  private queue: MinionQueue;
  private handlers = new Map<string, MinionHandler>();
  private running = false;
  private currentJob: MinionJob | null = null;
  private lockRenewalTimer: ReturnType<typeof setInterval> | null = null;
  private workerId = randomUUID();

  private opts: Required<MinionWorkerOpts>;

  constructor(
    private engine: BrainEngine,
    opts?: MinionWorkerOpts,
  ) {
    this.queue = new MinionQueue(engine);
    this.opts = {
      queue: opts?.queue ?? 'default',
      concurrency: opts?.concurrency ?? 1,
      lockDuration: opts?.lockDuration ?? 30000,
      stalledInterval: opts?.stalledInterval ?? 30000,
      maxStalledCount: opts?.maxStalledCount ?? 1,
      pollInterval: opts?.pollInterval ?? 5000,
    };
  }

  /** Register a handler for a job type. */
  register(name: string, handler: MinionHandler): void {
    this.handlers.set(name, handler);
  }

  /** Get registered handler names (used by claim query). */
  get registeredNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Start the worker loop. Blocks until stopped. */
  async start(): Promise<void> {
    if (this.handlers.size === 0) {
      throw new Error('No handlers registered. Call worker.register(name, handler) before start().');
    }

    await this.queue.ensureSchema();
    this.running = true;

    // Graceful shutdown
    const shutdown = () => {
      console.log('Minion worker shutting down...');
      this.running = false;
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Stall detection on interval
    const stalledTimer = setInterval(async () => {
      try {
        const { requeued, dead } = await this.queue.handleStalled();
        if (requeued.length > 0) console.log(`Stall detector: requeued ${requeued.length} jobs`);
        if (dead.length > 0) console.log(`Stall detector: dead-lettered ${dead.length} jobs`);
      } catch (e) {
        console.error('Stall detection error:', e instanceof Error ? e.message : String(e));
      }
    }, this.opts.stalledInterval);

    try {
      while (this.running) {
        // Promote delayed jobs
        try {
          await this.queue.promoteDelayed();
        } catch (e) {
          console.error('Promotion error:', e instanceof Error ? e.message : String(e));
        }

        // Claim and execute
        const lockToken = `${this.workerId}:${Date.now()}`;
        const job = await this.queue.claim(
          lockToken,
          this.opts.lockDuration,
          this.opts.queue,
          this.registeredNames,
        );

        if (job) {
          this.currentJob = job;
          await this.executeJob(job, lockToken);
          this.currentJob = null;
        } else {
          // No jobs available, poll
          await new Promise(resolve => setTimeout(resolve, this.opts.pollInterval));
        }
      }
    } finally {
      clearInterval(stalledTimer);
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('SIGINT', shutdown);

      // Wait for current job to finish (graceful shutdown)
      if (this.currentJob && this.lockRenewalTimer) {
        console.log('Waiting for current job to finish (30s timeout)...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }

      console.log('Minion worker stopped.');
    }
  }

  /** Stop the worker gracefully. */
  stop(): void {
    this.running = false;
  }

  private async executeJob(job: MinionJob, lockToken: string): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      // This shouldn't happen (claim filters by registered names), but be safe
      await this.queue.failJob(job.id, lockToken, `No handler for job type '${job.name}'`, 'dead');
      return;
    }

    // Start lock renewal
    this.lockRenewalTimer = setInterval(async () => {
      const renewed = await this.queue.renewLock(job.id, lockToken, this.opts.lockDuration);
      if (!renewed) {
        // Lock was stolen (stall detector reclaimed it)
        console.warn(`Lock lost for job ${job.id}, stopping execution`);
        this.lockRenewalTimer && clearInterval(this.lockRenewalTimer);
        this.lockRenewalTimer = null;
      }
    }, this.opts.lockDuration / 2);

    // Build job context
    const context: MinionJobContext = {
      id: job.id,
      name: job.name,
      data: job.data,
      attempts_made: job.attempts_made,
      updateProgress: async (progress: unknown) => {
        await this.queue.updateProgress(job.id, lockToken, progress);
      },
      log: async (message: string) => {
        // Append to stacktrace as a log entry
        await this.engine.executeRaw(
          `UPDATE minion_jobs SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
            updated_at = now()
           WHERE id = $2 AND status = 'active' AND lock_token = $3`,
          [message, job.id, lockToken]
        );
      },
      isActive: async () => {
        const rows = await this.engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2`,
          [job.id, lockToken]
        );
        return rows.length > 0;
      },
    };

    try {
      const result = await handler(context);

      // Clear renewal timer
      if (this.lockRenewalTimer) {
        clearInterval(this.lockRenewalTimer);
        this.lockRenewalTimer = null;
      }

      // Complete the job (token-fenced)
      const completed = await this.queue.completeJob(
        job.id,
        lockToken,
        result != null ? (typeof result === 'object' ? result as Record<string, unknown> : { value: result }) : undefined,
      );

      if (!completed) {
        console.warn(`Job ${job.id} completion dropped (lock token mismatch, job was reclaimed)`);
        return;
      }

      // Resolve parent if this is a child job
      if (job.parent_job_id) {
        await this.queue.resolveParent(job.parent_job_id);
      }
    } catch (err) {
      // Clear renewal timer
      if (this.lockRenewalTimer) {
        clearInterval(this.lockRenewalTimer);
        this.lockRenewalTimer = null;
      }

      const errorText = err instanceof Error ? err.message : String(err);
      const isUnrecoverable = err instanceof UnrecoverableError;
      const attemptsExhausted = job.attempts_made + 1 >= job.max_attempts;

      let newStatus: 'delayed' | 'failed' | 'dead';
      if (isUnrecoverable || attemptsExhausted) {
        newStatus = 'dead';
      } else {
        newStatus = 'delayed';
      }

      const backoffMs = newStatus === 'delayed' ? calculateBackoff({
        backoff_type: job.backoff_type,
        backoff_delay: job.backoff_delay,
        backoff_jitter: job.backoff_jitter,
        attempts_made: job.attempts_made + 1,
      }) : 0;

      const failed = await this.queue.failJob(job.id, lockToken, errorText, newStatus, backoffMs);
      if (!failed) {
        console.warn(`Job ${job.id} failure dropped (lock token mismatch)`);
        return;
      }

      // Handle parent-child failure policies
      if (job.parent_job_id && (newStatus === 'dead' || newStatus === 'failed')) {
        const parentJob = await this.queue.getJob(job.parent_job_id);
        if (parentJob && parentJob.status === 'waiting-children') {
          switch (job.on_child_fail) {
            case 'fail_parent':
              await this.queue.failParent(job.parent_job_id, job.id, errorText);
              break;
            case 'remove_dep':
              await this.queue.removeChildDependency(job.id);
              await this.queue.resolveParent(job.parent_job_id);
              break;
            case 'ignore':
            case 'continue':
              await this.queue.resolveParent(job.parent_job_id);
              break;
          }
        }
      }

      if (newStatus === 'delayed') {
        console.log(`Job ${job.id} (${job.name}) failed, retrying in ${Math.round(backoffMs)}ms (attempt ${job.attempts_made + 1}/${job.max_attempts})`);
      } else {
        console.log(`Job ${job.id} (${job.name}) permanently failed: ${errorText}`);
      }
    }
  }
}
