'use strict';
/*
 * config rules. the first three drive the real CLI instead of a copy of its
 * logic: a test that re implements the thing its testing passes happily while
 * the actual file is broken, which is how the shallow merge slipped past once.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, resolveServer } = require('../src/config');
const { tmpDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'index.js');
const cfgDir = tmpDir('cfg');

let n = 0;
const accepts = (obj) => {
  const f = path.join(cfgDir, `c${n++}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return spawnSync(process.execPath, [CLI, f, '--check'], { encoding: 'utf8' }).status === 0;
};
const srv = (extra) => Object.assign({ name: 's', host: '10.0.0.5', port: 7779, token: 'Hx8kQ2mVp' }, extra || {});
const good = (extra) => Object.assign({ servers: [srv()] }, extra || {});
const errorsFor = (raw) => loadConfig(raw, {}).errors;

describe('--check, through the real CLI', () => {
  after(() => fs.rmSync(cfgDir, { recursive: true, force: true }));

  // REGRESSION. setting ONE key inside announce or rescue used to wipe the rest of
  // that block, becuase the config merge was shallow.
  it('setting one key keeps the rest of that block', () => {
    assert.deepEqual([accepts(good({ rescue: { enabled: true } })), accepts(good({ announce: { message: 'mine' } }))],
      [true, true]);
  });

  /* every placeholder printed in the readme, the wiki or the example config has to
   * bounce off --check. nothing in this list is ever contacted. the last host looks
   * fake and isnt, its real and routable and belongs to somebody, which is exactly
   * why its in here. */
  it('every placeholder in the docs is rejected by --check', () => {
    const hosts = ['YOUR.IP', 'OTHER.IP', '203.0.113.10', '198.51.100.4', '192.0.2.7', '123.45.67.89'];
    const tokens = ['PUT_YOUR_RCON_PASSWORD_HERE', 'PUT_THE_PASSWORD_HERE', 'the-password-from-step-1', '...', 'changeme', 'xxxx'];
    const leaked = [
      ...hosts.filter((h) => accepts({ servers: [srv({ host: h })] })),
      ...tokens.filter((t) => accepts({ servers: [srv({ token: t })] })),
    ];
    assert.deepEqual(leaked, []);
  });

  it('a config with real values is still accepted', () => {
    assert.equal(accepts(good()), true);
  });
});

describe('validation', () => {
  // a server could switch rescue on with a minorityShare of 0.9 and --check said fine
  it('per server rescue and closedFaction are validated', () => {
    const rescue = errorsFor({ servers: [srv({ rescue: { enabled: true, minorityShare: 0.9 } })] });
    const closed = errorsFor({ servers: [srv({ closedFaction: 'Lonestarr' })] });
    assert.equal(rescue.length, 1);
    assert.match(rescue[0], /^servers\[0\] \("s"\): rescue\.minorityShare/);
    assert.equal(closed.length, 1);
    assert.match(closed[0], /^servers\[0\] \("s"\): closedFaction "Lonestarr"/);
  });

  it('a bad global setting is reported once', () => {
    assert.deepEqual(errorsFor({ gapTolerance: -1, servers: [srv({ name: 'a' }), srv({ name: 'b' })] }),
      ['gapTolerance has to be 0 or more.']);
  });

  it('rescue is accepted with all three sides open', () => {
    assert.deepEqual(errorsFor({ closedFaction: null, rescue: { enabled: true }, servers: [srv()] }), []);
  });

  // a typo in a cooldown used to silently mean nobody was ever moved
  it('cooldowns override per server, and junk in them is rejected', () => {
    const { cfg } = loadConfig({ servers: [srv({ moveCooldownSeconds: 10 })] }, {});
    assert.equal(resolveServer(cfg, cfg.servers[0]).moveCooldownSeconds, 10);
    assert.equal(errorsFor({ servers: [srv({ bounceCooldownSeconds: '5s' })] }).length, 1);
  });

  it('tokenEnv reads the named variable, and says so when its missing', () => {
    const named = loadConfig({ servers: [srv({ token: undefined, tokenEnv: 'WD_TEST_TOKEN' })] }, { env: { WD_TEST_TOKEN: 'Hx8kQ2mVp' } });
    const missing = loadConfig({ servers: [srv({ token: undefined, tokenEnv: 'WD_TEST_TOKEN' })] }, { env: {} });
    assert.deepEqual([named.errors, named.cfg.servers[0].token], [[], 'Hx8kQ2mVp']);
    assert.equal(missing.errors.length, 1);
    assert.match(missing.errors[0], /WD_TEST_TOKEN but its not set/);
  });

  it('a server set to null closedFaction gets three open sides, even under a global one', () => {
    const { cfg } = loadConfig({ closedFaction: 'Lonestar', servers: [srv({ closedFaction: null }), srv({ name: 't' })] }, {});
    assert.deepEqual(cfg.servers.map((s) => resolveServer(cfg, s).closedFaction), [null, 'Lonestar']);
  });

  it('stateDir is relative to the config file, not the shell', () => {
    const { cfg } = loadConfig(good(), { configDir: '/opt/wd' });
    assert.equal(cfg.stateDir, path.resolve('/opt/wd', 'state'));
  });
});
