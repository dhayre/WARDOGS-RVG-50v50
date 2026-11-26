'use strict';
/*
 * the rules on their own, with no server, no balancer and no clock. each of these
 * is a plain function: numbers in, a decision out.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RED, GREEN, BLUE } = require('../src/factions');
const { mergeConfig, resolveServer } = require('../src/config');
const { tally, spread, fmtCounts } = require('../src/policy/counts');
const { chooseSide, clanSideFor, bounceTarget } = require('../src/policy/placement');
const { readSnapshot, detectBoundary } = require('../src/policy/match');
const { isLopsided, rescueStep } = require('../src/policy/rescue');
const { dueAnnouncement, STANDING_LINE } = require('../src/policy/announce');
const { planTick, FORGET_AFTER_MS } = require('../src/policy/plan');

const LIMITS = { sideCap: 50, gapTolerance: 3 };
const two = (r, g) => ({ [RED]: r, [GREEN]: g });
const three = (r, g, b) => ({ [RED]: r, [GREEN]: g, [BLUE]: b });
const MIN = 60 * 1000;

describe('counts', () => {
  it('tally counts open sides and clan tags, and skips the closed side and unknowns', () => {
    const { counts, tagCounts } = tally([
      { fac: RED, tag: 'A' }, { fac: RED, tag: null }, { fac: GREEN, tag: 'A' },
      { fac: BLUE, tag: 'A' }, { fac: null, tag: 'A' },
    ], [RED, GREEN]);
    assert.deepEqual([counts, tagCounts], [two(2, 1), { A: { [RED]: 1, [GREEN]: 1 } }]);
  });

  it('spread is biggest minus smallest, and the log format uses initials', () => {
    assert.deepEqual([spread(two(26, 24)), spread(three(17, 17, 12)), spread({}), fmtCounts(three(17, 17, 16))],
      [2, 5, 0, 'V17/M17/L16']);
  });
});

describe('chooseSide', () => {
  // counts include the player, on the side theyre on now
  it('stays put when that is inside the tolerance', () => {
    assert.equal(chooseSide(two(21, 20), RED, null, LIMITS), RED);
  });

  it('goes to the lighter side when staying would break the tolerance', () => {
    assert.equal(chooseSide(two(25, 20), RED, null, LIMITS), GREEN);
  });

  it('goes to the clan when that is inside the tolerance', () => {
    assert.equal(chooseSide(two(21, 20), RED, GREEN, LIMITS), GREEN);
  });

  it('when nothing is inside the tolerance, takes the smallest gap even over the clan', () => {
    assert.equal(chooseSide(two(20, 26), RED, GREEN, LIMITS), RED);
  });

  it('never breaks the cap for a joiner', () => {
    assert.equal(chooseSide(two(51, 40), RED, null, LIMITS), GREEN);
  });

  // leaving somebody stuck on a shut faction is worse than 51 a side
  it('clearing the closed side beats the cap when every side is full', () => {
    assert.equal(chooseSide(two(50, 50), BLUE, null, LIMITS), RED);
  });

  it('with three sides, picks the one that leaves the smallest spread', () => {
    assert.equal(chooseSide(three(21, 20, 15), RED, null, LIMITS), BLUE);
  });

  it('only ever answers with a side in the counts', () => {
    for (const cur of [RED, GREEN, BLUE, null]) {
      for (const clan of [RED, GREEN, BLUE, null]) {
        assert.ok([RED, GREEN].includes(chooseSide(two(30, 10), cur, clan, LIMITS)));
      }
    }
  });
});

describe('clanSideFor', () => {
  const tags = { OWLS: { [RED]: 2, [GREEN]: 2, [BLUE]: 3 } };

  it('is the side with strictly the most of the tag, not counting the player', () => {
    assert.equal(clanSideFor({ tag: 'OWLS', fac: RED }, tags, [RED, GREEN, BLUE]), BLUE);
    assert.equal(clanSideFor({ tag: 'OWLS', fac: BLUE }, tags, [RED, GREEN, BLUE]), null);   // 2/2/2 without them
  });

  it('is nothing for no tag, an unknown tag, or a clan of one', () => {
    assert.deepEqual([
      clanSideFor({ tag: null, fac: RED }, tags, [RED, GREEN]),
      clanSideFor({ tag: 'WOLF', fac: RED }, tags, [RED, GREEN]),
      clanSideFor({ tag: 'SOLO', fac: RED }, { SOLO: { [RED]: 1 } }, [RED, GREEN]),
    ], [null, null, null]);
  });

  it('ignores clan members on the closed side', () => {
    // three of them sit on BLUE, but BLUE is shut: without the player its 1 v 2, so GREEN
    assert.equal(clanSideFor({ tag: 'OWLS', fac: RED }, tags, [RED, GREEN]), GREEN);
    assert.equal(clanSideFor({ tag: 'OWLS', fac: GREEN }, tags, [RED, GREEN]), RED);
  });
});

describe('bounceTarget (the closed door)', () => {
  // counts are after the switch: they are allready on the side they jumped to
  it('jumping to the lighter side is left alone', () => {
    assert.equal(bounceTarget({ fac: GREEN }, RED, two(29, 21), null, LIMITS), null);
  });

  it('jumping onto a side heavier than the one you left, past the tolerance, sends you back', () => {
    assert.equal(bounceTarget({ fac: RED }, GREEN, two(31, 19), null, LIMITS), GREEN);
  });

  it('jumping onto a full side sends you back, even inside the tolerance', () => {
    assert.equal(bounceTarget({ fac: RED }, GREEN, two(51, 49), null, LIMITS), GREEN);
  });

  it('coming off the closed side onto a heavy one gets you placed, never sent back', () => {
    assert.equal(bounceTarget({ fac: RED }, BLUE, two(31, 20), null, LIMITS), GREEN);
  });

  it('with three sides, it compares with the side you left, not the lightest', () => {
    // 20/20/15, someone goes RED -> GREEN: 19/21/15. worse than the 15 side, fine against RED
    assert.equal(bounceTarget({ fac: GREEN }, RED, three(19, 21, 15), null, LIMITS), null);
  });
});

describe('spotting a new match', () => {
  const st = (o) => Object.assign({ matchSig: 'A|x', matchScoreSum: 50, lastUptime: 1000, lastRebalanceAt: 0 }, o);
  const snap = (o) => Object.assign({ sig: 'A|x', scoreSum: 60, scoreLead: 0, uptime: 1010 }, o);
  const NOW = 10 * MIN;

  it('fires on a map rotation, a score reset, or an uptime drop', () => {
    assert.deepEqual([
      detectBoundary(st(), snap({ sig: 'B|y' }), NOW),
      detectBoundary(st(), snap({ scoreSum: 0 }), NOW),
      detectBoundary(st(), snap({ uptime: 5 }), NOW),
    ], ['map -> B|y', 'scores reset', 'box restarted']);
  });

  it('does not fire on the same match, a reset from almost nothing, a small uptime wobble, or a missing status', () => {
    assert.deepEqual([
      detectBoundary(st(), snap(), NOW),
      detectBoundary(st({ matchScoreSum: 5 }), snap({ scoreSum: 0 }), NOW),
      detectBoundary(st(), snap({ uptime: 950 }), NOW),
      detectBoundary(st(), snap({ sig: null }), NOW),
    ], [null, null, null, null]);
  });

  it('fires at most once a minute', () => {
    assert.equal(detectBoundary(st({ lastRebalanceAt: NOW - 30 * 1000 }), snap({ sig: 'B|y' }), NOW), null);
  });

  it('reads the leader margin and nulls out failed calls', () => {
    assert.deepEqual(readSnapshot({ ok: true, map: 'M', experiences: ['k'], scores: [5, 40, 12] }, { ok: false }),
      { sig: 'M|k', scoreSum: 57, scoreLead: 28, uptime: null });
    assert.deepEqual(readSnapshot({ ok: false }, { ok: true, uptimeSeconds: 9 }),
      { sig: null, scoreSum: null, scoreLead: 0, uptime: 9 });
  });
});

describe('rescue', () => {
  const RS = mergeConfig({}).rescue;
  // a real clock. starting near 0 would put every test inside the cooldown after a
  // restart "at" the epoch, and the state machine would never move.
  const T0 = 1700000000000;
  const on = Object.assign({}, RS, { enabled: true });

  // the table in the readme
  it('broken means under 40% on the small side, a gap of 8, and 20 players', () => {
    assert.deepEqual([[59, 48], [40, 30], [50, 35], [40, 25], [45, 23], [12, 6]].map(([r, g]) => isLopsided(two(r, g), RS)),
      [false, false, false, true, true, false]);
  });

  it('with three sides the line scales to 40% * 2/3', () => {
    assert.deepEqual([isLopsided(three(30, 30, 10), RS), isLopsided(three(30, 26, 22), RS)], [true, false]);
  });

  it('waits out the grace period, warns, waits out the window, then restarts', () => {
    const st = {};
    const lop = two(45, 23);
    const steps = [];
    for (const t of [0, 2 * MIN, 4 * MIN, 5 * MIN, 6 * MIN]) steps.push(rescueStep(st, lop, 40, on, T0 + t));
    assert.deepEqual(steps, [null, null, 'warn', null, 'restart']);
  });

  it('does nothing while the score is close, and nothing during the cooldown', () => {
    const close = {};
    assert.deepEqual([rescueStep(close, two(45, 23), 40, on, T0), rescueStep(close, two(45, 23), 5, on, T0 + 4 * MIN)], [null, null]);
    assert.equal(close.lopsidedSince, T0);       // the clock did start; only the score held it back
    const cooling = { lastRestartAt: T0 };
    assert.equal(rescueStep(cooling, two(45, 23), 40, on, T0 + 2 * MIN), null);
    assert.equal(cooling.lopsidedSince, undefined);
  });

  it('says so when a warned server recovers, and forgets the warning', () => {
    const st = { lopsidedSince: T0, warnedAt: T0 };
    assert.equal(rescueStep(st, two(34, 34), 40, on, T0 + MIN), 'recovered');
    assert.deepEqual([st.lopsidedSince, st.warnedAt], [0, 0]);
  });

  it('is nothing at all when switched off', () => {
    assert.equal(rescueStep({ lopsidedSince: 1, warnedAt: 1 }, two(45, 23), 40, RS, 99 * MIN), null);
  });
});

describe('announcements', () => {
  const NOW = 2 * 60 * MIN;
  it('sends the default, yours, or nothing', () => {
    assert.deepEqual([
      dueAnnouncement({}, { everyMinutes: 60 }, 50, NOW),
      dueAnnouncement({}, { everyMinutes: 60, message: ' mine ' }, 50, NOW),
      dueAnnouncement({}, { everyMinutes: 60, message: '' }, 50, NOW),
    ], [STANDING_LINE, 'mine', null]);
  });

  it('waits for the interval and for enough players, and marks when it went out', () => {
    const st = { lastAnnounceAt: NOW - 30 * MIN };
    assert.equal(dueAnnouncement(st, { everyMinutes: 60 }, 50, NOW), null);
    assert.equal(dueAnnouncement({}, { everyMinutes: 60, minPlayers: 10 }, 9, NOW), null);
    const due = {};
    dueAnnouncement(due, { everyMinutes: 60 }, 50, NOW);
    assert.equal(due.lastAnnounceAt, NOW);
  });
});

describe('planTick', () => {
  const cfg = mergeConfig({ closedFaction: BLUE, joinMessage: 'hi', moveCooldownSeconds: 30, servers: [{ name: 's' }] });
  const eff = (o) => Object.assign(resolveServer(cfg, cfg.servers[0]), o || {});
  const status = { ok: true, map: 'M', experiences: [], scores: [0, 0, 0] };
  const health = { ok: true, uptimeSeconds: 5 };
  const P = (id, fac) => ({ id, fac, tag: null, name: 'n' + id });
  const roster = (n, fac, base) => Array.from({ length: n }, (_, i) => P(String(base + i), fac));
  const plan = (players, prev, now, o) => planTick({ players, status, health }, prev, eff(o), now);
  const moves = (p) => p.actions.filter((a) => a.type === 'move').map((a) => [a.id, a.to]);

  // planning is pure: it hands back a new state and leaves the one it was given
  // alone, so a crash between deciding and doing loses nothing
  it('planTick leaves its input state untouched and returns the moves to make', () => {
    const prev = { seeded: true, known: { 1: { fac: RED, movedAt: 0, placed: false } }, messaged: {}, matchSig: 'M|', matchScoreSum: 0, matchPeak: {} };
    const frozen = JSON.stringify(prev);
    const p = planTick({ players: [P('1', RED), P('2', BLUE)], status, health }, prev, resolveServer(mergeConfig({ servers: [{ name: 's' }] }), { name: 's' }), 1000);
    assert.equal(JSON.stringify(prev), frozen);
    assert.deepEqual(moves(p), [['2', GREEN]]);
  });

  it('the first look writes everyone down as settled and plans nothing', () => {
    // a real clock, so no cooldown is what holds the closed side back: only seeding
    const p = plan([...roster(40, RED, 100), ...roster(5, BLUE, 300)], undefined, 1700000000000);
    assert.deepEqual([p.actions, p.state.seeded, Object.values(p.state.known).every((k) => k.placed)], [[], true, true]);
    assert.match(p.notes[0], /^seeded 45 player/);
  });

  it('a planned move is written to state as not done yet', () => {
    const seeded = plan(roster(25, RED, 100), undefined, 0).state;
    const p = plan([...roster(25, RED, 100), P('9', BLUE)], seeded, 1000);
    assert.deepEqual([moves(p), p.state.known['9'], p.state.matchClosedClears], [[['9', GREEN]], { fac: BLUE, movedAt: 0, placed: false }, 0]);
  });

  it('welcomes a new player once, and never somebody who was there at seeding', () => {
    const seeded = plan(roster(20, RED, 100), undefined, 0).state;
    const first = plan([...roster(20, RED, 100), P('9', GREEN)], seeded, 1000);
    const second = plan([...roster(20, RED, 100), P('9', GREEN)], first.state, 2000);
    const welcomes = (p) => p.actions.filter((a) => a.type === 'message').map((a) => a.id);
    assert.deepEqual([welcomes(first), welcomes(second)], [['9'], []]);
  });

  it('respects the move cooldown, but not for somebody on the closed side', () => {
    const players = [...roster(30, RED, 100), P('1', RED), P('2', BLUE)];
    const prev = plan(players, undefined, 0).state;
    const T = 1000 * 1000;
    prev.known['1'] = { fac: RED, movedAt: T - 10 * 1000, placed: false };   // wants placing, moved 10s ago
    prev.known['2'] = { fac: BLUE, movedAt: T - 1000, placed: true };        // on the closed side
    const p = plan(players, prev, T, { bounceCooldownSeconds: 0 });
    assert.deepEqual(moves(p), [['2', GREEN]]);
  });

  it('remembers somebody who vanished for five minutes, then forgets them', () => {
    const seeded = plan([P('1', RED), P('2', GREEN)], undefined, 0).state;
    const gone = plan([P('2', GREEN)], seeded, 1000).state;
    const stillGone = plan([P('2', GREEN)], gone, 1000 + FORGET_AFTER_MS).state;
    const forgotten = plan([P('2', GREEN)], stillGone, 1001 + FORGET_AFTER_MS).state;
    assert.deepEqual(['1' in gone.known, '1' in stillGone.known, '1' in forgotten.known], [true, true, false]);
  });

  it('an exempt player is written down and never planned for', () => {
    const seeded = plan(roster(30, RED, 100), undefined, 0).state;
    const p = plan([...roster(30, RED, 100), P('76561198000000001', BLUE)], seeded, 1000, { exempt: ['76561198000000001'] });
    assert.deepEqual([p.actions, p.state.known['76561198000000001'].fac], [[], BLUE]);
  });

  it('later decisions see earlier moves, so a boundary moves only as many as it needs', () => {
    const seeded = plan([...roster(35, RED, 100), ...roster(15, GREEN, 200)], undefined, 0).state;
    const p = plan([...roster(35, RED, 100), ...roster(15, GREEN, 200)], seeded, 61 * 1000, {});
    const rotated = planTick({ players: [...roster(35, RED, 100), ...roster(15, GREEN, 200)], status: Object.assign({}, status, { map: 'N' }), health },
      p.state, eff(), 2 * 61 * 1000);
    assert.equal(moves(rotated).length, 9);
    assert.ok(rotated.finishedMatch);
  });
});
