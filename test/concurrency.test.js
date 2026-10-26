/**
 * Parallel tool calls for one user, through the server the HTTP endpoint builds.
 *
 * Claude sends tool calls in parallel and every session for a user shares that
 * user's one AnyListClient, which keeps the list it is working on as instance
 * state. Unqueued, "eggs and butter to Groceries, dog food to Costco" put the
 * butter on Costco. The library below answers every request after a short
 * delay, which is what lets the calls interleave.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'anylist-concurrency-'));
process.env.SERVER_SECRET_KEY = randomBytes(32).toString('hex');

const io = () => new Promise(r => setTimeout(r, 10));

function library(writes) {
  const lib = {
    lists: [],
    async getLists() {
      await io();
      lib.lists = [
        { name: 'Groceries', identifier: 'g', stores: [], items: [] },
        { name: 'Costco', identifier: 'c', stores: [], items: [] },
      ].map(l => ({
        ...l,
        getItemByName: n => l.items.find(i => i.name === n),
        addItem: async item => { await io(); writes.push(`${l.name} += ${item.name}`); l.items.push(item); },
      }));
      return lib.lists;
    },
    getListByName: n => lib.lists.find(l => l.name === n),
    createItem: o => ({ ...o, checked: false, storeIds: [] }),
    teardown() {},
  };
  return lib;
}

describe('parallel tool calls', () => {
  let createMcpServer, getOrCreateSession, evictSession;

  before(async () => {
    const db = await import('../src/http/db.js');
    ({ createMcpServer } = await import('../src/http/mcp-server.js'));
    ({ getOrCreateSession, evictSession } = await import('../src/http/session-manager.js'));
    db.createUser({ id: 'u1', email: 'house@example.com' });
    db.upsertAnyListCredentials('u1', { username: 'list@example.com', password: 'pw', defaultListName: 'Groceries' });
  });

  it('each write lands on the list its own call named, and each reply names it', async () => {
    const writes = [];
    (await getOrCreateSession('u1')).client = library(writes); // already logged in

    const server = createMcpServer('u1');
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(clientSide);

    try {
      const call = args => mcp.callTool({ name: 'shopping', arguments: args });
      const [groceries, costco] = await Promise.all([
        call({ action: 'add_items', list_name: 'Groceries', items: [{ name: 'Eggs', exact: true }, { name: 'Butter', exact: true }] }),
        call({ action: 'add_item', list_name: 'Costco', name: 'Dog food', exact: true }),
      ]);

      assert.deepEqual(writes.sort(), ['Costco += Dog food', 'Groceries += Butter', 'Groceries += Eggs']);
      assert.ok(groceries.content[0].text.startsWith('Added 2 of 2 items to list "Groceries"'));
      assert.equal(costco.content[0].text, 'Successfully added "Dog food" to list "Costco"');
    } finally {
      await mcp.close();
      evictSession('u1'); // its idle timer would otherwise hold the test process open
    }
  });
});
