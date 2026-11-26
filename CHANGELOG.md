# Whats changed

Newest at the top. Version numbers follow [semver](https://semver.org): the first number
changes if I break your config, the second if theres somthing new, the third for fixes.

## Unreleased

**Fixed**

- `closedFaction` only worked when it was `Lonestar`. With `Valkyra` or `Manticore` closed
  it never cleared the closed side and could move players onto it. Any of the three works
  now.
- `closedFaction: null` ignored the third side instead of balancing it. All three sides are
  balanced now: placement, the closed door, clans, match boundaries and rescue.
- The closed door could bounce somebody back onto the closed side if they had been seeded
  there and switched before being cleared. They get placed properly now.
- Per server `rescue`, `announce`, `closedFaction` and cooldowns were never validated. They
  are now, with the same rules as the global settings.

**Changed**

- `--check` lists every problem in the config at once instead of stopping at the first.
- `moveCooldownSeconds` and `bounceCooldownSeconds` can be set per server. A non-number in
  either is rejected; before, it meant nobody was ever moved.
- Rescue works with three open sides. `minorityShare` scales to `minorityShare * 2 / 3`.
- `match-history.json` records `peak` as a map keyed by faction instead of `peakRed` and
  `peakGreen`. State files from 1.0.0 are migrated on load.
- Config handling moved to `src/config.js` and the faction table to `src/factions.js`.
- When a server wont answer, the log says why: bad token, wrong port, refused, timed out,
  DNS, or a payload it doesnt recognise. Each failure is logged once rather than every
  poll, and recovery is logged too. Failed moves, announcements and rescue calls carry the
  reason as well.
- A player list in a shape it doesnt recognise is treated as a failed read, not as an
  empty server.
- The state file is writen atomically (temp file and rename) in a versioned format,
  `{ "schema": 2, "servers": { ... } }`. An unreadable state file is moved to
  `balancer-state.json.corrupt` and logged instead of silently re seeding. Servers removed
  from the config are forgotten on start.
- A lockfile in `stateDir` stops a second copy running against the same state. Stale
  locks from a crash, or from a container restart reusing the pid, are taken over.
- RCON calls moved to `src/api.js` and state handling to `src/state.js`. `Balancer`
  accepts `{ log, now, clientFor, store }` as well as a bare log function.

**Known**

- Dry run still overstates moves at a match boundary, because it never updates its counts
  as it goes. There's a test for it, and the fix comes with the planned split between
  deciding and doing in `docs/ARCHITECTURE.md`.

## 1.0.0

First public release.

**What it does**

- Evens the two playing sides by placing new arrivals, never by draging somebody who is
  allready in a fight.
- Leaves the round its started on completly alone, and re evens at the next map change.
- Keeps the third faction empty, and never sends anybody to it.
- Keeps clan tags together where the cap and the gap allow it.
- Bounces anybody who switches onto the full or the heavier side. The closed door.
- Remembers across a restart, so a crash or an update dosent reshuffle a live match.
- `exempt` list so your admins can move about freely without being treated as stackers.
- `rescue`, off by default, which warns and then restarts a round the teams have ruined.
- Broadcasts one line on a timer. Yours if you set one, mine if you dont, nothing if you
  set it empty.

**How its been tested**

- 36 tests covering every rule, run against a fake server in memory.
- 660 randomised stress runs over 120,000 ticks, checking 8 invariants after every single
  tick, with no violations. That harness ships as `stress.js`, so the number is one you can
  reproduce rather than one you have to believe. CI runs a short pass of it on every push.
- A six hour soak across eight simulated servers. 26,000 players through it, memory stayed
  bounded.
- The 40% imbalance threshold was checked against 344,000 real kills from live servers.
- Sat on a live 50v50 in dry run, reading it every two seconds for twelve minutes while the
  server drained out. The gap got to 6 on a tolerance of 3 and it moved nobody, becuase they
  were all settled in a round that had allready started. Which is the whole point.

**Known, and said out loud**

- It has not yet moved a real player on a real server. The rules have years on them, this
  packaging does not. Run `--dry-run` for a match before you trust it.

**Fixed before release**

- An empty or half finished player list from the game API was being read as "everyone
  left", which wiped its memory and then re placed the whole server mid match. Found by
  stress testing. Absent players now keep their place for five minutes.
- `--check` used to say your config was fine when the password or the host was still a
  placeholder, and then it would just fail to connect with no explanation. It names the one
  you left in now.
- `announce.minPlayers` disagreed between the code and the example config, so what you got
  depended on which one you copied.
- The shebang had Windows line endings, so it wouldnt run as an executable on linux.
