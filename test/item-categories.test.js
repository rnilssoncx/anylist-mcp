/**
 * Categories: what anylist-js sends to file an item, how AnyListClient finds a
 * category and names the one an item shows under, and what the tool answers.
 * Offline — the HTTP client is replaced by hand.
 *
 * The household's list has its own categories beside AnyList's (Penzy's,
 * Asian Market, Deep Cuts, ...), so the fixed list of 19 the tool used to take
 * reached none of them. Handler ids and the match-id rule are from
 * BookCatKid/aioanylist's port of the web app; the rule agrees with the ids the
 * household's own items carry ("penzys", "asian-market", "deep-cuts").
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
const Item = require('../anylist-js/lib/item.js');

const GROUP = 'g-1';
const CATEGORIES = [
  { identifier: 'c-dairy', name: 'Dairy', systemCategory: 'dairy', sortIndex: 1 },
  { identifier: 'c-cond', name: 'Condiments & Dressings', systemCategory: 'condiments-oils-and-salad-dressings', sortIndex: 0 },
  { identifier: 'c-other', name: 'Other', systemCategory: 'other', sortIndex: 2 },
  { identifier: 'c-penzys', name: 'Penzy’s', systemCategory: null, sortIndex: 3 },
  { identifier: 'c-asian', name: 'Asian Market', systemCategory: null, sortIndex: 4 },
];

test('categoryMatchId is the system id, or the name normalised as AnyList files it', () => {
  assert.equal(Item.categoryMatchId({ name: 'Dairy', systemCategory: 'dairy' }), 'dairy');
  assert.equal(Item.categoryMatchId({ name: 'Penzy’s' }), 'penzys');
  assert.equal(Item.categoryMatchId({ name: "Penzy's" }), 'penzys');
  assert.equal(Item.categoryMatchId({ name: 'Asian Market' }), 'asian-market');
  assert.equal(Item.categoryMatchId({ name: '  Deep  Cuts ' }), 'deep-cuts');
  assert.equal(Item.categoryMatchId({ name: 'Mom & Pop' }), 'mom-and-pop');
  assert.equal(Item.categoryMatchId({ name: 'Café Olé' }), 'cafe-ole');
});

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
  return { any, l, posts };
}

test("assignment ids are AnyList's: uuid5 of the set id", () => {
  // Computed independently with Python's uuid.uuid5 against the namespace the
  // household's own items' ids were checked against.
  assert.equal(Item.assignmentId('abc'), '1dbf254d2458551891eaae2d7e385e15');
  assert.notEqual(Item.assignmentId('abd'), Item.assignmentId('abc'));
});

test('assignCategory sends the assignment, then the match id in originalValue, as partial items', async () => {
  const { l, posts } = list([{
    identifier: 'i-1', listId: 'list-1', name: 'Smoked Paprika', categoryMatchId: 'other',
    categoryAssignments: [
      { identifier: 'a-1', categoryGroupId: GROUP, categoryId: 'c-other' },
      { identifier: 'a-2', categoryGroupId: 'g-store', categoryId: 'c-aisle-9' },
    ],
  }]);
  await l.items[0].assignCategory({ ...CATEGORIES[3], categoryGroupId: GROUP });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'data/shopping-lists/update');
  const [assign, match] = posts[0].ops;
  assert.equal(assign.metadata.handlerId, 'update-list-item-category-assignment');
  assert.equal(assign.listItemId, 'i-1');
  // The group's assignment is replaced, under the id the app gives it — not
  // the random one it had; another group's is kept as it was.
  assert.deepEqual(assign.listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
    [['a-2', 'g-store', 'c-aisle-9'], [Item.assignmentId(GROUP), GROUP, 'c-penzys']]);
  assert.equal(assign.listItem.name, null);

  assert.equal(match.metadata.handlerId, 'set-list-item-category-match-id');
  assert.equal(match.originalValue, 'penzys');
  assert.equal(match.listItem.categoryMatchId, 'penzys');
  assert.equal(match.listItem.category, 'other');
  assert.equal(match.listItem.name, null);
  assert.equal(l.items[0].categoryMatchId, 'penzys');
});

test('a new item created with categoryFields is sent filed in that category', async () => {
  const { any, l, posts } = list([]);
  const item = any.createItem({ name: 'Yogurt', ...Item.categoryFields({ ...CATEGORIES[0], categoryGroupId: GROUP }) });
  await l.addItem(item);
  const sent = posts[0].ops[0].listItem;
  assert.equal(sent.categoryMatchId, 'dairy');
  assert.equal(sent.category, 'dairy');
  assert.deepEqual(sent.categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]), [[GROUP, 'c-dairy']]);
  assert.equal(sent.categoryAssignments[0].identifier, Item.assignmentId(GROUP));
});

// AnyListClient over a hand-made list with one category group.
function connected(items = []) {
  const created = [];
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.client = { createItem: o => { created.push(o); return { ...o, storeIds: [] }; } };
  c.targetList = {
    name: 'Groceries', items, stores: [],
    categoryGroups: [{ identifier: GROUP, categories: CATEGORIES }],
    getItemByName: n => items.find(i => i.name === n),
    addItem: async i => { items.push(i); },
  };
  return { c, created };
}

test('findCategory takes a name or an id, spelled the way people type it', () => {
  const { c } = connected();
  const find = n => c.findCategory(n)?.identifier ?? null;
  assert.equal(find('Condiments & Dressings'), 'c-cond');
  assert.equal(find('condiments-oils-and-salad-dressings'), 'c-cond');
  assert.equal(find("penzy's"), 'c-penzys');
  assert.equal(find('PENZYS'), 'c-penzys');
  assert.equal(find('asian-market'), 'c-asian');
  assert.equal(find('Deli'), null);
  assert.equal(find(''), null);
  assert.equal(c.findCategory('dairy').categoryGroupId, GROUP);
});

test('getCategories lists them in AnyList order', () => {
  const { c } = connected();
  assert.deepEqual(c.getCategories().map(x => x.name), ['Condiments & Dressings', 'Dairy', 'Other', 'Penzy’s', 'Asian Market']);
});

test('an item shows under its assignment first, else the category its id files it in', () => {
  const { c } = connected();
  assert.equal(c.categoryNameOf({ categoryMatchId: 'dairy', categoryAssignments: [{ categoryGroupId: GROUP, categoryId: 'c-penzys' }] }), 'Penzy’s');
  assert.equal(c.categoryNameOf({ categoryMatchId: 'dairy', categoryAssignments: [] }), 'Dairy');
  assert.equal(c.categoryNameOf({ categoryMatchId: 'asian-market' }), 'Asian Market');
  assert.equal(c.categoryNameOf({ categoryMatchId: 'deli' }), 'deli');
});

test('addItem files a new item in the category it names', async () => {
  const { c, created } = connected();
  assert.equal(await c.addItem('Smoked Paprika', 1, null, "penzy's"), 'added');
  assert.equal(created[0].categoryMatchId, 'penzys');
  assert.deepEqual(created[0].categoryAssignments.map(a => a.categoryId), ['c-penzys']);
});

test('addItem with no category leaves filing to AnyList', async () => {
  const { c, created } = connected();
  await c.addItem('Bread');
  assert.equal(created[0].categoryMatchId, undefined);
  assert.equal(created[0].categoryAssignments, undefined);
});

test('addItem refuses a category the list does not have, and adds nothing', async () => {
  const { c, created } = connected();
  await assert.rejects(c.addItem('Pastrami', 1, null, 'Deli'),
    /Category "Deli" not found in list "Groceries"\. Available categories: Condiments & Dressings, Dairy, Other, Penzy’s, Asian Market$/);
  assert.deepEqual(created, []);
});

test("a scanned product is filed in the list's category for the lookup's id, or keeps the id when there is none", async () => {
  const { c, created } = connected();
  await c.addProduct({ name: 'Greek Yogurt', productUpc: '1', categoryMatchId: 'dairy' });
  await c.addProduct({ name: 'Pastrami', productUpc: '2', categoryMatchId: 'deli' });
  assert.deepEqual(created[0].categoryAssignments.map(a => a.categoryId), ['c-dairy']);
  assert.equal(created[1].categoryMatchId, 'deli');
  assert.equal(created[1].categoryAssignments, undefined);
});

test('setItemCategory moves the item and says where from and to', async () => {
  const sent = [];
  const item = { name: 'Sosiski', categoryMatchId: 'dairy', categoryAssignments: [], assignCategory: async cat => { sent.push(cat); } };
  const { c } = connected([item]);
  assert.deepEqual(await c.setItemCategory('Sosiski', 'other'), { from: 'Dairy', to: 'Other' });
  assert.equal(sent[0].identifier, 'c-other');
  assert.equal(sent[0].categoryGroupId, GROUP);
  await assert.rejects(c.setItemCategory('Sosiski', 'Deli'), /^Error: Category "Deli" not found/);
  assert.equal(sent.length, 1);
});

test('getItems names the category each item shows under', async () => {
  const { c } = connected([{ name: 'Paprika', checked: false, storeIds: [], categoryMatchId: 'penzys' }]);
  assert.equal((await c.getItems())[0].category, 'Penzy’s');
});

function tool() {
  const client = new MockAnyListClient();
  client._items.push({ name: 'Meat Bavarian Sausages Sosiski, +/-lb', category: 'Dairy' });
  const { server, handlers } = createMockServer();
  register(server, () => Promise.resolve(client));
  return { client, handlers };
}

test('set_item_category says where it moved the item from and to', async () => {
  const { client, handlers } = tool();
  const result = await handlers.shopping({ action: 'set_item_category', name: 'sosiski', category: 'other' });
  assert.equal(result.content[0].text, 'Moved "Meat Bavarian Sausages Sosiski, +/-lb" from "Dairy" to "Other"');
  assert.equal(client._items[0].category, 'Other');
});

test('set_item_category refuses a category the list does not have, naming the ones it does', async () => {
  const { client, handlers } = tool();
  const result = await handlers.shopping({ action: 'set_item_category', name: 'sosiski', category: 'Deli' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Category "Deli" not found in list "Test List". Available categories: Produce, Dairy, Other, Penzy’s');
  assert.equal(client._items[0].category, 'Dairy');
});

test('list_categories lists them', async () => {
  const { handlers } = tool();
  const result = await handlers.shopping({ action: 'list_categories' });
  assert.equal(result.content[0].text, 'Categories for "Test List" (4):\n- Produce\n- Dairy\n- Other\n- Penzy’s');
});
