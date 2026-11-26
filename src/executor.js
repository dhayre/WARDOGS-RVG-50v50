'use strict';
/*
 * does what planTick decided, through the RCON client, or in a dry run, logs
 * what it would have done. the only desision made here is none at all.
 *
 * actions run in order and one at a time. moves are awaited so a slow box isnt
 * handed fifty at once; the welcome message is fire and forget, a missed one is
 * no loss.
 */

const { fmtCounts } = require('./policy/counts');
const { applyMoveSucceeded } = require('./policy/plan');

/* plan   planTick() output
 * state  the state the plan produced (plan.state, as stored by the balancer),
 *        updated here for each move that goes through */
async function execute(plan, { api, state, key, dryRun, log }) {
  const tag = `[${key}]`;
  // the real head counts, moved only by moves that actualy happened, so the log
  // never claims a balance the server doesnt have
  const counts = Object.assign({}, plan.counts);

  for (const a of plan.actions) {
    if (a.type === 'message') {
      if (!dryRun) api.message(a.id, a.text);
    } else if (a.type === 'broadcast' && a.purpose === 'rescue') {
      if (dryRun) { log(`${tag} WOULD WARN: ${a.text}`); continue; }
      const r = await api.broadcast(a.text);
      if (r.ok) log(`${tag} warned: ${fmtCounts(a.counts)}, leader up ${a.scoreLead}. ${a.warnSeconds}s to fix it.`);
      else log(`${tag} rescue warning FAILED (${r.reason}). restart still due in ${a.warnSeconds}s.`);
    } else if (a.type === 'broadcast') {
      if (dryRun) { log(`${tag} WOULD ANNOUNCE: ${a.text}`); continue; }
      const r = await api.broadcast(a.text);
      log(`${tag} ${r.ok ? 'announced' : `announce FAILED (${r.reason})`}: ${a.text}`);
    } else if (a.type === 'restart') {
      if (dryRun) { log(`${tag} WOULD RESTART MATCH (${fmtCounts(a.counts)})`); continue; }
      const r = await api.restartMatch();
      log(`${tag} ${r.ok ? 'restarted the match' : `match restart FAILED (${r.reason})`} on ${fmtCounts(a.counts)}`);
    } else if (a.type === 'move') {
      if (dryRun) { log(`${tag} WOULD MOVE ${a.label} ${a.from} -> ${a.to} (${a.why})`); continue; }
      const r = await api.move(a.id, a.to);
      if (r.ok) {
        applyMoveSucceeded(state, a);
        if (a.from in counts) counts[a.from]--;
        counts[a.to]++;
        log(`${tag} moved ${a.label} ${a.from} -> ${a.to} (${a.why}) now ${fmtCounts(counts)}`);
      } else {
        // state allready says where they really are, with the old movedAt, so the
        // next tick retries instead of sitting on a cooldown we never earned
        log(`${tag} move FAILED ${a.label} ${a.from} -> ${a.to} (${r.reason})`);
      }
    }
  }
}

module.exports = { execute };
