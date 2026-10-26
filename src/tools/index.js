import { register as registerHealth } from "./health.js";
import { register as registerShopping } from "./shopping.js";
import { register as registerRecipes } from "./recipes.js";
import { register as registerMealPlan } from "./meal-plan.js";
import { register as registerRecipeCollections } from "./recipe-collections.js";

const TOOLS = {
  health_check: registerHealth,
  shopping: registerShopping,
  recipes: registerRecipes,
  meal_plan: registerMealPlan,
  recipe_collections: registerRecipeCollections,
};

/**
 * The tools named by ANYLIST_TOOLS (comma-separated), or every tool when it is
 * unset or empty.
 *
 * A household whose recipes live elsewhere can serve only `shopping` and
 * `health_check`, so a model cannot answer a recipe question from a stale copy
 * here. This is done server-side because a client that only proxies the server
 * may have no way to hide a tool. An unknown name is refused rather than
 * skipped: a typo would otherwise quietly serve fewer tools than intended.
 */
export function enabledTools(setting = process.env.ANYLIST_TOOLS) {
  // Deduplicated: registering a tool twice throws in the MCP SDK.
  const names = [...new Set((setting || "").split(",").map(s => s.trim()).filter(Boolean))];
  if (names.length === 0) return Object.keys(TOOLS);
  const unknown = names.filter(n => !(n in TOOLS));
  if (unknown.length > 0) {
    throw new Error(`ANYLIST_TOOLS names unknown tools: ${unknown.join(", ")}. Known: ${Object.keys(TOOLS).join(", ")}`);
  }
  return names;
}

/**
 * Register the enabled AnyList MCP tools on the given server.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {() => Promise<import("../anylist-client.js").default>} getClient
 *   Async factory that returns the AnyListClient for the current request/session.
 *   For stdio: always returns the same singleton client.
 *   For HTTP: returns the per-user client from the session manager.
 * @param {string[]} [names] Tools to register; defaults to `enabledTools()`.
 * @param {(run: () => Promise<any>) => Promise<any>} [serialise] Wraps every
 *   tool call; the HTTP server passes a per-user queue (see http/mcp-server.js).
 */
export function registerAllTools(server, getClient, names = enabledTools(), serialise = run => run()) {
  // The tools still see the real server (elicitation reads `server.server`);
  // only registerTool is intercepted, so every handler runs inside `serialise`.
  const wrapped = Object.create(server);
  wrapped.registerTool = (name, config, handler) =>
    server.registerTool(name, config, (...args) => serialise(() => handler(...args)));
  for (const name of names) TOOLS[name](wrapped, getClient);
}
