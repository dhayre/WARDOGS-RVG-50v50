'use strict';
/*
 * the RCON client: what it reads out of the replies, and what it says when the
 * box wont answer.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RconClient, idOf, tagOf } = require('../src/api');
const { Balancer } = require('../src/balancer');
const { FakeServer, team, makeBalancer, tmpDir, RED, GREEN, BLUE } = require('./helpers');

const box = { name: 'b', host: '10.0.0.5', port: 7779, token: 't' };
const clientWith = (fetch) => new RconClient(box, { fetch });
const reply = (o) => async () => ({ ok: true, status: 200, json: async () => o });

describe('reading the replies', () => {
  // feild names have moved between game builds
  it('player ids, factions and tags are read from every field name builds have used', async () => {
    const { players } = await clientWith(reply({ players: [
      { steamId: '1', faction: 'Valkyra', name: '[WOLF] a' },
      { steamID: '2', team: 'MANTICORE', name: 'b' },
      { netId: '3', side: 'lonestar', name: '  [owl]  c' },
      { playerId: '4', factionName: 'Spectator', name: 'd' },
      { name: 'no id at all' },
    ] })).players();
    assert.deepEqual(players.map((p) => [p.id, p.fac, p.tag]),
      [['1', RED, 'WOLF'], ['2', GREEN, null], ['3', BLUE, 'OWL'], ['4', null, null]]);
  });

  it('a bare array works as a player list too', async () => {
    const r = await clientWith(reply([{ id: '9', faction: 'Valkyra' }])).players();
    assert.deepEqual(r.players.map((p) => p.id), ['9']);
  });

  // someone will turn up called "[i am the strongest soldier alive] dave" and he is not a clan
  it('a clan tag is a short bracket at the front, nothing else', () => {
    assert.deepEqual(['[ABC] x', 'x [ABC]', '[i am the strongest soldier alive] dave', '[] x', '[123456789012] x'].map((n) => tagOf({ name: n })),
      ['ABC', null, null, null, '123456789012']);
    assert.equal(idOf({}), '');
  });

  it('status and health are read into plain numbers, with gaps filled', async () => {
    const status = await clientWith(reply({ map: 'Ozeti', factionScores: [{ score: 10 }, {}, { score: 3 }] })).status();
    const health = await clientWith(reply({ uptimeSeconds: 'soon' })).health();
    assert.deepEqual([status.map, status.experiences, status.scores, health.uptimeSeconds],
      ['Ozeti', [], [10, 0, 3], null]);
  });

  it('every call sends the token, and bodies as JSON', async () => {
    const seen = [];
    const c = clientWith(async (url, init) => { seen.push([init.method, url, init.headers.Authorization, init.body]); return { ok: true, status: 200 }; });
    await c.move('7', GREEN);
    assert.deepEqual(seen, [['PATCH', 'http://10.0.0.5:7779/v1/players/7', 'Bearer t', '{"faction":"Manticore"}']]);
  });
});

describe('when the box wont answer', () => {
  // "box down, wrong port, or the token is not the token" sent people hunting in
  // three places at once
  it('a failed call says why: bad token, refused, timed out, garbage, blocked port', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const reasons = [
      (await clientWith(async () => ({ ok: false, status: 401 })).players()).reason,
      (await clientWith(async () => { throw refused; }).players()).reason,
      (await clientWith(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }).players()).reason,
      (await clientWith(reply({ nope: 1 })).players()).reason,
      // node's real fetch, not a fake: port 1 is on fetchs blocked list, so this
      // never leaves the machine
      (await new RconClient(Object.assign({}, box, { host: '127.0.0.1', port: 1 })).players()).reason,
    ];
    assert.deepEqual(reasons.map((r) => r.split(/[.(]/)[0].trim()),
      ['refused', 'connection refused', 'timed out after 6s', 'player list was not in a shape we recognise',
       'that port is one fetch will not connect to at all']);
  });

  it('a down box is logged once, and again when it comes back', async () => {
    const world = new FakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    const { bal, logs, ticks } = makeBalancer(world);
    await bal.tick();
    world.down = true;
    await ticks(3);
    world.down = false;
    await bal.tick();
    assert.deepEqual([logs.filter((l) => l.includes('cant read the player list')).length,
      logs.filter((l) => l.includes('player list is answering again')).length], [1, 1]);
  });

  it('clock and client can be injected', async () => {
    const fake = {
      players: async () => ({ ok: true, players: [{ id: '1', fac: RED, tag: null, name: 'a' }] }),
      status: async () => ({ ok: true, map: 'M', experiences: [], scores: [0, 0, 0] }),
      health: async () => ({ ok: true, uptimeSeconds: 10 }),
    };
    const bal = new Balancer({ stateDir: tmpDir('inj'), keepMatchHistory: false, servers: [{ name: 'x', host: 'h', port: 1, token: 't' }] },
      { clientFor: () => fake, now: () => 1000 });
    await bal.tick();
    assert.deepEqual([bal.state['x'].seeded, bal.state['x'].matchStartedAt], [true, 1000]);
  });
});
