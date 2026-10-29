#!/usr/bin/env node
// The nightly copy of the household's lists (moneypenny plans/012 § 1a), and
// the one reader of it that the restore action shares (§ 1c).
//
//   EXPORT_DATE=YYYY-MM-DD ANYLIST_USERNAME=… ANYLIST_PASSWORD=… node src/export.js
//
// Run by the Pi's host timer through `start.sh anylist export`, in a throwaway
// container that holds AnyList's secrets and nothing else. It never starts the
// HTTP server: the export reads the account and writes one file, and a
// listening port in a one-shot container would be surface for nothing.
//
// The host script names the date, not this process: one clock names the file,
// so a container whose clock or zone differs cannot write tomorrow's name.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import AnyList from "../anylist-js/lib/index.js";

export const FORMAT = "anylist-export/1";
export const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
// The top-level arrays a valid export has. The host script, Walt's puller and
// the restore action all judge a file by these, so they are named once here.
export const ARRAYS = ["lists", "stores", "categories", "recents"];
const OUT_DIR = "/export-out";

export function exportName(date) {
  return `anylist-${date}.json.gz`;
}

// The structure, which is stable: items are left out because AnyList's own
// "delete checked items" drops a fifth of them weekly, and a count that falls
// every week would page every week (§ 1a).
export function exportCount(data) {
  return data.lists.length + data.stores.length + data.categories.length;
}

// What a restore needs to say "this was on the list": the item as the apps draw
// it (name, quantity, notes, checked) and where it was filed (match id, the
// per-set assignments, stores, barcode). Read through the library's getters,
// which are the fields the client itself reads.
function itemRecord(item) {
  return {
    identifier: item.identifier,
    listId: item.listId ?? null,
    name: item.name,
    quantity: item.quantity ?? null,
    details: item.details ?? null,
    checked: Boolean(item.checked),
    categoryMatchId: item.categoryMatchId ?? null,
    categoryAssignments: (item.categoryAssignments || []).map(a => ({ ...a })),
    storeIds: [...(item.storeIds || [])],
    productUpc: item.productUpc ?? null,
    photoIds: [...(item.photoIds || [])],
    manualSortIndex: item.manualSortIndex ?? null,
  };
}

// An offset rather than "Z", so a person reading the file on the Pi sees the
// local time the copy was taken.
function isoWithOffset(date) {
  const pad = n => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * Everything the account's lists hold, from a logged-in anylist-js client whose
 * getLists() has run. Each category set's categories are flattened into the
 * top-level `categories`, each carrying its set's id, its list's id and the
 * stores whose view uses that set — so a person rebuilding a deleted store's
 * set by hand (§ 1c: not restorable by tool) can read which categories it had.
 */
export function snapshot(lib, now = new Date()) {
  const lists = [];
  const stores = [];
  const categories = [];
  const recents = [];
  for (const list of lib.lists || []) {
    const filters = (list.storeFilters || []).map(f => ({ ...f, storeIds: [...f.storeIds] }));
    lists.push({
      identifier: list.identifier,
      name: list.name,
      items: (list.items || []).map(itemRecord),
      // The sets without their categories, which are flattened below: the
      // default category is how an unfiled item is drawn (010, S4).
      categoryGroups: (list.categoryGroups || []).map(g => ({ identifier: g.identifier, name: g.name ?? null, defaultCategoryId: g.defaultCategoryId ?? null })),
      storeFilters: filters,
    });
    // A store is a protobuf message; its logicalTimestamp is a 64-bit Long
    // that JSON would write as an object, and nothing reads it back.
    for (const s of list.stores || []) {
      stores.push({ identifier: s.identifier, listId: s.listId || list.identifier, name: s.name, sortIndex: s.sortIndex ?? null });
    }
    for (const group of list.categoryGroups || []) {
      const storeIds = [...new Set(filters.filter(f => f.categoryGroupId === group.identifier).flatMap(f => f.storeIds))];
      for (const c of group.categories || []) {
        categories.push({ ...c, categoryGroupId: group.identifier, listId: list.identifier, storeIds });
      }
    }
    // Keyed by the shopping list's id; an entry's own listId is its starter
    // list's, so both are kept.
    for (const item of (lib.recentItems || {})[list.identifier] || []) {
      recents.push({ ...itemRecord(item), starterListId: item.listId ?? null, listId: list.identifier });
    }
  }
  return { format: FORMAT, exported_at: isoWithOffset(now), lists, stores, categories, recents };
}

/**
 * Write `data` as `<outDir>/anylist-<date>.json.gz`, atomically: a sync client
 * or Walt's puller must never see half a file under the real name. Written to
 * `.<name>.tmp`, fsync'd, renamed over any same-day copy (a hand re-run), then
 * the directory fsync'd so the rename survives the 04:00 reboot.
 * `beforeRename` exists for the test that injects a crash at that point.
 */
export function writeExport(outDir, date, data, { beforeRename = () => {} } = {}) {
  const name = exportName(date);
  const final = path.join(outDir, name);
  const tmp = path.join(outDir, `.${name}.tmp`);
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8"));
  try {
    const fd = fs.openSync(tmp, "w", 0o640);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeRename(tmp);
    fs.renameSync(tmp, final);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  // Past the rename the file under the real name is complete, and that is what
  // the host script reads and Walt copies. A failed directory fsync only means
  // the rename might not survive a power cut, so it is a warning and not a
  // failed night: failing would report "no copy" over a copy that is there,
  // and the host script would keep it but page as if it were missing. Paprika's
  // export does the same.
  try {
    const dir = fs.openSync(outDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (error) {
    console.error(`anylist export: warning: ${name} is written, but the directory fsync failed: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  return final;
}

/**
 * Read one export and judge it the way the host script and Walt do: gunzips,
 * parses as an object, carries this format, has every array, holds something.
 * Throws with the reason, which the restore action shows the member — an
 * unreadable copy is "can't tell", never "it wasn't there".
 */
export function readExport(file) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data) || data.format !== FORMAT) {
    throw new Error(`it is not an ${FORMAT} file`);
  }
  for (const key of ARRAYS) {
    if (!Array.isArray(data[key])) throw new Error(`its "${key}" is missing or not an array`);
  }
  if (exportCount(data) === 0) throw new Error("it holds no lists, stores or categories");
  return data;
}

/**
 * Log in, read, write. `lib` is an anylist-js client, injected so the tests
 * need no account. An account that reads as empty is refused rather than
 * written: a zero-count file is invalid to everything that reads it, and the
 * night should say it failed rather than leave a file rotation must skip.
 */
export async function runExport({ date, lib, outDir = OUT_DIR, now = new Date(), beforeRename }) {
  if (!DATE.test(String(date ?? ""))) throw new Error(`EXPORT_DATE "${date ?? ""}" is not YYYY-MM-DD`);
  // No websocket: nothing listens to its refresh, and its error handler's
  // token refresh throws when AnyList is down (see AnyListClient.connect).
  await lib.login(false);
  await lib.getLists();
  const data = snapshot(lib, now);
  if (exportCount(data) === 0) throw new Error("AnyList returned no lists, stores or categories; nothing written");
  return { file: writeExport(outDir, date, data, { beforeRename }), data };
}

async function main() {
  // 0640 files: the setgid directory gives them the host group the backup
  // user is in, which may read them and not write them.
  process.umask(0o027);
  const date = process.env.EXPORT_DATE;
  if (!DATE.test(String(date ?? ""))) {
    console.error(`anylist export: refused: EXPORT_DATE "${date ?? ""}" is not YYYY-MM-DD`);
    process.exit(2);
  }
  const { ANYLIST_USERNAME: email, ANYLIST_PASSWORD: password } = process.env;
  if (!email || !password) {
    console.error("anylist export: failed: ANYLIST_USERNAME and ANYLIST_PASSWORD are required");
    process.exit(1);
  }
  const lib = new AnyList({ email, password });
  let code = 0;
  try {
    const { file, data } = await runExport({ date, lib });
    console.error(`anylist export: wrote ${path.basename(file)} count=${exportCount(data)}`);
  } catch (error) {
    // One line: the host script reads this process's exit code, a person reads
    // the reason.
    console.error(`anylist export: failed: ${String(error?.message ?? error).split("\n")[0]}`);
    code = 1;
  } finally {
    lib.teardown();
  }
  // Explicit: an HTTP keep-alive socket must not hold a one-shot container open.
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
