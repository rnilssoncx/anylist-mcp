import { createRequire } from 'node:module';
import AnyList from '../anylist-js/lib/index.js';
import Item from '../anylist-js/lib/item.js';
import { normalizeRecipe } from './recipe-normalizer.js';

const uuidv5 = createRequire(import.meta.url)('uuid/v5');

// AnyList's web client takes a list's default category set to be the one whose
// id is uuid5(list id, this namespace). Per BookCatKid/aioanylist.
const MAIN_SET_NAMESPACE = 'f656a81f-0e0a-419a-a451-21f4f2eac51b';
const MAX_ROWS = 25;

export const NO_MAIN_SET = "Couldn't tell which category set is the list's main one, so nothing was changed";

export function noStoreView(store) {
  return `No store view for "${store}". Make one in the AnyList app: a category set for ${store}, then a store filter for ${store} that uses it`;
}

export function usesMainCategories(store) {
  return `The "${store}" store view uses the main categories, so there is no ${store} set to sort into. In the AnyList app, give it its own category set`;
}

export function notInStoreSet(category, store) {
  return `${category} is not a category in the ${store} set, and only "Aisle <number>" is created automatically`;
}

// "aisle 22", "Aisle 22 ", "AISLE 07" → "Aisle 22" / "Aisle 7". Anything else
// — "Aisle 22 Dairy", "Aisle 22-23" — is not an aisle this creates.
function aisleName(text) {
  const m = /^aisle\s+(\d{1,3})$/i.exec(String(text || '').trim());
  return m ? `Aisle ${Number(m[1])}` : null;
}

function aisleNumber(name) {
  return Number(name.slice('Aisle '.length));
}

function nextSortIndex(group) {
  return Math.max(-1, ...group.categories.map(c => c.sortIndex)) + 1;
}

class AnyListClient {
  /**
   * @param {{ username?: string, password?: string, defaultListName?: string }} [credentials]
   *   Optional credentials. Falls back to ANYLIST_USERNAME / ANYLIST_PASSWORD / ANYLIST_LIST_NAME
   *   environment variables when not provided (stdio mode).
   */
  constructor({ username, password, defaultListName } = {}) {
    this.client = null;
    this.targetList = null;
    this._username = username || null;
    this._password = password || null;
    this.defaultListName = defaultListName || null;
  }

  async connect(listName = null) {
    const username = this._username || process.env.ANYLIST_USERNAME;
    const password = this._password || process.env.ANYLIST_PASSWORD;
    const targetListName = listName || this.defaultListName || process.env.ANYLIST_LIST_NAME;

    if (!username || !password) {
      const error = new Error('Missing AnyList credentials. Provide username and password.');
      console.error(error.message);
      throw error;
    }

    if (!targetListName) {
      const error = new Error('No list name provided and no default list configured');
      console.error(error.message);
      throw error;
    }

    try {
      // Create AnyList client if not already authenticated
      if (!this.client) {
        this.client = this._createLibraryClient({ email: username, password });

        // Authenticate. No websocket: connect() re-reads the lists on every
        // call, so its refresh has no reader, and its error handler is an async
        // listener whose token refresh throws when AnyList or the network is
        // down — an unhandled rejection that ended the process, and with it
        // every server in the container.
        console.error(`Connecting to AnyList as ${username}...`);
        await this.client.login(false);
        console.error('Successfully authenticated with AnyList');
      }

      // Re-read the lists on every call. The HTTP server keeps one client per
      // user for as long as it is used, and the library's websocket refresh was
      // measured not to reach it: a store changed from another login was still
      // the old one here half an hour later, and a write resolves names against
      // the same copy. One request per call is the price of answering from what
      // the list holds now rather than what it held when the session began.
      await this.client.getLists();

      // Find the target list
      console.error(`Looking for list: "${targetListName}"`);
      this.targetList = this.client.getListByName(targetListName);

      if (!this.targetList) {
        const error = new Error(`List "${targetListName}" not found. Available lists: ${this.getAvailableListNames().join(', ')}`);
        console.error(error.message);
        throw error;
      }

      console.error(`Connected to list: "${this.targetList.name}"`);

      return true;

    } catch (error) {
      const wrappedError = new Error(`Failed to connect to AnyList: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  /** The anylist-js client; a seam so tests can see how it is driven. */
  _createLibraryClient(options) {
    return new AnyList(options);
  }

  /**
   * Look up a product by barcode. Returns null when AnyList has no match; a
   * lookup that fails for any other reason throws.
   */
  async lookupUpc(upc) {
    if (!this.client) throw new Error('Not connected to AnyList. Call connect() first.');
    return this.client.lookupProduct(upc);
  }

  /** The item on the target list already carrying this barcode, if any. */
  findItemByUpc(upc) {
    return (this.targetList?.items || []).find(i => i.productUpc === upc) || null;
  }

  /**
   * Add a looked-up product as a new item, keeping its barcode and photo so
   * the apps show it as that product rather than as a typed name.
   */
  async addProduct(product, quantity = 1, notes = null) {
    if (!this.targetList) throw new Error('Not connected to any list. Call connect() first.');
    const options = { name: product.name, productUpc: product.productUpc, photoIds: product.photoIds || [] };
    // The lookup gives a category id, not a category; filed under the list's
    // category with that id, as one added in the app would be.
    if (product.categoryMatchId) {
      const category = this.findCategory(product.categoryMatchId);
      Object.assign(options, category ? Item.categoryFields(category) : { categoryMatchId: product.categoryMatchId });
    }
    if (notes !== null) options.details = notes;
    const rawQuantity = quantity == null ? "" : String(quantity).trim();
    if (rawQuantity !== "" && rawQuantity !== "1") options.quantity = rawQuantity;
    const item = this.client.createItem(options);
    await this.targetList.addItem(item);
    console.error(`Added product: ${item.name}`);
  }

  getAvailableListNames() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => list.name);
  }

  getLists() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => ({
      name: list.name,
      uncheckedCount: list.items ? list.items.filter(item => !item.checked).length : 0
    }));
  }

  // A quantity on an item already listed goes through Item.setQuantity: the
  // `quantity` setter and save() write only the legacy field, which the apps
  // do not render. A category applies to a new item only — re-adding one is
  // not a request to move it; set_item_category is.
  //
  // Returns what happened — "added", "rechecked" (it was checked off) or
  // "already" (it was on the list) — so the tool can say which.
  //
  // A store given here is added to the item's stores, never put in place of
  // them: a saved item is often bought at two or three, and re-adding it "from
  // Kroger" is not a request to forget the others.
  async addItem(itemName, quantity = 1, notes = null, category = null, store = null) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    let outcome = "added";
    try {
      // First, check if item already exists
      const existingItem = this.targetList.getItemByName(itemName);

      if (existingItem) {
        // Item exists - check if it's checked (completed)

        // Nothing changes the quantity unless one was given: "1" is the
        // default every caller passes, not a request to reset "2 lb".
        const newQuantity = quantity != null && String(quantity).trim() !== "1" ? quantity : null;
        if (existingItem.checked) {
          // Uncheck the item to make it active again
          existingItem.checked = false;
          if (notes !== null) {
            existingItem.details = notes;
          }

          console.error(`Unchecked existing item: ${existingItem.name}`);
          await existingItem.save();
          outcome = "rechecked";
        } else {
          console.error(`Item "${itemName}" already exists and is active`);
          if (notes !== null) {
            existingItem.details = notes;
            // Awaited: unawaited, a failed save is reported as success, and the
            // rejection, unhandled, ends the Node process — which start.sh
            // answers by stopping the whole container.
            await existingItem.save();
          }
          outcome = "already";
        }
        if (newQuantity !== null) {
          await existingItem.setQuantity(newQuantity);
        }
      } else {
        // Item doesn't exist, create new one
        const itemOptions = { name: itemName };
        if (notes !== null) {
          itemOptions.details = notes;
        }
        if (category) {
          const found = this.findCategory(category);
          if (!found) throw new Error(this.categoryNotFound(category));
          Object.assign(itemOptions, Item.categoryFields(found));
        }
        // Carry the quantity through creation so it lands in quantityPb.rawQuantity
        // (List.addItem encodes the item). Bare "1" is AnyList's default, so skip it.
        const rawQuantity = quantity == null ? "" : String(quantity).trim();
        if (rawQuantity !== "" && rawQuantity !== "1") {
          itemOptions.quantity = rawQuantity;
        }

        const newItem = this.client.createItem(itemOptions);
        await this.targetList.addItem(newItem);

        console.error(`Added new item: ${newItem.name}`);
      }

      if (store) {
        await this.setItemStores(itemName, [store], { add: true });
      }
      return outcome;

    } catch (error) {
      const wrappedError = new Error(`Failed to add item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async deleteItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't delete it`);
        console.error(error.message);
        throw error;
      }

      await this.targetList.removeItem(existingItem);
      console.error(`Deleted item: ${existingItem.name}`);

    } catch (error) {
      const wrappedError = new Error(`Failed to delete item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async removeItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Find the item by name
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't check it`);
        console.error(error.message);
        throw error;
      }

      // Check the item (mark as completed) instead of deleting. Says whether it
      // changed, so the tool does not report checking off what already was.
      if (!existingItem.checked) {
        existingItem.checked = true;
        await existingItem.save();
        console.error(`Checked off item: ${existingItem.name}`);
        return true;
      }
      console.error(`Item "${itemName}" is already checked off`);
      return false;
    } catch (error) {
      const wrappedError = new Error(`Failed to remove item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async uncheckItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't uncheck it`);
        console.error(error.message);
        throw error;
      }

      // Uncheck the item (mark as active again). No-op if already unchecked.
      if (existingItem.checked) {
        existingItem.checked = false;
        await existingItem.save();
        console.error(`Unchecked item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already unchecked`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to uncheck item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async getItems(includeChecked = false, includeNotes = false, includeBarcodes = false) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Get all items from the list
      const items = this.targetList.items || [];

      // Filter based on checked status
      const filteredItems = includeChecked
        ? items
        : items.filter(item => !item.checked);

      // Map to a clean format
      return filteredItems.map(item => {
        const result = {
          name: item.name,
          quantity: item.quantity ?? null,
          checked: item.checked || false,
          category: this.categoryNameOf(item)
        };
        if (includeNotes && item.details) {
          result.note = item.details;
        }
        if (includeBarcodes && item.productUpc) {
          result.barcode = item.productUpc;
        }
        const stores = (item.storeIds || [])
          .map(id => (this.targetList.stores || []).find(s => s.identifier === id))
          .filter(Boolean)
          .map(s => s.name);
        result.store = stores.length ? stores.join(", ") : null;
        
        return result;
      });
    } catch (error) {
      const wrappedError = new Error(`Failed to get items: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  _buildCategoryMap() {
    const categoryMap = {};
    try {
      // Access the raw user data from the client to get category groups
      const userData = this.client._userData;
      if (userData && userData.shoppingListsResponse && userData.shoppingListsResponse.categoryGroupResponses) {
        for (const groupResponse of userData.shoppingListsResponse.categoryGroupResponses) {
          if (groupResponse.categoryGroup && groupResponse.categoryGroup.categories) {
            for (const category of groupResponse.categoryGroup.categories) {
              if (category.identifier && category.name) {
                categoryMap[category.identifier] = category.name;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to build category map: ${error.message}`);
    }
    return categoryMap;
  }

  // ===== STORES =====

  getStores() {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    return this.targetList.stores || [];
  }

  // Sets an item's stores to exactly `storeNames` (empty clears them), or with
  // `add` adds them to the ones it has. An item can be at several stores, so
  // replacing is never silent: the result names what was removed. Names come
  // back in AnyList's spelling, not the caller's.
  async setItemStores(itemName, storeNames, { add = false } = {}) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    const stores = this.targetList.stores || [];
    const wanted = storeNames.filter(Boolean).map(name => {
      const store = stores.find(s => storeNameKey(s.name) === storeNameKey(name));
      if (!store) {
        const available = stores.map(s => s.name).join(', ') || 'none';
        throw new Error(`Store "${name}" not found. Available stores: ${available}`);
      }
      return store.identifier;
    });
    const current = item.storeIds || [];
    const storeIds = [...new Set(add ? [...current, ...wanted] : wanted)];
    const nameOf = id => (stores.find(s => s.identifier === id) || {}).name || id;
    await item.setStores(storeIds);
    return {
      stores: storeIds.map(nameOf),
      removed: current.filter(id => !storeIds.includes(id)).map(nameOf),
    };
  }

  // Changes an item already on the list. Fields left undefined are untouched.
  // A new name that another item already has is refused: every lookup here is
  // by name, so two items sharing one would make the second unreachable.
  async updateItem(itemName, { newName, quantity, notes } = {}) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    if (newName !== undefined) {
      const cleanName = String(newName).trim();
      if (!cleanName) throw new Error('New name is required.');
      const other = this.targetList.getItemByName(cleanName);
      if (other && other !== item) {
        throw new Error(`An item named "${other.name}" is already on the list${other.checked ? " (checked off)" : ""}`);
      }
      item.name = cleanName;
    }
    if (notes !== undefined) item.details = notes;
    if (newName !== undefined || notes !== undefined) await item.save();
    if (quantity !== undefined) await item.setQuantity(quantity);
    return item.name;
  }

  findStore(storeName) {
    return this.getStores().find(s => storeNameKey(s.name) === storeNameKey(storeName)) || null;
  }

  // Store names are matched the way set_item_store matches them, so a store
  // that "h.e.b." would find is one that "H.E.B." cannot be created beside.
  async createStore(storeName) {
    const existing = this.findStore(storeName);
    if (existing) {
      throw new Error(`Store "${existing.name}" already exists`);
    }
    return this.targetList.createStore(storeName);
  }

  async renameStore(storeName, newName) {
    const store = this.findStore(storeName);
    if (!store) {
      const available = this.getStores().map(s => s.name).join(', ') || 'none';
      throw new Error(`Store "${storeName}" not found. Available stores: ${available}`);
    }
    const clash = this.findStore(newName);
    if (clash && clash.identifier !== store.identifier) {
      throw new Error(`Store "${clash.name}" already exists`);
    }
    const oldName = store.name;
    await this.targetList.renameStore(store.identifier, newName);
    return { oldName, newName: store.name };
  }

  // Returns which items were assigned to it, which the deletion leaves without
  // a store: active ones by name, saved (checked-off) ones as a count, since a
  // list's history can run to dozens.
  async deleteStore(storeName) {
    const store = this.findStore(storeName);
    if (!store) {
      const available = this.getStores().map(s => s.name).join(', ') || 'none';
      throw new Error(`Store "${storeName}" not found. Available stores: ${available}`);
    }
    const assigned = (this.targetList.items || []).filter(i => (i.storeIds || []).includes(store.identifier));
    await this.targetList.deleteStore(store.identifier);
    return {
      name: store.name,
      activeItems: assigned.filter(i => !i.checked).map(i => i.name),
      savedCount: assigned.filter(i => i.checked).length,
    };
  }

  // ===== CATEGORIES =====
  //
  // A list can hold several category sets ("category groups"): the household's
  // ordinary one, and one per store view that has its own walk order. Every
  // lookup here names its set. Taking the first one, or every one, is how a
  // Kroger aisle would land in the ordinary view — the outcome plans/010 calls
  // the one that must not happen.

  // The household's ordinary set, by AnyList's own rule: the group whose id is
  // uuid5(list id, MAIN_SET_NAMESPACE) — true of every list on the account
  // (checked 2026-10-26). With no such group nothing is guessed, because the
  // guess is the defect.
  mainSet() {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const id = uuidv5(this.targetList.identifier, MAIN_SET_NAMESPACE).replace(/-/g, '');
    const group = (this.targetList.categoryGroups || []).find(g => g.identifier === id);
    if (!group) throw new Error(NO_MAIN_SET);
    return group;
  }

  // The set a store's view uses, found through the store filters by the
  // store's id — never by a set's or a filter's name, which the household
  // chooses freely ("Big shop", or a set that happens to be called "Kroger").
  // Returns the set and AnyList's spelling of the store, which is what the
  // words say: a sentence about AnyList's set names the store as AnyList does.
  storeSet(storeName) {
    const main = this.mainSet();
    const store = this.findStore(storeName);
    const filters = store
      ? (this.targetList.storeFilters || []).filter(f => f.storeIds.includes(store.identifier))
      : [];
    // AnyList's spelling once the store is found; the caller's only when it
    // is not.
    const named = store ? store.name : storeName;
    if (filters.length === 0) throw new Error(noStoreView(named));
    const sets = [...new Set(filters.map(f => f.categoryGroupId).filter(Boolean))];
    if (sets.length > 1) throw new Error(`Two store views for "${named}" use different category sets, so it is not clear which to sort into`);
    if (sets.length === 0 || sets[0] === main.identifier) throw new Error(usesMainCategories(named));
    const group = this.targetList.categoryGroups.find(g => g.identifier === sets[0]);
    if (!group) throw new Error(`The "${named}" store view uses a category set the list doesn't have, so nothing was changed`);
    return { group, store: store.name };
  }

  // Items answering to a name, ignoring case — the rule's own key. Two of them
  // share one rule, so a move of one would re-file the other on its next add.
  _itemsNamed(name) {
    const key = String(name).toLowerCase();
    return (this.targetList.items || []).filter(i => i.name.toLowerCase() === key);
  }

  // A set's categories in AnyList's order, each carrying its set's id.
  getCategories(group = this.mainSet()) {
    return [...group.categories]
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map(category => ({ ...category, categoryGroupId: group.identifier }));
  }

  // A category by its name or its id, matched the way AnyList files items:
  // "Condiments & Dressings", "condiments-oils-and-salad-dressings" and
  // "penzy's" all find theirs.
  findCategory(nameOrId, group = this.mainSet()) {
    const key = Item.categoryMatchId({ name: nameOrId });
    if (!key) return null;
    return this.getCategories(group).find(c => c.systemCategory === key || Item.categoryMatchId({ name: c.name }) === key) || null;
  }

  categoryNotFound(name) {
    const available = this.getCategories().map(c => c.name).join(', ') || 'none';
    return `Category "${name}" not found in list "${this.targetList.name}". Available categories: ${available}`;
  }

  // The name of the category an item shows under in a set: its assignment
  // there if it has one, else the category its match id files it in, else the
  // set's default — as the apps draw it.
  categoryNameOf(item, group = this.mainSet()) {
    const categories = this.getCategories(group);
    const assignment = (item.categoryAssignments || []).find(a => a.categoryGroupId === group.identifier);
    const assigned = assignment && categories.find(c => c.identifier === assignment.categoryId);
    if (assigned) return assigned.name;
    const matchId = item.categoryMatchId || 'other';
    const filed = categories.find(c => Item.categoryMatchId(c) === matchId)
      // A match id the set has no category for is drawn under the set's
      // default, Other (plans/010, S4, seen in the app).
      || categories.find(c => c.identifier === group.defaultCategoryId)
      || categories.find(c => c.systemCategory === 'other');
    return filed ? filed.name : matchId;
  }

  // Every main-set category with a system id is copied into a store's set,
  // with its name, icon and system id: a set made in the app starts with only
  // "Other", and the app files an unsorted item under the category whose
  // system id is its match id — so with the copy, an item Kroger cannot place
  // shows under its usual department at Kroger rather than in one pile.
  // Present already means the same system id or the same name, so a second
  // call, or a department made or renamed by hand, makes nothing. The
  // household's own categories have no system id and are not copied: a
  // "Walmart" category has no place in the Kroger walk. Returns how many were
  // made; one request, refused whole if it fails.
  async ensureDepartments(group, storeName) {
    const have = this.getCategories(group);
    const missing = this.getCategories().filter(m => m.systemCategory && !have.some(c =>
      c.systemCategory === m.systemCategory || Item.categoryMatchId({ name: c.name }) === Item.categoryMatchId({ name: m.name })));
    if (missing.length === 0) return 0;
    let next = Math.max(-1, ...have.map(c => c.sortIndex)) + 1;
    try {
      await this.targetList.createCategories(missing.map(m => ({
        name: m.name, categoryGroupId: group.identifier, systemCategory: m.systemCategory, icon: m.icon || undefined, sortIndex: next++,
      })));
    } catch (error) {
      // "No items were sorted", not "nothing was changed": whether the server
      // applies a request of several operations all-or-nothing is not
      // measured, so some departments may exist now. The next call makes the
      // rest.
      throw new Error(`Couldn't add the main set's departments to the ${storeName} set, so no items were sorted: ${error.message}`);
    }
    return missing.length;
  }

  // The rule is what the app reads when the item is next added there; without
  // it, the move is undone by the household's next re-add (plans/010, S5). It
  // is written after the assignment, so a failed move leaves the rule as it
  // was. A failure here is returned, not thrown: the item has moved.
  async _saveRule(item, category) {
    try {
      await this.targetList.saveCategorizationRule({
        itemName: item.name, categoryGroupId: category.categoryGroupId, categoryId: category.identifier,
      });
      return null;
    } catch (error) {
      return error.message;
    }
  }

  // Moves an item, in the main set or — with `store` — in that store's set.
  // Refusals throw before any write. After the first write, what happened is
  // returned rather than thrown — `kind` 'moved', 'not-created' (the aisle it
  // needs could not be made) or 'failed' (the assignment request failed) —
  // because departments may already have been copied, and the words have to
  // say so.
  async setItemCategory(itemName, categoryName, { store = null } = {}) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const { group, store: storeName } = store ? this.storeSet(store) : { group: this.mainSet(), store: null };
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    if (this._itemsNamed(itemName).length > 1) {
      throw new Error(`Two items on the list are called "${itemName}", ignoring case, and AnyList keeps one rule for both, so nothing was changed`);
    }
    // Checked before the departments are copied, so a refused category writes
    // nothing: in the store's set already, an aisle, or a main-set department
    // the copy is about to make.
    const copied = store && this.findCategory(categoryName)?.systemCategory;
    if (!this.findCategory(categoryName, group) && !(store && aisleName(categoryName)) && !copied) {
      throw new Error(store ? notInStoreSet(categoryName, storeName) : this.categoryNotFound(categoryName));
    }
    const departmentsAdded = store ? await this.ensureDepartments(group, storeName) : 0;
    const result = { departmentsAdded, store: storeName };
    let category = this.findCategory(categoryName, group);
    if (!category) {
      try {
        [category] = await this.targetList.createCategories([{
          name: aisleName(categoryName), categoryGroupId: group.identifier, sortIndex: nextSortIndex(group),
        }]);
      } catch (error) {
        return { ...result, kind: 'not-created', aisle: aisleName(categoryName), error: error.message };
      }
    }
    const from = this.categoryNameOf(item, group);
    // The match id only for the main set: it is item-level, and every other
    // set files an unassigned item by it.
    try {
      await item.assignCategory(category, { matchId: !store });
    } catch (error) {
      return { ...result, kind: 'failed', error: error.message };
    }
    const ruleError = await this._saveRule(item, category);
    return { ...result, kind: 'moved', from, to: category.name, ruleError };
  }

  // Up to 25 rows of {name, category} into a store's set. Whole-call refusals
  // (no main set, no usable store view, departments not copied) throw before
  // any write; after that each row has its own outcome and one row's failure
  // does not stop the rest.
  async setItemCategories(storeName, rows) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    if (rows.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} items at a time — this call had ${rows.length}`);
    const { group, store } = this.storeSet(storeName);
    const departmentsAdded = await this.ensureDepartments(group, store);

    const outcomes = rows.map(row => {
      const named = this._itemsNamed(row.name);
      if (named.length === 0) return { name: row.name, kind: 'not-on-list' };
      if (named.length > 1) return { name: row.name, kind: 'duplicate' };
      const category = this.findCategory(row.category, group);
      if (category) return { name: row.name, item: named[0], category };
      if (aisleName(row.category)) return { name: row.name, item: named[0], aisle: aisleName(row.category) };
      return { name: row.name, kind: 'refused', asked: row.category };
    });

    // The aisles the rows need and the set lacks, made in one request in
    // number order — the order Kroger's aisles are walked until someone drags
    // them.
    const needed = [...new Set(outcomes.filter(o => o.aisle).map(o => o.aisle))]
      .filter(name => !this.findCategory(name, group))
      .sort((a, b) => aisleNumber(a) - aisleNumber(b));
    let createError = null;
    if (needed.length) {
      let next = nextSortIndex(group);
      try {
        await this.targetList.createCategories(needed.map(name => ({ name, categoryGroupId: group.identifier, sortIndex: next++ })));
      } catch (error) {
        createError = error.message;
      }
    }
    for (const o of outcomes.filter(o => o.aisle)) {
      if (createError && needed.includes(o.aisle)) Object.assign(o, { kind: 'not-created', error: createError });
      else o.category = this.findCategory(o.aisle, group);
    }

    for (const o of outcomes.filter(o => o.category && !o.kind)) {
      try {
        await o.item.assignCategory(o.category, { matchId: false });
      } catch (error) {
        Object.assign(o, { kind: 'failed', error: error.message });
        continue;
      }
      o.kind = 'assigned';
      o.ruleError = await this._saveRule(o.item, o.category);
    }

    // A new aisle is said once: on the first row that landed in it, or — when
    // none did — on the first that tried, which then says the aisle is empty.
    if (!createError) {
      for (const aisle of needed) {
        const rowsIn = outcomes.filter(o => o.aisle === aisle);
        (rowsIn.find(o => o.kind === 'assigned') || rowsIn[0]).created = true;
      }
    }
    return { departmentsAdded, outcomes, store };
  }

  // ===== RECIPES =====

  async getRecipes(searchQuery = null) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      let results = recipes.map(r => ({
        identifier: r.identifier,
        name: r.name,
        note: r.note || null,
        sourceName: r.sourceName || null,
        sourceUrl: r.sourceUrl || null,
        rating: r.rating || null,
        prepTime: r.prepTime || null,
        cookTime: r.cookTime || null,
        servings: r.servings || null,
        ingredientCount: r.ingredients ? r.ingredients.length : 0,
        stepCount: r.preparationSteps ? r.preparationSteps.length : 0,
      }));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        results = results.filter(r => r.name && r.name.toLowerCase().includes(q));
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to get recipes: ${error.message}`);
    }
  }

  async getRecipeDetails(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      return {
        identifier: recipe.identifier,
        name: recipe.name,
        note: recipe.note || null,
        sourceName: recipe.sourceName || null,
        sourceUrl: recipe.sourceUrl || null,
        rating: recipe.rating || null,
        prepTime: recipe.prepTime || null,
        cookTime: recipe.cookTime || null,
        servings: recipe.servings || null,
        nutritionalInfo: recipe.nutritionalInfo || null,
        createdAt: recipe.creationTimestamp
          ? new Date(recipe.creationTimestamp * 1000).toISOString()
          : (recipe.timestamp ? new Date(recipe.timestamp * 1000).toISOString() : null),
        ingredients: recipe.ingredients ? recipe.ingredients.map(i => ({
          rawIngredient: i.rawIngredient || null,
          name: i.name || null,
          quantity: i.quantity || null,
          note: i.note || null,
        })) : [],
        preparationSteps: recipe.preparationSteps || [],
      };
    } catch (error) {
      throw new Error(`Failed to get recipe details: ${error.message}`);
    }
  }

  async importRecipeFromUrl(url) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Try AnyList's native web import first
    let nativeError = null;
    try {
      const result = await this.client.client.post('data/recipes/web-import?url=' + encodeURIComponent(url));
      const decoded = this.client.protobuf.PBRecipeWebImportResponse.decode(result.body);

      if (decoded.statusCode === 0 && decoded.recipe) {
        // Native import succeeded
        const recipe = await this.client.createRecipe({
          name: decoded.recipe.name,
          note: decoded.recipe.note || null,
          sourceName: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          prepTime: decoded.recipe.prepTime || null,
          cookTime: decoded.recipe.cookTime || null,
          servings: decoded.recipe.servings || null,
          nutritionalInfo: decoded.recipe.nutritionalInfo || null,
          rating: decoded.recipe.rating || null,
          ingredients: decoded.recipe.ingredients || [],
          preparationSteps: decoded.recipe.preparationSteps || [],
        });
        recipe.isNewRecipeFromWebImport = true;
        recipe.creationTimestamp = Date.now() / 1000;
        await recipe.save();
        console.error(`Imported recipe from URL (native): ${recipe.name}`);

        return {
          name: recipe.name,
          identifier: recipe.identifier,
          ingredientCount: decoded.recipe.ingredients?.length || 0,
          stepCount: decoded.recipe.preparationSteps?.length || 0,
          source: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          isPremiumUser: decoded.isPremiumUser,
          freeImportsRemaining: decoded.freeRecipeImportsRemainingCount,
          method: 'native',
        };
      }
      nativeError = decoded.siteSpecificHelpText || 'Native import returned no recipe';
    } catch (error) {
      nativeError = error.message;
    }

    // Fallback: use normalizer
    console.error(`Native import failed (${nativeError}), trying normalizer fallback...`);
    try {
      const normalized = await normalizeRecipe({ url });
      const created = await this.createRecipe({
        name: normalized.name,
        ingredients: normalized.ingredients,
        preparationSteps: normalized.preparationSteps,
        note: normalized.note,
        sourceName: normalized.sourceName,
        sourceUrl: normalized.sourceUrl || url,
        prepTime: normalized.prepTime,
        cookTime: normalized.cookTime,
        servings: normalized.servings,
      });
      console.error(`Imported recipe from URL (normalizer fallback): ${created.name}`);

      return {
        name: created.name,
        identifier: created.identifier,
        ingredientCount: normalized.ingredients.length,
        stepCount: normalized.preparationSteps.length,
        source: normalized.sourceName || null,
        sourceUrl: normalized.sourceUrl || url,
        method: 'normalizer',
      };
    } catch (fallbackError) {
      throw new Error(`Failed to import recipe from URL: native import failed (${nativeError}), normalizer also failed (${fallbackError.message})`);
    }
  }

  async createRecipe({ name, ingredients = [], preparationSteps = [], note = null, sourceName = null, sourceUrl = null, prepTime = null, cookTime = null, servings = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const nowSecs = Date.now() / 1000;
      const recipeObj = { name, creationTimestamp: nowSecs };
      if (note) recipeObj.note = note;
      if (sourceName) recipeObj.sourceName = sourceName;
      if (sourceUrl) recipeObj.sourceUrl = sourceUrl;
      if (prepTime) recipeObj.prepTime = prepTime;
      if (cookTime) recipeObj.cookTime = cookTime;
      if (servings) recipeObj.servings = servings;
      if (preparationSteps.length > 0) recipeObj.preparationSteps = preparationSteps;
      if (ingredients.length > 0) {
        recipeObj.ingredients = ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
        }));
      }
      const recipe = await this.client.createRecipe(recipeObj);
      await recipe.save();
      console.error(`Created recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to create recipe: ${error.message}`);
    }
  }

  /**
   * Partially update an existing recipe in place.
   *
   * Only the fields present in `fields` are changed; every other field
   * (identifier, note, photos, rating, timestamps, and any field not passed)
   * is carried over from the existing recipe. This is a real in-place update
   * (`save-recipe` on the same identifier), NOT a delete + recreate, so recipe
   * collection membership and meal-plan links that reference the recipe id
   * survive untouched.
   *
   * `ingredients` and `preparationSteps`, when provided, REPLACE the existing
   * array wholesale — they are not merged item-by-item.
   *
   * @param {string} recipeName - name identifying the recipe to update
   * @param {object} fields - subset of { name, note, sourceName, sourceUrl,
   *   prepTime, cookTime, servings, ingredients, preparationSteps }; keys with an
   *   `undefined` value are ignored. `name` renames the recipe in place.
   */
  async updateRecipe(recipeName, fields = {}) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const matches = recipes.filter(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (matches.length === 0) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple recipes named "${recipeName}" (${matches.length}) exist. Rename or remove the duplicates so the target is unambiguous, then try again.`);
      }
      const existing = matches[0];
      if (fields.name !== undefined && recipes.some(r => r !== existing && r.name && r.name.toLowerCase() === fields.name.toLowerCase())) {
        throw new Error(`Cannot rename to "${fields.name}": a recipe with that name already exists.`);
      }

      // Start from every existing field so nothing is lost on save, then
      // override only the provided fields. Existing ingredients are serialized
      // via toJSON() to preserve their identifiers and headings.
      const merged = {
        identifier: existing.identifier,
        name: existing.name,
        note: existing.note,
        sourceName: existing.sourceName,
        sourceUrl: existing.sourceUrl,
        prepTime: existing.prepTime,
        cookTime: existing.cookTime,
        servings: existing.servings,
        rating: existing.rating,
        nutritionalInfo: existing.nutritionalInfo,
        scaleFactor: existing.scaleFactor,
        paprikaIdentifier: existing.paprikaIdentifier,
        creationTimestamp: existing.creationTimestamp,
        photoIds: existing.photoIds,
        photoUrls: existing.photoUrls,
        preparationSteps: existing.preparationSteps,
        ingredients: existing.ingredients.map(i => i.toJSON()),
      };

      for (const key of ['name', 'note', 'sourceName', 'sourceUrl', 'prepTime', 'cookTime', 'servings', 'preparationSteps']) {
        if (fields[key] !== undefined) merged[key] = fields[key];
      }
      if (fields.ingredients !== undefined) {
        merged.ingredients = fields.ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
        }));
      }

      const recipe = await this.client.createRecipe(merged);
      await recipe.save();
      console.error(`Updated recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to update recipe: ${error.message}`);
    }
  }

  async deleteRecipe(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      await recipe.delete();
      console.error(`Deleted recipe: ${recipe.name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe: ${error.message}`);
    }
  }

  // ===== MEAL PLANNING =====

  async getMealPlanEvents() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      return events.map(e => ({
        identifier: e.identifier,
        date: e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date),
        title: e.title || null,
        details: e.details || null,
        labelName: e.label ? e.label.name : null,
        labelColor: e.label ? e.label.hexColor : null,
        recipeName: e.recipe ? e.recipe.name : null,
        recipeId: e.recipeId || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan events: ${error.message}`);
    }
  }

  async getMealPlanLabels() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.client.getMealPlanningCalendarEvents();
      return (this.client.mealPlanningCalendarEventLabels || []).map(l => ({
        identifier: l.identifier,
        name: l.name,
        hexColor: l.hexColor,
        sortIndex: l.sortIndex,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan labels: ${error.message}`);
    }
  }

  async createMealPlanEvent({ date, title = null, recipeId = null, labelId = null, details = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const eventObj = { date: new Date(`${date}T12:00:00`) };
      if (title) eventObj.title = title;
      if (recipeId) eventObj.recipeId = recipeId;
      if (labelId) eventObj.labelId = labelId;
      if (details) eventObj.details = details;
      const event = await this.client.createEvent(eventObj);
      await event.save();
      console.error(`Created meal plan event for ${date}`);
      return { identifier: event.identifier, date: date };
    } catch (error) {
      throw new Error(`Failed to create meal plan event: ${error.message}`);
    }
  }

  async deleteMealPlanEvent(eventId) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      const event = events.find(e => e.identifier === eventId);
      if (!event) {
        throw new Error(`Meal plan event "${eventId}" not found`);
      }
      await event.delete();
      console.error(`Deleted meal plan event: ${eventId}`);
    } catch (error) {
      throw new Error(`Failed to delete meal plan event: ${error.message}`);
    }
  }

  // ===== FAVORITES & RECENTS =====

  async getFavoriteItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const favList = this.client.getFavoriteItemsByListId(this.targetList.identifier);
      if (!favList || !favList.items) {
        return [];
      }
      return favList.items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get favorite items: ${error.message}`);
    }
  }

  async getRecentItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const items = this.client.getRecentItemsByListId(this.targetList.identifier);
      if (!items) {
        return [];
      }
      return items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get recent items: ${error.message}`);
    }
  }

  // ===== RECIPE COLLECTIONS =====

  async getRecipeCollections() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      return collections.map(c => ({
        identifier: c.identifier,
        name: c.name,
        recipeCount: c.recipeIds ? c.recipeIds.length : 0,
        recipeNames: (c.recipeIds || []).map(id => {
          const r = recipes.find(r => r.identifier === id);
          return r ? r.name : id;
        }),
      }));
    } catch (error) {
      throw new Error(`Failed to get recipe collections: ${error.message}`);
    }
  }

  async createRecipeCollection(name, recipeNames = []) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipeIds = [];
      if (recipeNames.length > 0) {
        const recipes = await this.client.getRecipes();
        for (const rName of recipeNames) {
          const r = recipes.find(r => r.name && r.name.toLowerCase() === rName.toLowerCase());
          if (r) recipeIds.push(r.identifier);
        }
      }
      const collection = this.client.createRecipeCollection({ name, recipeIds });
      await collection.save();
      console.error(`Created recipe collection: ${name}`);
      return { identifier: collection.identifier, name: collection.name };
    } catch (error) {
      throw new Error(`Failed to create recipe collection: ${error.message}`);
    }
  }

  async deleteRecipeCollection(name) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const raw = collections.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
      if (!raw) throw new Error(`Recipe collection "${name}" not found`);
      const collection = this.client.createRecipeCollection(raw);
      await collection.delete();
      console.error(`Deleted recipe collection: ${name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe collection: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.teardown();
        console.error('Disconnected from AnyList');
      } catch (error) {
        const wrappedError = new Error(`Error during disconnect: ${error.message}`);
        console.error(wrappedError.message);
        throw wrappedError;
      }
    }
    this.client = null;
    this.targetList = null;
  }
}

/**
 * How a store name is compared. The tool's check and the write must agree, or
 * "h.e.b." passes the check, the item is added, and the store lookup then fails
 * with the item already on the list. Case is ignored, and a curly apostrophe
 * matches a straight one: AnyList stores "Trader Joe’s", and nobody types that.
 */
export function storeNameKey(name) {
  return String(name).trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

export default AnyListClient;
