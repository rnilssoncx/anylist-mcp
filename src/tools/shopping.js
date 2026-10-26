import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";
import { storeNameKey } from "../anylist-client.js";

  // TODO: What does this do?
function buildDescription(stores) {
  const base = `Manage AnyList shopping lists and items. Actions:
- list_lists: Show all lists with item counts
- list_items: Show items on a list (grouped by category)
- add_item: Add an item to a list. A name is matched against items already saved on the list (specific products, often scanned): one match is re-added, several are listed back without adding anything — ask which one, or resend with exact: true
- add_items: Add several items to a list in one call (use this instead of repeating add_item); entries are matched the same way
- update_item: Change an item already on the list — its name (new_name), quantity or notes. Its stores, barcode and photo are kept
- set_item_category: Move an item already on the list into a category (category)
- list_categories: List the list's categories — AnyList's built-in ones and the household's own
- set_item_store: Set the stores for an item already on the list (store_names, or store_name for one); an empty list clears them. This replaces the item's stores — list_items shows the ones it has, and the reply names any removed
- check_item: Check off (complete) an item
- uncheck_item: Uncheck a previously checked-off item (make it active again)
- delete_item: Permanently remove an item from a list
- get_favorites: Get favorite items for a list
- get_recents: Get recently added items for a list
- list_stores: list stores available for the list (if any)
- create_store: Add a store to the list (store_name)
- rename_store: Rename a store (store_name, new_store_name); items assigned to it stay assigned
- delete_store: Delete a store (store_name). Items assigned to it are left with no store, so confirm with the person first
- lookup_upc: Say what product a barcode is, and whether it is already saved on the list
- add_by_upc: Add a product by barcode. An item already saved with that barcode is re-added; otherwise the looked-up product is added with its barcode and photo`;
  if (!stores || stores.length === 0) return base;
  const storeList = stores.map(s => s.name).join(', ');
  return `${base}\n\nAvailable stores: ${storeList}`;
}

// The list's categories are the household's, not a fixed set: a name AnyList
// does not have is refused here, before anything is written, with the ones it
// does.
function validateCategory(client, category) {
  if (!category || client.findCategory(category)) return { valid: true, message: null };
  return { valid: false, message: client.categoryNotFound(category) };
}

async function validateStoreName(client, storeName) {
  if (!storeName) return { valid: true, message: null };
  const stores = client.getStores();
  for (const name of [].concat(storeName)) {
    if (!stores.some(s => storeNameKey(s.name) === storeNameKey(name))) {
      return { valid: false, message: `Store "${name}" not found in list "${client.targetList.name}". Available stores: ${stores.map(s => s.name).join(", ")}.
    Use create_store to add it, then try again.` };
    }
  }
  return { valid: true, message: null };
}

export function register(server, getClient) {
  const { elicitListName, elicitItemChoice, elicitRequiredField } = createElicitationHelpers(server);

  function findPartialMatches(client, itemName, wantChecked = false) {
    const items = client.targetList.items || [];
    const lower = itemName.toLowerCase();
    return items
      .filter(i => Boolean(i.checked) === wantChecked && i.name.toLowerCase().includes(lower))
      .map(i => i.name);
  }

  async function resolveItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact) return itemName;
    const matches = findPartialMatches(client, itemName);
    if (matches.length === 0) throw new Error(`Item "${itemName}" not found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  // Symmetric to resolveItemName, but resolves against checked-off items —
  // used by uncheck_item, which only makes sense on an already-checked item.
  async function resolveCheckedItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact && exact.checked) return itemName;
    const matches = findPartialMatches(client, itemName, true);
    if (matches.length === 0) throw new Error(`No checked-off item matching "${itemName}" found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  // Items already on the list, checked or not, are specific products — a
  // scanned "Beemster Swiss Cheese" with its store, not "cheese". Re-adding one
  // by its exact name keeps all of that, so a requested name is matched against
  // them first. A trailing plural is dropped so "sausages" finds "sausage".
  function findSavedMatches(client, itemName) {
    const lower = itemName.toLowerCase().trim();
    const stem = lower.length > 3 ? lower.replace(/(es|s)$/, "") : lower;
    const names = (client.targetList.items || [])
      .map(i => i.name)
      .filter(n => n.toLowerCase().includes(lower) || n.toLowerCase().includes(stem));
    return [...new Set(names)];
  }

  // One match is used; several are a question for the person, so nothing is
  // added. An exact name that also matches more specific items does not win
  // silently — the specific product is usually what was meant. `exact` skips
  // matching, for "just add it as I said".
  function resolveAddName(client, itemName, exact) {
    if (exact) return { name: itemName };
    const matches = findSavedMatches(client, itemName);
    if (matches.length === 0) return { name: itemName };
    if (matches.length === 1) return { name: matches[0] };
    return { choices: matches };
  }

  // Barcodes are digits; scanners and people add spaces and dashes.
  function normaliseUpc(upc) {
    const digits = String(upc || "").replace(/[\s-]/g, "");
    if (!/^\d{8,14}$/.test(digits)) {
      throw new Error(`"${upc}" is not a barcode — expected 8 to 14 digits`);
    }
    return digits;
  }

  function noProductText(upc) {
    return `AnyList has no product for barcode ${upc}. Its database has no match — that does not mean the product doesn't exist.`;
  }

  // What add_item reports, by what addItem says happened.
  function addedText(name, listName, outcome) {
    if (outcome === "already") return `"${name}" is already on list "${listName}".`;
    if (outcome === "rechecked") return `Successfully added "${name}" to list "${listName}" (it was checked off; it is back on the list).`;
    return `Successfully added "${name}" to list "${listName}"`;
  }

  function choicesText(itemName, choices) {
    return `Several saved items match "${itemName}":\n${choices.map(c => `  - ${c}`).join("\n")}`;
  }

  let lastStoreSignature = '';

  // The description lists the stores, so a change to them has to reach it.
  function refreshDescription(client) {
    const stores = client.getStores();
    const sig = stores.map(s => s.name).join(',');
    if (sig !== lastStoreSignature) {
      lastStoreSignature = sig;
      registeredTool.update({ description: buildDescription(stores) });
    }
  }

  const registeredTool = server.registerTool("shopping", {
    title: "Shopping Lists & Items",
    description: buildDescription([]),
    inputSchema: {
      action: z.enum(["list_lists", "list_items", "add_item", "add_items",
        "update_item", "set_item_category", "list_categories", "set_item_store", "check_item", "uncheck_item", "delete_item", "get_favorites", "get_recents", "list_stores",
        "create_store", "rename_store", "delete_store", "lookup_upc", "add_by_upc"]).describe("The shopping action to perform"),
      upc: z.string().optional().describe("Barcode digits (lookup_upc and add_by_upc only)"),
      list_name: z.string().optional().describe("Name of the list (defaults to configured default list)"),
      name: z.string().optional().describe("Item name (required for add_item, update_item, set_item_store, check_item, uncheck_item, delete_item)"),
      new_name: z.string().optional().describe("The item's new name (update_item only)"),
      items: z.array(z.union([
        z.string(),
        z.object({
          name: z.string(),
          quantity: z.union([z.number().min(1), z.string().min(1)]).optional(),
          notes: z.string().optional(),
          category: z.string().optional(),
          store_name: z.string().optional(),
          exact: z.boolean().optional(),
        })
      ])).optional().describe("Items to add (add_items only). Each entry is either a plain item name or an object with name/quantity/notes/category/store_name/exact"),
      exact: z.boolean().optional().describe("Add the name exactly as given, without matching saved items (add_item only). Use after the person has chosen, or said to add it as written"),
      quantity: z.union([z.number().min(1), z.string().min(1)]).optional().describe("Item quantity, e.g. 2 or \"500 g\" (add_item and update_item; add_item defaults to 1)"),
      notes: z.string().optional().describe("Notes for the item (add_item and update_item; an empty string clears them on update_item)"),
      include_checked: z.boolean().optional().describe("Include checked-off items (list_items only, default false)"),
      include_notes: z.boolean().optional().describe("Include notes for each item (list_items only, default false)"),
      category: z.string().optional().describe("A category on the list, by name — built-in or the household's own; list_categories shows them (add_item, add_items entries, set_item_category). Omit to let AnyList file a new item"),
      store_name: z.string().optional().describe("A store for this item (add_item adds it to the item's stores; set_item_store sets it as the only one, or clears them if blank), or the store to create, rename or delete (create_store, rename_store, delete_store)"),
      store_names: z.array(z.string()).optional().describe("Every store for this item (set_item_store only; replaces store_name; an empty array clears them)"),
      new_store_name: z.string().optional().describe("The store's new name (rename_store only)"),
    }
  }, async (params) => {
    const { action, list_name, name, quantity, notes, include_checked, include_notes } = params;
    try {
      const client = await getClient();
      switch (action) {
        case "list_lists": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const lists = client.getLists();
          if (lists.length === 0) return textResponse("No lists found in the account.");
          const output = lists.map(l => `- ${l.name} (${l.uncheckedCount} unchecked items)`).join("\n");
          return textResponse(`Available lists (${lists.length}):\n${output}`);
        }
        case "list_items": {
          let resolvedListName = list_name;
          if (!resolvedListName && !client.defaultListName) {
            await client.connect(null);
            const lists = client.getLists();
            if (lists.length > 1) {
              resolvedListName = await elicitListName(lists);
            }
          }
          await client.connect(resolvedListName);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const items = await client.getItems(include_checked || false, include_notes || false);
          if (items.length === 0) {
            return textResponse(include_checked
              ? `List "${client.targetList.name}" is empty.`
              : `No unchecked items on list "${client.targetList.name}".`);
          }
          const itemsByCategory = {};
          items.forEach(item => {
            const cat = item.category || 'other';
            if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
            itemsByCategory[cat].push(item);
          });
          const itemList = Object.keys(itemsByCategory).sort().map(category => {
            const categoryItems = itemsByCategory[category].map(item => {
              const qRaw = item.quantity == null ? "" : String(item.quantity).trim();
              const qty = (qRaw && qRaw !== "1") ? ` (${qRaw})` : "";
              const status = item.checked ? " ✓" : "";
              const note = item.note ? ` [${item.note}]` : "";
              const store = item.store ? ` @${item.store}` : "";
              return `  - ${item.name}${qty}${status}${note}${store}`;
            }).join("\n");
            return `**${category}**\n${categoryItems}`;
          }).join("\n\n");
          return textResponse(`Shopping list "${client.targetList.name}" (${items.length} items):\n${itemList}`);
        }
        case "add_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to add?");
          await client.connect(list_name);
          
          const {valid, message} = await validateStoreName(client, params.store_name);
          if (!valid)
            return errorResponse(message); 
          const categoryCheck = validateCategory(client, params.category);
          if (!categoryCheck.valid) return errorResponse(categoryCheck.message);

          const resolved = resolveAddName(client, itemName, params.exact);
          if (resolved.choices) {
            return textResponse(
              `${choicesText(itemName, resolved.choices)}\nNothing was added. Ask which one they mean. ` +
              `To add exactly "${itemName}", call add_item again with exact: true.`
            );
          }

          const outcome = await client.addItem(resolved.name, quantity || 1, notes || null, params.category || null, params.store_name || null);
          return textResponse(addedText(resolved.name, client.targetList.name, outcome));
        }
        case "add_items": {
          const entries = params.items;
          if (!entries || entries.length === 0) throw new Error(`Action "add_items" requires a non-empty "items" array`);
          await client.connect(list_name);
          const added = [];
          const failed = [];
          const unresolved = [];
          for (const entry of entries) {
            const item = typeof entry === "string" ? { name: entry } : entry;
            try {
              const categoryCheck = validateCategory(client, item.category);
              if (!categoryCheck.valid) throw new Error(categoryCheck.message);
              const { valid, message } = await validateStoreName(client, item.store_name);
              if (!valid) throw new Error(message);
              const resolved = resolveAddName(client, item.name, item.exact);
              if (resolved.choices) {
                unresolved.push(choicesText(item.name, resolved.choices));
                continue;
              }
              const outcome = await client.addItem(resolved.name, item.quantity || 1, item.notes || null, item.category || null, item.store_name || null);
              added.push(resolved.name
                + (outcome === "already" ? " (already on the list)" : outcome === "rechecked" ? " (was checked off)" : ""));
            } catch (error) {
              failed.push(`${item.name}: ${error.message}`);
            }
          }
          const summary = [`Added ${added.length} of ${entries.length} items to list "${client.targetList.name}":`];
          added.forEach(n => summary.push(`  ✓ ${n}`));
          failed.forEach(f => summary.push(`  ✗ ${f}`));
          if (unresolved.length > 0) {
            summary.push("", "Not added — ask which one they mean, or resend the entry with exact: true:");
            unresolved.forEach(u => summary.push(u));
          }
          return failed.length > 0 ? errorResponse(summary.join("\n")) : textResponse(summary.join("\n"));
        }
        case "lookup_upc": {
          const upc = normaliseUpc(params.upc);
          await client.connect(list_name || null);
          const product = await client.lookupUpc(upc);
          if (!product) return textResponse(noProductText(upc));
          const category = product.categoryMatchId ? ` (${product.categoryMatchId})` : "";
          const saved = client.findItemByUpc(upc);
          const onList = saved
            ? `\nAlready saved on "${client.targetList.name}" as "${saved.name}"${saved.checked ? " (checked off)" : ""}.`
            : "";
          return textResponse(`Barcode ${upc} is "${product.name}"${category}.${onList}`);
        }
        case "add_by_upc": {
          const upc = normaliseUpc(params.upc);
          await client.connect(list_name || null);
          const { valid, message } = await validateStoreName(client, params.store_name);
          if (!valid) return errorResponse(message);

          // An item already carrying this barcode is the product, with its
          // store and photo; re-adding it by name keeps all of that.
          const saved = client.findItemByUpc(upc);
          if (saved) {
            const outcome = await client.addItem(saved.name, quantity || 1, notes || null, null, params.store_name || null);
            return textResponse(`${addedText(saved.name, client.targetList.name, outcome)} (already saved with barcode ${upc})`);
          }

          const product = await client.lookupUpc(upc);
          if (!product) {
            return textResponse(`${noProductText(upc)}\nNothing was added. Ask what it is, or add it by name.`);
          }
          // An item of the same name, typed rather than scanned, is the same
          // thing to the household. Creating the product beside it made two
          // "Whole Milk"s, and the store then went to whichever came first.
          if (client.targetList.getItemByName(product.name)) {
            const outcome = await client.addItem(product.name, quantity || 1, notes || null, null, params.store_name || null);
            return textResponse(`${addedText(product.name, client.targetList.name, outcome)} (barcode ${upc} is that product; the item already on the list was used)`);
          }
          await client.addProduct(product, quantity || 1, notes || null);
          if (params.store_name) await client.setItemStores(product.name, [params.store_name], { add: true });
          return textResponse(`Successfully added "${product.name}" to list "${client.targetList.name}" from barcode ${upc}`);
        }
        case "update_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "Which item would you like to change?");
          const changes = { newName: params.new_name, quantity, notes };
          if (Object.values(changes).every(v => v === undefined)) {
            return errorResponse(`Nothing to change: give new_name, quantity or notes`);
          }
          await client.connect(list_name);
          const resolved = await resolveItemName(client, itemName);
          const finalName = await client.updateItem(resolved, changes);
          const done = [
            changes.newName !== undefined && `renamed to "${finalName}"`,
            quantity !== undefined && `quantity ${quantity}`,
            notes !== undefined && (notes ? `notes "${notes}"` : "notes cleared"),
          ].filter(Boolean);
          return textResponse(`Updated "${resolved}": ${done.join(", ")}`);
        }
        case "set_item_category": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "Which item would you like to move?");
          let categoryName = params.category;
          if (!categoryName) categoryName = await elicitRequiredField("category", `Which category should "${itemName}" go in?`);
          await client.connect(list_name);
          const { valid, message } = validateCategory(client, categoryName);
          if (!valid) return errorResponse(message);
          const resolved = await resolveItemName(client, itemName);
          const { from, to } = await client.setItemCategory(resolved, categoryName);
          return textResponse(from === to
            ? `"${resolved}" is filed under "${to}"`
            : `Moved "${resolved}" from "${from}" to "${to}"`);
        }
        case "list_categories": {
          await client.connect(list_name || null);
          const categories = client.getCategories();
          if (categories.length === 0) return textResponse(`No categories found for list "${client.targetList.name}".`);
          return textResponse(`Categories for "${client.targetList.name}" (${categories.length}):\n${categories.map(c => `- ${c.name}`).join("\n")}`);
        }
        case "set_item_store": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "Which item would you like to assign to a store?");
          await client.connect(list_name);
          const storeNames = params.store_names ?? (params.store_name ? [params.store_name] : []);
          const { valid, message } = await validateStoreName(client, storeNames);
          if (!valid) return errorResponse(message);
          const resolved = await resolveItemName(client, itemName);
          const { stores, removed } = await client.setItemStores(resolved, storeNames);
          const was = removed.length ? ` (removed: ${removed.join(", ")})` : "";
          return textResponse(stores.length
            ? `Stores for "${resolved}": ${stores.join(", ")}${was}`
            : `Cleared the stores for "${resolved}"${was}`);
        }
        case "check_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to check off?");
          await client.connect(list_name);
          const resolvedCheck = await resolveItemName(client, itemName);
          const changed = await client.removeItem(resolvedCheck);
          return textResponse(changed
            ? `Successfully checked off "${resolvedCheck}" from list "${client.targetList.name}"`
            : `"${resolvedCheck}" was already checked off on list "${client.targetList.name}"`);
        }
        case "uncheck_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to uncheck?");
          await client.connect(list_name);
          const resolvedUncheck = await resolveCheckedItemName(client, itemName);
          await client.uncheckItem(resolvedUncheck);
          return textResponse(`Successfully unchecked "${resolvedUncheck}" on list "${client.targetList.name}"`);
        }
        case "delete_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to delete?");
          await client.connect(list_name);
          const resolvedDelete = await resolveItemName(client, itemName);
          await client.deleteItem(resolvedDelete);
          return textResponse(`Successfully deleted "${resolvedDelete}" from list "${client.targetList.name}"`);
        }
        case "get_favorites": {
          await client.connect(list_name || null);
          const items = await client.getFavoriteItems(list_name);
          if (items.length === 0) return textResponse(`No favorite items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Favorite items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "get_recents": {
          await client.connect(list_name || null);
          const items = await client.getRecentItems(list_name);
          if (items.length === 0) return textResponse(`No recent items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Recent items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "list_stores": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          if (stores.length === 0) return textResponse(`No stores found for list "${client.targetList.name}".`);
          const list = stores.map(s => `- ${s.name}`).join('\n');
          return textResponse(`Stores for "${client.targetList.name}" (${stores.length}):\n${list}`);
        }
        case "create_store": {
          let storeName = params.store_name;
          if (!storeName) storeName = await elicitRequiredField("store_name", "What should the new store be called?");
          await client.connect(list_name || null);
          const store = await client.createStore(storeName);
          refreshDescription(client);
          return textResponse(`Created store "${store.name}" on "${client.targetList.name}"`);
        }
        case "rename_store": {
          let storeName = params.store_name;
          if (!storeName) storeName = await elicitRequiredField("store_name", "Which store would you like to rename?");
          let newName = params.new_store_name;
          if (!newName) newName = await elicitRequiredField("new_store_name", `What should "${storeName}" be renamed to?`);
          await client.connect(list_name || null);
          const { oldName, newName: renamed } = await client.renameStore(storeName, newName);
          refreshDescription(client);
          return textResponse(`Renamed store "${oldName}" to "${renamed}"`);
        }
        case "delete_store": {
          let storeName = params.store_name;
          if (!storeName) storeName = await elicitRequiredField("store_name", "Which store would you like to delete?");
          await client.connect(list_name || null);
          const { name: deleted, activeItems, savedCount } = await client.deleteStore(storeName);
          refreshDescription(client);
          const lines = [`Deleted store "${deleted}" from "${client.targetList.name}"`];
          if (activeItems.length) lines.push(`Now without a store: ${activeItems.join(", ")}`);
          if (savedCount) lines.push(`${savedCount} saved item${savedCount === 1 ? "" : "s"} also lost the store`);
          return textResponse(lines.join("\n"));
        }
        default:
          // An action the schema admits but nothing handles must still answer.
          // Falling off the switch returns undefined, and the caller then waits
          // forever — upstream removed set_item_store's case but not its enum
          // entry, and a call to it hung a live conversation.
          return errorResponse(`Unknown shopping action "${action}"`);
      }
    } catch (error) {
      return errorResponse(`Shopping ${action} failed: ${error.message}`);
    }
  });
}
