/**
 * The nightly export (moneypenny plans/012 § 1a): what it writes, that it
 * writes it atomically, and what it refuses before touching anything.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runExport, readExport, exportCount, writeExport } from '../src/export.js';
import { fakeAccount, GROCERIES_ID, COSTCO_ID } from './export-fixture.js';

const DATE = '2026-10-27';
const NAME = `anylist-${DATE}.json.gz`;
const EXPORT_JS = fileURLToPath(new URL('../src/export.js', import.meta.url));

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylist-export-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const read = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));

describe('export', () => {
  it('writes every list with every item, checked included, plus stores, flattened categories and recents', async () => {
    const lib = fakeAccount();
    const { file } = await runExport({ date: DATE, lib, outDir: dir });
    assert.equal(file, path.join(dir, NAME));
    assert.deepEqual(fs.readdirSync(dir), [NAME]);
    assert.deepEqual(lib.calls.slice(0, 2), [['login', false], ['getLists']]);

    const data = read(file);
    assert.deepEqual(Object.keys(data), ['format', 'exported_at', 'lists', 'stores', 'categories', 'recents']);
    assert.equal(data.format, 'anylist-export/1');
    assert.match(data.exported_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    assert.deepEqual(data.lists.map(l => [l.identifier, l.name]), [[GROCERIES_ID, 'Groceries'], [COSTCO_ID, 'Costco']]);
    const groceries = data.lists[0];
    assert.deepEqual(groceries.items.map(i => [i.name, i.checked]), [['Milk', false], ['Bananas', false], ['Old Bread', true]]);
    assert.deepEqual(groceries.items[0], {
      identifier: 'i-milk', listId: GROCERIES_ID, name: 'Milk', quantity: '2', details: 'whole', checked: false,
      categoryMatchId: 'dairy',
      categoryAssignments: [
        { identifier: 'ca-1', categoryGroupId: groceries.categoryGroups[0].identifier, categoryId: 'c-dairy' },
        { identifier: 'ca-2', categoryGroupId: 'g-kroger', categoryId: 'c-aisle5' },
      ],
      storeIds: ['s-k1'], productUpc: null, photoIds: [], manualSortIndex: null,
    });
    assert.equal(groceries.items[2].productUpc, '0001234500012');
    assert.deepEqual(groceries.storeFilters, [{ identifier: 'f-1', name: 'Kroger view', storeIds: ['s-k1'], categoryGroupId: 'g-kroger' }]);

    // The store's 64-bit timestamp is left out rather than written as an object.
    assert.deepEqual(data.stores, [{ identifier: 's-k1', listId: GROCERIES_ID, name: 'Kroger', sortIndex: 0 }]);

    // Every category of every set, each carrying its set, its list, and the
    // stores whose view uses that set.
    assert.deepEqual(data.categories.map(c => [c.name, c.categoryGroupId === 'g-kroger', c.listId, c.storeIds]), [
      ['Dairy', false, GROCERIES_ID, []], ['Produce', false, GROCERIES_ID, []], ['Other', false, GROCERIES_ID, []],
      ['Aisle 5', true, GROCERIES_ID, ['s-k1']],
      ['Other', false, COSTCO_ID, []],
    ]);

    // Under the shopping list's id; the entry's own is the starter list's.
    assert.deepEqual(data.recents.map(r => [r.name, r.listId, r.starterListId]), [['Eggs', GROCERIES_ID, 'starter-9']]);
  });

  it('counts lists, stores and categories, never items', async () => {
    const { file } = await runExport({ date: DATE, lib: fakeAccount(), outDir: dir });
    const data = readExport(file);
    // 2 lists + 1 store + 5 categories; the four items are not counted.
    assert.equal(exportCount(data), 8);
  });

  it('refuses an account that reads as empty, and writes nothing', async () => {
    await assert.rejects(runExport({ date: DATE, lib: fakeAccount({ empty: true }), outDir: dir }),
      { message: 'AnyList returned no lists, stores or categories; nothing written' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('refuses a malformed date before logging in or writing', async () => {
    const lib = fakeAccount();
    await assert.rejects(runExport({ date: '../x', lib, outDir: dir }), { message: 'EXPORT_DATE "../x" is not YYYY-MM-DD' });
    assert.deepEqual(lib.calls, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('exits 2 on a malformed EXPORT_DATE, with one line saying why', () => {
    for (const value of ['../x', '2026-10-2', '']) {
      const run = spawnSync(process.execPath, [EXPORT_JS], { env: { PATH: process.env.PATH, EXPORT_DATE: value }, encoding: 'utf8' });
      assert.equal(run.status, 2, value);
      assert.equal(run.stderr, `anylist export: refused: EXPORT_DATE "${value}" is not YYYY-MM-DD\n`);
    }
  });

  it('a crash between write and rename leaves no file under the real name', async () => {
    await assert.rejects(
      runExport({ date: DATE, lib: fakeAccount(), outDir: dir, beforeRename: () => { throw new Error('killed'); } }),
      { message: 'killed' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("a crash in a same-day re-run leaves the earlier copy whole", async () => {
    const earlier = { format: 'anylist-export/1', exported_at: 'x', lists: [{ name: 'Before' }], stores: [], categories: [], recents: [] };
    writeExport(dir, DATE, earlier);
    const before = fs.readFileSync(path.join(dir, NAME));
    await assert.rejects(runExport({ date: DATE, lib: fakeAccount(), outDir: dir, beforeRename: () => { throw new Error('killed'); } }));
    assert.deepEqual(fs.readFileSync(path.join(dir, NAME)), before);
    assert.deepEqual(fs.readdirSync(dir), [NAME]);
  });

  it("writes to /export-out when no directory is given, as main() does", async () => {
    // main() passes none; a wrong default would write where the host script
    // never looks, or fail on a read-only mount, every night.
    await assert.rejects(runExport({ date: DATE, lib: fakeAccount() }), { path: `/export-out/.${NAME}.tmp` });
  });

  it("the partial is `.` + name + `.tmp` beside the export", async () => {
    // The contract's seam with the Pi's host script (mcp-host pi/mcp-export's
    // TMP pattern, pinned by its own tests): any other spelling and the host
    // script would neither recognise it as a partial nor ever clear it.
    const rename = mock.method(fs, 'renameSync');
    try {
      await runExport({ date: DATE, lib: fakeAccount(), outDir: dir });
      assert.deepEqual(rename.mock.calls.map(c => c.arguments), [[path.join(dir, `.${NAME}.tmp`), path.join(dir, NAME)]]);
    } finally {
      mock.restoreAll();
    }
  });

  it("a directory fsync that fails after the rename is a warning, not a failed night", async () => {
    const real = fs.fsyncSync;
    const dirFd = new Set();
    const open = fs.openSync;
    mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); if (p === dir) dirFd.add(fd); return fd; });
    mock.method(fs, 'fsyncSync', fd => { if (dirFd.has(fd)) throw new Error('EIO: i/o error, fsync'); return real(fd); });
    const err = mock.method(console, 'error', () => {});
    let file;
    try {
      ({ file } = await runExport({ date: DATE, lib: fakeAccount(), outDir: dir }));
    } finally {
      mock.restoreAll();
    }
    assert.equal(file, path.join(dir, NAME));
    assert.equal(readExport(file).format, 'anylist-export/1');
    assert.deepEqual(err.mock.calls.map(c => c.arguments), [[`anylist export: warning: ${NAME} is written, but the directory fsync failed: EIO: i/o error, fsync`]]);
  });
});
