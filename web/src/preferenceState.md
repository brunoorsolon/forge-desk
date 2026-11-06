# Preference state integration contract

`reducePreferences` is the pure state/effect boundary for the later preference API
and view wiring. The caller dispatches `open` on app open and `tab-return` when
returning to the tab; both produce a `read` effect. `reload` is an explicit retry.
The caller executes effects and returns each result with its original `id`.

`mutate` accepts a favorite add/remove or remembered-project save. Save effects
are serialized; subsequent mutations wait in memory in issue order. Favorite
changes are optimistic, while `confirmed` always retains the last authoritative
server response. A failed save rolls the display back and automatically requests
a fresh read. It never retries the failed mutation. Unsent mutations remain
paused until that read succeeds. A failed read keeps earlier data visible as
`unverified` and read-only. Use `canChangeFavorites` to enable star controls,
including removal of an `inCatalog: false` favorite. Its existing entry remains
visible so the view can mark it unavailable.

Save errors and remembered-project notices are separate. Navigation never waits
for a save and this module produces no navigation effects. A reload changing the
remembered project likewise does not navigate.

Dispatch `logout` or `session-expired` immediately on those lifecycle events.
These clear all private page state and pending effects without touching server
storage. Request IDs are not reused, so late results cannot restore old-session
data. Successful saves supersede reads already in flight; reads begun before an
uncertain save cannot clear its reread gate. Apply API unavailable responses as
`read-success` with the unavailable payload; transport failures use `read-failure`.
