/**
 * Changing an item already on the list: what anylist-js sends for a quantity,
 * what AnyListClient.updateItem refuses and writes, and what update_item
 * answers. Offline — the HTTP client is replaced by hand.
 *
 * The quantity is the part with history. `set-list-item-quantity` (the
 * library's setter and save()) writes only the legacy field, and the apps
 * render `quantityPb`, so a quantity change on an existing item never showed —
 * the 2026-10-25 audit made add_item say so rather than fix it.
 * `set-list-item-quantity-v2` is what AnyList's web app sends (per
 * BookCatKid/aioanylist); checked live on 2026-10-26.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient from '../src/anylist-client.js';
import { register } from '../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './tools/helpers.js';

const require = createRequire(import.meta.url);
const AnyList = require('../anylist-js/lib/index.js');
const List = require('../anylist-js/lib/list.js');

function list(items) {
  const any = new AnyList({ email: 'test@example.com', password: 'unused', credentialsFile: '/nonexistent' });
  const posts = [];
  const client = {
    post: async (url, { body }) => {
      const buffer = body._streams.find(s => Buffer.isBuffer(s));
      posts.push({ url, ops: any.protobuf.PBListOperationList.decode(buffer).operations });
    },
  };
  const l = new List({ identifier: 'list-1', listId: 'parent', name: 'Groceries', items },
    { client, protobuf: any.protobuf, uid: 'user-1', stores: [] });
  return { l, posts };
}

test('setQuantity sends set-list-item-quantity-v2 carrying the quantity the apps render', async () => {
  const { l, posts } = list([{ identifier: 'i-1', listId: 'list-1', name: 'Milk', quantityPb: { rawQuantity: '1' } }]);
  await l.items[0].setQuantity('2 gallons');

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'data/shopping-lists/update');
  const [op] = posts[0].ops;
  assert.equal(op.metadata.handlerId, 'set-list-item-quantity-v2');
  assert.equal(op.listId, 'list-1');
  assert.equal(op.listItemId, 'i-1');
  assert.equal(op.listItem.identifier, 'i-1');
  assert.equal(op.listItem.quantityPb.rawQuantity, '2 gallons');
  assert.equal(op.listItem.quantityPb.amount, '2');
  assert.equal(op.listItem.quantityPb.unit, 'gallons');
  assert.equal(op.listItem.deprecatedQuantity, '2 gallons');
  // A partial item: nothing else rides along to overwrite what the apps hold.
  assert.equal(op.listItem.name, null);
  assert.equal(l.items[0].quantity, '2 gallons');
});

test('setQuantity leaves nothing queued for a later save()', async () => {
  const { l, posts } = list([{ identifier: 'i-1', listId: 'list-1', name: 'Milk' }]);
  const item = l.items[0];
  await item.setQuantity(3);
  item.details = 'organic';
  await item.save();
  assert.deepEqual(posts[1].ops.map(o => o.metadata.handlerId), ['set-list-item-details']);
});

test('setQuantity refuses a blank quantity and sends nothing', async () => {
  const { l, posts } = list([{ identifier: 'i-1', listId: 'list-1', name: 'Milk' }]);
  await assert.rejects(l.items[0].setQuantity(' '), /^Error: Quantity is required\.$/);
  assert.equal(posts.length, 0);
});

// AnyListClient over plain items: name/details assignments and the calls made.
function connected(items) {
  const calls = [];
  for (const i of items) {
    i.save = async () => { calls.push(['save', i.name, i.details]); };
    i.setQuantity = async q => { calls.push(['quantity', i.name, q]); };
  }
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.targetList = { name: 'Groceries', items, getItemByName: n => items.find(i => i.name === n) };
  return { c, calls };
}

test('updateItem renames, sets notes and quantity, and touches nothing it was not given', async () => {
  const { c, calls } = connected([{ name: 'Eggs', details: 'brown' }]);
  assert.equal((await c.updateItem('Eggs', { newName: '  Eggs, large ', quantity: '2 dozen' })).name, 'Eggs, large');
  assert.deepEqual(calls, [['save', 'Eggs, large', 'brown'], ['quantity', 'Eggs, large', '2 dozen']]);
});

test('updateItem clears notes when given an empty string', async () => {
  const { c, calls } = connected([{ name: 'Eggs', details: 'brown' }]);
  await c.updateItem('Eggs', { notes: '' });
  assert.deepEqual(calls, [['save', 'Eggs', '']]);
});

test('updateItem with only a quantity does not save the other fields', async () => {
  const { c, calls } = connected([{ name: 'Eggs' }]);
  await c.updateItem('Eggs', { quantity: 2 });
  assert.deepEqual(calls, [['quantity', 'Eggs', 2]]);
});

test('updateItem refuses a name another item has, even a checked-off one, and writes nothing', async () => {
  const { c, calls } = connected([{ name: 'Eggs' }, { name: 'Brown Eggs', checked: true }]);
  await assert.rejects(c.updateItem('Eggs', { newName: 'Brown Eggs', quantity: 2 }),
    /^Error: An item named "Brown Eggs" is already on the list \(checked off\)$/);
  assert.deepEqual(calls, []);
  assert.equal(c.targetList.items[0].name, 'Eggs');
});

function tool() {
  const client = new MockAnyListClient();
  client._items.push({ name: 'Pearl River Bridge Superior Dark Soy Sauce', notes: 'the big bottle' });
  const { server, handlers } = createMockServer();
  register(server, () => Promise.resolve(client));
  return { client, handlers };
}

test('update_item says what it changed, resolving a partial name', async () => {
  const { client, handlers } = tool();
  const result = await handlers.shopping({ action: 'update_item', name: 'dark soy', new_name: 'Dark Soy Sauce', quantity: 2, notes: '' });
  assert.equal(result.content[0].text, 'Updated "Pearl River Bridge Superior Dark Soy Sauce": renamed to "Dark Soy Sauce", quantity 2, notes cleared');
  assert.deepEqual(client._items[0], { name: 'Dark Soy Sauce', notes: '', quantity: 2 });
});

test('update_item with nothing to change says so and writes nothing', async () => {
  const { client, handlers } = tool();
  const result = await handlers.shopping({ action: 'update_item', name: 'dark soy' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Nothing to change: give new_name, quantity or notes');
  assert.equal(client._items[0].name, 'Pearl River Bridge Superior Dark Soy Sauce');
});
