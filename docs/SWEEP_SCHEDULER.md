# Sweep scheduler service

`src/service/sweepScheduler.ts` orchestrates the all-sources refresh operation.
Construct `SweepScheduler` with the configured catalog, the shared
`ScopeRefreshJobs`, `refresh.sweepHours` and `cache.ttlSeconds`. It does not create
providers, observations or admission queues.

- `start()` is idempotent and launches the first scheduled sweep immediately when
  the interval is positive. The next timer starts after completion, including
  failed or partial sweeps. An interval of zero disables scheduling only.
- `sweep()` starts a manual sweep or returns the current handle. Joins preserve
  the original ID, trigger and start time. Both manual and scheduled sweeps submit
  source jobs at sweep priority. A manual sweep replaces a pending timer, and its
  completion establishes the next deadline.
- Each handle exposes detached live `status` and a `completion` promise. The
  scheduler's `status` is null before any sweep and otherwise describes the
  current or most recent sweep. It includes every catalog project, source errors,
  policy conflicts and cooldowns. Failed checks retain their last successful
  check time from the observation store. Outside-issue work contributes to source
  completion and errors but does not become a catalog project.
- With zero TTL, requests complete with `state: skipped` and
  `skipReason: caching-disabled`, no source jobs and no recurring timer.
- `stop()` is terminal: it cancels the timer, rejects new manual requests and
  prevents a queued startup from launching source jobs. Already launched source
  jobs may settle; shutdown of their shared admission queues belongs to the
  caller, so stopping this scheduler never shuts down interactive work by itself.

The optional clock and timer allow deterministic service tests. The default
one-shot timer is unreferenced and never keeps a process alive on its own.

This module is the scheduler service from issue #187. Server startup/shutdown and
GET/POST sweep route wiring belong to issue #191 and are not installed by this
module. Service tests exercise the real scope jobs, observation store and queues
with fake provider fetches; they do not claim browser or live-forge validation.
