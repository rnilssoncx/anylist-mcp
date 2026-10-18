import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

// Default categories recognized by anylist.
const valid_categories = ["baby","bakery","beverages","breakfast-and-cereal","condiments-oils-and-salad-dressings",
  "cooking-and-baking","dairy","frozen-foods","grains-pasta-and-side-dishes",
  "health-and-personal-care","household-and-cleaning","meat","pet-supplies",
  "produce","seafood","snacks-cookies-and-candy","soups-and-canned-goods",
  "wine-beer-spirits","other"];

  // TODO: What does this do?
function buildDescription(stores) {
  const base = `Manage AnyList shopping lists and items. Actions:
- list_lists: Show all lists with item counts
- list_items: Show items on a list (grouped by category)
- add_item: Add an item to a list. A name is matched against items already saved on the list (specific products, often scanned): one match is re-added, several are listed back without adding anything — ask which one, or resend with exact: true
- add_items: Add several items to a list in one call (use this instead of repeating add_item); entries are matched the same way
- check_item: Check off (complete) an item
- uncheck_item: Uncheck a previously checked-off item (make it active again)
- delete_item: Permanently remove an item from a list
- get_favorites: Get favorite items for a list
- get_recents: Get recently added items for a list
- list_stores: list stores available for the list (if any)`;
  if (!stores || stores.length === 0) return base;
  const storeList = stores.map(s => s.name).join(', ');
  return `${base}\n\nAvailable stores: ${storeList}`;
}

async function validateStoreName(client, storeName) {
  if (!storeName) return { valid: true, message: null };
  const stores = client.getStores();
  const storeNames = stores.map(s => s.name.toLowerCase());
  if (!storeNames.includes(storeName.toLowerCase())) {
    return { valid: false, message: `Store "${storeName}" not found in list "${client.targetList.name}". Available stores: ${storeNames.join(", ")}.
    Create a new store from the web application or mobile app, then try again.` };
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

  function choicesText(itemName, choices) {
    return `Several saved items match "${itemName}":\n${choices.map(c => `  - ${c}`).join("\n")}`;
  }

  let lastStoreSignature = '';

  const registeredTool = server.registerTool("shopping", {
    title: "Shopping Lists & Items",
    description: buildDescription([]),
    inputSchema: {
      action: z.enum(["list_lists", "list_items", "add_item", "add_items",
        "set_item_store", "check_item", "uncheck_item", "delete_item", "get_favorites", "get_recents", "list_stores"]).describe("The shopping action to perform"),
      list_name: z.string().optional().describe("Name of the list (defaults to configured default list)"),
      name: z.string().optional().describe("Item name (required for add_item, set_item_store, check_item, uncheck_item, delete_item)"),
      items: z.array(z.union([
        z.string(),
        z.object({
          name: z.string(),
          quantity: z.union([z.number().min(1), z.string().min(1)]).optional(),
          notes: z.string().optional(),
          category: z.enum(valid_categories).optional(),
          store_name: z.string().optional(),
          exact: z.boolean().optional(),
        })
      ])).optional().describe("Items to add (add_items only). Each entry is either a plain item name or an object with name/quantity/notes/category/store_name/exact"),
      exact: z.boolean().optional().describe("Add the name exactly as given, without matching saved items (add_item only). Use after the person has chosen, or said to add it as written"),
      quantity: z.union([z.number().min(1), z.string().min(1)]).optional().describe("Item quantity, e.g. 2 or \"500 g\" (add_item only, defaults to 1)"),
      notes: z.string().optional().describe("Notes for the item (add_item only)"),
      include_checked: z.boolean().optional().describe("Include checked-off items (list_items only, default false)"),
      include_notes: z.boolean().optional().describe("Include notes for each item (list_items only, default false)"),
      category: z.enum(valid_categories).optional().describe("Category for the item (add_item only, defaults to 'other')"),
      store_name: z.string().optional().describe("Store to assign to this item (add_item and set_item_store only; omit or leave blank to clear)"),
    }
  }, async (params) => {
    const { action, list_name, name, quantity, notes, include_checked, include_notes, category } = params;
    if (category && !valid_categories.includes(category)) {
      throw new Error(`Invalid input for field "category": "${category}". Valid categories are: ${valid_categories.join(", ")}`);
    }
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

          const resolved = resolveAddName(client, itemName, params.exact);
          if (resolved.choices) {
            return textResponse(
              `${choicesText(itemName, resolved.choices)}\nNothing was added. Ask which one they mean. ` +
              `To add exactly "${itemName}", call add_item again with exact: true.`
            );
          }

          await client.addItem(resolved.name, quantity || 1, notes || null, params.category || "other", params.store_name || null);
          return textResponse(`Successfully added "${resolved.name}" to list "${client.targetList.name}"`);
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
              if (item.category && !valid_categories.includes(item.category)) {
                throw new Error(`invalid category "${item.category}"`);
              }
              const { valid, message } = await validateStoreName(client, item.store_name);
              if (!valid) throw new Error(message);
              const resolved = resolveAddName(client, item.name, item.exact);
              if (resolved.choices) {
                unresolved.push(choicesText(item.name, resolved.choices));
                continue;
              }
              await client.addItem(resolved.name, item.quantity || 1, item.notes || null, item.category || "other", item.store_name || null);
              added.push(resolved.name);
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
        case "check_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to check off?");
          await client.connect(list_name);
          const resolvedCheck = await resolveItemName(client, itemName);
          await client.removeItem(resolvedCheck);
          return textResponse(`Successfully checked off "${resolvedCheck}" from list "${client.targetList.name}"`);
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
      }
    } catch (error) {
      return errorResponse(`Shopping ${action} failed: ${error.message}`);
    }
  });
}
