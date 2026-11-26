#!/usr/bin/env node
'use strict';
/*
 * startup. read the config, moan about anything obviously wrong, start the loop.
 *   --check     validate and exit
 *   --dry-run   deside everything, move nobody
 *
 * the rules for what counts as a good config live in src/config.js.
 *
 * SIXFIVE
 */

const fs = require('fs');
const path = require('path');
const { Balancer } = require('./balancer');
const { loadConfig } = require('./src/config');

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...a) {
  console.log(`[${stamp()}]`, ...a);
}
function die(...msgs) {
  for (const msg of msgs) console.error(`\n  config error: ${msg}`);
  console.error('');
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const fileArg = args.find((a) => !a.startsWith('--'));
const configPath = path.resolve(fileArg || 'config.json');

if (!fs.existsSync(configPath)) {
  die(
    `no config at ${configPath}\n` +
    `  copy config.example.json to config.json and put your servers in it.`
  );
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  // nine times out of ten this is a trailing coma
  die(`${configPath} is not valid JSON: ${e.message}`);
}

// every problem at once, not one per run. fixing them one restart at a time is miserable.
const { cfg, errors } = loadConfig(raw, {
  configDir: path.dirname(configPath),
  env: process.env,
  dryRun: flags.has('--dry-run'),
});
if (errors.length) die(...errors);

/* the mistake everyone makes once. walk up looking for a .git and check the
 * config is actualy ignored. reads .gitignore only, never shells out to git. */
(function warnIfConfigIsInARepo() {
  try {
    const base = path.basename(configPath);
    let dir = path.dirname(configPath);
    for (let hops = 0; hops < 6; hops++) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        let ignored = false;
        for (const g of [path.join(path.dirname(configPath), '.gitignore'), path.join(dir, '.gitignore')]) {
          if (!fs.existsSync(g)) continue;
          const rules = fs.readFileSync(g, 'utf8').split(/\r?\n/).map((l) => l.trim());
          if (rules.some((l) => l && !l.startsWith('#') && !l.startsWith('!') &&
              (l === base || l === '/' + base || (l.includes('*') && new RegExp('^' + l.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(base))))) {
            ignored = true;
          }
        }
        if (!ignored) {
          console.error('');
          console.error('  ******************************************************************');
          console.error('  *  WARNING: ' + base + ' holds your RCON password and it is       ');
          console.error('  *  sat in a git repo WITHOUT being ignored.                       ');
          console.error('  *                                                                 ');
          console.error('  *  add this to .gitignore before you push anything:               ');
          console.error('  *      ' + base);
          console.error('  *                                                                 ');
          console.error('  *  if it is allready pushed, change the RCON password on your      ');
          console.error('  *  server first. that is what actualy closes the hole.            ');
          console.error('  ******************************************************************');
          console.error('');
        }
        return;
      }
      const up = path.dirname(dir);
      if (up === dir) return;
      dir = up;
    }
  } catch (e) { /* a warning that crashes the app is worse than no warning */ }
})();

const active = cfg.servers.filter((s) => s.enabled !== false);
if (flags.has('--check')) {
  console.log(`config OK: ${active.length} server(s) enabled, cap ${cfg.sideCap} a side, ` +
    `tolerance ${cfg.gapTolerance}, closed side ${cfg.closedFaction || 'none, three open'}, ` +
    `clan grouping ${cfg.clanGrouping ? 'on' : 'off'}` +
    `${(cfg.exempt || []).length ? ', ' + cfg.exempt.length + ' exempt' : ''}` +
    `${(cfg.rescue || {}).enabled ? ', rescue ON (restarts at <' + Math.round(cfg.rescue.minorityShare * 100) + '% a side)' : ', rescue off'}` +
    `${(cfg.announce || {}).message !== undefined && String(cfg.announce.message).trim() === ''
        ? ', announcements off'
        : ', announcing every ' + cfg.announce.everyMinutes + 'min'}` +
    `${cfg.dryRun ? ', DRY RUN' : ''}.`);
  process.exit(0);
}

// dont let one bad responce kill it at 2am
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.message ? e.message : e));

// before the balancer, so the state line it prints has context
log(`config: ${configPath}`);
log(`state:  ${cfg.stateDir}`);

const bal = new Balancer(cfg, log);

// save on the way out or a restart re seeds
function shutdown(sig) {
  log(`${sig}, saving state and stopping.`);
  bal.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// the only way start fails is the lock: another copy is allready on this state
try {
  bal.start();
} catch (e) {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
