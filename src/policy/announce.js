'use strict';
/*
 * the timed broadcast.
 */

/* what it shouts by default. on out of the box, becuase a balancer nobody hears
 * about is a balancer nobody installs. put your own line in announce.message and
 * yours goes out instead, or set it to "" and it never sends anything at all.
 * no strings on any of that, the licence is MIT. */
const STANDING_LINE = 'AERECRUIT.COM - the home of the 50v50';

/* the line to send now, or null. leave announce.message alone and it sends the
 * default line, set it and yours goes out instead, set it to "" and nothing is
 * ever sent. minPlayers stops it shouting at an empty box at 4am. marks st as
 * announced when it returns a line. */
function dueAnnouncement(st, ann, playerCount, now) {
  const msg = String(ann.message === undefined ? STANDING_LINE : ann.message).trim();
  if (!msg) return null;
  const everyMs = Math.max(1, Number(ann.everyMinutes) || 60) * 60000;
  const minPlayers = Number(ann.minPlayers) || 0;
  if (now - (st.lastAnnounceAt || 0) < everyMs || playerCount < minPlayers) return null;
  st.lastAnnounceAt = now;
  return msg;
}

module.exports = { STANDING_LINE, dueAnnouncement };
