# Tool Reference

Functionality is organized into **5 domain-grouped tools**. Every domain tool takes an `action` enum plus action-specific parameters.

```json
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Milk", "quantity": 2 } }
```

---

## `health_check`

Tests the connection to AnyList and verifies access to the target list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `list_name` | string | No | List to test (defaults to configured default) |

---

## `shopping`

Manage shopping lists, items, stores and categories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `list_name` | string | No | Target list (defaults to configured default) |
| `name` | string | For item actions | Item name; partial names are matched |
| `new_name` | string | No | New item name (update_item) |
| `quantity` | number or string | No | e.g. `2` or `"500 g"` (add_item, update_item) |
| `notes` | string | No | Item notes (add_item, update_item; `""` clears on update_item) |
| `exact` | boolean | No | Add the name as given, without matching saved items (add_item) |
| `items` | array | For add_items | Names, or objects with name/quantity/notes/category/store_name/exact |
| `category` | string | No | A category on the list, by name: built-in or the household's own (add_item, add_items, set_item_category) |
| `store_name` | string | No | add_item: a store added to the item's stores. set_item_store: the only store. create_store / rename_store / delete_store: the store |
| `store_names` | string[] | No | Every store for the item (set_item_store; `[]` clears) |
| `new_store_name` | string | No | The store's new name (rename_store) |
| `upc` | string | For barcode actions | Barcode digits (lookup_upc, add_by_upc) |
| `include_checked` | boolean | No | Include checked-off items (list_items) |
| `include_notes` | boolean | No | Include item notes in output (list_items) |

**Actions:**

```json
// Lists, and the items on one (grouped by category, with every store an item is at)
{ "name": "shopping", "arguments": { "action": "list_lists" } }
{ "name": "shopping", "arguments": { "action": "list_items", "list_name": "Costco", "include_notes": true } }

// Add items; a name is matched against items already saved on the list
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Eggs", "quantity": 2, "notes": "organic", "store_name": "Costco", "category": "Dairy" } }
{ "name": "shopping", "arguments": { "action": "add_items", "items": ["Milk", { "name": "Paprika", "category": "Penzy's" }] } }

// Change an item already on the list: name, quantity or notes
{ "name": "shopping", "arguments": { "action": "update_item", "name": "Eggs", "new_name": "Eggs, large", "quantity": "2 dozen" } }

// Check off, uncheck, delete
{ "name": "shopping", "arguments": { "action": "check_item", "name": "Eggs" } }
{ "name": "shopping", "arguments": { "action": "uncheck_item", "name": "Eggs" } }
{ "name": "shopping", "arguments": { "action": "delete_item", "name": "Eggs" } }

// Favorites and recents
{ "name": "shopping", "arguments": { "action": "get_favorites" } }
{ "name": "shopping", "arguments": { "action": "get_recents" } }

// Categories
{ "name": "shopping", "arguments": { "action": "list_categories" } }
{ "name": "shopping", "arguments": { "action": "set_item_category", "name": "Sosiski", "category": "Meat" } }

// An item's stores (this replaces them; the reply names any removed)
{ "name": "shopping", "arguments": { "action": "set_item_store", "name": "Milk", "store_names": ["Costco", "Kroger"] } }

// Stores on the list
{ "name": "shopping", "arguments": { "action": "list_stores" } }
{ "name": "shopping", "arguments": { "action": "create_store", "store_name": "Costco" } }
{ "name": "shopping", "arguments": { "action": "rename_store", "store_name": "Costco", "new_store_name": "Costco Wholesale" } }
{ "name": "shopping", "arguments": { "action": "delete_store", "store_name": "Costco Wholesale" } }

// Barcodes
{ "name": "shopping", "arguments": { "action": "lookup_upc", "upc": "0074338007611" } }
{ "name": "shopping", "arguments": { "action": "add_by_upc", "upc": "0074338007611", "store_name": "Kroger" } }
```

---

## `recipes`

Manage AnyList recipes, including URL import and text parsing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `name` | string | For most actions | Recipe name |
| `new_name` | string | No | Rename the recipe (update only) |
| `search` | string | No | Filter recipes by name (list only) |
| `ingredients` | array | No | `[{ name, quantity }]` (create, update — replaces list on update) |
| `steps` | string[] | No | Preparation steps (create, update — replaces list on update) |
| `note` | string | No | Recipe notes (create, update) |
| `source_name` | string | No | Source attribution (create, update) |
| `source_url` | string | No | Source URL (create, update) |
| `prep_time` | number | No | Prep time in minutes (create, update) |
| `cook_time` | number | No | Cook time in minutes (create, update) |
| `servings` | string | No | e.g. `"4"` or `"4-6"` (create, update) |
| `url` | string | For import/normalize | URL to fetch recipe from |
| `text` | string | For normalize | Raw recipe text to parse |
| `save` | boolean | No | Save normalized result to AnyList (normalize only) |

**Actions:**

```json
// Browse all recipes (summaries: name, rating, times, servings)
{ "name": "recipes", "arguments": { "action": "list" } }

// Search recipes
{ "name": "recipes", "arguments": { "action": "list", "search": "chicken" } }

// Get full details — ingredients and steps
{ "name": "recipes", "arguments": { "action": "get", "name": "Chicken Tikka Masala" } }

// Create a recipe
{ "name": "recipes", "arguments": {
    "action": "create",
    "name": "Simple Pasta",
    "ingredients": [
      { "name": "spaghetti", "quantity": "1 lb" },
      { "name": "garlic cloves", "quantity": "2" },
      { "name": "olive oil", "quantity": "1/4 cup" }
    ],
    "steps": ["Boil pasta", "Sauté garlic in oil", "Toss together"],
    "servings": "4"
} }

// Partially update a recipe — only the fields you pass change; the rest
// (identifier, note, photos, collection membership, meal-plan links) are kept.
// ingredients and steps, when provided, replace the whole array.
{ "name": "recipes", "arguments": { "action": "update", "name": "Simple Pasta", "servings": "6", "note": "Doubled the garlic" } }

// Rename a recipe in place (fails if another recipe already has the new name)
{ "name": "recipes", "arguments": { "action": "update", "name": "Simple Pasta", "new_name": "Garlic Pasta" } }

// Delete a recipe
{ "name": "recipes", "arguments": { "action": "delete", "name": "Simple Pasta" } }

// Import a recipe from a website URL
{ "name": "recipes", "arguments": { "action": "import_url", "url": "https://..." } }

// Parse and preview a recipe without saving (set save=true to also save)
{ "name": "recipes", "arguments": { "action": "normalize", "url": "https://..." } }
{ "name": "recipes", "arguments": { "action": "normalize", "text": "Pasta\n\n1 lb spaghetti\n\n1. Boil pasta", "save": true } }
```

---

## `meal_plan`

Manage the AnyList meal planning calendar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `date` | string | For create | Date in `YYYY-MM-DD` format |
| `title` | string | No | Event title (use this or `recipe_id`) |
| `recipe_id` | string | No | Link an existing recipe by ID |
| `label_id` | string | No | Meal type label ID (get from `list_labels`) |
| `details` | string | No | Additional notes |
| `event_id` | string | For delete | Event ID to delete |

**Actions:**

```json
// View all meal plan events, sorted by date
{ "name": "meal_plan", "arguments": { "action": "list_events" } }

// Get available labels (Breakfast, Lunch, Dinner, etc.) with their IDs
{ "name": "meal_plan", "arguments": { "action": "list_labels" } }

// Schedule a meal
{ "name": "meal_plan", "arguments": {
    "action": "create_event",
    "date": "2025-02-15",
    "title": "Pizza Night",
    "label_id": "<id from list_labels>"
} }

// Delete an event
{ "name": "meal_plan", "arguments": { "action": "delete_event", "event_id": "<id>" } }
```

---

## `recipe_collections`

Organize recipes into named collections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list` or `create` |
| `name` | string | For create | Collection name |
| `recipe_names` | string[] | No | Recipes to include on creation |

**Actions:**

```json
// List all collections
{ "name": "recipe_collections", "arguments": { "action": "list" } }

// Create a collection
{ "name": "recipe_collections", "arguments": {
    "action": "create",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta", "Chicken Tikka Masala"]
} }
```

---

## Typical multi-step interaction

1. **Browse recipes** — `recipes` → `list`
2. **Get details** — `recipes` → `get` with `name`
3. **Plan the meal** — `meal_plan` → `create_event` with date and title
4. **Add ingredients** — `shopping` → `add_item` for each ingredient
