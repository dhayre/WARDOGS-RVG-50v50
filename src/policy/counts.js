'use strict';
/*
 * head counts. a map of faction -> heads holding only the open sides, so
 * everything that reads one works the same for two sides or three.
 */

/* the gap is the spread across the open sides: biggest minus smallest. with two
 * sides thats |a - b|. */
function spread(counts) {
  const n = Object.values(counts);
  return n.length ? Math.max(...n) - Math.min(...n) : 0;
}

// V26/M24, or V17/M17/L16 with three open. the initials are unique.
function fmtCounts(counts) {
  return Object.keys(counts).map((f) => f[0] + counts[f]).join('/');
}

/* heads per open side, and heads per clan tag per open side. players on the
 * closed side or on a faction we cant read are in neither. */
function tally(players, sides) {
  const counts = {};
  for (const f of sides) counts[f] = 0;
  const tagCounts = {};
  for (const pl of players) {
    if (!sides.includes(pl.fac)) continue;
    counts[pl.fac]++;
    if (pl.tag) {
      const t = (tagCounts[pl.tag] = tagCounts[pl.tag] || {});
      t[pl.fac] = (t[pl.fac] || 0) + 1;
    }
  }
  return { counts, tagCounts };
}

module.exports = { spread, fmtCounts, tally };
