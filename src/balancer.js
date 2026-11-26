'use strict';
/*
 * wd-balancer. talks to the servers own RCON api and nothing else.
 *
 * this file is the loop: every pollSeconds, for each server, read it, decide
 * (src/policy/plan.js), act (src/executor.js), save. the rules themselves live
 * in src/policy.
 *
 * SIXFIVE
 */

const { RED, GREEN, BLUE, FACTIONS } = require('./factions');
const { mergeConfig, resolveServer } = require('./config');
const { RconClient } = require('./api');
const { StateStore } = require('./state');
const { planTick, blankState } = require('./policy/plan');
const { STANDING_LINE } = require('./policy/announce');
const { execute } = require('./executor');

class Balancer {
  /* opts is either a log function, or { log, now, clientFor, store }. the defaults
   * are the real thing: the global fetch, the real clock, files in stateDir.
   * tests can hand in fakes instead of patching globals. */
  constructor(config, opts) {
    const o = typeof opts === 'function' ? { log: opts } : opts || {};
    // defaults underneath, so a bare config behaves the same here as through index.js
    this.cfg = mergeConfig(config);
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    this.clientFor = o.clientFor || ((server) => new RconClient(server));
    this.store = o.store || new StateStore(this.cfg.stateDir, { log: this.log });
    this.clients = new Map();
    this.failing = {};      // "server|what" -> the reason we last logged
    this.busy = false;

    this.state = this.store.load();
    this.store.prune(this.state, this.cfg.servers.map((s) => s.name));
    const n = Object.keys(this.state).length;
    if (n) this.log(`picked up where we left off, ${n} server(s)`);
  }

  // TODO would be handy to expose match-history over http so you can see it
  // with out ssh'ing in. not worth a dependency yet.
  stateFor(key) {
    return this.state[key] || (this.state[key] = blankState());
  }

  client(server) {
    let c = this.clients.get(server.name);
    if (!c) this.clients.set(server.name, (c = this.clientFor(server)));
    return c;
  }

  saveState() {
    this.store.save(this.state);
  }

  /* a box thats down would otherwise log the same line every two seconds all
   * night. say it once, say it again if the reason changes, and say when its back. */
  noteFailure(key, what, reason) {
    const k = `${key}|${what}`;
    if (this.failing[k] === reason) return;
    this.failing[k] = reason;
    this.log(`[${key}] cant read the ${what}: ${reason}`);
  }

  noteOk(key, what) {
    const k = `${key}|${what}`;
    if (this.failing[k] === undefined) return;
    delete this.failing[k];
    this.log(`[${key}] ${what} is answering again`);
  }

  async processServer(server) {
    const key = server.name;
    const api = this.client(server);
    const [roster, status, health] = await Promise.all([api.players(), api.status(), api.health()]);
    if (!roster.ok) { this.noteFailure(key, 'player list', roster.reason); return; }
    this.noteOk(key, 'player list');
    // without these it still balances, it just cant spot a new match as well
    if (status.ok) this.noteOk(key, 'status'); else this.noteFailure(key, 'status', status.reason);
    if (health.ok) this.noteOk(key, 'health'); else this.noteFailure(key, 'health', health.reason);

    const plan = planTick({ players: roster.players, status, health },
      this.stateFor(key), resolveServer(this.cfg, server), this.now());
    this.state[key] = plan.state;
    for (const note of plan.notes) this.log(`[${key}] ${note}`);
    // for when somebody swears the teams are allways stacked and you want to look
    if (plan.finishedMatch && this.cfg.keepMatchHistory) {
      this.store.appendMatch(Object.assign({ server: key }, plan.finishedMatch));
    }
    await execute(plan, { api, state: plan.state, key, dryRun: this.cfg.dryRun, log: this.log });
  }

  /* the busy flag is not decoration. at two second polling with a slow box you
   * will overlap ticks, and two passes desiding at the same time will move the
   * same player twice in oposite directions. ask me how i know. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const servers = this.cfg.servers.filter((s) => s.enabled !== false);
      await Promise.all(
        servers.map((s) =>
          this.processServer(s).catch((e) => this.log(`[${s.name}] ${e.message || e}`))
        )
      );
      this.saveState();
    } finally {
      this.busy = false;
    }
  }

  /* takes the lock first. a second copy against the same stateDir throws here
   * instead of quietly fighting the first one over every player. */
  start() {
    this.store.acquireLock();
    // tried 1s polling early on. made no diference to how even it stayed and
    // just hammered the box, 2 is fine.
    const every = Math.max(1, this.cfg.pollSeconds) * 1000;
    const names = this.cfg.servers.filter((s) => s.enabled !== false).map((s) => s.name);
    this.log(
      `running${this.cfg.dryRun ? ' in DRY RUN, nobody gets moved' : ''}, ` +
      `${names.length} server(s) every ${every / 1000}s: ${names.join(', ')}`
    );
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log('tick: ' + (e.message || e)));
    }, every);
    this.tick().catch((e) => this.log('tick: ' + (e.message || e)));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.saveState();
    this.store.releaseLock();
  }
}

module.exports = { Balancer, FACTIONS, RED, GREEN, BLUE, STANDING_LINE };
