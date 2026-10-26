import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOrCreateSession } from "./session-manager.js";
import { registerAllTools } from "../tools/index.js";

// Every MCP session for a user shares that user's one AnyListClient, and the
// client keeps the list a call is working on as instance state (`targetList`)
// across awaits. Claude issues tool calls in parallel and the SDK does not
// queue them, so two calls interleave on that state: "eggs and butter to
// Groceries, dog food to Costco" put the butter on Costco and reported it as
// Groceries. Calls for one user therefore run one at a time. A household's
// calls are seconds apart, so the queue costs nothing anyone would notice.
const queues = new Map(); // userId → tail of that user's queue

export function oneAtATime(userId, fn) {
  const run = (queues.get(userId) || Promise.resolve()).then(fn, fn);
  queues.set(userId, run.catch(() => {}));
  return run;
}

export function createMcpServer(userId) {
  const mcpServer = new McpServer({ name: "anylist-mcp-server", version: "1.9.0" });
  registerAllTools(mcpServer, () => getOrCreateSession(userId), undefined, fn => oneAtATime(userId, fn));
  return mcpServer;
}
