# Preference state integration contract

`reducePreferences` is the pure state/effect boundary. `preference-controller.ts`
executes its effects through `api.ts`; `main.ts` connects navigation and views. The caller dispatches `open` on app open and `tab-return` when
returning to the tab; both produce a `read` effect. `reload` is an explicit retry.
The caller executes effects and returns each result with its original `id`.

`mutate` accepts a favorite add/remove or remembered-project save. Save effects
are serialized; subsequent mutations wait in memory in issue order. Favorite
changes are optimistic, while `confirmed` always retains the last authoritative
server response. A failed save rolls the display back and automatically requests
a fresh read. It discards both the failed mutation and all unsent mutations. A later successful
read never replays those actions; a new explicit user action is required. A failed or unavailable read also discards unsent mutations, while retaining any
already in-flight save identity until its result arrives. Discarded queued favorite
changes produce an error; discarded remembered-project selections produce a
notice. Cancellation feedback is appended to existing feedback, so the original
failure and unrelated messages remain visible even after recovery. A failed read keeps earlier data visible as
`unverified` and read-only. Use `canChangeFavorites` to enable star controls,
including removal of an `inCatalog: false` favorite. Its existing entry remains
visible so the view can mark it unavailable.

All mutations are refused when preferences are not writable (not loaded,
unavailable, unverified, or awaiting a recovery read). A refused remembered-project
mutation emits no effect, is not queued, and sets a notice that it was not saved.
For an explicit project link on initial open, the controller waits for
the first preference read before dispatching the latest explicit
selection. A failed initial read reports the refusal instead of replaying it later. Navigation itself must not wait. During unverified/unavailable recovery,
report the refusal; do not replay earlier selections on a later tab return.
Source/view destinations cancel an initial deferred selection. Only destination
changes are explicit selections; tab, sort, query and preference responses never save
the current project. Bare startup waits for the read, while explicit links load immediately.

Save errors and remembered-project notices are separate. Each mutation clears
only its own feedback field, and each failure sets only its own field. Navigation never waits
for a save and this module produces no navigation effects. A reload changing the
remembered project likewise does not navigate.

The controller dispatches `logout` or `session-expired` immediately on those lifecycle events.
These clear all private page state and pending effects without touching server
storage. Request IDs are not reused, so late results cannot restore old-session
data. It aborts pending IO and refuses subsequent reads/writes until a new page session.
`api.ts` notifies expiry listeners synchronously before redirecting to login. Logout
form submission and `pagehide` clear preferences; a BFCache restore reloads the page
to revalidate authentication. Successful saves supersede reads already in flight; reads begun before an
uncertain save cannot clear its reread gate. Apply API unavailable responses as
`read-success` with the unavailable payload; transport failures use `read-failure`.
