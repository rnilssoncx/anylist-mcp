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

  it("reports the store in AnyList's spelling, not the caller's", async () => {
    const result = await handlers.shopping({ action: 'set_item_store', name: 'dark soy', store_name: 'h.e.b.' });
    assert.equal(result.content[0].text, 'Assigned "Pearl River Bridge Superior Dark Soy Sauce" to store "H.E.B."');
  });
});

describe('check_item', () => {
  it('does not claim to check off an item that already was', async () => {
    const client = new MockAnyListClient();
    client._items.push({ name: 'Milk', checked: true });
    const { server, handlers } = createMockServer();
    register(server, () => Promise.resolve(client));
    const result = await handlers.shopping({ action: 'check_item', name: 'Milk' });
    assert.equal(result.content[0].text, '"Milk" was already checked off on list "Test List"');
  });
});

describe('what add reports', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  it('says an item was already on the list, and that a quantity did not reach it', async () => {
    client._addOutcome = 'already';
    const result = await handlers.shopping({ action: 'add_item', name: 'Milk', quantity: 2, exact: true });
    assert.equal(result.content[0].text, '"Milk" is already on list "Test List". Its quantity was not changed: this server can set a quantity only on an item it creates. To change it, delete the item and add it again with the quantity.');
  });

  it('says a checked-off item is back on the list, with no quantity caveat when none was given', async () => {
    client._addOutcome = 'rechecked';
    const result = await handlers.shopping({ action: 'add_item', name: 'Milk', exact: true });
    assert.equal(result.content[0].text, 'Successfully added "Milk" to list "Test List" (it was checked off; it is back on the list).');
  });

  it('marks each add_items entry that was already there or lost its quantity', async () => {
    client._addOutcome = 'already';
    const result = await handlers.shopping({ action: 'add_items', items: [{ name: 'Milk', quantity: 3, exact: true }] });
    assert.ok(result.content[0].text.includes('✓ Milk (already on the list) — quantity not changed; delete and re-add to change it'));
  });

  it('re-uses a typed item of the same name rather than adding the scanned product beside it', async () => {
    client._items.push({ name: 'Sabrett Cocktail Beef Franks' });
    client._products = { '0074338007611': { name: 'Sabrett Cocktail Beef Franks', productUpc: '0074338007611', photoIds: ['p2'] } };
    client._addOutcome = 'already';
    const result = await handlers.shopping({ action: 'add_by_upc', upc: '0074338007611' });
    assert.equal(client._items.filter(i => i.productUpc).length, 0, 'the product was created beside the typed item');
    assert.ok(result.content[0].text.endsWith('(barcode 0074338007611 is that product; the item already on the list was used)'));
  });
});
