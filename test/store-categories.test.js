/**
 * Categories per store (moneypenny plans/010): a store's own category set,
 * filled with the main set's departments and with aisles, one set's
 * assignment at a time, and the categorisation rule with every assignment.
 *
 * Everything here drives the real AnyListClient over a real List, through the
 * tool, with only HTTP faked: a words test through MockAnyListClient asserts
 * the mock's answers, which the test author writes. The fake records a request
 * before it fails it, and fails by what the request carries, so "no rule was
 * posted" can be told from "the rule post threw".
 *
 * Fixtures are shaped to separate implementations that a plainer fixture
 * would let pass: the main set and the walk set are each first in one run
 * (⇄); the walk set is not named after the store and a decoy set is; a
 * department's name differs from its system id (Fruit & Veg / produce); a
 * hand-made "snacks " has no system id and a trailing space; and Paprika reads
 * Penzy's in the main set but Other in the walk set, where a dairy item would
 * read Dairy in both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient, { NO_MAIN_SET } from '../src/anylist-client.js';
import { register } from '../src/tools/shopping.js';
import { createMockServer } from './tools/helpers.js';

const require = createRequire(import.meta.url);
const AnyList = require('../anylist-js/lib/index.js');
const List = require('../anylist-js/lib/list.js');
const Item = require('../anylist-js/lib/item.js');

const any = new AnyList({ email: 'test@example.com', password: 'unused', credentialsFile: '/nonexistent' });

const LIST = 'list-1';
// uuid5('list-1', f656a81f-…), computed with Python's uuid.uuid5.
const MAIN = 'b907355ef26d5331849d1d5fe1f23a61';
const WALK = 'g-walk';
const DECOY = 'g-decoy';

const ASSIGN = 'update-list-item-category-assignment';
const MATCH = 'set-list-item-category-match-id';
const RULE = 'save-categorization-rule';
const CREATE = 'create-category';

function mainSet() {
  return { identifier: MAIN, name: 'Default', categories: [
    { identifier: 'm-produce', name: 'Produce', systemCategory: 'produce', sortIndex: 0, icon: 'apple' },
    { identifier: 'm-dairy', name: 'Dairy', systemCategory: 'dairy', sortIndex: 1 },
    { identifier: 'm-snacks', name: 'Snacks', systemCategory: 'snacks-cookies-and-candy', sortIndex: 2 },
    { identifier: 'm-penzys', name: 'Penzy’s', systemCategory: null, sortIndex: 3 },
    { identifier: 'm-other', name: 'Other', systemCategory: 'other', sortIndex: 4 },
  ] };
}

function walkSet(state) {
  const categories = [{ identifier: 'w-other', name: 'Other', systemCategory: 'other', sortIndex: 5 }];
  if (state === 'sorted') {
    categories.push(
      { identifier: 'w-fv', name: 'Fruit & Veg', systemCategory: 'produce', sortIndex: 6 },
      { identifier: 'w-a22', name: 'Aisle 22', systemCategory: null, sortIndex: 7 },
      { identifier: 'w-snacks', name: 'snacks ', systemCategory: null, sortIndex: 8 },
    );
  }
  return { identifier: WALK, name: 'Walk order', categories };
}

// Named after the store and holding an "Aisle 22" of its own: a lookup by any
// name instead of through the store filter lands here.
function decoySet() {
  return { identifier: DECOY, name: 'Kroger', categories: [
    { identifier: 'd-other', name: 'Other', systemCategory: 'other', sortIndex: 0 },
    { identifier: 'd-a22', name: 'Aisle 22', systemCategory: null, sortIndex: 1 },
  ] };
}

function defaultItems() {
  return [
    { identifier: 'i-milk', name: 'Milk', categoryMatchId: 'dairy', category: 'dairy', categoryAssignments: [] },
    { identifier: 'i-bread', name: 'Bread', categoryMatchId: 'snacks-cookies-and-candy', categoryAssignments: [
      { identifier: 'a-main', categoryGroupId: MAIN, categoryId: 'm-snacks' },
      { identifier: 'a-decoy', categoryGroupId: DECOY, categoryId: 'd-other' },
    ] },
    { identifier: 'i-paprika', name: 'Paprika', categoryMatchId: 'penzys', categoryAssignments: [
      { identifier: 'a-pz', categoryGroupId: MAIN, categoryId: 'm-penzys' },
    ] },
  ];
}

const STORES = [{ identifier: 's-7', name: 'Kroger' }, { identifier: 's-9', name: 'Walmart' }, { identifier: 's-3', name: 'Target' }];
const FILTERS = [
  { identifier: 'f-1', name: 'Big shop', storeIds: ['s-7'], listCategoryGroupId: WALK },
  { identifier: 'f-2', name: 'Walmart Items', storeIds: ['s-9'] },
];

// `fail(request)` decides whether a request fails; it is recorded either way.
function fixture({ walk = 'sorted', mainFirst = true, fail = () => false, items = defaultItems(), filters = FILTERS, groups } = {}) {
  const posts = [];
  const client = {
    post: async (url, { body }) => {
      const buffer = body._streams.find(s => Buffer.isBuffer(s));
      const request = { url, ops: any.protobuf.PBListOperationList.decode(buffer).operations };
      posts.push(request);
      if (fail(request)) throw new Error('Response code 500 (Internal Server Error)');
    },
  };
  const l = new List({ identifier: LIST, listId: 'parent', name: 'Groceries', items: items.map(i => ({ listId: LIST, ...i })) },
    { client, protobuf: any.protobuf, uid: 'user-1', stores: STORES });
  l.categoryGroups = groups || (mainFirst ? [mainSet(), walkSet(walk), decoySet()] : [walkSet(walk), decoySet(), mainSet()]);
  l._setStoreFilters(filters);
  const c = new AnyListClient({ username: 'u', password: 'p' });
  c.client = any;
  c.targetList = l;
  c.connect = async () => {};
  const { server, handlers } = createMockServer();
  register(server, () => Promise.resolve(c));
  const call = async params => (await handlers.shopping(params)).content[0].text;
  const item = name => l.items.find(i => i.name === name);
  return { c, l, posts, call, item };
}

const handlerIds = posts => posts.map(p => p.ops.map(o => o.metadata.handlerId));
const opsOf = (posts, handler) => posts.flatMap(p => p.ops).filter(o => o.metadata.handlerId === handler);
const failing = handler => request => request.ops.some(o => o.metadata.handlerId === handler);

const ORDERS = [['main set first', true], ['walk set first', false]];

for (const [order, mainFirst] of ORDERS) {
  test(`⇄ ${order}: a batch sort sends the assignment and its rule, never the match id, into the store's set`, async () => {
    const { posts, call, item, c } = fixture({ mainFirst });
    const text = await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 22' }] });
    assert.equal(text, 'Added 1 department to the Kroger set.\n"Milk" → Aisle 22\nAssigned 1 of 1.');
    assert.deepEqual(handlerIds(posts), [[CREATE], [ASSIGN], [RULE]]);
    assert.deepEqual(opsOf(posts, MATCH), []);
    const [assign] = opsOf(posts, ASSIGN);
    // Nor folded into the assignment op's partial item.
    assert.ok(!assign.listItem.categoryMatchId && !assign.listItem.category);
    // The walk set's Aisle 22, not the decoy set's of the same name.
    assert.deepEqual(assign.listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
      [[Item.assignmentId(WALK), WALK, 'w-a22']]);
    assert.equal(item('Milk').categoryMatchId, 'dairy');
    assert.equal(c.categoryNameOf(item('Milk'), c.mainSet()), 'Dairy');
  });

  test(`⇄ ${order}: the single-item path with a store does the same, after copying departments into a fresh set`, async () => {
    const { posts, call, item } = fixture({ mainFirst, walk: 'fresh' });
    const text = await call({ action: 'set_item_category', name: 'Milk', category: 'Aisle 22', store: 'Kroger' });
    assert.equal(text, 'Added 3 departments to the Kroger set.\nMoved "Milk" from "Dairy" to "Aisle 22" in the Kroger view');
    assert.deepEqual(handlerIds(posts), [[CREATE, CREATE, CREATE], [CREATE], [ASSIGN], [RULE]]);
    assert.deepEqual(opsOf(posts, CREATE).map(o => [o.updatedCategory.name, o.updatedCategory.categoryGroupId]),
      [['Produce', WALK], ['Dairy', WALK], ['Snacks', WALK], ['Aisle 22', WALK]]);
    assert.equal(item('Milk').categoryMatchId, 'dairy');
  });

  test(`⇄ ${order}: an item assigned in other sets is sent its store-set assignment alone`, async () => {
    const { posts, call } = fixture({ mainFirst });
    await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Bread', category: 'Aisle 22' }] });
    const [assign] = opsOf(posts, ASSIGN);
    assert.deepEqual(assign.listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
      [[Item.assignmentId(WALK), WALK, 'w-a22']]);
  });

  test(`⇄ ${order}: a main-set move sends the main assignment alone, then the match id, then the main set's rule`, async () => {
    const { posts, call } = fixture({ mainFirst });
    const text = await call({ action: 'set_item_category', name: 'Bread', category: 'Dairy' });
    assert.equal(text, 'Moved "Bread" from "Snacks" to "Dairy"');
    assert.deepEqual(handlerIds(posts), [[ASSIGN, MATCH], [RULE]]);
    assert.deepEqual(opsOf(posts, ASSIGN)[0].listItem.categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]),
      [[MAIN, 'm-dairy']]);
    const [rule] = opsOf(posts, RULE);
    assert.equal(rule.updatedCategorizationRule.categoryGroupId, MAIN);
    assert.equal(rule.updatedCategorizationRule.categoryId, 'm-dairy');
  });

  test(`⇄ ${order}: the rule names the item lowercased, the list, the store's set and a newly created aisle's id`, async () => {
    const { posts, call, l } = fixture({ mainFirst });
    await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 31' }] });
    const created = opsOf(posts, CREATE).find(o => o.updatedCategory.name === 'Aisle 31').updatedCategory;
    const rulePost = posts.find(p => p.ops[0].metadata.handlerId === RULE);
    assert.equal(rulePost.url, 'data/shopping-lists/update-v2');
    const [op] = rulePost.ops;
    assert.equal(op.metadata.operationClass, 5);
    assert.equal(op.listId, LIST);
    const rule = op.updatedCategorizationRule;
    assert.deepEqual([rule.itemName, rule.listId, rule.categoryGroupId, rule.categoryId], ['milk', LIST, WALK, created.identifier]);
    assert.equal(rule.identifier, l.categorizationRuleId('Milk', WALK));
  });

  test(`⇄ ${order}: an item already where it is asked to go still gets its rule — the rule may be the stale part`, async () => {
    const ok = fixture({ mainFirst });
    assert.equal(await ok.call({ action: 'set_item_category', name: 'Milk', category: 'Dairy' }), '"Milk" is filed under "Dairy"');
    assert.equal(opsOf(ok.posts, RULE).length, 1);

    const broken = fixture({ mainFirst, fail: failing(RULE) });
    assert.equal(await broken.call({ action: 'set_item_category', name: 'Milk', category: 'Dairy' }),
      '"Milk" is filed under "Dairy", but AnyList\'s rule for it wasn\'t saved, so re-adding it from the app may file it where it was: Response code 500 (Internal Server Error)');
  });

  test(`⇄ ${order}: a failed assignment writes no rule and is "couldn't confirm", not "not written"`, async () => {
    const { posts, call } = fixture({ mainFirst, fail: failing(ASSIGN) });
    const text = await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 22' }] });
    assert.equal(text, 'Added 1 department to the Kroger set.\n'
      + '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view\nAssigned 0 of 1.');
    assert.equal(opsOf(posts, ASSIGN).length, 1);
    assert.deepEqual(opsOf(posts, RULE), []);
  });

  test(`⇄ ${order}: a failed rule is said, and the item counts as moved`, async () => {
    const batch = fixture({ mainFirst, fail: failing(RULE) });
    assert.equal(await batch.call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 22' }] }),
      'Added 1 department to the Kroger set.\n'
      + '"Milk" → Aisle 22, but AnyList\'s rule for it wasn\'t saved, so re-adding it from the app may file it where it was: Response code 500 (Internal Server Error)\n'
      + 'Assigned 1 of 1.');

    const single = fixture({ mainFirst, fail: failing(RULE) });
    assert.equal(await single.call({ action: 'set_item_category', name: 'Milk', category: 'Aisle 22', store: 'Kroger' }),
      'Added 1 department to the Kroger set.\n'
      + 'Moved "Milk" from "Dairy" to "Aisle 22" in the Kroger view, but AnyList\'s rule for it wasn\'t saved, so re-adding it from the app may file it where it was: Response code 500 (Internal Server Error)');
  });

  test(`⇄ ${order}: a new aisle is announced on the row that landed in it, or said to exist when none did`, async () => {
    let assigns = 0;
    const firstFails = request => request.ops[0].metadata.handlerId === ASSIGN && ++assigns === 1;
    const two = fixture({ mainFirst, fail: firstFails });
    assert.equal(await two.call({ action: 'set_item_categories', store: 'Kroger',
      items: [{ name: 'Milk', category: 'Aisle 31' }, { name: 'Bread', category: 'aisle 31' }] }),
    'Added 1 department to the Kroger set.\n'
      + '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view\n'
      + '"Bread" → Aisle 31 (new category)\nAssigned 1 of 2.');

    const one = fixture({ mainFirst, fail: failing(ASSIGN) });
    assert.equal(await one.call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 31' }] }),
      'Added 1 department to the Kroger set.\n'
      + '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view; Aisle 31 was created for it\n'
      + 'Assigned 0 of 1.');
  });

  test(`⇄ ${order}: an aisle that couldn't be made stops only the rows that need it`, async () => {
    const aisleFails = request => request.ops.some(o => o.metadata.handlerId === CREATE && o.updatedCategory.name === 'Aisle 31');
    const { posts, call } = fixture({ mainFirst, fail: aisleFails });
    assert.equal(await call({ action: 'set_item_categories', store: 'Kroger',
      items: [{ name: 'Milk', category: 'Aisle 31' }, { name: 'Paprika', category: 'Aisle 22' }] }),
    'Added 1 department to the Kroger set.\n'
      + '"Milk": not written — Aisle 31 couldn\'t be created: Response code 500 (Internal Server Error)\n'
      + '"Paprika" → Aisle 22\nAssigned 1 of 2.');
    assert.deepEqual(opsOf(posts, ASSIGN).map(o => o.listItemId), ['i-paprika']);
  });

  test(`⇄ ${order}: a fresh set gets the main set's departments in one request — system ids, not Other, not the household's own`, async () => {
    const { posts, call } = fixture({ mainFirst, walk: 'fresh' });
    const text = await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Dairy' }] });
    assert.equal(text, 'Added 3 departments to the Kroger set.\n"Milk" → Dairy\nAssigned 1 of 1.');
    const [first] = posts;
    const made = first.ops.map(o => o.updatedCategory);
    assert.deepEqual(first.ops.map(o => o.metadata.handlerId), [CREATE, CREATE, CREATE]);
    assert.deepEqual(made.map(c => [c.name, c.systemCategory, c.categoryGroupId]),
      [['Produce', 'produce', WALK], ['Dairy', 'dairy', WALK], ['Snacks', 'snacks-cookies-and-candy', WALK]]);
    assert.equal(made[0].icon, 'apple');
    // After the set's own Other (5), strictly increasing — not main's 0, 1, 2.
    assert.deepEqual(made.map(c => c.sortIndex), [6, 7, 8]);
    // The row is checked against the set after the copy, by system id.
    const [rule] = opsOf(posts, RULE);
    assert.equal(rule.updatedCategorizationRule.categoryId, made[1].identifier);
  });

  test(`⇄ ${order}: a department already there by system id or by name, however spelled, is not made twice`, async () => {
    const { posts, call } = fixture({ mainFirst });
    const text = await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 22' }] });
    assert.ok(text.startsWith('Added 1 department to the Kroger set.\n'));
    assert.deepEqual(opsOf(posts, CREATE).map(o => o.updatedCategory.systemCategory), ['dairy']);

    posts.length = 0;
    const again = await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Paprika', category: 'Aisle 22' }] });
    assert.equal(again, '"Paprika" → Aisle 22\nAssigned 1 of 1.');
    assert.deepEqual(opsOf(posts, CREATE), []);
  });

  test(`⇄ ${order}: the household's own category is not in the store's set, and is refused there`, async () => {
    const { posts, call } = fixture({ mainFirst });
    assert.equal(await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Paprika', category: 'Penzy’s' }] }),
      'Added 1 department to the Kroger set.\n'
      + '"Paprika": Penzy’s is not a category in the Kroger set, and only "Aisle <number>" is created automatically\nAssigned 0 of 1.');
    assert.deepEqual(opsOf(posts, ASSIGN), []);
  });

  test(`⇄ ${order}: an item's category is read in the set asked about`, async () => {
    const { c, call, item } = fixture({ mainFirst });
    assert.equal(c.categoryNameOf(item('Paprika'), c.mainSet()), 'Penzy’s');
    assert.equal(c.categoryNameOf(item('Paprika'), c.storeSet('Kroger').group), 'Other');
    assert.equal(c.findCategory('Produce', c.storeSet('Kroger').group).identifier, 'w-fv');
    assert.equal(await call({ action: 'set_item_category', name: 'Paprika', category: 'Aisle 22', store: 'Kroger' }),
      'Added 1 department to the Kroger set.\nMoved "Paprika" from "Other" to "Aisle 22" in the Kroger view');
  });

  test(`⇄ ${order}: the single-item path files a department in the store's set — never the main set's of the same name`, async () => {
    // Bread is in Snacks in the main set: a lookup in the main set would send
    // main's Dairy and move it there, in the ordinary view.
    const { posts, call, c, item } = fixture({ mainFirst });
    assert.equal(await call({ action: 'set_item_category', name: 'Bread', category: 'Dairy', store: 'Kroger' }),
      'Added 1 department to the Kroger set.\nMoved "Bread" from "Other" to "Dairy" in the Kroger view');
    const dairy = opsOf(posts, CREATE)[0].updatedCategory;
    assert.deepEqual(opsOf(posts, CREATE).map(o => o.updatedCategory.name), ['Dairy']);
    assert.deepEqual(opsOf(posts, ASSIGN)[0].listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
      [[Item.assignmentId(WALK), WALK, dairy.identifier]]);
    assert.equal(opsOf(posts, RULE)[0].updatedCategorizationRule.categoryGroupId, WALK);
    assert.deepEqual(opsOf(posts, MATCH), []);
    assert.equal(c.categoryNameOf(item('Bread'), c.mainSet()), 'Snacks');
  });

  test(`⇄ ${order}: the single-item path refuses a category the store's set won't have before writing anything`, async () => {
    const { posts, call } = fixture({ mainFirst, walk: 'fresh' });
    assert.equal(await call({ action: 'set_item_category', name: 'Paprika', category: 'Penzy’s', store: 'Kroger' }),
      'Shopping set_item_category failed: Penzy’s is not a category in the Kroger set, and only "Aisle <number>" is created automatically');
    assert.deepEqual(posts, []);
  });

  test(`⇄ ${order}: the single-item path says "couldn't confirm" for a failed move, and what it made before it`, async () => {
    const moved = fixture({ mainFirst, walk: 'fresh', fail: failing(ASSIGN) });
    assert.equal(await moved.call({ action: 'set_item_category', name: 'Milk', category: 'Aisle 22', store: 'Kroger' }),
      'Added 3 departments to the Kroger set.\n'
        + '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view');
    assert.deepEqual(opsOf(moved.posts, RULE), []);

    const main = fixture({ mainFirst, fail: failing(ASSIGN) });
    assert.equal(await main.call({ action: 'set_item_category', name: 'Milk', category: 'Snacks' }),
      '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the list');

    const aisleFails = request => request.ops.some(o => o.metadata.handlerId === CREATE && o.updatedCategory.name === 'Aisle 31');
    const aisle = fixture({ mainFirst, fail: aisleFails });
    assert.equal(await aisle.call({ action: 'set_item_category', name: 'Milk', category: 'Aisle 31', store: 'Kroger' }),
      'Added 1 department to the Kroger set.\n"Milk": not written — Aisle 31 couldn\'t be created: Response code 500 (Internal Server Error)');
    assert.deepEqual(opsOf(aisle.posts, ASSIGN), []);
  });
}

test('a department request that fails stops the call before any aisle or assignment', async () => {
  const { posts, call } = fixture({ walk: 'fresh', fail: failing(CREATE) });
  assert.equal(await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 31' }] }),
    'Shopping set_item_categories failed: Couldn\'t add the main set\'s departments to the Kroger set, so no items were sorted: Response code 500 (Internal Server Error)');
  assert.equal(posts.length, 1);
  assert.deepEqual(opsOf(posts, ASSIGN), []);
});

test("the words name the store as AnyList spells it, whatever the caller typed", async () => {
  const { call } = fixture({ fail: failing(ASSIGN) });
  assert.equal(await call({ action: 'set_item_categories', store: 'kroger',
    items: [{ name: 'Milk', category: 'Aisle 22' }, { name: 'Paprika', category: 'Penzy’s' }] }),
  'Added 1 department to the Kroger set.\n'
    + '"Milk": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view\n'
    + '"Paprika": Penzy’s is not a category in the Kroger set, and only "Aisle <number>" is created automatically\nAssigned 0 of 2.');
});

for (const [order, mainFirst] of ORDERS) {
  test(`⇄ ${order}: an item assigned in several sets reads each set's own assignment, wherever it sits in the array`, () => {
    // Its decoy-set assignment comes first, and its match id names a category
    // main has: reading the first assignment, not main's, falls through to Dairy.
    const items = [{ identifier: 'i-cheese', name: 'Cheese', categoryMatchId: 'dairy', categoryAssignments: [
      { identifier: 'a-d', categoryGroupId: DECOY, categoryId: 'd-a22' },
      { identifier: 'a-m', categoryGroupId: MAIN, categoryId: 'm-penzys' },
    ] }];
    const { c, item } = fixture({ mainFirst, items });
    assert.equal(c.categoryNameOf(item('Cheese'), c.mainSet()), 'Penzy’s');
    // No walk-set assignment, and this walk set has no Dairy yet: its default.
    assert.equal(c.categoryNameOf(item('Cheese'), c.storeSet('Kroger').group), 'Other');
  });
}

test('two items whose names differ only in case are refused on both tools, with nothing written', async () => {
  const items = [...defaultItems(), { identifier: 'i-milk2', name: 'milk', categoryMatchId: 'dairy', categoryAssignments: [] }];
  const batch = fixture({ items: items.map(i => ({ ...i })) });
  assert.equal(await batch.call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'Aisle 22' }] }),
    'Added 1 department to the Kroger set.\n"Milk": not written — two items are called that\nAssigned 0 of 1.');
  assert.deepEqual(opsOf(batch.posts, ASSIGN), []);

  const single = fixture({ items: items.map(i => ({ ...i })) });
  assert.equal(await single.call({ action: 'set_item_category', name: 'Milk', category: 'Dairy' }),
    'Shopping set_item_category failed: Two items on the list are called "Milk", ignoring case, and AnyList keeps one rule for both, so nothing was changed');
  assert.deepEqual(single.posts, []);
});

test('the rule id is the one AnyList gives: uuid5 of the lowercased name, the set and the list', () => {
  const l = new List({ identifier: 'def', listId: 'p', name: 'L', items: [] }, { client: {}, protobuf: any.protobuf, uid: 'u', stores: [] });
  // Python: uuid.uuid5(uuid.UUID('f4338133-428d-4f0b-9402-7c9b23243f14'), 'spike milk' + 'abc' + 'def').hex
  assert.equal(l.categorizationRuleId('Spike Milk', 'abc'), '5da04c05003b5fdd99c34efb727bc40c');
  assert.equal(l.categorizationRuleId('spike milk', 'abc'), '5da04c05003b5fdd99c34efb727bc40c');
});

test('which set a store sorts into: only through a filter naming the store, never by name, never the main set', async () => {
  const words = async (opts, store = 'Kroger') => {
    const f = fixture(opts);
    const text = await f.call({ action: 'set_item_categories', store, items: [{ name: 'Milk', category: 'Aisle 22' }] });
    if (text.startsWith('Shopping')) assert.deepEqual(f.posts, [], text);
    return text;
  };
  const prefix = 'Shopping set_item_categories failed: ';
  assert.equal(await words({}, 'Target'),
    prefix + 'No store view for "Target". Make one in the AnyList app: a category set for Target, then a store filter for Target that uses it');
  assert.equal(await words({}, 'Walmart'),
    prefix + 'The "Walmart" store view uses the main categories, so there is no Walmart set to sort into. In the AnyList app, give it its own category set');
  assert.equal(await words({ filters: [{ identifier: 'f', name: 'K', storeIds: ['s-7'], listCategoryGroupId: MAIN }] }),
    prefix + 'The "Kroger" store view uses the main categories, so there is no Kroger set to sort into. In the AnyList app, give it its own category set');
  assert.equal(await words({ filters: [...FILTERS, { identifier: 'f-3', name: 'Quick trip', storeIds: ['s-7'], listCategoryGroupId: DECOY }] }),
    prefix + 'Two store views for "Kroger" use different category sets, so it is not clear which to sort into');
  assert.equal(await words({ filters: [...FILTERS, { identifier: 'f-3', name: 'Quick trip', storeIds: ['s-7'], listCategoryGroupId: WALK }] }),
    'Added 1 department to the Kroger set.\n"Milk" → Aisle 22\nAssigned 1 of 1.');
  assert.equal(await words({ groups: [walkSet('sorted'), decoySet()] }), prefix + NO_MAIN_SET);
  // AnyList's spelling once the store is found, as everywhere else.
  assert.equal(await words({}, 'walmart'),
    prefix + 'The "Walmart" store view uses the main categories, so there is no Walmart set to sort into. In the AnyList app, give it its own category set');
  assert.equal(await words({ filters: [...FILTERS, { identifier: 'f-3', name: 'Quick trip', storeIds: ['s-7'], listCategoryGroupId: DECOY }] }, 'kroger'),
    prefix + 'Two store views for "Kroger" use different category sets, so it is not clear which to sort into');
  assert.equal(await words({}, 'target'),
    prefix + 'No store view for "Target". Make one in the AnyList app: a category set for Target, then a store filter for Target that uses it');
});

test('with no main set, nothing guesses one: set_item_category and list_items refuse', async () => {
  const { call, posts } = fixture({ groups: [walkSet('sorted'), decoySet()] });
  assert.equal(await call({ action: 'set_item_category', name: 'Milk', category: 'Dairy' }), `Shopping set_item_category failed: ${NO_MAIN_SET}`);
  assert.equal(await call({ action: 'list_items' }), `Shopping list_items failed: Failed to get items: ${NO_MAIN_SET}`);
  assert.deepEqual(posts, []);
});

test('"Aisle <number>" is matched whole, case and spaces aside, and leading zeros dropped', async () => {
  const { posts, call } = fixture();
  const text = await call({ action: 'set_item_categories', store: 'Kroger', items: [
    { name: 'Milk', category: 'aisle 22' }, { name: 'Bread', category: 'Aisle 22 ' },
    { name: 'Paprika', category: 'Aisle 22 Dairy' },
  ] });
  assert.equal(text, 'Added 1 department to the Kroger set.\n"Milk" → Aisle 22\n"Bread" → Aisle 22\n'
    + '"Paprika": Aisle 22 Dairy is not a category in the Kroger set, and only "Aisle <number>" is created automatically\nAssigned 2 of 3.');
  assert.deepEqual(opsOf(posts, CREATE).map(o => o.updatedCategory.name), ['Dairy']);

  const seven = fixture();
  assert.equal(await seven.call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Milk', category: 'AISLE 07' }] }),
    'Added 1 department to the Kroger set.\n"Milk" → Aisle 7 (new category)\nAssigned 1 of 1.');
});

test('new aisles are made in number order, after everything in the set, in one request', async () => {
  const { posts, call } = fixture();
  await call({ action: 'set_item_categories', store: 'Kroger', items: [
    { name: 'Milk', category: 'Aisle 31' }, { name: 'Bread', category: 'Aisle 4' }, { name: 'Paprika', category: 'Aisle 31' },
  ] });
  const aislePost = posts.find(p => p.ops[0].updatedCategory?.name?.startsWith('Aisle'));
  assert.deepEqual(aislePost.ops.map(o => [o.updatedCategory.name, o.updatedCategory.sortIndex, o.updatedCategory.categoryGroupId]),
    [['Aisle 4', 10, WALK], ['Aisle 31', 11, WALK]]);
});

test('one row failing does not stop the rest: 25 rows, the 13th fails', async () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ identifier: `i-${i}`, name: `Thing ${i + 1}`, categoryMatchId: 'other', categoryAssignments: [] }));
  const thirteenth = request => request.ops[0].metadata.handlerId === ASSIGN && request.ops[0].listItemId === 'i-12';
  const { call } = fixture({ items, fail: thirteenth });
  const lines = (await call({ action: 'set_item_categories', store: 'Kroger',
    items: items.map(i => ({ name: i.name, category: 'Aisle 22' })) })).split('\n');
  assert.equal(lines.filter(l => l.includes(' → Aisle 22')).length, 24);
  assert.equal(lines[13], '"Thing 13": couldn\'t confirm the move — Response code 500 (Internal Server Error). Check the Kroger view');
  assert.equal(lines.at(-1), 'Assigned 24 of 25.');
});

test('26 rows are refused before anything is written', async () => {
  const { posts, call } = fixture();
  const rows = Array.from({ length: 26 }, () => ({ name: 'Milk', category: 'Aisle 22' }));
  assert.equal(await call({ action: 'set_item_categories', store: 'Kroger', items: rows }),
    'Shopping set_item_categories failed: At most 25 items at a time — this call had 26');
  assert.deepEqual(posts, []);
});

test('a row for an item the list does not have says so', async () => {
  const { call } = fixture();
  assert.equal(await call({ action: 'set_item_categories', store: 'Kroger', items: [{ name: 'Caviar', category: 'Aisle 22' }] }),
    'Added 1 department to the Kroger set.\n"Caviar": not on the list\nAssigned 0 of 1.');
});

test('list_items with include_barcodes puts a scanned item\'s barcode after its name, and nothing after a typed one', async () => {
  const items = [
    { identifier: 'i-1', name: 'Kiolbassa', productUpc: '0074338007611', categoryMatchId: 'other', categoryAssignments: [] },
    { identifier: 'i-2', name: 'Eggs', categoryMatchId: 'other', categoryAssignments: [] },
  ];
  const { call } = fixture({ items });
  const text = await call({ action: 'list_items', include_barcodes: true });
  assert.match(text, /  - Kiolbassa \[barcode 0074338007611\]\n/);
  assert.match(text, /  - Eggs\n|  - Eggs$/);
  assert.doesNotMatch(await call({ action: 'list_items' }), /barcode/);
});

test("getLists gives each list its store filters", async () => {
  const lib = new AnyList({ email: 'test@example.com', password: 'unused', credentialsFile: '/nonexistent' });
  lib._userData = {
    mealPlanningCalendarResponse: {},
    starterListsResponse: { recentItemListsResponse: { listResponses: [] }, favoriteItemListsResponse: { listResponses: [] } },
    shoppingListsResponse: {
      newLists: [{ identifier: LIST, listId: 'p', name: 'Groceries', items: [] }],
      listResponses: [{ listId: LIST, stores: STORES, categoryGroupResponses: [], storeFilters: FILTERS }],
    },
  };
  const [list] = await lib.getLists(false);
  assert.deepEqual(list.storeFilters.map(f => [f.name, f.storeIds, f.categoryGroupId]),
    [['Big shop', ['s-7'], WALK], ['Walmart Items', ['s-9'], null]]);
});
