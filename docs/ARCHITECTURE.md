# Architecture and refactor plan

This is the working plan for restructuring the balancer. It describes where the code is,
where it is going, and the order the work is being done in. Update the status markers as
steps land.

The rules in the README ("The rules") are the contract. Nothing in this plan changes them.
In particular: a settled player is never moved mid match, and the round the balancer starts
on is never touched.

## Where it started (1.0.0)

Two runtime files, no dependencies.

- `index.js` was a top-level script: merge defaults, validate with `die()` and
  `process.exit(1)`, warn about an unignored `config.json`, handle `--check` and
  `--dry-run`, start the loop.
- `balancer.js` held everything else: faction constants, payload normalisation
  (`factionOf`, `idOf`, `tagOf`), the HTTP wrapper `request()`, state persistence, and a
  single ~290 line `processServer()` that fetched, seeded, detected match boundaries, ran
  rescue, ran announcements, placed/bounced/cleared players, executed the moves, and
  expired leavers.
- `selftest.js` and `stress.js` tested it by replacing `globalThis.fetch` (and, in the
  stress harness, `Date.now`).

Problems that came out of that shape:

1. The two playing sides were hardcoded as red and green (`opposite()`, `red`/`green`
   counters, `matchPeak.red/green`, rescue). `closedFaction` only worked when it was
   Lonestar, and `closedFaction: null` ignored the third side instead of balancing it.
2. Deciding and doing were interleaved, so dry run took a different path from a live run
   and never updated its counts. At a 35/15 boundary a dry run reported 35 moves where a
   live run made 9.
3. The "closed door" bounce sent a player back to `prev.fac` even when that was the
   closed faction.
4. Per-server overrides were resolved field by field with inconsistent `!= null` and
   `!== undefined` checks, and per-server `rescue`, `announce` and `closedFaction` were
   never validated.
5. Validation could only be tested by spawning `index.js`; the balancer could only be
   tested by patching globals.

## Target layout

```
src/
  factions.js   faction table, payload aliases, openSides(closed)            [done]
  config.js     DEFAULTS, mergeConfig, resolveServer, resolveSecrets,
                validate -> string[], loadConfig                             [done]
  api.js        RconClient: players(), status(), health(), move(), message(),
                broadcast(), restartMatch(). Normalises payloads (idOf, tagOf)
                and returns { ok, status, reason } instead of null/false.    [done]
  state.js      StateStore: load/save via tmp file + rename, schema version and
                migration, pruning of servers no longer configured, a lockfile
                so two instances cannot run against one stateDir.            [done]
  policy/       pure functions, no I/O, no clock reads:                      [done]
    counts.js     tally(), spread(), fmtCounts()
    match.js      readSnapshot(), detectBoundary()
    placement.js  chooseSide(), clanSideFor(), bounceTarget()
    rescue.js     isLopsided(), rescueStep(): the warn/restart state machine
    announce.js   dueAnnouncement(), STANDING_LINE
    plan.js       planTick(snapshot, state, serverCfg, now)
                    -> { state, actions, counts, notes, finishedMatch }
  executor.js   applies actions through RconClient, or logs them in dry run [done]
  balancer.js   orchestration: poll, plan, execute, save                     [done]
bin/wd-balancer.js   the CLI: argv, config errors, --check, signals         [done]
balancer.js     shim: require('./src/balancer')
index.js        shim: require('./bin/wd-balancer.js')
```

The two root shims stay for good. `node index.js` is in the README, in the systemd and
pm2 examples, and in units people have already deployed, and `balancer.js` is the
package's `main`.

## Design decisions

### Sides are data, not variables

`openSides(closed)` returns the factions that are in play: two when a faction is closed,
all three when `closedFaction` is `null`. Head counts are a map keyed by faction name.
Every rule is written against that list, so two-sided and three-sided play run the same
code. With two open sides the behaviour is identical to 1.0.0.

How each rule generalises to N open sides:

- **Gap** is the spread: largest open side minus smallest. With two sides that is the old
  `|red - green|`.
- **Placement** (`chooseSide`) builds a preference list: the clan's side, then the side
  the player is already on (if it is open), then the remaining open sides from lightest to
  heaviest. Sides that would break the cap drop out. The first candidate that leaves the
  spread within `gapTolerance` wins; failing that, the candidate with the smallest
  resulting spread wins, earlier preference breaking ties.
- **Clan side** is the open side holding strictly the most members of the tag, not
  counting the player. A tie means no clan preference.
- **Closed door** compares the side the player jumped onto with the side they left. They
  are put back if the new side is over the cap or more than `gapTolerance` heavier than
  the side they left. If the side they left is not an open side (they came off the closed
  faction or an unrecognised one), the comparison is against the lightest other open
  side, and instead of being "put back" they are placed with `chooseSide`. A player is
  never bounced onto the closed faction.
- **Rescue** uses the smallest open side. `minorityShare` keeps its two-sided meaning (the
  smallest side's share of the server) and scales with the number of open sides: the
  threshold is `minorityShare * 2 / sides`. With the default `0.40` that is 40% for two
  sides and about 26.7% for three, which is the same 80% of a fair share in both cases.
  `minGap` is the spread.

### Decide, then do

`planTick()` takes the roster, the saved state, the server's settings and the time, and
returns the next state plus an ordered list of actions (`broadcast`, `restart`, `message`,
`move`). It never modifies the state it was given. As it walks the roster it updates its
own head counts for each move it plans, so later decisions see earlier ones as if they
had gone through. `src/executor.js` then performs the actions in order, or in a dry run
logs them. Dry run and live run share every line of decision code, which is what fixed
the dry run count bug.

Moves are recorded in the planned state as *not done*: the player's current side, their
old `movedAt`, and whether they are now placed. The executor calls `applyMoveSucceeded()`
only for a move the server accepted, which records the new side and time and counts a
closed-side clear. So a refused move, a dry run, or a crash between planning and doing
all leave a state that matches the server, and the next tick retries. The executor keeps
its own tally of moves that really happened for the `now V26/M24` log lines.

If a move fails, the decisions planned after it in that tick assumed it went through, so
they can be off by one for that tick. The next tick reads the real roster and corrects
it. Before step 4 the code used the real result immediately; the difference only shows
when the server refuses moves.

### Config is resolved once per server

`resolveServer(cfg, server)` returns one flat, fully defaulted settings object for a
server. Scalars use the server value when it is not `undefined` (so `null` is a real
value, which `closedFaction` needs). `announce` and `rescue` merge defaults, then global,
then server. `exempt` is the union of the global and server lists. `validate()` checks the
global settings and then each enabled server's resolved settings, reporting a server only
for problems the global block does not already have.

### Dependencies are passed in

From step 3 the balancer takes `{ log, now, clientFor, store }`, or a bare log function
as before. The defaults are the real thing: an `RconClient` that calls whatever
`globalThis.fetch` is at call time, `Date.now`, and a `StateStore` on `stateDir`. That
keeps the 1.x tests running unchanged through step 4; step 5 moves them to injected fakes.

### State on disk

`balancer-state.json` is `{ schema: 2, servers: { name: state } }`. A 1.0.0 file (a bare
map) is read and migrated. Writes go to a temp file that is renamed into place, without
`fsync`: that made each save about 20 times slower, and the only thing it protects
against (power loss) at worst leaves an unreadable file, which is moved aside to
`.corrupt` before seeding fresh. Seeding never moves anybody, so that failure is safe.

`balancer.lock` holds the pid, host and a per-instance token. A lock is stale, and taken
over, when its pid is dead, or when it names this process's own pid but this process
doesn't hold it (a container restart reuses pid 1). A lock from another host can't be
checked, so it holds.

### Still zero dependencies

Plain CommonJS on Node 18+. Tests move to the built-in `node:test` runner in step 5.

## Plan

Each step leaves `node selftest.js` and `node stress.js 10` green.

1. **[done] Tests for the known bugs.** Added scenarios for every choice of closed
   faction, for three open sides (placement, boundary evening, closed door, clans,
   rescue), for the closed-door-onto-closed-faction bug, and for dry run reporting the
   same moves as a live run. The stress harness runs with Valkyra and Manticore closed and
   with three open sides, and its invariants use the open-side spread. The dry run test
   is registered as a known bug: it is reported but does not fail the run, and it fails
   loudly once it starts passing so it gets promoted to a normal check.
2. **[done] `src/factions.js` and `src/config.js`; generic sides.** Faction table and
   aliases moved out of `balancer.js`. Config defaults, merging, per-server resolution and
   validation moved out of `index.js`, which is now only the CLI. Per-server `rescue`,
   `announce`, `closedFaction` and cooldowns are validated; cooldowns can be overridden
   per server; rescue no longer requires a closed faction. `processServer()` uses
   `openSides()` and count maps throughout. State files from 1.0.0 are migrated on load.
3. **[done] `src/api.js` and `src/state.js`.** RCON client with real error reasons (401,
   404, refused, timeout, DNS, unrecognised payload) in the log, each logged once and
   again on recovery. A player list in an unrecognised shape is now a failed read rather
   than an empty server. Atomic state writes, schema version, pruning, lockfile. The
   balancer accepts injected `log`, `now`, `clientFor` and `store`, with defaults that
   keep the existing tests unchanged.
4. **[done] Policy modules and executor.** `processServer()` is now fetch, `planTick()`,
   `execute()`. Every existing test passed unchanged against the split; the dry run test
   was then promoted to a normal check and extended to compare the exact moves and to
   confirm a dry run doesn't repeat them on later ticks. New tests cover a refused move
   being retried and `planTick()` leaving its input alone. Code moved to `src/` and
   `bin/`, with shims at the root.
5. **Tests on `node:test`.** Port `selftest.js` scenarios one for one, switch them from
   patching `globalThis.fetch` and `Date.now` to injected fakes, add unit tests for the
   pure policy functions, keep `stress.js` as the invariant campaign.
6. **Features**, from the list below.

## Possible features

Roughly in order of value for effort.

- **Dry run summary.** "Would end at 26/24 after 9 moves" per tick with any moves. The
  plan already has the numbers; it only needs a log line.
- **Reload config on `SIGHUP`** without losing state.
- **Read-only status endpoint** (the TODO in `src/balancer.js`): current counts, recent
  actions, match history. Opt-in and bound to `127.0.0.1` by default, because the tool's
  security pitch is that it opens no ports.
- **JSON log output** for people shipping logs to Loki or ELK.
- **Clan grouping options:** minimum clan size before grouping applies, tie-break rule.
- **Case-insensitive faction names in config** ("lonestar" as well as "Lonestar").

## Open questions

- **Default announcement.** The tool broadcasts `STANDING_LINE` hourly unless the operator
  sets `announce.message` to `""`. Decide whether that stays on by default.
- **Match history format.** 1.0.0 wrote `peakRed`/`peakGreen`; step 2 writes a `peak` map
  keyed by faction so three-sided matches are recorded. Anything reading the old fields
  needs updating.
