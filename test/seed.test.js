import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';

// db.js reads DATA_DIR when it is imported, so the environment is set first and
// the modules are imported afterwards.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'anylist-seed-'));
process.env.SERVER_SECRET_KEY = randomBytes(32).toString('hex');

let seed, db, loginWithPassword;

const SECRET = 'a'.repeat(40);
const base = () => ({
  SEED_EMAIL: 'House@Example.com',
  SEED_CLIENT_ID: 'client-1',
  SEED_CLIENT_SECRET: SECRET,
  ANYLIST_USERNAME: 'list@example.com',
  ANYLIST_PASSWORD: 'first-password',
  ANYLIST_LIST_NAME: 'Groceries',
});

describe('seed', () => {
  before(async () => {
    ({ seed } = await import('../scripts/seed.js'));
    db = await import('../src/http/db.js');
    ({ loginWithPassword } = await import('../src/http/auth/providers/password.js'));
  });

  beforeEach(() => {
    db.getDb().exec('DELETE FROM oauth_clients; DELETE FROM anylist_credentials; DELETE FROM users;');
  });

  const clients = () => db.getDb().prepare('SELECT * FROM oauth_clients').all();
  const users = () => db.getDb().prepare('SELECT * FROM users').all();

  it('creates the user, the AnyList login and a client whose secret verifies', async () => {
    const { userId } = await seed(base());
    assert.equal(users().length, 1);
    assert.deepEqual(db.getAnyListCredentials(userId),
      { username: 'list@example.com', password: 'first-password', defaultListName: 'Groceries' });
    const [client] = clients();
    assert.equal(client.client_id, 'client-1');
    assert.equal(client.user_id, userId);
    assert.ok(await bcrypt.compare(SECRET, client.client_secret_hash));
  });

  it('gives the user no password, so the web login refuses it', async () => {
    await seed(base());
    assert.equal(users()[0].pw_hash, null);
    await assert.rejects(loginWithPassword('house@example.com', ''), /Invalid email or password\./);
  });

  it('is a no-op the second time: one user, one client, same hash', async () => {
    await seed(base());
    const hash = clients()[0].client_secret_hash;
    await seed(base());
    assert.equal(users().length, 1);
    assert.equal(clients().length, 1);
    assert.equal(clients()[0].client_secret_hash, hash);
  });

  it('applies a rotated client secret to an existing client', async () => {
    await seed(base());
    const rotated = 'b'.repeat(40);
    await seed({ ...base(), SEED_CLIENT_SECRET: rotated });
    const [client] = clients();
    assert.ok(await bcrypt.compare(rotated, client.client_secret_hash));
    assert.equal(await bcrypt.compare(SECRET, client.client_secret_hash), false);
  });

  it('applies a changed AnyList password', async () => {
    const { userId } = await seed(base());
    await seed({ ...base(), ANYLIST_PASSWORD: 'second-password' });
    assert.equal(db.getAnyListCredentials(userId).password, 'second-password');
  });

  it('refuses when a variable is missing, naming it', async () => {
    const env = base();
    delete env.ANYLIST_PASSWORD;
    await assert.rejects(seed(env), /^Error: seed: missing ANYLIST_PASSWORD$/);
    assert.equal(users().length, 0);
  });

  it('refuses a short client secret', async () => {
    await assert.rejects(seed({ ...base(), SEED_CLIENT_SECRET: 'short' }),
      /seed: SEED_CLIENT_SECRET must be at least 32 characters/);
    assert.equal(clients().length, 0);
  });

  it('refuses a client id that belongs to another user', async () => {
    await seed(base());
    await assert.rejects(seed({ ...base(), SEED_EMAIL: 'other@example.com' }),
      /seed: SEED_CLIENT_ID is already registered to a different user/);
    // Refused before writing: no second user, and the first user's login untouched.
    assert.equal(users().length, 1);
    assert.equal(db.getUserByEmail('other@example.com'), undefined);
  });
});
