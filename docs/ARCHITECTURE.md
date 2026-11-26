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
                and returns { ok, status, reason } instead of null/false.
  state.js      StateStore: load/save via tmp file + rename, schema version and
                migration, pruning of servers no longer configured, a lockfile
                so two instances cannot run against one stateDir.
  policy/       pure functions, no I/O, no clock reads:
    match.js      detectBoundary(prevState, snapshot)
    placement.js  chooseSide(), clanSide(), bounce decision
    rescue.js     the warn/restart state machine
    announce.js   isDue()
    plan.js       planTick(snapshot, state, serverCfg, now) -> { actions, nextState }
  executor.js   applies actions through RconClient, or logs them in dry run
  balancer.js   orchestration: poll, plan, execute, save
bin/wd-balancer.js   argv parsing and log formatting only
```

`balancer.js` and `index.js` stay at the repo root until step 4 so that the package entry
points and the test imports keep working during the transition.

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

Step 4 splits `processServer()` into a pure `planTick()` that returns a list of actions
and updates its own tallies as it goes, and an executor that performs or logs them. Dry
run and live run then share every line of decision code, which fixes the dry run count
bug by construction. A failed move is reported back so the next tick retries, as today.

### Config is resolved once per server

`resolveServer(cfg, server)` returns one flat, fully defaulted settings object for a
server. Scalars use the server value when it is not `undefined` (so `null` is a real
value, which `closedFaction` needs). `announce` and `rescue` merge defaults, then global,
then server. `exempt` is the union of the global and server lists. `validate()` checks the
global settings and then each enabled server's resolved settings, reporting a server only
for problems the global block does not already have.

### Dependencies are passed in

From step 3 the balancer takes `{ client, now, log }` instead of reaching for
`globalThis.fetch` and `Date.now`. Tests and the stress harness inject fakes directly.

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
3. **`src/api.js` and `src/state.js`.** RCON client with real error reasons (401,
   timeout, refused) in the log. Atomic state writes, schema version, pruning, lockfile.
   Balancer takes injected `client`, `now` and `log`; tests stop patching globals.
4. **Policy modules and executor.** Split `processServer()` into `policy/*` and
   `executor.js` as above. Fixes the dry run bug; promote its test. Move entry points
   into `src/` and `bin/`.
5. **Tests on `node:test`.** Port `selftest.js` scenarios one for one, add unit tests for
   the pure policy functions, keep `stress.js` as the invariant campaign.
6. **Features**, from the list below.

## Possible features

Roughly in order of value for effort.

- **Dry run summary.** "Would end at 26/24 after 9 moves" per tick with any moves. Nearly
  free after step 4.
- **Specific connection errors.** "401: wrong token", "timed out after 6s", "connection
  refused". Comes with step 3.
- **Reload config on `SIGHUP`** without losing state.
- **Read-only status endpoint** (the TODO in `balancer.js`): current counts, recent
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
