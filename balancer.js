'use strict';
/*
 * wd-balancer. talks to the servers own RCON api and nothing else.
 * two rules matter more than the rest of this file: never move a settled player
 * mid match, and never touch the round you started on. everything else is detail.
 *
 * SIXFIVE
 */

const fs = require('fs');
const path = require('path');
const { RED, GREEN, BLUE, FACTIONS, factionOf, openSides } = require('./src/factions');
const { mergeConfig, resolveServer } = require('./src/config');

/* how long somebody has to be missing before we actualy forget them. short enough
 * that memory stays bounded, long enough that an api blip cant wipe the lot. */
const FORGET_AFTER_MS = 5 * 60 * 1000;

/* what it shouts by default. on out of the box, becuase a balancer nobody hears
 * about is a balancer nobody installs. put your own line in announce.message and
 * yours goes out instead, or set it to "" and it never sends anything at all.
 * no strings on any of that, the licence is MIT. */
const STANDING_LINE = 'AERECRUIT.COM - the home of the 50v50';

function idOf(p) {
  return String(p.steamId || p.steamID || p.id || p.netId || p.net_id || p.playerId || '');
}

/* a clan tag is a braket at the front. "[WOLF] someone".
 * caped at 12 charecters because someone will absolutly turn up called
 * "[i am the strongest soldier alive] dave" and he is not a clan. */
function tagOf(p) {
  const m = String(p.name || '').match(/^\s*\[([^\]]{1,12})\]/);
  return m ? m[1].trim().toUpperCase() : null;
}

/* counts are a map of faction -> heads, holding only the open sides. the gap is the
 * spread across them: biggest minus smallest. with two sides thats |a - b|. */
function spread(counts) {
  const n = Object.values(counts);
  return n.length ? Math.max(...n) - Math.min(...n) : 0;
}

// V26/M24, or V17/M17/L16 with three open. the initials are unique.
function fmtCounts(counts) {
  return Object.keys(counts).map((f) => f[0] + counts[f]).join('/');
}

// six seconds. a box that cant anwser in six is having a worse night than we
// are, and blocking here stops every other server getting looked at.
async function request(method, server, route, body) {
  const url = `${server.scheme || 'http'}://${server.host}:${server.port}${route}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), server.timeoutMs || 6000);
  try {
    const opts = {
      method,
      headers: { Authorization: 'Bearer ' + server.token },
      signal: ctrl.signal,
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (method === 'GET') return res.ok ? await res.json() : null;
    return res.ok;
  } catch (e) {
    return method === 'GET' ? null : false;
  } finally {
    clearTimeout(timer);
  }
}

/* one lot per server, they dont know about each other. writen to disk every
 * tick, which matters: with out it a restart desides nobody is settled and
 * rearanges a live match. do that once at prime time and you hear about it for
 * a week. */
function blankState() {
  return {
    known: {},          // steamId -> { fac, movedAt, placed }
    messaged: {},
    seeded: false,
    matchSig: null,     // map + experiences, changes when it rotates
    matchScoreSum: 0,
    lastUptime: null,   // drops when the box restarts
    lastRebalanceAt: 0,
    matchStartedAt: 0,
    matchClosedClears: 0,
    matchPeak: {},      // faction -> most heads seen on it this match
    lastAnnounceAt: 0,  // when we last shouted at the whole server
    lopsidedSince: 0,   // when the teams first went properly wrong
    warnedAt: 0,        // when we told them to sort it out
    lastRestartAt: 0,   // so it cant sit there restarting on a loop
  };
}

class Balancer {
  constructor(config, log) {
    // defaults underneath, so a bare config behaves the same here as through index.js
    this.cfg = mergeConfig(config);
    this.log = log || (() => {});
    this.state = {};
    this.busy = false;
    this.stateFile = path.join(config.stateDir, 'balancer-state.json');
    this.matchFile = path.join(config.stateDir, 'match-history.json');
    this.loadState();
  }

  // TODO would be handy to expose match-history over http so you can see it
  // with out ssh'ing in. not worth a dependency yet.
  stateFor(key) {
    return this.state[key] || (this.state[key] = blankState());
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const key of Object.keys(raw)) {
        const st = this.stateFor(key);
        Object.assign(st, raw[key]);
        // older files wont have every key
        if (!st.known) st.known = {};
        if (!st.messaged) st.messaged = {};
        if (!st.matchPeak) st.matchPeak = {};
        // 1.0.0 files: peaks were red/green only, and the clear count was called blue
        if ('red' in st.matchPeak || 'green' in st.matchPeak) {
          st.matchPeak = { [RED]: st.matchPeak.red || 0, [GREEN]: st.matchPeak.green || 0 };
        }
        if (st.matchBlueClears !== undefined) {
          st.matchClosedClears = st.matchBlueClears;
          delete st.matchBlueClears;
        }
      }
      const n = Object.keys(this.state).length;
      if (n) this.log(`picked up where we left off, ${n} server(s)`);
    } catch (e) {
      // first run, or someone binned it. we seed fresh either way.
    }
  }

  saveState() {
    try {
      fs.mkdirSync(this.cfg.stateDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) {
      this.log('could not write state: ' + (e.message || e));
    }
  }

  // for when somebody swears the teams are allways stacked and you want to look
  recordMatch(key, st, now) {
    if (!this.cfg.keepMatchHistory) return;
    try {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(this.matchFile, 'utf8')); } catch (e) {}
      arr.push({
        server: key,
        endedAt: new Date(now).toISOString(),
        durationMin: st.matchStartedAt ? Math.round((now - st.matchStartedAt) / 60000) : null,
        map: st.matchSig,
        peak: Object.assign({}, st.matchPeak),
        peakGap: spread(st.matchPeak),
        closedSideClears: st.matchClosedClears,
      });
      fs.mkdirSync(this.cfg.stateDir, { recursive: true });
      fs.writeFileSync(this.matchFile, JSON.stringify(arr.slice(-300), null, 2));
    } catch (e) {}
  }

  /* prefrence order: their clan if its allready somewhere, then the side they
   * picked, then the rest from emptiest up. anything over the cap drops out, and
   * of whats left the first one inside the gap tolerance wins. if none are, the
   * one that leaves the smallest gap, earlier prefrence breaking a tie.
   * it never breaks the cap to be nice to a clan. mates is lovely, 51 v 43 isnt
   * a game.
   *
   * counts holds the open sides only, so the answer is always an open side. */
  chooseSide(counts, currentFaction, clanSide, limits) {
    const sides = Object.keys(counts);
    const base = Object.assign({}, counts);
    if (currentFaction in base) base[currentFaction]--;      // take them out first
    const underCap = (X) => base[X] + 1 <= limits.sideCap;
    const gapWith = (X) => spread(Object.assign({}, base, { [X]: base[X] + 1 }));

    const lightest = sides.slice().sort((a, b) => base[a] - base[b]);   // stable, ties keep faction order
    const prefs = [...new Set([clanSide, currentFaction, ...lightest])].filter((X) => sides.includes(X));

    const room = prefs.filter(underCap);
    const cands = room.length ? room : prefs;
    for (const X of cands) if (gapWith(X) <= limits.gapTolerance) return X;
    let best = cands[0];
    for (const X of cands) if (gapWith(X) < gapWith(best)) best = X;
    return best;
  }

  /* the open side holding strictly the most of this tag, not counting the player.
   * a tie is no prefrence at all. take them out of their own count first or
   * everyone is a clan of one. */
  clanSideFor(pl, tagCounts, sides) {
    const t = pl.tag && tagCounts[pl.tag];
    if (!t) return null;
    let best = null, bestN = 0, tied = false;
    for (const f of sides) {
      const n = (t[f] || 0) - (pl.fac === f ? 1 : 0);
      if (n > bestN) { best = f; bestN = n; tied = false; }
      else if (n === bestN && n > 0) tied = true;
    }
    return tied ? null : best;
  }

  async processServer(server) {
    const key = server.name;
    const st = this.stateFor(key);
    const eff = resolveServer(this.cfg, server);
    const limits = { sideCap: eff.sideCap, gapTolerance: eff.gapTolerance };
    /* people the balancer leaves completly alone. admins mostly. an admin who
     * switches sides to go and watch somebody would otherwise get treated like a
     * stacker and put straight back, which is useless when your trying to work. */
    const exempt = new Set(eff.exempt);
    const closed = eff.closedFaction;
    const sides = openSides(closed);
    const joinMessage = eff.joinMessage;
    const clanOn = eff.clanGrouping;

    const [data, status, health] = await Promise.all([
      request('GET', server, '/v1/players'),
      request('GET', server, '/v1/status'),
      request('GET', server, '/v1/health'),
    ]);
    if (!data) { this.log(`[${key}] no player list. box down, wrong port, or the token is not the token.`); return; }

    const rawList = Array.isArray(data.players) ? data.players : (Array.isArray(data) ? data : []);
    const players = [];
    const tagCounts = {};
    const counts = {};
    for (const f of sides) counts[f] = 0;
    const isOpen = (fac) => sides.includes(fac);

    for (const p of rawList) {
      const id = idOf(p);
      if (!id) continue;
      const fac = factionOf(p);
      const tag = tagOf(p);
      if (isOpen(fac)) {
        counts[fac]++;
        if (tag) {
          const t = (tagCounts[tag] = tagCounts[tag] || {});
          t[fac] = (t[fac] || 0) + 1;
        }
      }
      players.push({ id, fac, tag, name: p.name });
    }

    const now = Date.now();
    const sig = status ? `${status.map || ''}|${(status.experiences || []).join(',')}` : null;
    const scoreSum = status ? (status.factionScores || []).reduce((a, f) => a + (f.score || 0), 0) : null;
    // how far ahead the leader is. a lopsided server that is still a close game
    // is not hurting anybody yet, so we dont touch it.
    const sorted = status ? (status.factionScores || []).map((f) => f.score || 0).sort((a, b) => b - a) : [];
    const scoreLead = sorted.length >= 2 ? sorted[0] - sorted[1] : 0;
    const uptime = health && typeof health.uptimeSeconds === 'number' ? health.uptimeSeconds : null;

    /* first look at this server. write everyone down as settled and touch nobody.
     * what ever mess the teams are in right now, its not ours to fix. we start
     * fixing at the next match. a balancer that reshuffles the round it just
     * walked in on is a balancer that gets uninstalled the same evening. */
    if (!st.seeded) {
      for (const pl of players) st.known[pl.id] = { fac: pl.fac, movedAt: 0, placed: true };
      st.seeded = true;
      st.matchSig = sig;
      st.matchScoreSum = scoreSum || 0;
      st.matchStartedAt = now;
      st.matchPeak = Object.assign({}, counts);
      st.matchClosedClears = 0;
      st.lastUptime = uptime;
      // start the announce clock now, so restarting the balancer doesnt fire an
      // anouncement at everyone the second it comes back up. nobody wants that.
      st.lastAnnounceAt = now;
      this.log(`[${key}] seeded ${players.length} player(s). this round is left alone, evening starts next match.`);
      return;
    }

    /* has a new match started. three ways of spoting it because not one of them
     * is reliable on its own:
     *   map rotated     easy, unless the rotation lands on the same map again
     *   scores reset    easy, unless nobody scored last match
     *   uptime droped   the box restarted and the other two never noticed
     * the 60 second gaurd stops all three firing at once and doing it twice. */
    if (sig !== null) {
      const mapRotated = st.matchSig !== null && sig !== st.matchSig;
      const scoreReset = st.matchScoreSum >= 10 && scoreSum === 0;
      const restarted = st.lastUptime != null && uptime != null && uptime < st.lastUptime - 60;
      if ((mapRotated || scoreReset || restarted) && now - st.lastRebalanceAt >= 60000) {
        this.recordMatch(key, st, now);
        // everyone goes back in the pot. this is the only moment settled players
        // get rearanged, and nobodys mid firefight at a map change.
        for (const id in st.known) if (st.known[id]) st.known[id].placed = false;
        st.lastRebalanceAt = now;
        st.matchStartedAt = now;
        st.matchPeak = Object.assign({}, counts);
        st.matchClosedClears = 0;
        const why = restarted ? 'box restarted' : mapRotated ? 'map -> ' + sig : 'scores reset';
        this.log(`[${key}] new match (${why}), evening the teams`);
      }
      if (uptime != null) st.lastUptime = uptime;
      st.matchSig = sig;
      st.matchScoreSum = scoreSum;
    }
    for (const f of sides) if (counts[f] > (st.matchPeak[f] || 0)) st.matchPeak[f] = counts[f];

    /* ---------- last resort: the match is lost because the teams are broken --
     * this is the one thing that can move settled players mid match, and it does
     * it by restarting the round rather than dragging anybody. it only fires when
     * the game is allready ruined, and it gives the server a chance to fix itself
     * first.
     *
     * what "broken" means: the small side is under 40% of the server. thats off
     * real numbers, 40v30 is a game, 40v25 is not. plus an absolute gap so it
     * cant trip on 12v6, plus a minimum headcount so it leaves quiet servers be.
     *
     * and it has to actualy be costing somebody the match, hence the score lead.
     * off by default. restarting somebody elses match uninvited is rude.
     *
     * with three open sides 40% of the server on the smallest side is impossible,
     * so the share scales: minorityShare * 2 / sides. 40% for two, 26.7% for three,
     * the same 80% of a fair share either way. */
    const rs = eff.rescue;

    if (rs.enabled) {
      const vals = sides.map((f) => counts[f]);
      const big = Math.max(...vals), small = Math.min(...vals), tot = vals.reduce((a, b) => a + b, 0);
      const line = rs.minorityShare * 2 / sides.length;
      const lopsided = tot >= rs.minPlayers && (big - small) >= rs.minGap && (small / tot) < line;
      const cooling = now - (st.lastRestartAt || 0) < rs.cooldownMinutes * 60000;

      if (!lopsided) {
        // sorted itself out, or people did as they were asked. forget it happened.
        if (st.warnedAt) this.log(`[${key}] teams recovered (${fmtCounts(counts)}), no restart`);
        st.lopsidedSince = 0; st.warnedAt = 0;
      } else if (!cooling) {
        if (!st.lopsidedSince) {
          st.lopsidedSince = now;                       // start the clock, give it a chance
        } else if (now - st.lopsidedSince >= rs.graceMinutes * 60000 && scoreLead > rs.scoreLead) {
          if (!st.warnedAt) {
            st.warnedAt = now;
            if (this.cfg.dryRun) this.log(`[${key}] WOULD WARN: ${rs.warning}`);
            else {
              await request('POST', server, '/v1/broadcast', { message: rs.warning });
              this.log(`[${key}] warned: ${fmtCounts(counts)}, leader up ${scoreLead}. ${rs.warnSeconds}s to fix it.`);
            }
          } else if (now - st.warnedAt >= rs.warnSeconds * 1000) {
            // they had their chance
            if (this.cfg.dryRun) this.log(`[${key}] WOULD RESTART MATCH (${fmtCounts(counts)})`);
            else {
              const ok = await request('POST', server, '/v1/match/restart', {});
              this.log(`[${key}] ${ok ? 'restarted the match' : 'match restart FAILED'} on ${fmtCounts(counts)}`);
            }
            st.lastRestartAt = now; st.lopsidedSince = 0; st.warnedAt = 0;
          }
        }
      }
    }

    /* leave announce.message alone and it sends the default line. set it and
     * yours goes out instead. set it to "" and nothing is ever sent.
     * minPlayers stops it shouting at an empty box at 4am. */
    const ann = eff.announce;
    const annMsg = String(ann.message === undefined ? STANDING_LINE : ann.message).trim();
    if (annMsg) {
      const everyMs = Math.max(1, Number(ann.everyMinutes) || 60) * 60000;
      const minPlayers = Number(ann.minPlayers) || 0;
      const due = now - (st.lastAnnounceAt || 0) >= everyMs;
      if (due && players.length >= minPlayers) {
        st.lastAnnounceAt = now;
        if (this.cfg.dryRun) {
          this.log(`[${key}] WOULD ANNOUNCE: ${annMsg}`);
        } else {
          const ok = await request('POST', server, '/v1/broadcast', { message: annMsg });
          this.log(`[${key}] ${ok ? 'announced' : 'announce FAILED'}: ${annMsg}`);
        }
      }
    }

    // tried 1s polling early on. made no diference to how even it stayed and
    // just hammered the box, 2 is fine.
    const moveCooldown = eff.moveCooldownSeconds * 1000;
    const bounceCooldown = eff.bounceCooldownSeconds * 1000;

    for (const pl of players) {
      // exempt: write down where they are and move on. no placing, no bouncing,
      // no clearing them off the closed side, no join message. nothing.
      if (exempt.has(pl.id)) {
        st.known[pl.id] = { fac: pl.fac, movedAt: now, placed: true };
        continue;
      }

      const prev = st.known[pl.id];
      const isNew = !prev;
      const sinceMove = prev ? now - (prev.movedAt || 0) : Infinity;

      if (isNew && joinMessage && !st.messaged[pl.id]) {
        st.messaged[pl.id] = now;
        if (!this.cfg.dryRun) {
          request('POST', server, `/v1/players/${pl.id}/message`, { message: joinMessage }).catch(() => {});
        }
      }

      let placed = prev ? !!prev.placed : false;

      const clanSide = clanOn ? this.clanSideFor(pl, tagCounts, sides) : null;

      let target = null;
      let forced = false;

      if (closed && pl.fac === closed) {
        // that side is shut. they get moved every time, no waiting about.
        // chooseSide only ever answers with an open side.
        target = this.chooseSide(counts, closed, clanSide, limits);
        forced = true;
      } else if (isOpen(pl.fac) && !placed) {
        // new arival, or everyone just after a match boundry. place them properly.
        const side = this.chooseSide(counts, pl.fac, clanSide, limits);
        if (side !== pl.fac) target = side;
        placed = true;
      } else if (isOpen(pl.fac) && placed && prev && prev.fac !== pl.fac) {
        /* the closed door.
         *
         * this is the one that stops stacking. a settled player who switches sides
         * mid match gets put back if the side they jumped to is full, or is all
         * ready heavier than the tolerance. jumping to the LIGHTER side is allways
         * fine, because somebody volunteering to even it up is doing our job for us.
         *
         * and note it only ever fires on someone who moved themselfs. a player who
         * is just playing is never touched. thats the whole promise and its why
         * this is safe to leave runing.
         *
         * heavier means heavier than the side they left. if they didnt leave an
         * open side (they came off the closed one) its the lightest other open side,
         * and they get placed properly instead of being sent back where they were,
         * because where they were is shut. */
        const onto = counts[pl.fac];
        const cameFromOpen = isOpen(prev.fac);
        const from = cameFromOpen
          ? counts[prev.fac]
          : Math.min(...sides.filter((f) => f !== pl.fac).map((f) => counts[f]));
        if (onto > limits.sideCap || onto - from > limits.gapTolerance) {
          const side = cameFromOpen ? prev.fac : this.chooseSide(counts, pl.fac, clanSide, limits);
          if (side !== pl.fac) { target = side; forced = true; }
        }
      }

      const cooldown = forced ? bounceCooldown : moveCooldown;
      if (target && sinceMove >= cooldown) {
        const label = `${pl.name || pl.id}${pl.tag ? ' [' + pl.tag + ']' : ''}`;
        const why = closed && pl.fac === closed ? 'closed side' : forced ? 'bounced' : 'balance';

        if (this.cfg.dryRun) {
          this.log(`[${key}] WOULD MOVE ${label} ${pl.fac} -> ${target} (${why})`);
          st.known[pl.id] = { fac: pl.fac, movedAt: prev ? prev.movedAt || 0 : 0, placed };
          continue;
        }

        const ok = await request('PATCH', server, `/v1/players/${pl.id}`, { faction: target });
        if (ok) {
          // keep the tally straight so the rest of this pass desides against
          // whats real and not what the roster said ten moves back
          if (closed && pl.fac === closed) st.matchClosedClears++;
          if (isOpen(pl.fac)) counts[pl.fac]--;
          counts[target]++;
          st.known[pl.id] = { fac: target, movedAt: now, placed: true };
          this.log(`[${key}] moved ${label} ${pl.fac} -> ${target} (${why}) now ${fmtCounts(counts)}`);
        } else {
          // leave movedAt alone so we retry, instead of sitting on a cooldown we
          // never earned
          st.known[pl.id] = { fac: pl.fac, movedAt: prev ? prev.movedAt || 0 : 0, placed };
          this.log(`[${key}] move FAILED ${label} ${pl.fac} -> ${target}`);
        }
      } else {
        st.known[pl.id] = { fac: pl.fac, movedAt: prev ? prev.movedAt || 0 : 0, placed };
      }
    }

    /* forgetting somebody is how you accidently reshuffle a live match.
     *
     * if the api hiccups and hands back an empty or half finished player list and
     * we take that as "everyone left", the next good tick sees 50 strangers and re
     * places the lot of them, mid match. a stress run caught exactly that: ONE bad
     * response moved 10 settled players.
     *
     * so people who vanish get a grace period instead of being binned on the spot.
     * they keep their placed flag. bonus: it also kills the leave-and-rejoin-onto-
     * the-stacked-side trick, because they come back still remembered and get
     * treated as a switcher.
     *
     * was a Set, but an object serialises straight into the state file */
    const present = {};
    for (const pl of players) present[pl.id] = 1;
    for (const id in st.known) {
      if (present[id]) { if (st.known[id].goneAt) delete st.known[id].goneAt; continue; }
      if (!st.known[id].goneAt) st.known[id].goneAt = now;
      else if (now - st.known[id].goneAt > FORGET_AFTER_MS) delete st.known[id];
    }
    for (const id in st.messaged) if (!present[id] && now - st.messaged[id] > 3600000) delete st.messaged[id];
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

  start() {
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
    this.saveState();
  }
}

module.exports = { Balancer, FACTIONS, RED, GREEN, BLUE, STANDING_LINE };
