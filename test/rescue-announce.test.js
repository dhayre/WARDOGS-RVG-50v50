'use strict';
/*
 * the two things that talk to the whole server: the rescue (warn, give them a
 * chance, then restart the round) and the timed announcement. both run on the
 * clock, so these wind it on instead of waiting.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FakeServer, team, makeBalancer, MIN, RED, GREEN, BLUE } = require('./helpers');
const { STANDING_LINE } = require('../src/balancer');

const RESCUE = { rescue: { enabled: true, graceMinutes: 3, warnSeconds: 90, scoreLead: 15 } };

/* drive a server to a score lead, then through the grace period and the warning
 * window. returns how many warnings went out and how many restarts happened. */
async function rescueRun(red, green, lead, overrides, blue) {
  const world = new FakeServer({ players: [...team(red, RED), ...team(green, GREEN, 'G'), ...team(blue || 0, BLUE, 'B')] });
  world.scoreLead = lead;
  const h = makeBalancer(world, Object.assign({}, RESCUE, overrides || {}));
  await h.bal.tick();                 // seed
  await h.bal.tick();                 // lopsided: the grace clock starts
  h.advance(4 * MIN);
  await h.bal.tick();                 // grace served: warn
  const warned = world.broadcasts.length;
  h.advance(91 * 1000);
  await h.bal.tick();                 // window expired: restart
  return { warned, restarts: world.restarts };
}

describe('rescue', () => {
  // the numbers the founder called FINE must never trigger
  it('teams the founder called fine are never restarted', async () => {
    for (const [r, g] of [[59, 48], [40, 30], [50, 40], [45, 40], [30, 20]]) {
      assert.deepEqual(await rescueRun(r, g, 40), { warned: 0, restarts: 0 }, `${r} v ${g}`);
    }
  });

  it('badly lopsided teams get warned then restarted', async () => {
    for (const [r, g] of [[40, 25], [45, 23], [50, 30]]) {
      assert.deepEqual(await rescueRun(r, g, 40), { warned: 1, restarts: 1 }, `${r} v ${g}`);
    }
  });

  // lopsided but still a close game: leave it alone, its not hurting anyone
  it('lopsided but close on score is left alone', async () => {
    assert.deepEqual(await rescueRun(45, 23, 5), { warned: 0, restarts: 0 });
  });

  it('if players even it up themselves, no restart happens', async () => {
    const world = new FakeServer({ players: [...team(45, RED), ...team(23, GREEN, 'G')] });
    world.scoreLead = 40;
    const { bal, advance } = makeBalancer(world, RESCUE);
    await bal.tick();
    await bal.tick();
    advance(4 * MIN);
    await bal.tick();                                   // warned
    assert.equal(world.broadcasts.length, 1);
    // 11 people do the decent thing and switch to the small side
    let moved = 0;
    for (const p of world.players) { if (p.fac === RED && moved < 11) { p.fac = GREEN; moved++; } }
    advance(91 * 1000);
    await bal.tick();
    assert.equal(world.restarts, 0);
  });

  // off by default. nobody elses match gets restarted uninvited.
  it('rescue is off unless you switch it on', async () => {
    const world = new FakeServer({ players: [...team(45, RED), ...team(23, GREEN, 'G')] });
    world.scoreLead = 40;
    const { bal, advance } = makeBalancer(world);       // no rescue block at all
    await bal.tick();
    await bal.tick();
    advance(10 * MIN);
    await bal.tick();
    advance(2 * MIN);
    await bal.tick();
    assert.deepEqual([world.broadcasts.length, world.restarts], [0, 0]);
  });

  // 40% of the server on the small side is impossible with three, so the line is 40% * 2/3
  it('three open: rescue fires on a collapsed side, not on a fair three way', async () => {
    const broken = await rescueRun(30, 30, 40, { closedFaction: null }, 10);   // 10 of 70 = 14%
    const fine = await rescueRun(30, 26, 40, { closedFaction: null }, 22);     // 22 of 78 = 28%
    assert.deepEqual([broken, fine], [{ warned: 1, restarts: 1 }, { warned: 0, restarts: 0 }]);
  });
});

describe('announcements', () => {
  const full = () => new FakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });

  it('no announcement on startup', async () => {
    const world = full();
    const { ticks } = makeBalancer(world, { announce: { everyMinutes: 60, message: 'come to my discord' } });
    await ticks(2);
    assert.equal(world.broadcasts.length, 0);
  });

  it('announces once when due, then waits again', async () => {
    const world = full();
    const { bal, advance, ticks } = makeBalancer(world, { announce: { everyMinutes: 60, message: 'come to my discord' } });
    await bal.tick();
    advance(61 * MIN);
    await ticks(3);
    assert.deepEqual(world.broadcasts, ['come to my discord']);
  });

  it('with no message set, the default line goes out', async () => {
    const world = full();
    const { bal, advance } = makeBalancer(world, { announce: { everyMinutes: 60 } });
    await bal.tick();
    advance(61 * MIN);
    await bal.tick();
    assert.deepEqual(world.broadcasts, [STANDING_LINE]);
  });

  it('your own message replaces the default', async () => {
    const world = full();
    const { bal, advance } = makeBalancer(world, { announce: { everyMinutes: 60, message: 'MYCLAN.COM - come and play' } });
    await bal.tick();
    advance(61 * MIN);
    await bal.tick();
    assert.deepEqual(world.broadcasts, ['MYCLAN.COM - come and play']);
  });

  it('an empty message turns announcements off completly', async () => {
    const world = full();
    const { bal, advance, ticks } = makeBalancer(world, { announce: { everyMinutes: 60, message: '' } });
    await bal.tick();
    advance(61 * MIN);
    await ticks(2);
    assert.equal(world.broadcasts.length, 0);
  });

  it('dry run does not send announcements', async () => {
    const world = full();
    const { bal, advance } = makeBalancer(world, { dryRun: true, announce: { everyMinutes: 60, message: 'hello' } });
    await bal.tick();
    advance(61 * MIN);
    await bal.tick();
    assert.equal(world.broadcasts.length, 0);
  });
});
