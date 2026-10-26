/**
 * Store management, at three layers: what anylist-js puts on the wire, what
 * AnyListClient refuses before anything is sent, and what the shopping tool
 * answers. Offline — the HTTP client is replaced by hand.
 *
 * The handler ids and endpoints are not documented by AnyList. They come from
 * two independent reverse-engineered clients that agree (phildenhoff/anylist_rs
 * and BookCatKid/aioanylist, the latter live-verified), so these tests pin
 * them: a wrong id is accepted by the server and silently does nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import AnyListClient from '../src/anylist-client.js';
import { register } from '../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './tools/helpers.js';

const require = createRequire(import.meta.url);
const AnyList = require('../anylist-js/lib/index.js');
const List = require('../anylist-js/lib/list.js');

// A List on a recording HTTP client. Each post is kept as its endpoint and the
// operations decoded from the form body, in the order they were sent.
function list({ stores = [], items = [] } = {}) {
  const any = new AnyList({ email: 'test@example.com', password: 'unused', credentialsFile: '/nonexistent' });
  const posts = [];
  const client = {
    post: async (url, { body }) => {
      const buffer = body._streams.find(s => Buffer.isBuffer(s));
      posts.push({ url, ops: any.protobuf.PBListOperationList.decode(buffer).operations });
    },
  };
  const l = new List({ identifier: 'list-1', listId: 'parent', name: 'Groceries', items },
    { client, protobuf: any.protobuf, uid: 'user-1', stores });
  return { l, posts };
}

const STORES = () => [
  { identifier: 's-heb', listId: 'list-1', name: 'H.E.B.', sortIndex: 0 },
  { identifier: 's-tj', listId: 'list-1', name: 'Trader Joe’s', sortIndex: 3 },
];

test('createStore sends new-store to the v2 endpoint, placed after the last store', async () => {
  const { l, posts } = list({ stores: STORES() });
  const store = await l.createStore('  Costco ');

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'data/shopping-lists/update-v2');
  const [op] = posts[0].ops;
  assert.equal(op.metadata.handlerId, 'new-store');
  assert.equal(op.metadata.operationClass, 1);
  assert.equal(op.listId, 'list-1');
  assert.equal(op.updatedStore.name, 'Costco');
  assert.equal(op.updatedStore.listId, 'list-1');
  assert.equal(op.updatedStore.identifier, store.identifier);
  // max + 1, not the count: the fixture's indexes have a gap.
  assert.equal(op.updatedStore.sortIndex, 4);
  assert.deepEqual(l.stores.map(s => s.name), ['H.E.B.', 'Trader Joe’s', 'Costco']);
});

test('createStore refuses a blank name and sends nothing', async () => {
  const { l, posts } = list();
  await assert.rejects(l.createStore('  '), /^Error: Store name is required\.$/);
  assert.equal(posts.length, 0);
});

test('renameStore sends set-store-name with the same id and place', async () => {
  const { l, posts } = list({ stores: STORES() });
  await l.renameStore('s-tj', 'TJ’s');

  assert.equal(posts[0].url, 'data/shopping-lists/update-v2');
  const [op] = posts[0].ops;
  assert.equal(op.metadata.handlerId, 'set-store-name');
  assert.equal(op.metadata.operationClass, 1);
  assert.equal(op.updatedStore.identifier, 's-tj');
  assert.equal(op.updatedStore.name, 'TJ’s');
  assert.equal(op.updatedStore.sortIndex, 3);
  assert.equal(l.stores[1].name, 'TJ’s');
});

test('deleteStore unassigns its items first, then deletes the store', async () => {
  const { l, posts } = list({ stores: STORES(), items: [
    { identifier: 'i-1', name: 'Milk', storeIds: ['s-heb'] },
    { identifier: 'i-2', name: 'Eggs', storeIds: ['s-heb', 's-tj'] },
    { identifier: 'i-3', name: 'Rice', storeIds: ['s-tj'] },
  ] });
  await l.deleteStore('s-heb');

  assert.deepEqual(posts.map(p => [p.url, p.ops[0].metadata.handlerId]), [
    ['data/shopping-lists/update', 'remove-store-id-from-all-items'],
    ['data/shopping-lists/update-v2', 'delete-store'],
  ]);
  assert.equal(posts[0].ops[0].listId, 'list-1');
  assert.equal(posts[0].ops[0].updatedValue, 's-heb');
  assert.equal(posts[1].ops[0].metadata.operationClass, 1);
  assert.equal(posts[1].ops[0].updatedStore.identifier, 's-heb');
  // Only the deleted store's id leaves an item; Eggs keeps Trader Joe's.
  assert.deepEqual(l.items.map(i => i.storeIds), [[], ['s-tj'], ['s-tj']]);
  assert.deepEqual(l.stores.map(s => s.identifier), ['s-tj']);
});

// AnyListClient over a hand-made list: its refusals happen before the library
// is reached, so the library methods here only record.
function connected(stores, items = []) {
  const calls = [];
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.targetList = {
    name: 'Groceries', stores, items,
    createStore: async name => { calls.push(['create', name]); return { name }; },
    renameStore: async (id, name) => { calls.push(['rename', id, name]); stores.find(s => s.identifier === id).name = name; },
    deleteStore: async id => { calls.push(['delete', id]); },
  };
  return { c, calls };
}

test('createStore refuses a store that already exists under another spelling', async () => {
  const { c, calls } = connected(STORES());
  await assert.rejects(c.createStore('h.e.b.'), /^Error: Store "H\.E\.B\." already exists$/);
  await assert.rejects(c.createStore("trader joe's"), /^Error: Store "Trader Joe’s" already exists$/);
  assert.deepEqual(calls, []);
});

test('renameStore finds the store the way set_item_store does, and refuses a clash', async () => {
  const { c, calls } = connected(STORES());
  assert.deepEqual(await c.renameStore("trader joe's", 'TJ’s'), { oldName: 'Trader Joe’s', newName: 'TJ’s' });
  assert.deepEqual(calls, [['rename', 's-tj', 'TJ’s']]);

  await assert.rejects(c.renameStore('TJ’s', 'h.e.b.'), /^Error: Store "H\.E\.B\." already exists$/);
  // Changing only a store's own spelling is not a clash with itself.
  await c.renameStore('H.E.B.', 'h.e.b.');
  assert.deepEqual(calls.at(-1), ['rename', 's-heb', 'h.e.b.']);
});

test('renameStore and deleteStore name the stores there are when one is missing', async () => {
  const { c, calls } = connected(STORES());
  await assert.rejects(c.renameStore('Costco', 'x'), /^Error: Store "Costco" not found\. Available stores: H\.E\.B\., Trader Joe’s$/);
  await assert.rejects(c.deleteStore('Costco'), /^Error: Store "Costco" not found\. Available stores: H\.E\.B\., Trader Joe’s$/);
  assert.deepEqual(calls, []);
});

test('deleteStore reports which items lose the store: active by name, saved as a count', async () => {
  const { c, calls } = connected(STORES(), [
    { name: 'Milk', checked: false, storeIds: ['s-heb'] },
    { name: 'Rice', checked: false, storeIds: ['s-tj'] },
    { name: 'Eggs', checked: true, storeIds: ['s-heb'] },
    { name: 'Salt', checked: true, storeIds: ['s-heb'] },
  ]);
  assert.deepEqual(await c.deleteStore('h.e.b.'), { name: 'H.E.B.', activeItems: ['Milk'], savedCount: 2 });
  assert.deepEqual(calls, [['delete', 's-heb']]);
});

test('the shopping tool reports each store change', async () => {
  const client = new MockAnyListClient();
  client._stores = [{ identifier: 's-heb', name: 'H.E.B.' }];
  const { server, handlers } = createMockServer();
  register(server, () => Promise.resolve(client));

  assert.equal((await handlers.shopping({ action: 'create_store', store_name: 'Costco' })).content[0].text,
    'Created store "Costco" on "Test List"');
  assert.equal((await handlers.shopping({ action: 'rename_store', store_name: 'costco', new_store_name: 'Costco Wholesale' })).content[0].text,
    'Renamed store "Costco" to "Costco Wholesale"');

  client._deleteReport = { activeItems: ['Milk', 'Eggs'], savedCount: 1 };
  assert.equal((await handlers.shopping({ action: 'delete_store', store_name: 'h.e.b.' })).content[0].text,
    'Deleted store "H.E.B." from "Test List"\nNow without a store: Milk, Eggs\n1 saved item also lost the store');
  client._deleteReport = {};
  assert.equal((await handlers.shopping({ action: 'delete_store', store_name: 'Costco Wholesale' })).content[0].text,
    'Deleted store "Costco Wholesale" from "Test List"');
});

test('a store change reaches the tool description the client reads', async () => {
  const client = new MockAnyListClient();
  const server = new McpServer({ name: 'test', version: '0' });
  register(server, () => Promise.resolve(client));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  const description = async () => (await mcp.listTools()).tools.find(t => t.name === 'shopping').description;

  await mcp.callTool({ name: 'shopping', arguments: { action: 'create_store', store_name: 'Costco' } });
  assert.match(await description(), /Available stores: Costco$/);
  await mcp.callTool({ name: 'shopping', arguments: { action: 'rename_store', store_name: 'Costco', new_store_name: 'Sam’s' } });
  assert.match(await description(), /Available stores: Sam’s$/);
  await mcp.close();
});
