'use strict';
/*
 * last resort: the match is lost because the teams are broken.
 *
 * this is the one thing that can move settled players mid match, and it does it
 * by restarting the round rather than dragging anybody. it only fires when the
 * game is allready ruined, and it gives the server a chance to fix itself first.
 *
 * what "broken" means: the small side is under 40% of the server. thats off real
 * numbers, 40v30 is a game, 40v25 is not. plus an absolute gap so it cant trip on
 * 12v6, plus a minimum headcount so it leaves quiet servers be.
 *
 * and it has to actualy be costing somebody the match, hence the score lead.
 * off by default. restarting somebody elses match uninvited is rude.
 *
 * with three open sides 40% of the server on the smallest side is impossible, so
 * the share scales: minorityShare * 2 / sides. 40% for two, 26.7% for three, the
 * same 80% of a fair share either way.
 */

function isLopsided(counts, rs) {
  const vals = Object.values(counts);
  const big = Math.max(...vals), small = Math.min(...vals), tot = vals.reduce((a, b) => a + b, 0);
  const line = rs.minorityShare * 2 / vals.length;
  return tot >= rs.minPlayers && (big - small) >= rs.minGap && (small / tot) < line;
}

/* one step of the warn, wait, restart cycle. updates the rescue fields of st
 * (the next state planTick is building) and says what, if anything, to do:
 *   null          nothing
 *   'recovered'   it was warned and has come back inside the line
 *   'warn'        broadcast the warning
 *   'restart'     restart the round */
function rescueStep(st, counts, scoreLead, rs, now) {
  if (!rs.enabled) return null;
  if (!isLopsided(counts, rs)) {
    // sorted itself out, or people did as they were asked. forget it happened.
    const was = st.warnedAt;
    st.lopsidedSince = 0; st.warnedAt = 0;
    return was ? 'recovered' : null;
  }
  if (now - (st.lastRestartAt || 0) < rs.cooldownMinutes * 60000) return null;
  if (!st.lopsidedSince) {
    st.lopsidedSince = now;                       // start the clock, give it a chance
    return null;
  }
  if (now - st.lopsidedSince < rs.graceMinutes * 60000 || !(scoreLead > rs.scoreLead)) return null;
  if (!st.warnedAt) {
    st.warnedAt = now;
    return 'warn';
  }
  if (now - st.warnedAt >= rs.warnSeconds * 1000) {
    // they had their chance
    st.lastRestartAt = now; st.lopsidedSince = 0; st.warnedAt = 0;
    return 'restart';
  }
  return null;
}

module.exports = { isLopsided, rescueStep };
