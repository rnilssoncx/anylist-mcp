import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

// db.js reads DATA_DIR when it is imported, so the environment is set first.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'anylist-sessions-'));
process.env.SERVER_SECRET_KEY = randomBytes(32).toString('hex');

let db, sessions;

describe('session manager', () => {
  before(async () => {
    db = await import('../src/http/db.js');
    sessions = await import('../src/http/session-manager.js');
    db.createUser({ id: 'u1', email: 'house@example.com' });
    db.upsertAnyListCredentials('u1', { username: 'list@example.com', password: 'pw', defaultListName: 'Groceries' });
  });

  let ended;
  beforeEach(() => { ended = 0; });

  async function open() {
    const client = await sessions.getOrCreateSession('u1');
    client.disconnect = async () => { ended++; };
    return client;
  }

  it('disconnects the client when a session is evicted', async () => {
    const first = await open();
    sessions.evictSession('u1');
    assert.equal(ended, 1);
    assert.notEqual(await sessions.getOrCreateSession('u1'), first);
    sessions.evictSession('u1');
  });

  it('disconnects the client when a session goes idle', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const first = await open();
      mock.timers.tick(30 * 60 * 1000);
      assert.equal(ended, 1);
      assert.notEqual(await sessions.getOrCreateSession('u1'), first);
      sessions.evictSession('u1');
    } finally {
      mock.timers.reset();
    }
  });
});
