/**
 * Recent Items and barcodes: renaming and removing Recents entries, carrying
 * an item's rules and Recents entry through a rename, and making a typed item
 * the product a barcode names. Offline — the HTTP client is replaced by hand.
 *
 * Each of these was first done on 2026-10-26 by a script run inside the
 * server's container (moneypenny plans/010): twelve items made products, 22
 * renames, then two passes over Recents, the second because the first missed
 * the case-only renames' old names. These tools are those scripts, so the
 * household's next cleanup goes through the server.
 *
 * Recents is a starter list of its own, with its own id; the fixture's
 * entries carry `starter-1`, never the shopping list's `list-1`, so an op sent
 * with the wrong one cannot pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient, {
  notInRecents, severalRecents, recentRepeated, recentClash, itemHasBarcode, partlyRemoved, twoItemsNamed, alreadyProduct,
} from '../src/anylist-client.js';
import { register } from '../src/tools/shopping.js';
import { createMockServer } from './tools/helpers.js';

const require = createRequire(import.meta.url);
const AnyList = require('../anylist-js/lib/index.js');
const List = require('../anylist-js/lib/list.js');
const Item = require('../anylist-js/lib/item.js');

// The main set's id is AnyList's uuid5 of the list id (Python's uuid.uuid5).
const GROUP = 'b907355ef26d5331849d1d5fe1f23a61';
const STARTER = 'starter-1';
const MAIN = { identifier: GROUP, name: 'Main', categories: [
  { identifier: 'c-cond', name: 'Condiments & Dressings', systemCategory: 'condiments-oils-and-salad-dressings', sortIndex: 0 },
  { identifier: 'c-dairy', name: 'Dairy', systemCategory: 'dairy', sortIndex: 1 },
  { identifier: 'c-other', name: 'Other', systemCategory: 'other', sortIndex: 2 },
] };
const KROGER = { identifier: 'g-kroger', name: 'Kroger', categories: [{ identifier: 'k-22', name: 'Aisle 22', sortIndex: 0 }] };
// A store set the item has no assignment in: it needs no rule.
const TARGET = { identifier: 'g-target', name: 'Target', categories: [{ identifier: 't-other', name: 'Other', systemCategory: 'other', sortIndex: 0 }] };

function kewpie(extra = {}) {
  return {
    identifier: 'i-kewpie', listId: 'list-1', name: 'Kewpie Mayo', checked: true,
    categoryMatchId: 'condiments-oils-and-salad-dressings',
    categoryAssignments: [{ identifier: 'a-k', categoryGroupId: 'g-kroger', categoryId: 'k-22' }],
    ...extra,
  };
}

function fixture({ items = [kewpie()], recents = [], fail = () => false, product = null } = {}) {
  const any = new AnyList({ email: 'test@example.com', password: 'unused', credentialsFile: '/nonexistent' });
  const posts = [];
  const lookups = [];
  const http = {
    post: async (url, { body }) => {
      if (fail(url)) throw new Error(`HTTP 503 from ${url}`);
      const buffer = body._streams.find(s => Buffer.isBuffer(s));
      const type = url === 'data/starter-lists/update' ? any.protobuf.PBStarterListOperationList : any.protobuf.PBListOperationList;
      posts.push({ url, ops: type.decode(buffer).operations });
    },
  };
  any.client = http;
  any.uid = 'user-1';
  any.lookupProduct = async upc => { lookups.push(upc); return product; };
  const context = { client: http, protobuf: any.protobuf, uid: 'user-1' };
  const l = new List({ identifier: 'list-1', listId: 'parent', name: 'Groceries', items }, { ...context, stores: [] });
  l.categoryGroups = [MAIN, KROGER, TARGET];
  any.lists = [l];
  any.recentItems = { 'list-1': recents.map((name, n) => new Item({ identifier: `r-${n}`, listId: STARTER, name }, context)) };
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.client = any;
  c.targetList = l;
  c.connect = async () => true;
  return { any, c, l, posts, lookups, recents: () => any.recentItems['list-1'].map(i => i.name) };
}

const handlers = ops => ops.map(o => o.metadata.handlerId);
// Fails only the nth request to `url`: a failure part-way through several.
function nth(url, n) {
  let seen = 0;
  return u => u === url && ++seen === n;
}
const starterPosts = posts => posts.filter(p => p.url === 'data/starter-lists/update');
const rulePosts = posts => posts.filter(p => p.url === 'data/shopping-lists/update-v2').flatMap(p => p.ops);

// ===== The library =====

test('renameRecentItem sends set-list-item-name to the starter list, under the entry\'s own list id', async () => {
  const { any, posts, recents } = fixture({ recents: ['shrimp', 'Eggs'] });
  const entry = any.recentItems['list-1'][0];
  await any.renameRecentItem(entry, '  Shrimp ');

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'data/starter-lists/update');
  const [op] = posts[0].ops;
  assert.equal(op.metadata.handlerId, 'set-list-item-name');
  assert.equal(op.listId, STARTER);
  assert.equal(op.listItemId, 'r-0');
  assert.equal(op.updatedValue, 'Shrimp');
  assert.deepEqual(recents(), ['Shrimp', 'Eggs']);
  // Not through the setter, which would queue a save() to the shopping list.
  assert.deepEqual(entry._fieldsToUpdate, []);
});

test('removeRecentItem sends remove-item with the entry, and drops only that entry', async () => {
  const { any, posts, recents } = fixture({ recents: ['shrimp', 'Eggs'] });
  await any.removeRecentItem(any.recentItems['list-1'][0]);

  const [op] = posts[0].ops;
  assert.equal(posts[0].url, 'data/starter-lists/update');
  assert.equal(op.metadata.handlerId, 'remove-item');
  assert.equal(op.listId, STARTER);
  assert.equal(op.listItemId, 'r-0');
  assert.equal(op.listItem.identifier, 'r-0');
  assert.deepEqual(recents(), ['Eggs']);
});

test('setProduct sends name, barcode and photo in one request, each with the value it replaces', async () => {
  const { l, posts } = fixture({ items: [kewpie({ productUpc: '0000000000017', photoIds: ['old-photo'] })] });
  await l.items[0].setProduct({ name: 'Kewpie Mayonnaise', productUpc: '0033357071010', photoId: 'p-1' });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'data/shopping-lists/update');
  assert.deepEqual(posts[0].ops.map(o => [o.metadata.handlerId, o.listId, o.listItemId, o.updatedValue, o.originalValue]), [
    ['set-list-item-name', 'list-1', 'i-kewpie', 'Kewpie Mayonnaise', 'Kewpie Mayo'],
    ['set-list-item-product-upc', 'list-1', 'i-kewpie', '0033357071010', '0000000000017'],
    ['set-list-item-photo-id', 'list-1', 'i-kewpie', 'p-1', 'old-photo'],
  ]);
  const item = l.items[0];
  assert.deepEqual([item.name, item.productUpc, item.photoIds], ['Kewpie Mayonnaise', '0033357071010', ['p-1']]);
  assert.deepEqual(item._fieldsToUpdate, []);
});

test('setProduct sends no name op for an unchanged name and no photo op without a photo', async () => {
  const { l, posts } = fixture();
  await l.items[0].setProduct({ name: 'Kewpie Mayo', productUpc: '0033357071010' });
  assert.deepEqual(handlers(posts[0].ops), ['set-list-item-product-upc']);
  assert.equal(posts[0].ops[0].originalValue, '');
});

test('a failed setProduct leaves the local item as AnyList has it', async () => {
  const { l } = fixture({ fail: () => true });
  await assert.rejects(l.items[0].setProduct({ name: 'Kewpie Mayonnaise', productUpc: '0033357071010', photoId: 'p-1' }), /HTTP 503/);
  assert.deepEqual([l.items[0].name, l.items[0].productUpc, l.items[0].photoIds], ['Kewpie Mayo', null, []]);
});

// ===== Recent Items, through the client =====

test('renameRecentItem finds an entry by its exact name, else ignoring case', async () => {
  const { c, posts, recents } = fixture({ recents: ['shrimp', '3 shitake mushrooms'] });
  assert.deepEqual(await c.renameRecentItem('SHRIMP', 'Shrimp'), { from: 'shrimp', to: 'Shrimp', changed: true });
  assert.deepEqual(await c.renameRecentItem('3 shitake mushrooms', 'Shiitake Mushrooms'), { from: '3 shitake mushrooms', to: 'Shiitake Mushrooms', changed: true });
  assert.equal(posts.length, 2);
  assert.deepEqual(recents(), ['Shrimp', 'Shiitake Mushrooms']);
});

test('renameRecentItem refuses what it cannot pin to one entry, and sends nothing', async () => {
  const { c, posts } = fixture({ recents: ['mayo', 'Mayo', 'soap', 'soap', 'Eggs', 'Chicken eggs'] });
  await assert.rejects(c.renameRecentItem('MAYO', 'Mayonnaise'), { message: severalRecents('MAYO', ['mayo', 'Mayo']) });
  await assert.rejects(c.renameRecentItem('Lemongrass', 'Lemon Grass'), { message: notInRecents('Lemongrass') });
  await assert.rejects(c.renameRecentItem('soap', 'Soap'), { message: recentRepeated('soap', 2) });
  // Ignoring case: "eggs" beside "Eggs" is the second entry this refuses to make.
  await assert.rejects(c.renameRecentItem('Chicken eggs', 'eggs'), { message: recentClash('Eggs', 'Chicken eggs') });
  await assert.rejects(c.renameRecentItem('Eggs', '  '), /New name is required/);
  assert.equal(posts.length, 0);
});

test('an exact name wins over its case variants, which are left alone', async () => {
  // The second cleanup's own case: "mayo" and "Mayo" side by side.
  let f = fixture({ recents: ['mayo', 'Mayo'] });
  await f.c.renameRecentItem('Mayo', 'Mayonnaise');
  assert.deepEqual(f.recents(), ['mayo', 'Mayonnaise']);
  f = fixture({ recents: ['mayo', 'Mayo'] });
  await f.c.removeRecentItem('mayo');
  assert.deepEqual(f.recents(), ['Mayo']);
});

test('a case-only rename of an entry is not a clash with itself', async () => {
  const { c, recents } = fixture({ recents: ['soap', 'Eggs'] });
  assert.equal((await c.renameRecentItem('soap', 'Soap')).changed, true);
  assert.deepEqual(recents(), ['Soap', 'Eggs']);
});

test('renaming an entry to the name it has sends nothing', async () => {
  const { c, posts } = fixture({ recents: ['Eggs'] });
  assert.deepEqual(await c.renameRecentItem('Eggs', 'Eggs'), { from: 'Eggs', to: 'Eggs', changed: false });
  assert.equal(posts.length, 0);
});

test('removeRecentItem removes every copy of the name and nothing else', async () => {
  const { c, posts, recents } = fixture({ recents: ['lunchmeat', 'Eggs', 'lunchmeat'] });
  assert.deepEqual(await c.removeRecentItem('lunchmeat'), { name: 'lunchmeat', count: 2 });
  assert.deepEqual(starterPosts(posts).flatMap(p => p.ops).map(o => o.listItemId), ['r-0', 'r-2']);
  assert.deepEqual(recents(), ['Eggs']);
  await assert.rejects(c.removeRecentItem('lunchmeat'), { message: notInRecents('lunchmeat') });
});

test('removeRecentItem failing part-way says how many copies went', async () => {
  const { c, recents } = fixture({ recents: ['lunchmeat', 'lunchmeat', 'lunchmeat'], fail: nth('data/starter-lists/update', 2) });
  await assert.rejects(c.removeRecentItem('lunchmeat'),
    { message: partlyRemoved('lunchmeat', 1, 3, 'HTTP 503 from data/starter-lists/update') });
  assert.deepEqual(recents(), ['lunchmeat', 'lunchmeat']);
});

// ===== A rename carries rules and Recents =====

test('a rename writes the new name\'s rule in every set the item is filed in, and renames its Recents entry', async () => {
  const { c, l, posts, recents } = fixture({ recents: ['Kewpie Mayo', 'Eggs'] });
  const result = await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });

  assert.deepEqual(result, { name: 'Kewpie Mayonnaise', ruleError: null, recent: { kind: 'renamed' } });
  assert.equal(l.items[0].name, 'Kewpie Mayonnaise');
  // The main set through the match id (the item has no assignment there), the
  // Kroger set through its assignment; none for Target, where it has none.
  assert.deepEqual(rulePosts(posts).map(o => {
    const r = o.updatedCategorizationRule;
    return [o.metadata.handlerId, r.itemName, r.categoryGroupId, r.categoryId];
  }), [
    ['save-categorization-rule', 'kewpie mayonnaise', GROUP, 'c-cond'],
    ['save-categorization-rule', 'kewpie mayonnaise', 'g-kroger', 'k-22'],
  ]);
  assert.deepEqual(recents(), ['Kewpie Mayonnaise', 'Eggs']);
});

test('a case-only rename writes no rule but still renames the Recents entry', async () => {
  // The half the first Recents cleanup missed: "mayo" left beside "Mayo".
  const { c, posts, recents } = fixture({ items: [kewpie({ name: 'mayo' })], recents: ['mayo'] });
  const result = await c.updateItem('mayo', { newName: 'Mayo' });
  assert.deepEqual(rulePosts(posts), []);
  assert.equal(result.recent.kind, 'renamed');
  assert.deepEqual(recents(), ['Mayo']);
});

test('a rename to a name already in Recents removes the old entry instead of making a second', async () => {
  const { c, posts, recents } = fixture({ recents: ['Kewpie Mayo', 'Kewpie Mayonnaise'] });
  const result = await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.equal(result.recent.kind, 'removed');
  assert.deepEqual(handlers(starterPosts(posts).flatMap(p => p.ops)), ['remove-item']);
  assert.deepEqual(recents(), ['Kewpie Mayonnaise']);
});

test('the entry left behind is spelt as the item is, whatever case either had', async () => {
  // Leaving "kewpie mayonnaise" beside the item "Kewpie Mayonnaise" is the
  // case-variant the second cleanup removed by hand.
  let f = fixture({ recents: ['Kewpie Mayo', 'kewpie mayonnaise'] });
  assert.equal((await f.c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' })).recent.kind, 'removed');
  assert.deepEqual(f.recents(), ['Kewpie Mayonnaise']);
  // And the old name's entry found ignoring case.
  f = fixture({ recents: ['kewpie mayo', 'Eggs'] });
  assert.equal((await f.c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' })).recent.kind, 'renamed');
  assert.deepEqual(f.recents(), ['Kewpie Mayonnaise', 'Eggs']);
});

test('a case-only rename keeps an entry already spelt the new way and removes the old', async () => {
  const { c, posts, recents } = fixture({ items: [kewpie({ name: 'mayo' })], recents: ['mayo', 'Mayo'] });
  assert.equal((await c.updateItem('mayo', { newName: 'Mayo' })).recent.kind, 'renamed');
  assert.deepEqual(handlers(starterPosts(posts).flatMap(p => p.ops)), ['remove-item']);
  assert.deepEqual(recents(), ['Mayo']);
});

test('a Recents failure part-way is reported as unknown, not as one state', async () => {
  // The rename lands, then the extra copy's removal fails: neither "renamed"
  // nor "still says the old name" is true.
  const { c, recents } = fixture({ recents: ['Kewpie Mayo', 'Kewpie Mayo'], fail: nth('data/starter-lists/update', 2) });
  const result = await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.deepEqual(result.recent, { kind: 'failed', error: 'HTTP 503 from data/starter-lists/update' });
  assert.deepEqual(recents(), ['Kewpie Mayonnaise', 'Kewpie Mayo']);
});

test('every rule is attempted when the first fails', async () => {
  const { c, posts } = fixture({ fail: nth('data/shopping-lists/update-v2', 1) });
  const result = await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.match(result.ruleError, /HTTP 503/);
  assert.deepEqual(rulePosts(posts).map(o => o.updatedCategorizationRule.categoryGroupId), ['g-kroger']);
});

test('an unfiled item\'s rename writes no main-set rule, so AnyList can still place the new name', async () => {
  // "chese" sits in Other because AnyList could not place it; a rule would
  // pin "cheese" there for good.
  const { c, posts } = fixture({ items: [kewpie({ name: 'chese', categoryMatchId: 'other', categoryAssignments: [] })] });
  const result = await c.updateItem('chese', { newName: 'Cheese' });
  assert.deepEqual([rulePosts(posts), result.ruleError], [[], null]);
});

test('a list with no main set still gets the store sets\' rules', async () => {
  const { c, l, posts } = fixture();
  l.categoryGroups = [KROGER, TARGET];
  await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.deepEqual(rulePosts(posts).map(o => o.updatedCategorizationRule.categoryId), ['k-22']);
});

test('extra copies of the old name in Recents go, so the rename leaves one entry', async () => {
  const { c, recents } = fixture({ recents: ['Kewpie Mayo', 'Eggs', 'Kewpie Mayo'] });
  await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.deepEqual(recents(), ['Kewpie Mayonnaise', 'Eggs']);
});

test('a rename with no Recents entry by the old name touches Recents not at all', async () => {
  const { c, posts } = fixture({ recents: ['Eggs'] });
  assert.equal((await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' })).recent.kind, 'none');
  assert.deepEqual(starterPosts(posts), []);
});

test('failures after the rename are reported, not thrown — the item has its new name', async () => {
  const { c, l } = fixture({ recents: ['Kewpie Mayo'], fail: url => url !== 'data/shopping-lists/update' });
  const result = await c.updateItem('Kewpie Mayo', { newName: 'Kewpie Mayonnaise' });
  assert.equal(l.items[0].name, 'Kewpie Mayonnaise');
  assert.match(result.ruleError, /HTTP 503 from data\/shopping-lists\/update-v2/);
  assert.equal(result.recent.kind, 'failed');
  assert.match(result.recent.error, /HTTP 503 from data\/starter-lists\/update/);
});

test('a rename is refused when another item has the name in any case, and nothing is sent', async () => {
  // getItemByName is exact: through it, "milk" could be made beside "Milk",
  // and the two would share one rule.
  const { c, l, posts } = fixture({ items: [kewpie(), { identifier: 'i-milk', listId: 'list-1', name: 'Milk' }], recents: ['Kewpie Mayo'] });
  await assert.rejects(c.updateItem('Kewpie Mayo', { newName: 'milk' }), /^Error: An item named "Milk" is already on the list$/);
  assert.equal(posts.length, 0);
  assert.equal(l.items[0].name, 'Kewpie Mayo');
});

test('a notes change alone writes no rule and leaves Recents alone', async () => {
  const { c, posts } = fixture({ recents: ['Kewpie Mayo'] });
  assert.deepEqual(await c.updateItem('Kewpie Mayo', { notes: 'the squeeze bottle' }), { name: 'Kewpie Mayo' });
  assert.deepEqual(posts.map(p => p.url), ['data/shopping-lists/update']);
});

// ===== Making a typed item a product =====

const PRODUCT = { name: 'Kewpie Mayonnaise', productUpc: '0033357071010', photoIds: ['p-1'], categoryMatchId: 'condiments-oils-and-salad-dressings' };

test('setItemProduct gives the item AnyList\'s name, the barcode and the photo, then carries rules and Recents', async () => {
  // The product's category differs from the item's, so "keeps its
  // categories" cannot pass by the two being equal.
  const { c, l, posts, recents } = fixture({ recents: ['Kewpie Mayo'], product: { ...PRODUCT, categoryMatchId: 'dairy' } });
  const result = await c.setItemProduct('Kewpie Mayo', '033357071010');

  assert.deepEqual(handlers(posts[0].ops), ['set-list-item-name', 'set-list-item-product-upc', 'set-list-item-photo-id']);
  // AnyList's form of the barcode, not the 12 digits given.
  assert.equal(posts[0].ops[1].updatedValue, '0033357071010');
  assert.equal(posts[0].ops[2].originalValue, '');
  assert.equal(l.items[0].identifier, 'i-kewpie');
  assert.deepEqual(result, {
    kind: 'done', from: 'Kewpie Mayo', name: 'Kewpie Mayonnaise', productName: 'Kewpie Mayonnaise', barcode: '0033357071010',
    photo: 'new', filed: null, ruleError: null, recent: { kind: 'renamed' },
  });
  assert.equal(l.items[0].categoryMatchId, 'condiments-oils-and-salad-dressings');
  assert.deepEqual(l.items[0].categoryAssignments.map(a => a.categoryId), ['k-22']);
  assert.deepEqual(rulePosts(posts).map(o => o.updatedCategorizationRule.categoryId), ['c-cond', 'k-22']);
  assert.deepEqual(recents(), ['Kewpie Mayonnaise']);
});

test('an unfiled item is filed where AnyList files the product', async () => {
  const { c, l, posts } = fixture({ items: [kewpie({ categoryMatchId: 'other', categoryAssignments: [] })], product: PRODUCT });
  const result = await c.setItemProduct('Kewpie Mayo', '0033357071010');
  assert.deepEqual(result.filed, { category: 'Condiments & Dressings', ruleError: null });
  assert.equal(l.items[0].categoryMatchId, 'condiments-oils-and-salad-dressings');
  // The move's own rule, under the product's name; none pinning it to Other.
  assert.deepEqual(rulePosts(posts).map(o => [o.updatedCategorizationRule.itemName, o.updatedCategorizationRule.categoryId]),
    [['kewpie mayonnaise', 'c-cond']]);
});

test('setItemProduct keeps a photo the item had when the product has none', async () => {
  const { c, l, posts } = fixture({ items: [kewpie({ photoIds: ['own-photo'] })], product: { ...PRODUCT, photoIds: [] } });
  assert.equal((await c.setItemProduct('Kewpie Mayo', '0033357071010')).photo, 'kept');
  assert.deepEqual(l.items[0].photoIds, ['own-photo']);
  assert.ok(!handlers(posts[0].ops).includes('set-list-item-photo-id'));
});

test('a scanned item is not made a different product, and two items of one name are refused', async () => {
  let f = fixture({ items: [kewpie({ productUpc: '0011110000000' })], product: PRODUCT });
  await assert.rejects(f.c.setItemProduct('Kewpie Mayo', '0033357071010'), { message: alreadyProduct('Kewpie Mayo', '0011110000000') });
  assert.equal(f.posts.length, 0);
  f = fixture({ items: [kewpie(), kewpie({ identifier: 'i-2' })], product: PRODUCT });
  await assert.rejects(f.c.setItemProduct('Kewpie Mayo', '0033357071010'), { message: twoItemsNamed('Kewpie Mayo') });
  assert.equal(f.posts.length, 0);
});

test('a product name over several lines becomes one', async () => {
  const { c, l } = fixture({ product: { ...PRODUCT, name: 'Kewpie\nMayonnaise  ' } });
  assert.equal((await c.setItemProduct('Kewpie Mayo', '0033357071010')).name, 'Kewpie Mayonnaise');
  assert.equal(l.items[0].name, 'Kewpie Mayonnaise');
});

test('setItemProduct with a name of the household\'s keeps it, and has no rename to carry', async () => {
  const { c, posts, recents } = fixture({ recents: ['Kewpie Mayo'], product: PRODUCT });
  const result = await c.setItemProduct('Kewpie Mayo', '0033357071010', { name: 'Kewpie Mayo' });
  assert.deepEqual(handlers(posts[0].ops), ['set-list-item-product-upc', 'set-list-item-photo-id']);
  assert.equal(posts.length, 1);
  assert.equal(result.recent, null);
  assert.deepEqual(recents(), ['Kewpie Mayo']);
});

test('a barcode AnyList does not know changes nothing', async () => {
  const { c, posts } = fixture({ product: null });
  assert.deepEqual(await c.setItemProduct('Kewpie Mayo', '0033357071010'), { kind: 'no-product' });
  assert.equal(posts.length, 0);
});

test('a barcode another item carries is refused, in either form, and nothing is sent', async () => {
  const { c, posts } = fixture({
    items: [kewpie(), { identifier: 'i-2', listId: 'list-1', name: 'Kewpie Mayonnaise 12 oz', productUpc: '0033357071010' }],
    product: PRODUCT,
  });
  // The 12 digits given: the holder carries AnyList's 13-digit form.
  await assert.rejects(c.setItemProduct('Kewpie Mayo', '033357071010'), { message: itemHasBarcode('Kewpie Mayonnaise 12 oz', '0033357071010') });
  assert.equal(posts.length, 0);
});

test('setItemProduct refuses AnyList\'s name when another item has it, and sends nothing', async () => {
  const { c, posts } = fixture({ items: [kewpie(), { identifier: 'i-2', listId: 'list-1', name: 'kewpie mayonnaise' }], product: PRODUCT });
  await assert.rejects(c.setItemProduct('Kewpie Mayo', '0033357071010'), /^Error: An item named "kewpie mayonnaise" is already on the list$/);
  assert.equal(posts.length, 0);
});

// ===== What the tool says =====

function tool(options) {
  const f = fixture(options);
  const { server, handlers: h } = createMockServer();
  register(server, () => Promise.resolve(f.c));
  return { ...f, shopping: params => h.shopping(params) };
}

test('update_item says the Recents entry went with the rename', async () => {
  const { shopping } = tool({ recents: ['Kewpie Mayo'] });
  const result = await shopping({ action: 'update_item', name: 'Kewpie Mayo', new_name: 'Kewpie Mayonnaise' });
  assert.equal(result.content[0].text, 'Updated "Kewpie Mayo": renamed to "Kewpie Mayonnaise"\nIts Recent Items entry is renamed too.');
});

test('update_item says when the old entry was removed instead', async () => {
  const { shopping } = tool({ recents: ['Kewpie Mayo', 'Kewpie Mayonnaise'] });
  const result = await shopping({ action: 'update_item', name: 'Kewpie Mayo', new_name: 'Kewpie Mayonnaise' });
  assert.equal(result.content[0].text,
    'Updated "Kewpie Mayo": renamed to "Kewpie Mayonnaise"\nIts old Recent Items entry "Kewpie Mayo" is removed — "Kewpie Mayonnaise" was there already.');
});

test('update_item says what a failure after the rename leaves behind', async () => {
  const { shopping } = tool({ recents: ['Kewpie Mayo'], fail: url => url !== 'data/shopping-lists/update' });
  const result = await shopping({ action: 'update_item', name: 'Kewpie Mayo', new_name: 'Kewpie Mayonnaise' });
  assert.equal(result.content[0].text, [
    'Updated "Kewpie Mayo": renamed to "Kewpie Mayonnaise"',
    'AnyList\'s rule for "Kewpie Mayonnaise" wasn\'t saved, so re-adding it from the app may file it elsewhere: HTTP 503 from data/shopping-lists/update-v2',
    'Recent Items may not be fully updated — check for "Kewpie Mayo" there, since tapping it would add a second item: HTTP 503 from data/starter-lists/update',
  ].join('\n'));
});

test('set_item_barcode says what the item became, with or without a photo, and under whose name', async () => {
  let t = tool({ recents: ['Kewpie Mayo'], product: PRODUCT });
  // The whole name, ignoring case, finds a checked-off item.
  let result = await t.shopping({ action: 'set_item_barcode', name: 'kewpie mayo', upc: '0033-3570-71010' });
  assert.equal(result.content[0].text,
    '"Kewpie Mayo" is now the product with barcode 0033357071010, named "Kewpie Mayonnaise", with its photo.\nIts Recent Items entry is renamed too.');

  t = tool({ product: { ...PRODUCT, photoIds: [] } });
  result = await t.shopping({ action: 'set_item_barcode', name: 'Kewpie Mayo', upc: '0033357071010', new_name: 'Kewpie Mayo' });
  assert.equal(result.content[0].text,
    '"Kewpie Mayo" is now the product with barcode 0033357071010, named "Kewpie Mayo" (AnyList calls it "Kewpie Mayonnaise"), without a photo — AnyList has none for it.');

  t = tool({ items: [kewpie({ photoIds: ['own'], categoryMatchId: 'other', categoryAssignments: [] })], product: { ...PRODUCT, photoIds: [] } });
  result = await t.shopping({ action: 'set_item_barcode', name: 'Kewpie Mayo', upc: '0033357071010', new_name: 'Kewpie Mayo' });
  assert.equal(result.content[0].text, [
    '"Kewpie Mayo" is now the product with barcode 0033357071010, named "Kewpie Mayo" (AnyList calls it "Kewpie Mayonnaise"), keeping the photo it had — AnyList has none for the product.',
    'Filed under "Condiments & Dressings", where AnyList files the product.',
  ].join('\n'));
});

test('set_item_barcode takes no part of a name: "butter" is not the one butter on the list', async () => {
  const { shopping, posts } = tool({ product: PRODUCT });
  const result = await shopping({ action: 'set_item_barcode', name: 'kewpie', upc: '0033357071010' });
  assert.equal(result.content[0].text,
    'Shopping set_item_barcode failed: Item "kewpie" not found in list — set_item_barcode needs the item\'s whole name, as list_items shows it');
  assert.equal(posts.length, 0);
});

test('set_item_barcode without a name asks for one', async () => {
  const { shopping, posts } = tool({ product: PRODUCT });
  const result = await shopping({ action: 'set_item_barcode', upc: '0033357071010' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Which item is this barcode for\?/);
  assert.equal(posts.length, 0);
});

test('set_item_barcode with a barcode AnyList does not know says nothing changed', async () => {
  const { shopping } = tool({ product: null });
  const result = await shopping({ action: 'set_item_barcode', name: 'Kewpie Mayo', upc: '0033357071010' });
  assert.equal(result.content[0].text,
    'AnyList has no product for barcode 0033357071010. Its database has no match — that does not mean the product doesn\'t exist.\nNothing was changed.');
});

test('rename_recent and remove_recent say what they did', async () => {
  const { shopping } = tool({ recents: ['shrimp', 'lunchmeat', 'lunchmeat', 'Eggs'] });
  assert.equal((await shopping({ action: 'rename_recent', name: 'shrimp', new_name: 'Shrimp' })).content[0].text,
    'Renamed "shrimp" to "Shrimp" in Recent Items');
  assert.equal((await shopping({ action: 'rename_recent', name: 'Eggs', new_name: 'Eggs' })).content[0].text,
    '"Eggs" is already called that in Recent Items');
  assert.equal((await shopping({ action: 'remove_recent', name: 'lunchmeat' })).content[0].text,
    'Removed "lunchmeat" from Recent Items (2 copies). The list itself is unchanged');
  assert.equal((await shopping({ action: 'remove_recent', name: 'Shrimp' })).content[0].text,
    'Removed "Shrimp" from Recent Items. The list itself is unchanged');
});

test('rename_recent and remove_recent refuse a missing name and pass refusals through', async () => {
  const { shopping, posts } = tool({ recents: ['Eggs', 'Chicken eggs'] });
  assert.equal((await shopping({ action: 'rename_recent', new_name: 'x' })).content[0].text, 'rename_recent needs name: the Recent Items entry');
  const missing = await shopping({ action: 'remove_recent' });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, 'remove_recent needs name: the Recent Items entry');
  assert.equal((await shopping({ action: 'rename_recent', name: 'Eggs' })).content[0].text, 'rename_recent needs new_name');
  const clash = await shopping({ action: 'rename_recent', name: 'Chicken eggs', new_name: 'eggs' });
  assert.equal(clash.isError, true);
  assert.equal(clash.content[0].text, `Shopping rename_recent failed: ${recentClash('Eggs', 'Chicken eggs')}`);
  assert.equal(posts.length, 0);
});
