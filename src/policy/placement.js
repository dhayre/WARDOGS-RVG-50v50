'use strict';
/*
 * where one player should be. pure functions: counts in, a faction out.
 */

const { spread } = require('./counts');

/* prefrence order: their clan if its allready somewhere, then the side they
 * picked, then the rest from emptiest up. anything over the cap drops out, and
 * of whats left the first one inside the gap tolerance wins. if none are, the
 * one that leaves the smallest gap, earlier prefrence breaking a tie.
 * it never breaks the cap to be nice to a clan. mates is lovely, 51 v 43 isnt
 * a game.
 *
 * counts holds the open sides only, so the answer is always an open side. */
function chooseSide(counts, currentFaction, clanSide, limits) {
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
function clanSideFor(pl, tagCounts, sides) {
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

/* the closed door.
 *
 * this is the one that stops stacking. a settled player who switches sides mid
 * match gets put back if the side they jumped to is full, or is allready heavier
 * than the tolerance. jumping to the LIGHTER side is allways fine, because
 * somebody volunteering to even it up is doing our job for us.
 *
 * and note it only ever fires on someone who moved themselfs. a player who is
 * just playing is never touched. thats the whole promise and its why this is
 * safe to leave runing.
 *
 * heavier means heavier than the side they left. if they didnt leave an open side
 * (they came off the closed one) its the lightest other open side, and they get
 * placed properly instead of being sent back where they were, because where they
 * were is shut.
 *
 * returns where to send them, or null to leave them be. */
function bounceTarget(pl, prevFac, counts, clanSide, limits) {
  const sides = Object.keys(counts);
  const onto = counts[pl.fac];
  const cameFromOpen = sides.includes(prevFac);
  const from = cameFromOpen
    ? counts[prevFac]
    : Math.min(...sides.filter((f) => f !== pl.fac).map((f) => counts[f]));
  if (!(onto > limits.sideCap || onto - from > limits.gapTolerance)) return null;
  const side = cameFromOpen ? prevFac : chooseSide(counts, pl.fac, clanSide, limits);
  return side !== pl.fac ? side : null;
}

module.exports = { chooseSide, clanSideFor, bounceTarget };
