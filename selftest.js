#!/usr/bin/env node
'use strict';
/*
 * selftest. fakes a whole WARDOGS server in memory so every rule can be proven
 * with out going anywhere near a real game.
 *
 *   node selftest.js      (same as npm test)
 *
 * run this before you trust the thing on a live box. dont take my word for any
 * of it, the whole point is that you can check it yourself.
 *
 * no network, no config, no server needed. it never leaves the machine.
 *
 * the tests themselves are in test/, one file per area, run by node's own test
 * runner. every rule in the readme has one. if you change the logic and one of
 * them fails then the readme is now lying, so fix which ever of the two is wrong.
 *
 * SIXFIVE
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
