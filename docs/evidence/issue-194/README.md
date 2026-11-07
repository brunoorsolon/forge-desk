# Web refresh wiring evidence

Captured from application/test candidate `9988b00ccb3a9c2fb8d9e06a8f9a29be2b65ea7d` on 2026-11-07.

[Successful CI run](https://github.com/brunoorsolon/forge-desk/actions/runs/42426316353) ·
[Full browser artifact](https://github.com/brunoorsolon/forge-desk/actions/runs/42426316353/artifacts/13594714276).

The production-built application passed 14 browser checks in 28 seconds in headless
Chromium. Real HTTP routes, session authentication, scope services and sweep scheduler
run against two configured sources with controlled upstream issue data. The test holds
an upstream request to exercise the real 15-second refresh response bound and active-job
follow-up. A real sibling tab triggers visibility changes; fetch, application state and
document visibility are not mocked. One fixture hook rejects refresh requests with 403.

The checks cover all three controls, project-only visibility, scope responses and job
follow-up, a joined sweep preserving its start and per-project check times, running and
completed sweep progress, two-second polling, hidden-tab pause/return, retained data on
rejection, and all three launches through actual session-CSRF protection. Request records
store only the presence of the CSRF header, never tokens or cookies.

All five CI jobs passed, including typecheck, the full test suite, formatting, build,
18 existing heading layout cases, 27 existing navigation checks, the refresh browser
suite, Docker smoke and three forge integrations. Local typecheck, 2,694 tests, format
and build passed. Chromium cannot create sockets in the local executor and Docker is
absent, so browser and container results are CI evidence, not local execution.

The evidence-only commit adds these screenshots/results without changing application or
test bytes. CI reruns the browser suite on that final head and publishes a fresh artifact.

## Screenshots

- [Project controls](project-controls.png)
- [Source controls](source-controls.png)
- [Running and joined sweep](sweep-running-joined.png)
- [Completed sweep](sweep-completed.png)
- [Rejected scope refresh](scope-rejected.png)
- [Rejected sweep refresh](sweep-rejected.png)
- [Authenticated refresh](authenticated-refresh.png)
