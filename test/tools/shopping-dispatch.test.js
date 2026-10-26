/**
 * Every shopping action answers, through a real MCP session.
 *
 * The handler tests in shopping.test.js call the handler directly, so a case
 * that falls off the switch returns undefined there and fails only if a test
 * happens to name that action. Over a real session the same miss hangs the
 * caller, which is what reached a live conversation: set_item_store was still
 * in the schema after its case was removed. So the actions are read from the
 * schema the client sees, not from a list kept here.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { register } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

const HANG = Symbol('hang');

async function session(client) {
  const server = new McpServer({ name: 'test', version: '0' });
  register(server, () => Promise.resolve(client));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  return mcp;
}

function within(ms, promise) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(HANG), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('shopping dispatch', () => {
  it('answers every action in the schema', async () => {
    const mcp = await session(new MockAnyListClient());
    const { tools } = await mcp.listTools();
    const actions = tools.find(t => t.name === 'shopping').inputSchema.properties.action.enum;
    assert.ok(actions.includes('set_item_store'), 'the schema this test reads has changed shape');

    const hung = [];
    for (const action of actions) {
      // Arguments are deliberately thin: an error is an answer, silence is not.
      const result = await within(2000, mcp.callTool({ name: 'shopping', arguments: { action, name: 'x', upc: '0074338007611', items: ['x'] } }));
      if (result === HANG) hung.push(action);
    }
    assert.deepEqual(hung, []);
    await mcp.close();
  });

  it('answers an action nothing handles with an error', async () => {
    // Bypasses the schema, which is the only way to reach the default case.
    const { server, handlers } = createMockServer();
    register(server, () => Promise.resolve(new MockAnyListClient()));
    const result = await handlers.shopping({ action: 'bogus' });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Unknown shopping action "bogus"');
  });
});

describe('set_item_store', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    client._stores = [{ name: 'H.E.B.' }, { name: 'Trader Joe’s' }];
    client._items.push({ name: 'Pearl River Bridge Superior Dark Soy Sauce' });
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  it('assigns a store, resolving a partial item name', async () => {
    const result = await handlers.shopping({ action: 'set_item_store', name: 'dark soy', store_name: 'H.E.B.' });
    assert.equal(result.content[0].text, 'Assigned "Pearl River Bridge Superior Dark Soy Sauce" to store "H.E.B."');
    assert.equal(client._items[0].store, 'H.E.B.');
  });

  it('clears the store when none is given', async () => {
    client._items[0].store = 'H.E.B.';
    const result = await handlers.shopping({ action: 'set_item_store', name: 'Pearl River Bridge Superior Dark Soy Sauce' });
    assert.equal(result.content[0].text, 'Cleared the store for "Pearl River Bridge Superior Dark Soy Sauce"');
    assert.equal(client._items[0].store, null);
  });

  it('refuses a store the list does not have, and changes nothing', async () => {
    const result = await handlers.shopping({ action: 'set_item_store', name: 'dark soy', store_name: 'Costco' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.startsWith('Store "Costco" not found in list'));
    assert.equal(client._items[0].store, undefined);
  });

  it('accepts a store name typed with a straight apostrophe and any case', async () => {
    const result = await handlers.shopping({ action: 'set_item_store', name: 'dark soy', store_name: "trader joe's" });
    assert.equal(result.isError, undefined);
  });
});
