'use strict';
/*
 * what the balancer keeps on disk, and the lock that stops two copies fighting.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeServer, team, makeBalancer, tmpDir, RED, GREEN } = require('./helpers');

describe('state on disk', () => {
  // restart it and it remembers, instead of rearanging a live match
  it('a restart resumes and does not reshuffle', async () => {
    const world = new FakeServer({ players: [...team(35, RED), ...team(15, GREEN)] });
    const first = makeBalancer(world);
    await first.bal.tick();                              // seed uneven, settled
    first.bal.stop();                                    // writes state
    const revived = makeBalancer(world, {}, { stateDir: first.dir });
    await revived.bal.tick();
    assert.equal(world.moves.length, 0);
  });

  // peaks were red/green and the clear count was called blue in 1.0.0
  it('a 1.0.0 state file is migrated on load', () => {
    const dir = tmpDir('old');
    fs.writeFileSync(path.join(dir, 'balancer-state.json'), JSON.stringify({
      test: { known: {}, messaged: {}, seeded: true, matchPeak: { red: 31, green: 28 }, matchBlueClears: 4 },
    }));
    const { st } = makeBalancer(null, {}, { stateDir: dir });
    assert.deepEqual([st().matchPeak, st().matchClosedClears, 'matchBlueClears' in st()], [{ [RED]: 31, [GREEN]: 28 }, 4, false]);
  });

  it('state is saved atomically, versioned, and a corrupt file is set aside loudly', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    const { bal, dir } = makeBalancer(world);
    await bal.tick();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'balancer-state.json'), 'utf8'));
    assert.deepEqual([saved.schema, Object.keys(saved.servers)], [2, ['test']]);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

    fs.writeFileSync(path.join(dir, 'balancer-state.json'), '{"test": {"known": {');   // half a file
    const again = makeBalancer(world, {}, { stateDir: dir });
    assert.ok(fs.existsSync(path.join(dir, 'balancer-state.json.corrupt')));
    assert.ok(again.logs.some((l) => l.startsWith('state file could not be read')));
    assert.deepEqual(Object.keys(again.bal.state), []);
  });

  it('state for removed servers is pruned, parked servers keep theirs', () => {
    const dir = tmpDir('prune');
    fs.writeFileSync(path.join(dir, 'balancer-state.json'), JSON.stringify({
      schema: 2, servers: { test: { seeded: true }, parked: { seeded: true }, gone: { seeded: true } },
    }));
    const { bal, logs } = makeBalancer(null, { servers: [
      { name: 'test', host: '127.0.0.1', port: 7779, token: 't' },
      { name: 'parked', host: '127.0.0.1', port: 7779, token: 't', enabled: false },
    ] }, { stateDir: dir });
    assert.deepEqual(Object.keys(bal.state).sort(), ['parked', 'test']);
    assert.ok(logs.some((l) => l.includes('no longer in the config: gone')));
  });

  it('a finished match is written to the history', async () => {
    const world = new FakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    const { bal, dir, advance } = makeBalancer(world, { keepMatchHistory: true });
    await bal.tick();
    advance(25 * 60 * 1000);
    world.map = 'Ozeti';
    await bal.tick();
    const history = JSON.parse(fs.readFileSync(path.join(dir, 'match-history.json'), 'utf8'));
    assert.equal(history.length, 1);
    assert.deepEqual([history[0].server, history[0].durationMin, history[0].peak, history[0].peakGap],
      ['test', 25, { [RED]: 30, [GREEN]: 20 }, 10]);
  });
});

describe('the lock', () => {
  /* two copies on one state dir pinball players between sides, so the second
   * refuses to start. a lock left by a dead process, or by this same pid in a
   * previous life (containers are pid 1 every time), is taken over. */
  it('a second copy is refused, stale locks are taken over, foreign ones are not', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    const a = makeBalancer(world);
    const b = makeBalancer(world, {}, { stateDir: a.dir });
    const lock = path.join(a.dir, 'balancer.lock');
    const tryStart = (h) => {
      try { h.bal.start(); } catch (e) { return 'refused'; }
      h.bal.stop();
      return 'started';
    };
    const results = [];
    a.bal.start();
    try {
      results.push(tryStart(b));                       // a holds it
    } finally {
      a.bal.stop();
    }
    results.push(tryStart(b));                         // a let go
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: os.hostname() }));     // long dead
    results.push(tryStart(a));
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));    // us, last boot
    results.push(tryStart(a));
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, host: 'some-other-box' }));           // cant check it
    results.push(tryStart(a));
    await new Promise((r) => setTimeout(r, 20));       // let the ticks start() kicked off finish
    assert.deepEqual(results, ['refused', 'started', 'started', 'started', 'refused']);
    assert.ok(fs.existsSync(lock));
  });
});
