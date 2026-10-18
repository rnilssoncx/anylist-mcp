/**
 * anylist-js: product lookup by barcode, and items that keep their barcode.
 *
 * Offline — the HTTP client is replaced by hand, so nothing reaches AnyList.
 * The library's own suite in anylist-js/test is live integration tests that
 * create lists on a real account, which is why these live here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AnyList = require("../anylist-js/lib/index.js");

const UPC = "0074338007611";

function anylist(respond) {
  const any = new AnyList({ email: "test@example.com", password: "unused", credentialsFile: "/nonexistent" });
  const seen = [];
  if (respond) {
    any.client = { get: async url => { seen.push(url); return respond(any); } };
  }
  return { any, seen };
}

function roundTrip(any, item) {
  return any.protobuf.ListItem.decode(item._encode().encode().toBuffer());
}

test("a created item keeps its barcode and photo through encoding", () => {
  const { any } = anylist();
  const item = any.createItem({ name: "Sabrett Cocktail Beef Franks", productUpc: UPC, photoIds: ["photo-1"] });
  const decoded = roundTrip(any, item);
  assert.equal(decoded.productUpc, UPC);
  assert.deepEqual(decoded.photoIds, ["photo-1"]);
});

test("an item read from AnyList exposes its barcode", () => {
  const { any } = anylist();
  const item = any.createItem({ name: "Kiolbassa", productUpc: "0026875130116", photoIds: ["p"] });
  assert.equal(item.productUpc, "0026875130116");
  assert.deepEqual(item.photoIds, ["p"]);
});

test("a typed item encodes no barcode and no photo", () => {
  const { any } = anylist();
  const decoded = roundTrip(any, any.createItem({ name: "sausage" }));
  assert.equal(decoded.productUpc, null);
  assert.deepEqual(decoded.photoIds, []);
});

test("lookupProduct decodes a match from the product-lookup endpoint", async () => {
  const { any, seen } = anylist(a => ({
    statusCode: 200,
    body: new a.protobuf.PBProductLookupResponse({
      listItem: { identifier: "x", name: "Sabrett Cocktail Beef Franks", productUpc: UPC,
                  categoryMatchId: "frozen-foods", photoIds: ["photo-1"] },
      productThumbnailUrl: "https://example.test/thumb.jpg",
    }).encode().toBuffer(),
  }));
  const product = await any.lookupProduct(UPC);
  assert.deepEqual(seen, [`data/product-lookup/${UPC}`]);
  assert.equal(product.name, "Sabrett Cocktail Beef Franks");
  assert.equal(product.productUpc, UPC);
  assert.equal(product.categoryMatchId, "frozen-foods");
  assert.deepEqual(product.photoIds, ["photo-1"]);
  assert.equal(product.thumbnailUrl, "https://example.test/thumb.jpg");
});

test("lookupProduct returns null when AnyList has no match", async () => {
  const { any } = anylist(() => ({ statusCode: 404, body: Buffer.alloc(0) }));
  assert.equal(await any.lookupProduct(UPC), null);
});

// ── the MCP client's use of it ───────────────────────────────────────────────
// The tool tests replace these methods with a mock, so without the tests below
// nothing would check that the real client passes the barcode through.

const { default: AnyListClient } = await import("../src/anylist-client.js");

function mcpClient(items = []) {
  const { any } = anylist();
  const added = [];
  const client = new AnyListClient({ username: "u", password: "p" });
  client.client = any;
  client.targetList = { name: "Test", items, addItem: async item => { added.push(item); } };
  return { client, any, added };
}

test("addProduct adds the looked-up product with its barcode and photo", async () => {
  const { client, any, added } = mcpClient();
  await client.addProduct({ name: "Sabrett Cocktail Beef Franks", productUpc: UPC, photoIds: ["photo-1"],
                            categoryMatchId: "frozen-foods" });
  assert.equal(added.length, 1);
  const decoded = roundTrip(any, added[0]);
  assert.equal(decoded.name, "Sabrett Cocktail Beef Franks");
  assert.equal(decoded.productUpc, UPC);
  assert.deepEqual(decoded.photoIds, ["photo-1"]);
  assert.equal(decoded.categoryMatchId, "frozen-foods");
});

test("findItemByUpc finds the saved item carrying the barcode", () => {
  const { any } = anylist();
  const saved = any.createItem({ name: "Kiolbassa", productUpc: "0026875130116" });
  const typed = any.createItem({ name: "sausage" });
  const { client } = mcpClient([typed, saved]);
  assert.equal(client.findItemByUpc("0026875130116"), saved);
  assert.equal(client.findItemByUpc(UPC), null);
});

test("lookupProduct throws on any other failure, so it never reads as no match", async () => {
  const { any } = anylist(() => ({ statusCode: 503, body: Buffer.alloc(0) }));
  await assert.rejects(any.lookupProduct(UPC), /HTTP 503/);
});
