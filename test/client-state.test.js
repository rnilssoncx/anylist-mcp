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
  await assert.rejects(c.addItem('Milk', 2), /Failed to add item "Milk": save refused/);
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

test('setItemStore matches a store name regardless of case and apostrophe', async () => {
  let set = null;
  const item = { name: 'Dumplings', storeIds: [], setStores: async ids => { set = ids; } };
  const c = connected(library(() => [{
    name: 'Groceries', items: [item],
    stores: [{ name: 'Trader Joe’s', identifier: 'tj' }, { name: 'H.E.B.', identifier: 'heb' }],
  }]));
  await c.connect('Groceries');
  assert.equal(await c.setItemStore('Dumplings', "trader joe's"), 'Trader Joe’s');
  assert.deepEqual(set, ['tj']);
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
