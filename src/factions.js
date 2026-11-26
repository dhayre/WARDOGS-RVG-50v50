'use strict';
/*
 * the three factions, and which of them are in play.
 *
 * the colour names are just the slot order the rest of the code and the tests use.
 * the faction NAME is what the game api and the config speak.
 */

const RED = 'Valkyra';
const GREEN = 'Manticore';
const BLUE = 'Lonestar';
const FACTIONS = [RED, GREEN, BLUE];

// feild names and spellings have moved between builds. add to these if it happens again.
const ALIASES = [
  ['valk', RED],
  ['mant', GREEN],
  ['lone', BLUE],
];

function factionOf(p) {
  const f = String(p.faction || p.team || p.side || p.factionName || '').toLowerCase();
  for (const [needle, fac] of ALIASES) if (f.includes(needle)) return fac;
  return null;
}

function isFaction(x) {
  return FACTIONS.includes(x);
}

/* the sides that are actualy being played. two when one is closed, all three when
 * closedFaction is null. everything that counts or compares sides works off this
 * list, so two and three sided play run the same code. */
function openSides(closed) {
  return FACTIONS.filter((f) => f !== closed);
}

module.exports = { RED, GREEN, BLUE, FACTIONS, factionOf, isFaction, openSides };
