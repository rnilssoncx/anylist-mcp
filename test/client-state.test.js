/**
 * AnyListClient against a hand-made library object: what it reads, and what a
 * failed write does. Offline — nothing reaches AnyList.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient, { storeNameKey } from '../src/anylist-client.js';

// A stand-in for the anylist-js client. `serve` is what AnyList holds now;
// getLists() replaces `lists` with fresh objects, as the library does.
function library(serve) {
  const lib = {
    lists: [],
    fetches: 0,
    async getLists() {
      lib.fetches++;
      lib.lists = serve().map(l => ({ ...l, getItemByName: n => l.items.find(i => i.name === n) }));
      return lib.lists;
    },
    getListByName: name => lib.lists.find(l => l.name === name),
  };
  return lib;
}

function connected(lib) {
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.client = lib; // already logged in
  return c;
}

test('connect reads the list again on every call, so a change made elsewhere is seen', async () => {
  let items = [{ name: 'Milk', checked: false, storeIds: [] }];
  const c = connected(library(() => [{ name: 'Groceries', items, stores: [] }]));

  await c.connect('Groceries');
  assert.deepEqual(c.targetList.items.map(i => i.name), ['Milk']);

  items = [...items, { name: 'Eggs', checked: false, storeIds: [] }]; // added from a phone
  await c.connect('Groceries');
  assert.deepEqual(c.targetList.items.map(i => i.name), ['Milk', 'Eggs']);
});

function oneItem(item) {
  return connected(library(() => [{ name: 'Groceries', items: [item], stores: [] }]));
}

const failingSave = () => Promise.reject(new Error('save refused'));

test('re-adding a checked-off item fails when its save fails', async () => {
  const c = oneItem({ name: 'Milk', checked: true, save: failingSave });
  await c.connect('Groceries');
  await assert.rejects(c.addItem('Milk'), /Failed to add item "Milk": save refused/);
});

test('re-adding an item already on the list fails when its save fails', async () => {
  const c = oneItem({ name: 'Milk', checked: false, save: failingSave });
  await c.connect('Groceries');
  await assert.rejects(c.addItem('Milk', 1, 'organic'), /Failed to add item "Milk": save refused/);
});

test('re-adding an item already on the list fails when its quantity write fails', async () => {
  const c = oneItem({ name: 'Milk', checked: false, setQuantity: failingSave });
  await c.connect('Groceries');
  await assert.rejects(c.addItem('Milk', 2), /Failed to add item "Milk": save refused/);
});

test('re-adding an item sends its quantity through setQuantity, and leaves it alone for the default', async () => {
  const quantities = [];
  const item = { name: 'Milk', checked: true, save: async () => {}, setQuantity: async q => { quantities.push(q); } };
  const c = oneItem(item);
  await c.connect('Groceries');
  await c.addItem('Milk', '2 gallons');
  await c.addItem('Milk', 1);
  assert.deepEqual(quantities, ['2 gallons']);
  // The legacy field is what never reached the apps; nothing may write it.
  assert.equal(c.targetList.items[0].quantity, undefined);
});

test('addItem says what happened, and writes nothing for a plain re-add of a listed item', async () => {
  let saves = 0;
  const save = async () => { saves++; };
  const c = connected(library(() => [{ name: 'Groceries', stores: [], items: [
    { name: 'Milk', checked: false, save }, { name: 'Eggs', checked: true, save },
  ] }]));
  c.client.createItem = o => o;
  await c.connect('Groceries');
  c.targetList.addItem = async () => {};
  assert.equal(await c.addItem('Milk'), 'already');
  assert.equal(saves, 0);
  assert.equal(await c.addItem('Eggs'), 'rechecked');
  assert.equal(saves, 1);
  assert.equal(await c.addItem('Butter'), 'added');
});

test('connect logs in without the websocket', async () => {
  const seen = [];
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c._createLibraryClient = () => {
    const lib = library(() => [{ name: 'Groceries', items: [], stores: [] }]);
    lib.login = async (...args) => { seen.push(args); };
    return lib;
  };
  await c.connect('Groceries');
  assert.deepEqual(seen, [[false]]);
});

function storesFixture(storeIds) {
  const set = [];
  const item = { name: 'Chips', storeIds, setStores: async ids => { set.push(ids); } };
  const c = connected(library(() => [{
    name: 'Groceries', items: [item],
    stores: [{ name: 'Trader Joe’s', identifier: 'tj' }, { name: 'H.E.B.', identifier: 'heb' }, { name: 'Kroger', identifier: 'kr' }],
  }]));
  return { c, set };
}

test('setItemStores matches a store name regardless of case and apostrophe', async () => {
  const { c, set } = storesFixture([]);
  await c.connect('Groceries');
  assert.deepEqual(await c.setItemStores('Chips', ["trader joe's"]), { stores: ['Trader Joe’s'], removed: [] });
  assert.deepEqual(set, [['tj']]);
});

test('setItemStores replaces the stores and names the ones it removed', async () => {
  const { c, set } = storesFixture(['heb', 'kr']);
  await c.connect('Groceries');
  assert.deepEqual(await c.setItemStores('Chips', ['Kroger', 'Trader Joe’s']), { stores: ['Kroger', 'Trader Joe’s'], removed: ['H.E.B.'] });
  assert.deepEqual(set, [['kr', 'tj']]);
});

test('setItemStores with add keeps the stores an item already has', async () => {
  const { c, set } = storesFixture(['heb', 'kr']);
  await c.connect('Groceries');
  assert.deepEqual(await c.setItemStores('Chips', ['Trader Joe’s'], { add: true }), { stores: ['H.E.B.', 'Kroger', 'Trader Joe’s'], removed: [] });
  assert.deepEqual(set, [['heb', 'kr', 'tj']]);
});

test('re-adding an item with a store adds it to the stores the item has', async () => {
  const { c, set } = storesFixture(['heb', 'kr']);
  await c.connect('Groceries');
  c.targetList.items[0].checked = true;
  c.targetList.items[0].save = async () => {};
  await c.addItem('Chips', 1, null, 'other', 'Trader Joe’s');
  assert.deepEqual(set, [['heb', 'kr', 'tj']]);
});

test('getItems shows every store an item is at', async () => {
  const { c } = storesFixture(['heb', 'kr']);
  await c.connect('Groceries');
  assert.equal((await c.getItems(true))[0].store, 'H.E.B., Kroger');
});

test('removeItem says whether it checked anything off, and saves only when it did', async () => {
  let saves = 0;
  const save = async () => { saves++; };
  const c = connected(library(() => [{ name: 'Groceries', stores: [], items: [
    { name: 'Milk', checked: false, save }, { name: 'Eggs', checked: true, save },
  ] }]));
  await c.connect('Groceries');
  assert.equal(await c.removeItem('Milk'), true);
  assert.equal(await c.removeItem('Eggs'), false);
  assert.equal(saves, 1);
});

test('storeNameKey folds case, surrounding space and curly apostrophes, and nothing else', () => {
  assert.equal(storeNameKey(' Trader Joe’s '), "trader joe's");
  assert.notEqual(storeNameKey('H.E.B.'), storeNameKey('HEB'));
});
