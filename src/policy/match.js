'use strict';
/*
 * reading the status and health replies, and spotting a new match.
 */

/* what the status and health replies tell us, or nulls where a call failed.
 *   sig        map + experiences, changes when it rotates
 *   scoreSum   drops to 0 when scores reset
 *   scoreLead  how far ahead the leader is. a lopsided server that is still a
 *              close game is not hurting anybody yet, so rescue leaves it be.
 *   uptime     drops when the box restarts */
function readSnapshot(status, health) {
  const ok = status && status.ok;
  const sorted = ok ? status.scores.slice().sort((a, b) => b - a) : [];
  return {
    sig: ok ? `${status.map}|${status.experiences.join(',')}` : null,
    scoreSum: ok ? status.scores.reduce((a, b) => a + b, 0) : null,
    scoreLead: sorted.length >= 2 ? sorted[0] - sorted[1] : 0,
    uptime: health && health.ok ? health.uptimeSeconds : null,
  };
}

/* has a new match started. three ways of spoting it because not one of them is
 * reliable on its own:
 *   map rotated     easy, unless the rotation lands on the same map again
 *   scores reset    easy, unless nobody scored last match
 *   uptime droped   the box restarted and the other two never noticed
 * the 60 second gaurd stops all three firing at once and doing it twice.
 *
 * returns why, as a short string for the log, or null for the same match. */
function detectBoundary(st, snap, now) {
  if (snap.sig === null) return null;
  const mapRotated = st.matchSig !== null && snap.sig !== st.matchSig;
  const scoreReset = st.matchScoreSum >= 10 && snap.scoreSum === 0;
  const restarted = st.lastUptime != null && snap.uptime != null && snap.uptime < st.lastUptime - 60;
  if (!(mapRotated || scoreReset || restarted) || now - st.lastRebalanceAt < 60000) return null;
  return restarted ? 'box restarted' : mapRotated ? 'map -> ' + snap.sig : 'scores reset';
}

module.exports = { readSnapshot, detectBoundary };
