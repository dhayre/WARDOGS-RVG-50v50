'use strict';
/*
 * everything the balancer keeps on disk: the per server memory, the match
 * history, and a lockfile so two copies cant run against the same state.
 *
 * the memory is writen every tick, which matters: with out it a restart desides
 * nobody is settled and rearanges a live match. so it gets writen to a temp
 * file and renamed into place. a crash halfway through a write leaves the last
 * good file, not half of one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RED, GREEN } = require('./factions');

/* 1: 1.0.0. the file was a bare { serverName: state } map.
 * 2: { schema: 2, servers: { ... } }. peaks keyed by faction, matchClosedClears. */
const SCHEMA = 2;
const HISTORY_KEEP = 300;

// lock paths this process holds. see acquireLock for why it matters.
const heldHere = new Set();

/* write to a temp file and rename it over the old one. rename is atomic on the
 * same filesystem, so a crash mid write leaves the last good file.
 *
 * no fsync, on purpose. it made every save about 20x slower (18ms vs 0.8ms on
 * ext4), and it only buys anything on a power cut or a kernel crash. the worst
 * that does without it is an unreadable file, which load() moves aside before
 * seeding fresh, and seeding never moves anybody. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// bring one servers saved state up to the current shape
function migrateServer(st) {
  if (!st.known) st.known = {};
  if (!st.messaged) st.messaged = {};
  if (!st.matchPeak) st.matchPeak = {};
  // 1.0.0: peaks were red/green only, and the clear count was called blue
  if ('red' in st.matchPeak || 'green' in st.matchPeak) {
    st.matchPeak = { [RED]: st.matchPeak.red || 0, [GREEN]: st.matchPeak.green || 0 };
  }
  if (st.matchBlueClears !== undefined) {
    st.matchClosedClears = st.matchBlueClears;
    delete st.matchBlueClears;
  }
  return st;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';      // its there, it just isnt ours to signal
  }
}

class StateStore {
  constructor(dir, opts) {
    this.dir = dir;
    this.log = (opts && opts.log) || (() => {});
    this.stateFile = path.join(dir, 'balancer-state.json');
    this.historyFile = path.join(dir, 'match-history.json');
    this.lockFile = path.join(dir, 'balancer.lock');
    this.lockToken = null;
  }

  /* the saved memory, as { serverName: state }. a missing file is a first run.
   * an unreadable one is moved aside so somebody can look at it, and we seed
   * fresh, which is safe: seeding never moves anybody. */
  load() {
    let text;
    try {
      text = fs.readFileSync(this.stateFile, 'utf8');
    } catch (e) {
      return {};
    }
    let raw;
    try {
      raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    } catch (e) {
      const aside = `${this.stateFile}.corrupt`;
      try { fs.renameSync(this.stateFile, aside); } catch (e2) {}
      this.log(`state file could not be read (${e.message}). moved it to ${path.basename(aside)} and starting fresh. this round is left alone.`);
      return {};
    }
    const servers = typeof raw.schema === 'number' ? raw.servers || {} : raw;
    const out = {};
    for (const name of Object.keys(servers)) {
      if (servers[name] && typeof servers[name] === 'object') out[name] = migrateServer(servers[name]);
    }
    return out;
  }

  save(servers) {
    try {
      // once is enough. if somebody deletes the dir while its running the write
      // fails, says so, and the next save makes it again.
      if (!this.dirReady) { fs.mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
      writeAtomic(this.stateFile, JSON.stringify({ schema: SCHEMA, servers }));
    } catch (e) {
      this.dirReady = false;
      this.log('could not write state: ' + (e.message || e));
    }
  }

  /* drop the memory of servers that are no longer in the config at all. a parked
   * server (enabled: false) is still in the config, so it keeps its memory. */
  prune(servers, configuredNames) {
    const keep = new Set(configuredNames);
    const gone = Object.keys(servers).filter((name) => !keep.has(name));
    for (const name of gone) delete servers[name];
    if (gone.length) this.log(`forgot ${gone.length} server(s) no longer in the config: ${gone.join(', ')}`);
    return gone;
  }

  // for when somebody swears the teams are allways stacked and you want to look
  appendMatch(record) {
    try {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch (e) {}
      if (!Array.isArray(arr)) arr = [];
      arr.push(record);
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.historyFile, JSON.stringify(arr.slice(-HISTORY_KEEP), null, 2));
    } catch (e) {
      this.log('could not write match history: ' + (e.message || e));
    }
  }

  /* two copies against one state dir fight over the same players and pinball them
   * between sides all night, so the second one refuses to start.
   *
   * a lock whose process is gone is stale and gets taken over. a lock with OUR pid
   * that this process doesnt hold is stale too: in a container the balancer is
   * pid 1 every time, so after a restart the old lock names a pid that is alive
   * and is us. a lock from another host cant be checked at all, so it holds, and
   * the message says how to clear it. */
  acquireLock() {
    fs.mkdirSync(this.dir, { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, since: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.lockFile, body, { flag: 'wx' });
        this.lockToken = token;
        heldHere.add(this.lockFile);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let held = {};
      try { held = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch (e) {}
      const sameHost = held.host === os.hostname();
      const stale = sameHost && (
        !(held.pid > 0) ||
        (held.pid === process.pid ? !heldHere.has(this.lockFile) : !pidAlive(held.pid))
      );
      if (!stale) {
        throw new Error(
          `another copy is allready running against ${this.dir} ` +
          `(pid ${held.pid} on ${held.host || 'an unknown host'}, since ${held.since || 'unknown'}). ` +
          `two at once will pinball players between sides. if you are sure it is not running, ` +
          `delete ${this.lockFile}`);
      }
      this.log(`taking over a stale lock from pid ${held.pid}`);
      try { fs.unlinkSync(this.lockFile); } catch (e) {}
    }
    throw new Error(`could not take the lock at ${this.lockFile}`);
  }

  // only removes the lock if its still ours
  releaseLock() {
    if (!this.lockToken) return;
    try {
      const held = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (held.token === this.lockToken) fs.unlinkSync(this.lockFile);
    } catch (e) {}
    heldHere.delete(this.lockFile);
    this.lockToken = null;
  }
}

module.exports = { StateStore, SCHEMA, writeAtomic };
