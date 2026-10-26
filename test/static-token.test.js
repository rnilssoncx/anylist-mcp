// ANYLIST_STATIC_TOKEN: the middleware on its own, then the real server as start.sh runs it.
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'anylist-static-'));
process.env.SERVER_SECRET_KEY = randomBytes(32).toString('hex');

const TOKEN = 't'.repeat(48);
let requireBearerToken, userId;

function call(token) {
  const req = { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, method: 'POST', path: '/mcp', ip: '127.0.0.1', protocol: 'http', get: () => 'x.test' };
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  requireBearerToken(req, res, () => { nexted = true; });
  return { nexted, req, res };
}

describe('ANYLIST_STATIC_TOKEN in the bearer check', () => {
  before(async () => {
    const { seed } = await import('../scripts/seed.js');
    ({ userId } = await seed({ SEED_EMAIL: 'house@example.com', SEED_CLIENT_ID: 'c1', SEED_CLIENT_SECRET: 'a'.repeat(40), ANYLIST_USERNAME: 'u', ANYLIST_PASSWORD: 'p' }));
    ({ requireBearerToken } = await import('../src/http/auth/oauth.js'));
  });
  afterEach(() => { delete process.env.ANYLIST_STATIC_TOKEN; delete process.env.SEED_EMAIL; });

  const on = () => { process.env.ANYLIST_STATIC_TOKEN = TOKEN; process.env.SEED_EMAIL = 'house@example.com'; };

  it('accepts the token as the seeded user', () => {
    on();
    const { nexted, req } = call(TOKEN);
    assert.equal(nexted, true);
    assert.equal(req.userId, userId);
  });

  it('refuses a different token of the same length', () => {
    on();
    const { nexted, res } = call('u'.repeat(48));
    assert.equal(nexted, false);
    assert.deepEqual([res.statusCode, res.body], [401, { error: 'invalid_token' }]);
  });

  it('refuses a prefix of the token', () => {
    on();
    assert.equal(call(TOKEN.slice(0, 47)).nexted, false);
  });

  it('does not exist when unset', () => {
    process.env.SEED_EMAIL = 'house@example.com';
    const { nexted, res } = call(TOKEN);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  it('refuses rather than crashes when the seeded user is missing', () => {
    process.env.ANYLIST_STATIC_TOKEN = TOKEN; process.env.SEED_EMAIL = 'nobody@example.com';
    assert.equal(call(TOKEN).nexted, false);
  });
});

function serverEnv(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'anylist-static-srv-'));
  writeFileSync(path.join(dir, 'allowed-emails.txt'), '');
  return {
    PATH: process.env.PATH, DATA_DIR: dir, ALLOWED_EMAILS_FILE: path.join(dir, 'allowed-emails.txt'),
    SERVER_SECRET_KEY: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'),
    PORT: String(40000 + Math.floor(Math.random() * 20000)), ...extra,
  };
}

describe('ANYLIST_STATIC_TOKEN at startup', () => {
  it('refuses a short token', () => {
    const r = spawnSync('node', ['src/http/index.js'], { env: serverEnv({ ANYLIST_STATIC_TOKEN: 'short', SEED_EMAIL: 'h@example.com' }), encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANYLIST_STATIC_TOKEN must be at least 32 characters\./);
  });

  it('refuses a token with no user to act as', () => {
    const r = spawnSync('node', ['src/http/index.js'], { env: serverEnv({ ANYLIST_STATIC_TOKEN: TOKEN }), encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANYLIST_STATIC_TOKEN needs SEED_EMAIL, the user it acts as\./);
  });

  it('serves /mcp to the token, end to end, and refuses another', async () => {
    const e = serverEnv({ ANYLIST_STATIC_TOKEN: TOKEN, SEED_EMAIL: 'house@example.com', SEED_CLIENT_ID: 'c1', SEED_CLIENT_SECRET: 'a'.repeat(40), ANYLIST_USERNAME: 'u', ANYLIST_PASSWORD: 'p' });
    assert.equal(spawnSync('node', ['scripts/seed.js'], { env: e, encoding: 'utf8' }).status, 0);
    const child = spawn('node', ['src/http/index.js'], { env: e });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(out)), 10000);
        child.stdout.on('data', () => { if (out.includes('listening on port')) { clearTimeout(t); resolve(); } });
      });
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
      const post = token => fetch(`http://127.0.0.1:${e.PORT}/mcp`, { method: 'POST', body: JSON.stringify(init),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
      assert.equal((await post(TOKEN)).status, 200);
      assert.equal((await post('u'.repeat(48))).status, 401);
    } finally {
      child.kill();
    }
  });
});
