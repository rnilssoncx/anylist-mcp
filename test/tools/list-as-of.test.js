/**
 * shopping list_items_as_of (moneypenny plans/012 § 1c): a list as a nightly
 * copy had it, read from the read-only export directory.
 *
 * The copies are written by the real export from the fixture account, so a
 * change to what the export writes that the reader no longer understands
 * fails here. The words are 012's table; each is asserted whole, because two
 * refusals of one input are only told apart by their text.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { register } from '../../src/tools/shopping.js';
import { snapshot, writeExport } from '../../src/export.js';
import { fakeAccount } from '../export-fixture.js';
import { MockAnyListClient } from './helpers.js';

const D = '2026-10-27';

let dir;
let mcp;

async function copy(date, into = dir) {
  const lib = fakeAccount();
  await lib.getLists();
  writeExport(into, date, snapshot(lib));
}

function corrupt(date, bytes = 'not gzip at all') {
  fs.writeFileSync(path.join(dir, `anylist-${date}.json.gz`), bytes);
}

// Through a real MCP session, so the action has to be in the schema a client
// sees as well as in the switch.
async function call(args, exportDir = dir) {
  const server = new McpServer({ name: 'test', version: '0' });
  register(server, () => Promise.resolve(new MockAnyListClient()), { exportDir });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  const result = await mcp.callTool({ name: 'shopping', arguments: { action: 'list_items_as_of', ...args } });
  return { text: result.content[0].text, isError: result.isError === true };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylist-asof-')); });
afterEach(async () => {
  await mcp?.close();
  mcp = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('list_items_as_of', () => {
  it("shows the list as that copy had it, in list_items' format", async () => {
    await copy(D);
    const { text, isError } = await call({ list_name: 'Groceries', date: D });
    assert.equal(isError, false);
    // Milk's Kroger-set assignment ("Aisle 5") is not its category here: the
    // main set is found by its id, as list_items finds it.
    assert.equal(text, [
      'Shopping list "Groceries" in the 2026-10-27 copy (2 items):',
      '**Dairy**',
      '  - Milk (2) @Kroger',
      '',
      '**Produce**',
      '  - Bananas',
    ].join('\n'));
  });

  it('takes the checked, notes and barcode switches list_items takes', async () => {
    await copy(D);
    const { text } = await call({ list_name: 'Groceries', date: D, include_checked: true, include_notes: true, include_barcodes: true });
    assert.equal(text, [
      'Shopping list "Groceries" in the 2026-10-27 copy (3 items):',
      '**Dairy**',
      '  - Milk (2) [whole] @Kroger',
      '',
      '**Other**',
      '  - Old Bread [barcode 0001234500012] ✓',
      '',
      '**Produce**',
      '  - Bananas',
    ].join('\n'));
  });

  it("finds a list by its name, not its identifier", async () => {
    // Costco's identifier is "Groceries".
    await copy(D);
    const { text } = await call({ list_name: 'Groceries', date: D });
    assert.ok(!text.includes('Paper Towels'), text);
    const costco = await call({ list_name: 'costco', date: D });
    assert.equal(costco.text, 'Shopping list "Costco" in the 2026-10-27 copy (1 items):\n**Other**\n  - Paper Towels');
  });

  it('says a list was not in that copy', async () => {
    await copy(D);
    const { text } = await call({ list_name: 'Hardware', date: D });
    assert.equal(text, '"Hardware" was not in the 2026-10-27 copy.');
  });

  it('refuses a date that is not one before it becomes a path', async () => {
    // "anylist-../x.json.gz" joined onto the directory is "<dir>/x.json.gz":
    // a readable copy sits there, so a path built first answers with the list.
    await copy(D);
    fs.renameSync(path.join(dir, `anylist-${D}.json.gz`), path.join(dir, 'x.json.gz'));
    const { text, isError } = await call({ list_name: 'Groceries', date: '../x' });
    assert.equal(isError, true);
    assert.equal(text, '"../x" is not a date; give it as YYYY-MM-DD.');
  });

  it("an empty /export is can't tell, never nothing there", async () => {
    const { text, isError } = await call({ list_name: 'Groceries', date: D });
    assert.equal(isError, true);
    assert.equal(text, 'No saved copies are readable here, so I can\'t tell what "Groceries" used to be.');
    assert.equal((await call({ list_name: 'Groceries' })).text, text);
  });

  it("an unmounted /export is can't tell", async () => {
    const { text } = await call({ list_name: 'Groceries', date: D }, path.join(dir, 'not-mounted'));
    assert.equal(text, 'No saved copies are readable here, so I can\'t tell what "Groceries" used to be.');
  });

  it("copies that are all unreadable are can't tell, and named", async () => {
    corrupt('2026-10-25');
    corrupt('2026-10-26');
    const { text } = await call({ list_name: 'Groceries', date: D });
    assert.equal(text, 'No saved copies are readable here, so I can\'t tell what "Groceries" used to be. Couldn\'t read 2 saved copies: 2026-10-25, 2026-10-26.');
  });

  it("a corrupt copy for the date is unreadable, not absent", async () => {
    await copy('2026-10-26');
    corrupt(D);
    const { text, isError } = await call({ list_name: 'Groceries', date: D });
    assert.equal(isError, true);
    assert.equal(text, "Couldn't read the 2026-10-27 copy: incorrect header check.");
  });

  it('a copy that gunzips but is not an export is unreadable, with the reason', async () => {
    corrupt(D, zlib.gzipSync('{"format":"paprika-export/1"}'));
    const { text } = await call({ list_name: 'Groceries', date: D });
    assert.equal(text, "Couldn't read the 2026-10-27 copy: it is not an anylist-export/1 file.");
  });

  it('a date with no copy lists the readable dates and names the unreadable ones', async () => {
    await copy('2026-10-25');
    corrupt('2026-10-26');
    await copy(D);
    // A half-written night is never a copy.
    fs.writeFileSync(path.join(dir, '.anylist-2026-10-24.json.gz.tmp'), fs.readFileSync(path.join(dir, `anylist-${D}.json.gz`)));
    const { text, isError } = await call({ list_name: 'Groceries', date: '2026-10-20' });
    assert.equal(isError, true);
    assert.equal(text, "There is no saved copy from 2026-10-20. Saved copies: 2026-10-25, 2026-10-27. Couldn't read 1 saved copies: 2026-10-26.");
  });

  it('with no date, lists the dates there are copies of', async () => {
    await copy(D);
    corrupt('2026-10-26');
    await copy('2026-10-25');
    const { text, isError } = await call({ list_name: 'Groceries' });
    assert.equal(isError, false);
    assert.equal(text, 'Saved copies: 2026-10-25, 2026-10-27. Say which date to show "Groceries" from. Couldn\'t read 1 saved copies: 2026-10-26.');
  });

  it('reads /export when registered with no directory, as registerAllTools does', async () => {
    // A wrong default would read nothing on the Pi and answer "can't tell"
    // every time, which is exactly what an empty /export answers too.
    const seen = [];
    mock.method(fs, 'readdirSync', p => { seen.push(p); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    try {
      const server = new McpServer({ name: 'test', version: '0' });
      register(server, () => Promise.resolve(new MockAnyListClient()));
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      mcp = new Client({ name: 'test', version: '0' });
      await mcp.connect(clientSide);
      await mcp.callTool({ name: 'shopping', arguments: { action: 'list_items_as_of', list_name: 'Groceries' } });
    } finally {
      mock.restoreAll();
    }
    assert.deepEqual(seen, ['/export']);
  });
});
