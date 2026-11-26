'use strict';
/*
 * one tick for one server, decided. no network, no clock, no disk: a roster, the
 * saved state, the settings and the time go in; the next state and a list of
 * things to do come out. src/executor.js does them, or in a dry run, says it
 * would.
 *
 * two rules matter more than the rest: never move a settled player mid match,
 * and never touch the round you started on. everything else is detail.
 */

const { openSides } = require('../factions');
const { tally, spread, fmtCounts } = require('./counts');
const { chooseSide, clanSideFor, bounceTarget } = require('./placement');
const { readSnapshot, detectBoundary } = require('./match');
const { rescueStep } = require('./rescue');
const { dueAnnouncement } = require('./announce');

/* how long somebody has to be missing before we actualy forget them. short enough
 * that memory stays bounded, long enough that an api blip cant wipe the lot. */
const FORGET_AFTER_MS = 5 * 60 * 1000;

// a welcome is remembered this long after somebody leaves, so a quick rejoin isnt welcomed twice
const MESSAGED_FOR_MS = 60 * 60 * 1000;

/* one lot per server, they dont know about each other. writen to disk every
 * tick, which matters: with out it a restart desides nobody is settled and
 * rearanges a live match. do that once at prime time and you hear about it for
 * a week. */
function blankState() {
  return {
    known: {},          // steamId -> { fac, movedAt, placed, goneAt? }
    messaged: {},       // steamId -> when they were welcomed
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

/* a copy planTick can change without touching the state it was given. every
 * field is a primitive except these three flat maps, so this is a full copy at a
 * fraction of what structuredClone costs, which was 17% of a stress run. if you
 * add a nested field to blankState, copy it here too. */
function cloneState(prev) {
  const p = prev || {};
  const st = Object.assign(blankState(), p);
  st.known = {};
  for (const id in p.known || {}) st.known[id] = Object.assign({}, p.known[id]);
  st.messaged = Object.assign({}, p.messaged);
  st.matchPeak = Object.assign({}, p.matchPeak);
  return st;
}

/* snapshot  { players: [{ id, fac, tag, name }], status, health } from RconClient
 * prev      this servers saved state. never modified.
 * eff       resolveServer() output for this server
 * now       ms
 *
 * returns {
 *   state          the next state. moves are recorded as NOT done yet; the
 *                  executor calls applyOutcome() for each one that succeeds
 *   actions        in order: { type: 'broadcast' | 'restart' | 'message' | 'move', ... }
 *   counts         open side head counts before any action
 *   notes          log lines with no action attached
 *   finishedMatch  the match history record if a match just ended, else null
 * } */
function planTick(snapshot, prev, eff, now) {
  const st = cloneState(prev);
  const sides = openSides(eff.closedFaction);
  const closed = eff.closedFaction;
  const isOpen = (fac) => sides.includes(fac);
  const players = snapshot.players;
  const { counts: before, tagCounts } = tally(players, sides);
  const snap = readSnapshot(snapshot.status, snapshot.health);
  const out = { state: st, actions: [], counts: before, notes: [], finishedMatch: null };

  /* first look at this server. write everyone down as settled and touch nobody.
   * what ever mess the teams are in right now, its not ours to fix. we start
   * fixing at the next match. a balancer that reshuffles the round it just
   * walked in on is a balancer that gets uninstalled the same evening. */
  if (!st.seeded) {
    for (const pl of players) st.known[pl.id] = { fac: pl.fac, movedAt: 0, placed: true };
    st.seeded = true;
    st.matchSig = snap.sig;
    st.matchScoreSum = snap.scoreSum || 0;
    st.matchStartedAt = now;
    st.matchPeak = Object.assign({}, before);
    st.matchClosedClears = 0;
    st.lastUptime = snap.uptime;
    // start the announce clock now, so restarting the balancer doesnt fire an
    // anouncement at everyone the second it comes back up. nobody wants that.
    st.lastAnnounceAt = now;
    out.notes.push(`seeded ${players.length} player(s). this round is left alone, evening starts next match.`);
    return out;
  }

  if (snap.sig !== null) {
    const why = detectBoundary(st, snap, now);
    if (why) {
      out.finishedMatch = {
        endedAt: new Date(now).toISOString(),
        durationMin: st.matchStartedAt ? Math.round((now - st.matchStartedAt) / 60000) : null,
        map: st.matchSig,
        peak: Object.assign({}, st.matchPeak),
        peakGap: spread(st.matchPeak),
        closedSideClears: st.matchClosedClears,
      };
      // everyone goes back in the pot. this is the only moment settled players
      // get rearanged, and nobodys mid firefight at a map change.
      for (const id in st.known) if (st.known[id]) st.known[id].placed = false;
      st.lastRebalanceAt = now;
      st.matchStartedAt = now;
      st.matchPeak = Object.assign({}, before);
      st.matchClosedClears = 0;
      out.notes.push(`new match (${why}), evening the teams`);
    }
    if (snap.uptime != null) st.lastUptime = snap.uptime;
    st.matchSig = snap.sig;
    st.matchScoreSum = snap.scoreSum;
  }
  for (const f of sides) if (before[f] > (st.matchPeak[f] || 0)) st.matchPeak[f] = before[f];

  const rs = eff.rescue;
  const rescue = rescueStep(st, before, snap.scoreLead, rs, now);
  if (rescue === 'recovered') out.notes.push(`teams recovered (${fmtCounts(before)}), no restart`);
  if (rescue === 'warn') {
    out.actions.push({ type: 'broadcast', purpose: 'rescue', text: rs.warning,
      counts: Object.assign({}, before), scoreLead: snap.scoreLead, warnSeconds: rs.warnSeconds });
  }
  if (rescue === 'restart') out.actions.push({ type: 'restart', counts: Object.assign({}, before) });

  const announcement = dueAnnouncement(st, eff.announce, players.length, now);
  if (announcement) out.actions.push({ type: 'broadcast', purpose: 'announce', text: announcement });

  /* people the balancer leaves completly alone. admins mostly. an admin who
   * switches sides to go and watch somebody would otherwise get treated like a
   * stacker and put straight back, which is useless when your trying to work. */
  const exempt = new Set(eff.exempt);
  const limits = { sideCap: eff.sideCap, gapTolerance: eff.gapTolerance };
  const moveCooldown = eff.moveCooldownSeconds * 1000;
  const bounceCooldown = eff.bounceCooldownSeconds * 1000;
  // decisions further down the roster see the moves planned above them, as if
  // they had all gone through. thats what keeps a dry run honest.
  const counts = Object.assign({}, before);

  for (const pl of players) {
    // exempt: write down where they are and move on. no placing, no bouncing,
    // no clearing them off the closed side, no join message. nothing.
    if (exempt.has(pl.id)) {
      st.known[pl.id] = { fac: pl.fac, movedAt: now, placed: true };
      continue;
    }

    const prevRec = st.known[pl.id];
    const sinceMove = prevRec ? now - (prevRec.movedAt || 0) : Infinity;

    if (!prevRec && eff.joinMessage && !st.messaged[pl.id]) {
      st.messaged[pl.id] = now;
      out.actions.push({ type: 'message', id: pl.id, text: eff.joinMessage });
    }

    let placed = prevRec ? !!prevRec.placed : false;
    const clanSide = eff.clanGrouping ? clanSideFor(pl, tagCounts, sides) : null;
    let target = null;
    let forced = false;

    if (closed && pl.fac === closed) {
      // that side is shut. they get moved every time, no waiting about.
      // chooseSide only ever answers with an open side.
      target = chooseSide(counts, closed, clanSide, limits);
      forced = true;
    } else if (isOpen(pl.fac) && !placed) {
      // new arival, or everyone just after a match boundry. place them properly.
      const side = chooseSide(counts, pl.fac, clanSide, limits);
      if (side !== pl.fac) target = side;
      placed = true;
    } else if (isOpen(pl.fac) && placed && prevRec && prevRec.fac !== pl.fac) {
      target = bounceTarget(pl, prevRec.fac, counts, clanSide, limits);
      forced = target !== null;
    }

    // where they are now. a move that goes through replaces this, one that fails
    // or is only a dry run leaves it, so the next tick sees the truth and retries.
    st.known[pl.id] = { fac: pl.fac, movedAt: prevRec ? prevRec.movedAt || 0 : 0, placed };

    const cooldown = forced ? bounceCooldown : moveCooldown;
    if (target && sinceMove >= cooldown) {
      out.actions.push({
        type: 'move', id: pl.id, from: pl.fac, to: target,
        why: closed && pl.fac === closed ? 'closed side' : forced ? 'bounced' : 'balance',
        label: `${pl.name || pl.id}${pl.tag ? ' [' + pl.tag + ']' : ''}`,
        at: now,
      });
      if (isOpen(pl.fac)) counts[pl.fac]--;
      counts[target]++;
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
  for (const id in st.messaged) if (!present[id] && now - st.messaged[id] > MESSAGED_FOR_MS) delete st.messaged[id];

  return out;
}

/* a move went through. record it: where they are now, when, and that they are
 * placed. a failed or dry run move needs nothing, planTick allready wrote down
 * where they actualy are. */
function applyMoveSucceeded(st, action) {
  st.known[action.id] = { fac: action.to, movedAt: action.at, placed: true };
  if (action.why === 'closed side') st.matchClosedClears++;
}

module.exports = { planTick, applyMoveSucceeded, blankState, FORGET_AFTER_MS };
