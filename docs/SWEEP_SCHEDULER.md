# Sweep scheduler service

`src/service/sweepScheduler.ts` orchestrates the all-sources refresh operation.
Construct `SweepScheduler` with the configured catalog, the shared
`ScopeRefreshJobs`, the same shared observation store, `refresh.sweepHours` and
`cache.ttlSeconds`. It does not create providers, observations or admission queues.

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
  policy conflicts and cooldowns. Projects retain their last successful check time
  from the observation store before source jobs launch, while queued or checking,
  and after failed checks. Outside-issue work contributes to source
  completion and errors but does not become a catalog project.
- With zero TTL, requests complete with `state: skipped` and
  `skipReason: caching-disabled`, no source jobs and no recurring timer.
- `stop()` is terminal: it cancels the timer, rejects new manual requests and
  prevents a queued startup from launching source jobs. The current sweep's
  already launched source jobs finish, including their queued reads and work
  shared with interactive refreshes. Server shutdown separately closes the shared
  admission queues to abandon pending requests; stopping this scheduler alone
  never closes those queues or interrupts interactive work.

The optional clock and timer allow deterministic service tests. The default
one-shot timer is unreferenced and never keeps a process alive on its own.

## HTTP routes and server lifecycle

`startServer` constructs one scheduler using the shared scope runtime, then starts
it after the HTTP listener succeeds. A positive `refresh.sweepHours` starts an
immediate sweep without a browser; zero disables scheduled sweeps but leaves
manual launches available. Closing the app stops the scheduler before the shared
scope queues stop admission and finish their bounded drain. `buildApp` accepts an
optional startup-owned `sweeps` instance and does not start it implicitly.

- `POST /api/refresh` returns `200` with the newly started or joined sweep status.
  It never waits for a sweep to finish or for a provider cooldown. Concurrent
  launches join the current sweep with its original ID, trigger and start time.
- `GET /api/refresh` returns `200` with the current or most recent sweep status,
  or JSON `null` before any sweep. It includes start/finish times, each source's
  status, conflicts and cooldowns, and project states, check times and errors.
- Reads use ordinary planning authentication. Launches use the shared
  `refresh-launch` protection: `x-forge-desk-request: 1` for every caller, a
  matching Origin when supplied, and the configured planning login when enabled.
  Session callers also need an Origin and their session's `x-csrf-token` from
  `/api/session`. Basic scripts send no session cookie. A configured
  `server.publicOrigin` takes precedence over Host behind a proxy.
- Without login, launches still require the launch header and reject foreign
  Origins or mixed session/Authorization credentials. Rejections use `401`
  `unauthenticated` or `403` `forbidden-origin`, `missing-csrf`, `invalid-csrf`,
  `mixed-credentials` or `missing-launch-header`. Rejected launches start no work.
- Both routes use `Cache-Control: no-store`, redact configured provider tokens
  from status errors, and send no CORS headers.

Service and HTTP injection tests exercise the real scope jobs, observation store,
queues and scheduler with controlled providers and clocks. Startup tests run the
actual listener and fixture provider, including interval scheduling and close.
These tests do not claim browser or live-forge validation.
