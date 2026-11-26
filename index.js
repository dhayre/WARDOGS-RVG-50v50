#!/usr/bin/env node
'use strict';
/*
 * the CLI lives in bin/wd-balancer.js. this stays so `node index.js`, your
 * systemd unit and the pm2 config keep working without a change.
 *   --check     validate and exit
 *   --dry-run   deside everything, move nobody
 */
require('./bin/wd-balancer.js');
