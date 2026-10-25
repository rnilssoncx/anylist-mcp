import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerAllTools, enabledTools } from '../../src/tools/index.js';
import { createMockServer } from './helpers.js';

const ALL = ['health_check', 'shopping', 'recipes', 'meal_plan', 'recipe_collections'];

function registered(setting) {
  if (setting === undefined) delete process.env.ANYLIST_TOOLS;
  else process.env.ANYLIST_TOOLS = setting;
  const { server, handlers } = createMockServer();
  // No names passed: the production call sites rely on the default reading the env.
  registerAllTools(server, () => Promise.resolve(null));
  return Object.keys(handlers).sort();
}

describe('ANYLIST_TOOLS', () => {
  afterEach(() => { delete process.env.ANYLIST_TOOLS; });

  it('registers every tool when unset', () => {
    assert.deepEqual(registered(undefined), [...ALL].sort());
  });

  it('registers every tool when empty', () => {
    assert.deepEqual(registered(''), [...ALL].sort());
  });

  it('registers only the named tools', () => {
    assert.deepEqual(registered('shopping,health_check'), ['health_check', 'shopping']);
  });

  it('tolerates spaces around names', () => {
    assert.deepEqual(registered(' shopping , health_check '), ['health_check', 'shopping']);
  });

  it('refuses an unknown name, naming it', () => {
    assert.throws(() => enabledTools('shopping,recipe'), /ANYLIST_TOOLS names unknown tools: recipe\./);
  });

  it('refuses at registration, not just when asked', () => {
    assert.throws(() => registered('shoping'), /ANYLIST_TOOLS names unknown tools: shoping\./);
  });
});
