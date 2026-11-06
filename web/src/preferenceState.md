# Preference state integration contract

`reducePreferences` is the pure state/effect boundary for the later preference API
and view wiring. The caller dispatches `open` on app open and `tab-return` when
returning to the tab; both produce a `read` effect. `reload` is an explicit retry.
The caller executes effects and returns each result with its original `id`.

`mutate` accepts a favorite add/remove or remembered-project save. Save effects
are serialized; subsequent mutations wait in memory in issue order. Favorite
changes are optimistic, while `confirmed` always retains the last authoritative
server response. A failed save rolls the display back and automatically requests
a fresh read. It discards both the failed mutation and all unsent mutations. A later successful
read never replays those actions; a new explicit user action is required. A failed or unavailable read also discards unsent mutations, while retaining any
already in-flight save identity until its result arrives. A failed read keeps earlier data visible as
`unverified` and read-only. Use `canChangeFavorites` to enable star controls,
including removal of an `inCatalog: false` favorite. Its existing entry remains
visible so the view can mark it unavailable.

All mutations are refused when preferences are not writable (not loaded,
unavailable, unverified, or awaiting a recovery read). A refused remembered-project
mutation emits no effect, is not queued, and sets a notice that it was not saved.
For an explicit project link on initial open, the later #193 wiring must wait for
the first successful preference read before dispatching the latest explicit
selection. Navigation itself must not wait. During unverified/unavailable recovery,
report the refusal; do not replay earlier selections on a later tab return.
This module does not implement that app wiring.

Save errors and remembered-project notices are separate. Each mutation clears
only its own feedback field, and each failure sets only its own field. Navigation never waits
for a save and this module produces no navigation effects. A reload changing the
remembered project likewise does not navigate.

Dispatch `logout` or `session-expired` immediately on those lifecycle events.
These clear all private page state and pending effects without touching server
storage. Request IDs are not reused, so late results cannot restore old-session
data. Successful saves supersede reads already in flight; reads begun before an
uncertain save cannot clear its reread gate. Apply API unavailable responses as
`read-success` with the unavailable payload; transport failures use `read-failure`.
