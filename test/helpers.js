'use strict';
/*
 * a whole WARDOGS server, faked in memory, so every rule can be proven with out
 * going anywhere near a real game. no network, no config, no server needed.
 *
 * nothing in here touches a global. the balancer is handed a real RconClient
 * whose fetch is the fake server, and a clock the test winds on by hand.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Balancer, RED, GREEN, BLUE, FACTIONS } = require('../src/balancer');
const { RconClient } = require('../src/api');

const json = (o) => ({ ok: true, status: 200, json: async () => o });

/* just enough of the RCON API to fool the balancer. it remembers who got moved
 * and what got said, so the desicions can be checked after.
 *
 * knobs for the bad nights:
 *   down          every call throws, like a refused connection
 *   dudList       the player list comes back empty, like an api hiccup
 *   refuseMoves   the next N moves are refused with a 500 */
class FakeServer {
  constructor(opts) {
    const o = opts || {};
    this.players = (o.players || []).slice();
    this.map = o.map || 'Bakurani';
    this.scores = o.scores == null ? 100 : o.scores;
    this.scoreLead = o.scoreLead || 0;
    this.uptime = o.uptime == null ? 5000 : o.uptime;
    this.moves = [];
    this.messages = [];
    this.broadcasts = [];
    this.restarts = 0;
    this.down = false;
    this.dudList = false;
    this.refuseMoves = 0;
    this.fetch = this.fetch.bind(this);
  }

  async fetch(url, opt) {
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const method = (opt && opt.method) || 'GET';
    const route = new URL(url).pathname;

    if (method === 'GET' && route === '/v1/players') {
      if (this.dudList) return json({ players: [] });
      return json({ players: this.players.map((p) => ({ name: p.name, steamId: p.id, faction: p.fac })) });
    }
    if (method === 'GET' && route === '/v1/status') {
      return json({
        map: this.map,
        experiences: [this.map + '_KOTH_01'],
        factionScores: [
          { name: RED, score: this.scores + this.scoreLead },
          { name: GREEN, score: this.scores },
          { name: BLUE, score: 0 },
        ],
      });
    }
    if (method === 'GET' && route === '/v1/health') return json({ uptimeSeconds: this.uptime });

    if (method === 'PATCH' && route.startsWith('/v1/players/')) {
      if (this.refuseMoves > 0) { this.refuseMoves--; return { ok: false, status: 500, json: async () => ({}) }; }
      const id = route.split('/').pop();
      const to = JSON.parse(opt.body).faction;
      const p = this.players.find((x) => x.id === id);
      if (p) { this.moves.push({ id, from: p.fac, to }); p.fac = to; }
      return json({});
    }
    if (method === 'POST' && route.endsWith('/message')) { this.messages.push(route.split('/')[3]); return json({}); }
    if (method === 'POST' && route === '/v1/match/restart') { this.restarts++; return json({}); }
    if (method === 'POST' && route === '/v1/broadcast') { this.broadcasts.push(JSON.parse(opt.body).message); return json({}); }
    return { ok: false, status: 404, json: async () => ({}) };
  }

  count(fac) { return this.players.filter((p) => p.fac === fac).length; }

  // biggest minus smallest across the given sides
  spread(sides) {
    const n = sides.map((f) => this.count(f));
    return Math.max(...n) - Math.min(...n);
  }

  find(id) { return this.players.find((p) => p.id === id); }
  firstOn(fac) { return this.players.find((p) => p.fac === fac); }
}

/* a block of players. the id offset per faction has to be distinct or green and
 * blue end up sharing steam ids and you spend an hour blaming the balancer for
 * what is actualy a broken test. voice of experiance. */
function team(n, fac, prefix) {
  const base = fac === RED ? 100000 : fac === GREEN ? 200000 : 300000;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: String(base + i), name: `${prefix || 'P'}${i}`, fac });
  return out;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wdb-${tag || 't'}-`));
}

/* a balancer pointed at one fake server called "test", with no cooldowns so a
 * scenario doesnt have to wait them out. the clock starts at a fixed time and
 * only moves when the test says so: advance(ms).
 *
 * pass world: null for a balancer with no server behind it (state tests). */
function makeBalancer(world, overrides, opts) {
  const o = opts || {};
  const dir = o.stateDir || tmpDir();
  const cfg = Object.assign({
    pollSeconds: 1, dryRun: false, clanGrouping: true,
    sideCap: 50, gapTolerance: 3, closedFaction: BLUE,
    moveCooldownSeconds: 0, bounceCooldownSeconds: 0,
    joinMessage: 'hello', keepMatchHistory: false, stateDir: dir,
    servers: [{ name: 'test', host: '127.0.0.1', port: 7779, token: 't' }],
  }, overrides || {});
  const clock = { t: o.startAt || 1700000000000 };
  const logs = [];
  const bal = new Balancer(cfg, {
    log: (line) => logs.push(line),
    now: () => clock.t,
    clientFor: (server) => new RconClient(server, { fetch: world ? world.fetch : async () => { throw new Error('no server'); } }),
  });
  return {
    bal, cfg, dir, logs, clock,
    advance(ms) { clock.t += ms; },
    st() { return bal.state['test']; },
    async ticks(n) { for (let i = 0; i < n; i++) await bal.tick(); },
  };
}

const MIN = 60 * 1000;

module.exports = { FakeServer, team, makeBalancer, tmpDir, MIN, RED, GREEN, BLUE, FACTIONS };
