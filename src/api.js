'use strict';
/*
 * the RCON client. one per server. every call it makes is in the table in the
 * readme and in SECURITY.md, and there are no others. if you add one here, add
 * it there too.
 *
 * nothing in here throws. every call comes back as { ok, reason, ... } so the
 * balancer can say WHY a box isnt answering instead of guessing.
 */

const { factionOf } = require('./factions');

// six seconds. a box that cant anwser in six is having a worse night than we
// are, and blocking here stops every other server getting looked at.
const DEFAULT_TIMEOUT_MS = 6000;

function idOf(p) {
  return String(p.steamId || p.steamID || p.id || p.netId || p.net_id || p.playerId || '');
}

/* a clan tag is a braket at the front. "[WOLF] someone".
 * caped at 12 charecters because someone will absolutly turn up called
 * "[i am the strongest soldier alive] dave" and he is not a clan. */
function tagOf(p) {
  const m = String(p.name || '').match(/^\s*\[([^\]]{1,12})\]/);
  return m ? m[1].trim().toUpperCase() : null;
}

/* turn whatever fetch threw into something a person can act on. node puts the
 * socket error code on e.cause. some stubs and older builds put it on the error
 * itself or only in the message, so look in all three. */
function reasonFromError(e, timeoutMs) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return `timed out after ${timeoutMs / 1000}s`;
  // fetch refuses a short list of ports outright (1, 22, 25, 6000, 6667 and so on)
  if (e && e.cause && e.cause.message === 'bad port') {
    return 'that port is one fetch will not connect to at all. give RCON a different port';
  }
  const code = (e && ((e.cause && e.cause.code) || e.code)) ||
    ((e && /\b(E[A-Z]{3,})\b/.exec(String(e.message))) || [])[1];
  switch (code) {
    case 'ECONNREFUSED': return 'connection refused. wrong port, or RCON is not switched on';
    case 'ENOTFOUND': return 'host not found. check the host in your config';
    case 'EAI_AGAIN': return 'dns lookup failed. check the host, and that this machine has dns';
    case 'ETIMEDOUT': return 'connection timed out. a firewall is probably dropping it';
    case 'EHOSTUNREACH': case 'ENETUNREACH': return 'no route to the host';
    case 'ECONNRESET': return 'connection reset by the server';
    default: return code ? `network error (${code})` : `request failed: ${(e && e.message) || e}`;
  }
}

function reasonFromStatus(status) {
  if (status === 401 || status === 403) return `refused (${status}). the token is not the token`;
  if (status === 404) return 'not found (404). is that the RCON port and not the game port?';
  return status ? `HTTP ${status}` : 'the server said no';
}

class RconClient {
  /* fetch defaults to whatever globalThis.fetch is at the moment of the call,
   * not at construction, so the selftest can still swap it about mid run. */
  constructor(server, opts) {
    const o = opts || {};
    this.server = server;
    this.fetch = o.fetch || ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = server.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async call(method, route, body) {
    const s = this.server;
    const url = `${s.scheme || 'http'}://${s.host}:${s.port}${route}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const init = { method, headers: { Authorization: 'Bearer ' + s.token }, signal: ctrl.signal };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await this.fetch(url, init);
      if (!res.ok) return { ok: false, status: res.status, reason: reasonFromStatus(res.status) };
      if (method !== 'GET') return { ok: true, status: res.status };
      try {
        return { ok: true, status: res.status, data: await res.json() };
      } catch (e) {
        return { ok: false, status: res.status, reason: 'answered with something that is not JSON' };
      }
    } catch (e) {
      return { ok: false, reason: reasonFromError(e, this.timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* the roster, normalised. a list we cant make sense of is a failure, not an
   * empty server: treating garbage as "nobody is on" is how memory gets wiped.
   * entries with no id are dropped, they cant be moved anyway. */
  async players() {
    const r = await this.call('GET', '/v1/players');
    if (!r.ok) return r;
    const d = r.data;
    const list = d && Array.isArray(d.players) ? d.players : Array.isArray(d) ? d : null;
    if (!list) return { ok: false, reason: 'player list was not in a shape we recognise' };
    const players = [];
    for (const p of list) {
      const id = idOf(p || {});
      if (id) players.push({ id, fac: factionOf(p), tag: tagOf(p), name: p.name });
    }
    return { ok: true, players };
  }

  async status() {
    const r = await this.call('GET', '/v1/status');
    if (!r.ok) return r;
    const d = r.data || {};
    return {
      ok: true,
      map: d.map || '',
      experiences: Array.isArray(d.experiences) ? d.experiences : [],
      scores: (Array.isArray(d.factionScores) ? d.factionScores : []).map((f) => (f && f.score) || 0),
    };
  }

  async health() {
    const r = await this.call('GET', '/v1/health');
    if (!r.ok) return r;
    const u = r.data && r.data.uptimeSeconds;
    return { ok: true, uptimeSeconds: typeof u === 'number' ? u : null };
  }

  move(id, faction) { return this.call('PATCH', `/v1/players/${id}`, { faction }); }
  message(id, message) { return this.call('POST', `/v1/players/${id}/message`, { message }); }
  broadcast(message) { return this.call('POST', '/v1/broadcast', { message }); }
  restartMatch() { return this.call('POST', '/v1/match/restart', {}); }
}

module.exports = { RconClient, idOf, tagOf, reasonFromError, reasonFromStatus };
