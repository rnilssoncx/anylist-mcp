// The production entry points run as processes, as start.sh runs them: the
// HTTP server's startup checks and request log, and the seed script's CLI guard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';

function env(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'anylist-start-'));
  writeFileSync(path.join(dir, 'allowed-emails.txt'), '');
  return {
    PATH: process.env.PATH,
    DATA_DIR: dir,
    ALLOWED_EMAILS_FILE: path.join(dir, 'allowed-emails.txt'),
    SERVER_SECRET_KEY: randomBytes(32).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    PORT: String(40000 + Math.floor(Math.random() * 20000)),
    ...extra,
  };
}

// Start the server, wait for it to listen, run `fn`, and return everything it printed.
async function withServer(e, fn) {
  const child = spawn('node', ['src/http/index.js'], { env: e });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000);
    child.stdout.on('data', () => { if (out.includes('listening on port')) { clearTimeout(timer); resolve(); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  try {
    await fn(`http://127.0.0.1:${e.PORT}`);
    await new Promise(r => setTimeout(r, 200));
  } finally {
    child.removeAllListeners('exit');
    child.kill();
  }
  return out;
}

describe('HTTP server startup', () => {
  it('refuses a misspelt ANYLIST_TOOLS at startup, naming it', () => {
    const r = spawnSync('node', ['src/http/index.js'], { env: env({ ANYLIST_TOOLS: 'shopping,shoping' }), timeout: 10000, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANYLIST_TOOLS names unknown tools: shoping\./);
  });

  it('starts with a valid ANYLIST_TOOLS', async () => {
    const out = await withServer(env({ ANYLIST_TOOLS: 'shopping,health_check' }), async () => {});
    assert.match(out, /listening on port/);
  });

  it('does not log request bodies by default', async () => {
    const out = await withServer(env(), base =>
      fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list: 'SECRET-LIST-ITEM' }) }));
    assert.match(out, /POST \/mcp → 401/);
    assert.doesNotMatch(out, /SECRET-LIST-ITEM/);
  });

  it('logs request bodies when LOG_REQUEST_BODIES=1', async () => {
    const out = await withServer(env({ LOG_REQUEST_BODIES: '1' }), base =>
      fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list: 'SECRET-LIST-ITEM' }) }));
    assert.match(out, /SECRET-LIST-ITEM/);
  });
});

describe('seed script', () => {
  it('runs when invoked as start.sh invokes it, and writes the user', () => {
    const e = env({
      SEED_EMAIL: 'house@example.com', SEED_CLIENT_ID: 'client-1', SEED_CLIENT_SECRET: 'a'.repeat(40),
      ANYLIST_USERNAME: 'list@example.com', ANYLIST_PASSWORD: 'pw',
    });
    const r = spawnSync('node', ['scripts/seed.js'], { env: e, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'seed: done');
    const db = new Database(path.join(e.DATA_DIR, 'anylist-mcp.db'), { readonly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT user_id FROM oauth_clients WHERE client_id = ?').get('client-1').user_id,
      db.prepare('SELECT id FROM users').get().id);
  });

  it('exits 1 with the reason when the environment is incomplete', () => {
    const r = spawnSync('node', ['scripts/seed.js'], { env: env(), encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /seed: missing SEED_EMAIL/);
  });
});
