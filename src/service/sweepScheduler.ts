import { randomUUID } from 'node:crypto';
import type {
  CatalogSource,
  RefreshTrigger,
  SweepSourceStatus,
  SweepStatus,
} from '../core/scope.js';
import type { ScopeRefreshJob, ScopeRefreshJobs } from './scopeRefreshJobs.js';

export interface SweepJob {
  readonly status: SweepStatus;
  readonly completion: Promise<SweepStatus>;
}

export interface SweepTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(timer: unknown): void;
}

interface Run {
  status: SweepStatus;
  sources: Map<string, ScopeRefreshJob>;
  handle: SweepJob;
}

/** All-sources orchestration. Providers and admission queues remain owned by the caller. */
export class SweepScheduler {
  private readonly now: () => Date;
  private readonly timer: SweepTimer;
  private pending: unknown;
  private scheduled = false;
  private started = false;
  private stopped = false;
  private current: Run | null = null;
  private recent: SweepStatus | null = null;

  constructor(
    private readonly options: {
      sources: CatalogSource[];
      jobs: Pick<ScopeRefreshJobs, 'refresh'>;
      sweepHours: number;
      ttlSeconds: number;
      now?: () => Date;
      timer?: SweepTimer;
    },
  ) {
    if (!Number.isInteger(options.sweepHours) || options.sweepHours < 0 || options.sweepHours > 168)
      throw new Error('Sweep interval must be an integer from 0 to 168 hours');
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 0)
      throw new Error('Cache TTL must be a nonnegative integer');
    this.now = options.now ?? (() => new Date());
    this.timer = options.timer ?? {
      set: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return timer;
      },
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  get status(): SweepStatus | null {
    return this.current ? this.snapshot(this.current) : structuredClone(this.recent);
  }

  /** Idempotent startup; interval zero disables scheduling, not manual requests. */
  start(): SweepJob | null {
    if (this.stopped || this.started) return this.current?.handle ?? null;
    this.started = true;
    return this.options.sweepHours > 0 ? this.sweep('scheduled') : null;
  }

  /** Joins an existing sweep without changing its trigger, time or priority. */
  sweep(trigger: RefreshTrigger = 'interactive'): SweepJob {
    if (this.stopped) throw new Error('Sweep scheduler is stopped');
    if (this.current) return this.current.handle;
    this.cancelTimer();
    const status: SweepStatus = {
      id: randomUUID(),
      trigger,
      state: 'running',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      sources: [],
    };
    const run: Run = { status, sources: new Map(), handle: undefined! };
    // Publish before starting work, including empty catalogs and synchronous failures.
    const completion = Promise.resolve().then(async () => {
      if (this.options.ttlSeconds === 0) {
        status.state = 'skipped';
        status.skipReason = 'caching-disabled';
      } else if (this.stopped) {
        status.state = 'failed';
        for (const source of status.sources) {
          source.state = 'failed';
          source.error = 'Sweep scheduler stopped before starting work';
          for (const project of source.projects) {
            project.state = 'failed';
            project.error = source.error;
          }
        }
      } else {
        await Promise.all(
          this.options.sources.map(async (catalog, index) => {
            const source = status.sources[index]!;
            try {
              if (catalog.policy.status === 'conflict') {
                source.state = 'conflict';
                source.policyConflict = catalog.policy.conflict;
                throw new Error(catalog.policy.conflict.explanation);
              }
              const job = this.options.jobs.refresh(
                { kind: 'source', source: catalog.id },
                { priority: 'sweep', trigger },
              );
              run.sources.set(catalog.id, job);
              await job.completion;
            } catch (error) {
              if (source.state !== 'conflict') source.state = 'failed';
              source.error = error instanceof Error ? error.message : String(error);
              for (const project of source.projects) {
                project.state = 'failed';
                project.error = source.error;
              }
            }
          }),
        );
        status.sources = this.snapshot(run).sources;
        const failed = status.sources.filter(
          (source) => source.state === 'failed' || source.state === 'conflict',
        ).length;
        status.state =
          failed > 0 && failed === status.sources.length
            ? 'failed'
            : failed > 0 || status.sources.some((source) => source.state === 'partial')
              ? 'partial'
              : 'completed';
      }
      status.finishedAt = this.now().toISOString();
      this.recent = structuredClone(status);
      this.current = null;
      this.schedule();
      return structuredClone(status);
    });
    status.sources =
      this.options.ttlSeconds === 0
        ? []
        : this.options.sources.map((source) => ({
            source: source.id,
            state: 'queued',
            delayedUntil: null,
            error: null,
            policyConflict: null,
            projects: source.projects.map((project) => ({
              project: { ...project },
              state: 'queued',
              lastCheckedAt: null,
              error: null,
            })),
          }));
    run.handle = {
      get status() {
        return scheduler.snapshot(run);
      },
      completion,
    };
    const scheduler = this;
    this.current = run;
    return run.handle;
  }

  /** Terminal: cancel the timer and reject new sweeps. Already admitted source jobs
   * settle normally; the server separately closes its shared admission queues. */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private snapshot(run: Run): SweepStatus {
    const status = structuredClone(run.status);
    if (status.finishedAt !== null) return status;
    status.sources = status.sources.map((source) => {
      const job = run.sources.get(source.source)?.status;
      if (!job) return source;
      const units = job.units.filter((unit) => unit.kind === 'repository');
      return {
        ...source,
        state: job.delayedUntil !== null ? 'delayed' : job.state,
        delayedUntil: job.delayedUntil,
        error: job.error,
        projects: source.projects.map((project) => {
          const unit = units.find(
            (unit) => unit.project.repo === project.project.repo.toLowerCase(),
          );
          return unit
            ? {
                project: project.project,
                state: unit.state,
                lastCheckedAt: unit.lastCheckedAt,
                error: unit.error,
              }
            : project;
        }),
      } satisfies SweepSourceStatus;
    });
    return status;
  }

  private cancelTimer(): void {
    if (this.scheduled) this.timer.clear(this.pending);
    this.scheduled = false;
  }

  private schedule(): void {
    if (
      !this.started ||
      this.stopped ||
      this.options.sweepHours === 0 ||
      this.options.ttlSeconds === 0
    )
      return;
    this.scheduled = true;
    this.pending = this.timer.set(
      () => {
        this.scheduled = false;
        if (!this.stopped) this.sweep('scheduled');
      },
      this.options.sweepHours * 60 * 60 * 1000,
    );
  }
}
