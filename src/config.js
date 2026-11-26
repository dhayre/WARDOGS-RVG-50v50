'use strict';
/*
 * config: defaults, merging, per server resolution and validation.
 *
 * nothing in here exits or prints. validate() hands back a list of problems and the
 * caller decides what to do with them, so the rules can be tested directly.
 *
 * the validation is deliberatly shouty. the worst failure this has is not crashing,
 * its sitting there all night looking alive and balancing absolutly nothing because
 * a port was a string.
 */

const path = require('path');
const { FACTIONS, isFaction } = require('./factions');

const DEFAULTS = {
  pollSeconds: 2,
  dryRun: false,
  clanGrouping: true,
  sideCap: 50,
  gapTolerance: 3,
  closedFaction: 'Lonestar',
  moveCooldownSeconds: 30,
  bounceCooldownSeconds: 5,
  joinMessage: '',
  announce: { everyMinutes: 60, minPlayers: 10 },
  exempt: [],
  rescue: {
    enabled: false, minPlayers: 20, minorityShare: 0.40, minGap: 8,
    scoreLead: 15, graceMinutes: 3, warnSeconds: 90, cooldownMinutes: 15,
    warning: 'Teams are badly unbalanced. Switch to the smaller side now or this match will be restarted.',
  },
  keepMatchHistory: true,
  stateDir: './state',
  servers: [],
};

// the blocks that merge key by key instead of being replaced wholesale
const NESTED = ['announce', 'rescue'];

// settings a server can override for itself. exempt is handled seperately, its a union.
const SCALAR_OVERRIDES = [
  'sideCap', 'gapTolerance', 'closedFaction', 'clanGrouping', 'joinMessage',
  'moveCooldownSeconds', 'bounceCooldownSeconds',
];

/* defaults under whatever the user wrote. Object.assign is shallow, so
 * `"rescue": { "enabled": true }` would otherwise REPLACE the whole default rescue
 * block and take minorityShare, minGap and the rest with it. */
function mergeConfig(raw) {
  const r = raw || {};
  const cfg = Object.assign({}, DEFAULTS, r);
  for (const k of NESTED) cfg[k] = Object.assign({}, DEFAULTS[k], r[k] || {});
  return cfg;
}

/* one flat settings object for one server, global values under the servers own.
 * a server value counts when its not undefined, so null is a real value. that
 * matters for closedFaction, where null means three open sides. */
function resolveServer(cfg, server) {
  const out = {};
  for (const k of SCALAR_OVERRIDES) out[k] = server[k] !== undefined ? server[k] : cfg[k];
  out.closedFaction = out.closedFaction || null;
  for (const k of NESTED) out[k] = Object.assign({}, DEFAULTS[k], cfg[k] || {}, server[k] || {});
  out.exempt = [].concat(cfg.exempt || [], server.exempt || []).map((x) => String(x).trim()).filter(Boolean);
  return out;
}

/* name an env var instead of putting the password in the file. this is the only
 * thing in here with a side effect: it fills in server.token. */
function resolveSecrets(cfg, env) {
  const errors = [];
  (cfg.servers || []).forEach((s, i) => {
    if (s.enabled === false || s.token || !s.tokenEnv) return;
    const v = env[s.tokenEnv];
    if (!v) errors.push(`servers[${i}] ("${s.name}") points at env var ${s.tokenEnv} but its not set in this shell.`);
    else s.token = v;
  });
  return errors;
}

/* the rules that apply to a set of balancing settings, global or one servers.
 * messages are unprefixed so a server only gets told about problems the global
 * block doesnt allready have. */
function checkPolicy(eff) {
  const e = [];
  if (eff.closedFaction && !isFaction(eff.closedFaction)) {
    e.push(`closedFaction "${eff.closedFaction}" is not one of: ${FACTIONS.join(', ')}. use null to leave all three open.`);
  }
  if (!(eff.gapTolerance >= 0)) e.push('gapTolerance has to be 0 or more.');
  // a typo like "30s" here used to mean nobody was ever moved, silently
  if (!(eff.moveCooldownSeconds >= 0)) e.push('moveCooldownSeconds has to be a number, 0 or more.');
  if (!(eff.bounceCooldownSeconds >= 0)) e.push('bounceCooldownSeconds has to be a number, 0 or more.');

  // stop somebody setting it to every 2 minutes and getting the whole server to
  // mute chat, which makes the anouncement worthless and annoys everyone.
  const a = eff.announce || {};
  const sending = a.message === undefined || String(a.message).trim() !== '';
  if (sending && !(Number(a.everyMinutes) >= 5)) {
    e.push('announce.everyMinutes has to be 5 or more. once an hour is plenty.');
  }

  const R = eff.rescue || {};
  if (R.enabled) {
    // these restart peoples matches, so a fat finger here is expensive
    if (!(R.minorityShare > 0.10 && R.minorityShare < 0.50)) {
      e.push('rescue.minorityShare has to be between 0.10 and 0.50. 0.40 means the small side must be 40% of the server.');
    }
    if (!(R.minPlayers >= 10)) e.push('rescue.minPlayers has to be 10 or more. dont restart matches on a quiet server.');
    if (!(R.minGap >= 4)) e.push('rescue.minGap has to be 4 or more.');
    if (!(R.graceMinutes >= 1)) e.push('rescue.graceMinutes has to be at least 1. give it a chance to recover first.');
    if (!(R.warnSeconds >= 15)) e.push('rescue.warnSeconds has to be at least 15. people need time to actually switch.');
  }
  return e;
}

function checkExempt(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return ['"exempt" has to be a list of steam ids in [ ] brackets.'];
  // steam ids, not names. names change, ids dont.
  return list
    .filter((id) => !/^\d{15,20}$/.test(String(id).trim()))
    .map((id) => `exempt list has "${id}" in it. that needs to be a steam id (the long number), not a name.`);
}

/* every problem with a merged config, as a list of messages. empty means fine.
 * run resolveSecrets first, or every tokenEnv server reads as missing a token. */
function validate(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
    return ['no servers configured. put at least one in "servers".'];
  }

  const seen = new Set();
  cfg.servers.forEach((s, i) => {
    const where = `servers[${i}]`;
    if (!s.name) { errors.push(`${where} needs a "name". any label you like, it shows in the logs.`); return; }
    // the name keys the saved state, so two the same would share one
    if (seen.has(s.name)) errors.push(`two servers are both called "${s.name}". names have to be unique.`);
    seen.add(s.name);
    if (s.enabled === false) return;
    const who = `${where} ("${s.name}")`;
    if (!s.host) errors.push(`${who} needs a "host".`);
    if (!s.port) errors.push(`${who} needs a "port". thats the RCON port, not the game port.`);
    if (!s.token && !s.tokenEnv) {
      errors.push(`${who} needs a "token" (your RCON password) or a "tokenEnv" naming an env var that holds it.`);
    }

    /* people copy the example, run --check, get told its fine, then wonder why it
     * cant connect. catch the placeholder so the error lands where the mistake is. */
    if (s.token && /^(PUT_|YOUR_|CHANGE_|the-password|\.{2,}$|xxx+$|password$|changeme$)/i.test(String(s.token).trim())) {
      errors.push(`${who} still has the example password in it (${s.token}).\n` +
        `  put your real RCON password there. its the one from your servers\n` +
        `  [/Script/WDRCON.WDRCONSettings] block, not your game or admin password.`);
    }
    /* every placeholder we print anywhere. the readme and the wiki say YOUR.IP, the
     * example config uses the documentation ranges. none of them go anywhere. */
    const h = String(s.host || '').trim();
    if (/^(203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|123\.45\.67\.)/.test(h) || /^(your|other)\.ip$/i.test(h)) {
      errors.push(`${who} still has the example host ${s.host} in it.\n` +
        `  thats a placeholder, it goes nowhere. put your servers real IP there, the\n` +
        `  same address people type to connect.`);
    }
    const cap = s.sideCap !== undefined ? s.sideCap : cfg.sideCap;
    if (!(cap > 0)) errors.push(`${who} has a sideCap of ${cap}, which would be a quiet server.`);
  });

  const globalPolicy = checkPolicy(cfg);
  errors.push(...globalPolicy);
  const already = new Set(globalPolicy);
  cfg.servers.forEach((s, i) => {
    if (!s.name || s.enabled === false) return;
    for (const msg of checkPolicy(resolveServer(cfg, s))) {
      if (!already.has(msg)) errors.push(`servers[${i}] ("${s.name}"): ${msg}`);
    }
  });

  for (const list of [cfg.exempt, ...cfg.servers.map((s) => s.exempt)]) errors.push(...checkExempt(list));
  if (!(cfg.pollSeconds >= 1)) errors.push('pollSeconds has to be at least 1. be kind to your server.');
  return errors;
}

/* raw parsed JSON in, ready to run config out. stateDir is worked out from where
 * the config file is, not from where ever the shell happens to be stood. systemd
 * starts you in / and then your state ends up in /state and re seeds every boot. */
function loadConfig(raw, opts) {
  const o = opts || {};
  const cfg = mergeConfig(raw);
  if (o.dryRun) cfg.dryRun = true;
  if (o.configDir) cfg.stateDir = path.resolve(o.configDir, cfg.stateDir);
  const errors = [...resolveSecrets(cfg, o.env || {}), ...validate(cfg)];
  return { cfg, errors };
}

module.exports = { DEFAULTS, mergeConfig, resolveServer, resolveSecrets, validate, loadConfig };
