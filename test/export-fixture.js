/**
 * An account as anylist-js models it, for the export and the restore action.
 *
 * Built from the library's own List and Item, so the export reads the getters
 * it reads in production. Every id differs from every name — and one list's
 * identifier is another list's name ("Costco" is identified as "Groceries") —
 * so a lookup by the wrong key answers with the wrong list instead of the
 * right one by coincidence.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const List = require('../anylist-js/lib/list.js');
const Item = require('../anylist-js/lib/item.js');
const uuidv5 = require('uuid/v5');

const MAIN_SET_NAMESPACE = 'f656a81f-0e0a-419a-a451-21f4f2eac51b';
const mainSetId = listId => uuidv5(listId, MAIN_SET_NAMESPACE).replace(/-/g, '');

export const GROCERIES_ID = 'a1b2c3d4e5f60718';
export const COSTCO_ID = 'Groceries';

const lib = { client: null, protobuf: null, uid: null };
const item = fields => new Item(fields, lib);

function group(listId, identifier, name, categories, defaultCategoryId) {
  return { categoryGroup: { identifier, name, listId, defaultCategoryId, categories } };
}

export function fakeAccount({ empty = false } = {}) {
  const lists = [];
  const recentItems = {};
  if (!empty) {
    const groceries = new List({
      identifier: GROCERIES_ID,
      listId: 'parent-1',
      name: 'Groceries',
      items: [
        { identifier: 'i-milk', listId: GROCERIES_ID, name: 'Milk', details: 'whole', checked: false,
          categoryMatchId: 'dairy', quantityPb: { rawQuantity: '2' }, storeIds: ['s-k1'],
          categoryAssignments: [
            { identifier: 'ca-1', categoryGroupId: mainSetId(GROCERIES_ID), categoryId: 'c-dairy' },
            { identifier: 'ca-2', categoryGroupId: 'g-kroger', categoryId: 'c-aisle5' },
          ] },
        { identifier: 'i-banana', listId: GROCERIES_ID, name: 'Bananas', checked: false, categoryMatchId: 'produce' },
        { identifier: 'i-bread', listId: GROCERIES_ID, name: 'Old Bread', checked: true, categoryMatchId: 'other', productUpc: '0001234500012', photoIds: ['p-1'] },
      ],
    }, { ...lib, stores: [{ identifier: 's-k1', listId: GROCERIES_ID, name: 'Kroger', sortIndex: 0, logicalTimestamp: { low: 5, high: 0, unsigned: true } }] });
    groceries._setCategoryGroups([
      group(GROCERIES_ID, mainSetId(GROCERIES_ID), 'Default', [
        { identifier: 'c-dairy', name: 'Dairy', systemCategory: 'dairy', sortIndex: 0 },
        { identifier: 'c-produce', name: 'Produce', systemCategory: 'produce', sortIndex: 1 },
        { identifier: 'c-other', name: 'Other', systemCategory: 'other', sortIndex: 2 },
      ], 'c-other'),
      group(GROCERIES_ID, 'g-kroger', 'Big shop', [
        { identifier: 'c-aisle5', name: 'Aisle 5', sortIndex: 0 },
      ], 'c-aisle5'),
    ]);
    groceries._setStoreFilters([{ identifier: 'f-1', name: 'Kroger view', storeIds: ['s-k1'], listCategoryGroupId: 'g-kroger' }]);

    const costco = new List({
      identifier: COSTCO_ID,
      listId: 'parent-2',
      name: 'Costco',
      items: [{ identifier: 'i-towels', listId: COSTCO_ID, name: 'Paper Towels', checked: false, categoryMatchId: 'other' }],
    }, { ...lib, stores: [] });
    costco._setCategoryGroups([
      group(COSTCO_ID, mainSetId(COSTCO_ID), 'Default', [{ identifier: 'c-other-2', name: 'Other', systemCategory: 'other', sortIndex: 0 }], 'c-other-2'),
    ]);

    lists.push(groceries, costco);
    // A recent entry's own listId is its starter list's, not the shopping list's.
    recentItems[GROCERIES_ID] = [item({ identifier: 'r-eggs', listId: 'starter-9', name: 'Eggs' })];
  }

  const calls = [];
  return {
    calls,
    lists: [],
    recentItems: {},
    async login(ws) { calls.push(['login', ws]); },
    async getLists() { calls.push(['getLists']); this.lists = lists; this.recentItems = recentItems; return lists; },
    teardown() { calls.push(['teardown']); },
  };
}
