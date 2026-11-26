'use strict';
/*
 * the rules in the readme, one test each, against a fake server. if you change
 * the logic and one of these fails then the readme is now lying, so fix which
 * ever of the two is wrong.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FakeServer, team, makeBalancer, RED, GREEN, BLUE, FACTIONS } = require('./helpers');

const open = (closed) => FACTIONS.filter((f) => f !== closed);

describe('placing people', () => {
  // first look never moves anyone, however bad the teams are. this is the one
  // that stops it wreaking a live round the second you install it.
  it('seeding an uneven server moves nobody', async () => {
    // not even the people on the closed side. they go on the next tick, not this one
    const world = new FakeServer({ players: [...team(40, RED), ...team(10, GREEN), ...team(4, BLUE, 'B')] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    assert.equal(world.moves.length, 0);
  });

  it('new joiner sent to the lighter side', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.players.push({ id: '999001', name: 'Newcomer', fac: RED });
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.id, m.to]), [['999001', GREEN]]);
  });

  it('a joiner cannot push a side past the cap', async () => {
    const world = new FakeServer({ players: [...team(50, RED), ...team(40, GREEN)] });
    const { bal } = makeBalancer(world, { sideCap: 50 });
    await bal.tick();
    world.players.push({ id: '999003', name: 'Latecomer', fac: RED });   // 51st on red
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => m.to), [GREEN]);
  });

  it('join message sent once per player', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    const { bal, ticks } = makeBalancer(world);
    await bal.tick();
    world.players.push({ id: '999005', name: 'Chatty', fac: GREEN });
    await ticks(3);
    assert.equal(world.messages.filter((x) => x === '999005').length, 1);
  });

  it('dry run moves nobody', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { bal } = makeBalancer(world, { dryRun: true });
    await bal.tick();
    world.players.push({ id: '999004', name: 'Ghost', fac: RED });
    await bal.tick();
    assert.deepEqual([world.moves.length, world.messages.length], [0, 0]);
  });

  // dry run has to say what a real run would do. it used to judge every player
  // against the starting counts, so a 35/15 boundary read as 35 moves, not 9.
  it('dry run names the same moves a real run makes, once', async () => {
    const run = async (dryRun) => {
      const world = new FakeServer({ players: [...team(35, RED), ...team(15, GREEN, 'G')] });
      const { bal, logs, ticks } = makeBalancer(world, { dryRun });
      await bal.tick();
      world.map = 'Ozeti';
      await bal.tick();
      const nameOf = (id) => world.find(id).name;
      const would = () => logs.filter((l) => l.includes('WOULD MOVE'));
      const moves = dryRun
        ? would().map((l) => l.replace(/^.*WOULD MOVE (\S+) \S+ -> (\S+).*$/, '$1 -> $2'))
        : world.moves.map((m) => `${nameOf(m.id)} -> ${m.to}`);
      await ticks(2);
      return { moves: moves.sort(), later: dryRun ? would().length - moves.length : 0 };
    };
    const real = await run(false);
    const dry = await run(true);
    assert.equal(real.moves.length, 9);
    assert.deepEqual(dry, real);
  });

  // a move the server refuses is not written down as done
  it('a refused move is retried next tick and not counted until it lands', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(20, GREEN, 'G')] });
    world.refuseMoves = 1;
    const { bal, logs, st } = makeBalancer(world);
    await bal.tick();
    world.players.push({ id: '999201', name: 'Stubborn', fac: BLUE });
    await bal.tick();                                   // refused
    assert.deepEqual([st().known['999201'].fac, st().matchClosedClears], [BLUE, 0]);
    assert.ok(logs.some((l) => l.includes('move FAILED Stubborn')));
    await bal.tick();                                   // retried, goes through
    assert.deepEqual([world.moves.map((m) => m.to), st().known['999201'].fac, st().matchClosedClears],
      [[GREEN], GREEN, 1]);
  });
});

describe('settled players', () => {
  // settled players stay put even when it goes lopsided. this is the promise.
  it('settled players are never moved mid-match', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { ticks } = makeBalancer(world);
    await ticks(3);
    assert.equal(world.moves.length, 0);
  });

  // someone stacks onto the big side. back you go.
  it('switching onto the heavier side is bounced back', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.firstOn(GREEN).fac = RED;
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.from, m.to]), [[RED, GREEN]]);
  });

  // someone volenteers for the small side. leave them alone.
  it('switching toward the lighter side is allowed', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.firstOn(RED).fac = GREEN;
    await bal.tick();
    assert.equal(world.moves.length, 0);
  });

  // map changes, teams get sorted. nobodys mid fight at a map change.
  it('teams are evened at a match boundary', async () => {
    const world = new FakeServer({ players: [...team(35, RED), ...team(15, GREEN)] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.map = 'Ozeti';
    await bal.tick();
    assert.ok(world.spread([RED, GREEN]) <= 3);
  });

  // REGRESSION. a stress run found this: one empty/dud player list used to wipe
  // the memory, and the next good tick re placed everybody mid match.
  it('one dud player list does not wipe memory or reshuffle a live match', async () => {
    const world = new FakeServer({ players: [...team(40, RED), ...team(18, GREEN, 'G')] });
    const { bal, st } = makeBalancer(world);
    await bal.tick();
    const knownAfterSeed = Object.keys(st().known).length;
    world.dudList = true;
    await bal.tick();
    const knownAfterBlip = Object.keys(st().known).length;
    world.dudList = false;
    world.moves.length = 0;
    await bal.tick();
    assert.deepEqual([knownAfterSeed, knownAfterBlip, world.moves.length], [58, 58, 0]);
  });
});

describe('clans', () => {
  it('a clan member joins their clan', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    world.players.push({ id: '888001', name: '[WOLF] One', fac: GREEN });
    world.players.push({ id: '888002', name: '[WOLF] Two', fac: GREEN });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.players.push({ id: '888003', name: '[WOLF] Three', fac: RED });
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.id, m.to]), [['888003', GREEN]]);
  });

  // but not if that would blow the cap. mates is nice, 51 v 43 is not.
  it('clan grouping yields to the cap', async () => {
    const world = new FakeServer({ players: [...team(49, RED), ...team(50, GREEN, 'G')] });
    world.players[60].name = '[WOLF] Anchor';            // clan sits on the full green side
    const { bal } = makeBalancer(world, { sideCap: 50 });
    await bal.tick();
    world.players.push({ id: '888004', name: '[WOLF] Late', fac: RED });
    await bal.tick();
    const moved = world.moves.find((m) => m.id === '888004');
    assert.equal(moved ? moved.to : 'not moved', 'not moved');
  });

  it('a split clan ends up more together than it started', async () => {
    const world = new FakeServer({ players: [...team(24, RED), ...team(24, GREEN, 'G')] });
    world.players.push({ id: '777001', name: '[OWLS] a', fac: RED });
    world.players.push({ id: '777002', name: '[OWLS] b', fac: RED });
    world.players.push({ id: '777003', name: '[OWLS] c', fac: GREEN });
    world.players.push({ id: '777004', name: '[OWLS] d', fac: GREEN });
    const { bal, ticks } = makeBalancer(world);
    await bal.tick();
    world.map = 'Ozeti';
    await ticks(2);
    const onRed = world.players.filter((p) => p.name.startsWith('[OWLS]') && p.fac === RED).length;
    assert.ok(Math.max(onRed, 4 - onRed) >= 3);
  });
});

describe('the closed side', () => {
  it('player on the closed faction is moved off', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.players.push({ id: '999002', name: 'BlueGuy', fac: BLUE });
    await bal.tick();
    const m = world.moves[0];
    assert.deepEqual([world.moves.length, m && m.from, m && m.to !== BLUE], [1, BLUE, true]);
  });

  // it NEVER puts anyone on the closed side. not once, not ever, whatever the
  // teams look like.
  it('never moves anyone onto the closed side, across 6 messy servers', async () => {
    let everSentToClosed = false;
    for (const [r, g, b] of [[50, 2, 6], [2, 50, 6], [25, 25, 20], [49, 49, 4], [1, 1, 40], [40, 3, 9]]) {
      const world = new FakeServer({ players: [...team(r, RED), ...team(g, GREEN, 'G'), ...team(b, BLUE, 'B')] });
      const { bal, ticks } = makeBalancer(world);
      await bal.tick();
      world.map = 'Ozeti';
      await ticks(2);
      if (world.moves.some((m) => m.to === BLUE) || world.count(BLUE) > 0) everSentToClosed = true;
    }
    assert.equal(everSentToClosed, false);
  });

  it('every move target is red or green only', async () => {
    const world = new FakeServer({ players: [...team(38, RED), ...team(6, GREEN, 'G'), ...team(8, BLUE, 'B')] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.map = 'Ozeti';
    await bal.tick();
    assert.deepEqual([...new Set(world.moves.map((m) => m.to))].sort(), [GREEN, RED].sort());
  });

  // people keep turning up on the closed side every tick for 12 ticks, across a
  // map change. nobody should be sat on it, nobody should be SENT there.
  it('12 ticks of people picking blue: never sent there, never left there', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    const { bal, ticks } = makeBalancer(world);
    await bal.tick();
    let sentToClosed = 0, strandedTicks = 0, n = 0;
    for (let t = 0; t < 12; t++) {
      world.players.push({ id: String(400000 + n++), name: 'blue' + t + 'a', fac: BLUE });
      world.players.push({ id: String(400000 + n++), name: 'blue' + t + 'b', fac: BLUE });
      if (t === 6) world.map = 'Ozeti';
      await ticks(2);
      if (world.count(BLUE) > 0) strandedTicks++;
      sentToClosed += world.moves.filter((m) => m.to === BLUE).length;
      world.moves.length = 0;
    }
    assert.deepEqual([sentToClosed, strandedTicks], [0, 0]);
  });

  // REGRESSION. somebody seeded on the closed side who hops onto the heavy side
  // before we clear them used to get bounced straight back ONTO the closed side.
  it('the closed door never bounces anybody onto the closed side', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN, 'G'), ...team(1, BLUE, 'B')] });
    const { bal } = makeBalancer(world);
    await bal.tick();
    world.firstOn(BLUE).fac = RED;
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.from, m.to]), [[RED, GREEN]]);
  });
});

describe('admins', () => {
  it('exempt admin is never moved, even at a match boundry', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    world.players.push({ id: '555001', name: 'TheAdmin', fac: RED });
    const { bal, ticks } = makeBalancer(world, { exempt: ['555001'] });
    await bal.tick();
    world.map = 'Ozeti';
    await ticks(2);
    assert.deepEqual([world.moves.some((m) => m.id === '555001'), world.find('555001').fac === RED], [false, true]);
  });

  it('exempt admin can switch onto the heavy side without being put back', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    world.players.push({ id: '555002', name: 'TheAdmin', fac: GREEN });
    const { bal, ticks } = makeBalancer(world, { exempt: ['555002'] });
    await bal.tick();
    world.find('555002').fac = RED;
    await ticks(2);
    assert.equal(world.moves.filter((m) => m.id === '555002').length, 0);
  });

  it('exempting one person does not break the closed side clear', async () => {
    const world = new FakeServer({ players: [...team(24, RED), ...team(24, GREEN, 'G'), ...team(5, BLUE, 'B')] });
    world.players.push({ id: '555003', name: 'TheAdmin', fac: RED });
    const { ticks } = makeBalancer(world, { exempt: ['555003'] });
    await ticks(3);
    assert.equal(world.players.filter((p) => p.fac === BLUE && p.id !== '555003').length, 0);
  });
});

describe('any faction can be the closed one', () => {
  it('any closed faction: a joiner on it goes to the lighter open side', async () => {
    for (const closed of FACTIONS) {
      const [a, b] = open(closed);
      const world = new FakeServer({ players: [...team(25, a), ...team(20, b)] });
      const { bal } = makeBalancer(world, { closedFaction: closed });
      await bal.tick();
      world.players.push({ id: '999101', name: 'WrongDoor', fac: closed });
      await bal.tick();
      assert.deepEqual(world.moves.map((m) => [m.id, m.to]), [['999101', b]], `${closed} closed`);
    }
  });

  it('any closed faction: a boundary empties it and evens the other two', async () => {
    for (const closed of FACTIONS) {
      const sides = open(closed);
      const world = new FakeServer({ players: [...team(20, closed, 'C'), ...team(22, sides[0], 'A'), ...team(8, sides[1], 'B')] });
      const { bal, ticks } = makeBalancer(world, { closedFaction: closed });
      await bal.tick();
      world.map = 'Ozeti';
      await ticks(2);
      assert.deepEqual(
        { onClosed: world.count(closed), sentToClosed: world.moves.filter((m) => m.to === closed).length, even: world.spread(sides) <= 3 },
        { onClosed: 0, sentToClosed: 0, even: true }, `${closed} closed`);
    }
  });

  it('any closed faction: switching onto the heavier side is bounced back', async () => {
    for (const closed of FACTIONS) {
      const [a, b] = open(closed);
      const world = new FakeServer({ players: [...team(30, a), ...team(20, b, 'B')] });
      const { bal } = makeBalancer(world, { closedFaction: closed });
      await bal.tick();
      world.firstOn(b).fac = a;
      await bal.tick();
      assert.deepEqual(world.moves.map((m) => [m.from, m.to]), [[a, b]], `${closed} closed`);
    }
  });
});

describe('three open sides', () => {
  it('three open: a joiner goes to the lightest of the three', async () => {
    const world = new FakeServer({ players: [...team(20, RED), ...team(20, GREEN), ...team(15, BLUE)] });
    const { bal } = makeBalancer(world, { closedFaction: null });
    await bal.tick();
    world.players.push({ id: '999006', name: 'Third', fac: RED });
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.id, m.to]), [['999006', BLUE]]);
  });

  it('three open: a boundary evens all three sides', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(15, GREEN, 'G'), ...team(5, BLUE, 'B')] });
    const { bal, ticks } = makeBalancer(world, { closedFaction: null });
    await bal.tick();
    world.map = 'Ozeti';
    await ticks(2);
    assert.ok(world.spread(FACTIONS) <= 3);
  });

  it('three open: onto a heavier side is bounced, onto a lighter one is allowed', async () => {
    const world = new FakeServer({ players: [...team(20, RED), ...team(20, GREEN, 'G'), ...team(15, BLUE, 'B')] });
    const { bal } = makeBalancer(world, { closedFaction: null });
    await bal.tick();
    world.firstOn(BLUE).fac = RED;          // 15 -> 20 side, makes it worse
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.from, m.to]), [[RED, BLUE]]);
    world.moves.length = 0;
    world.firstOn(GREEN).fac = BLUE;        // 20 -> 15 side, helps
    await bal.tick();
    assert.equal(world.moves.length, 0);
  });

  it('three open: a clan member joins their clan', async () => {
    const world = new FakeServer({ players: [...team(20, RED), ...team(18, GREEN, 'G'), ...team(20, BLUE, 'B')] });
    world.players.push({ id: '888101', name: '[OWLS] a', fac: GREEN });
    world.players.push({ id: '888102', name: '[OWLS] b', fac: GREEN });
    const { bal } = makeBalancer(world, { closedFaction: null });
    await bal.tick();
    world.players.push({ id: '888103', name: '[OWLS] c', fac: RED });
    await bal.tick();
    assert.deepEqual(world.moves.map((m) => [m.id, m.to]), [['888103', GREEN]]);
  });
});
