#!/usr/bin/env node
// Seed the HTTP server's database from the environment, for a host whose disk
// starts empty on every boot.
//
//   SEED_EMAIL, SEED_CLIENT_ID, SEED_CLIENT_SECRET, ANYLIST_USERNAME,
//   ANYLIST_PASSWORD, optional ANYLIST_LIST_NAME, plus the server's own
//   DATA_DIR and SERVER_SECRET_KEY.
//
// The client id and secret come from the environment rather than being
// generated, as scripts/create-client.js does, because the client is what a
// remote caller has stored: a fresh random client on every boot would break it
// at every restart. Running it again is safe — the user and client are reused,
// and the AnyList login and the client secret are brought up to date, so a
// rotated secret takes effect at the next start.
//
// The user gets no password, so there is no way to sign in to the web pages as
// it; the only way in is the client credentials grant.

import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import {
  getDb, getUserByEmail, createUser, upsertAnyListCredentials,
  getOAuthClientWithSecret, createConfidentialClient,
} from "../src/http/db.js";

const REQUIRED = ["SEED_EMAIL", "SEED_CLIENT_ID", "SEED_CLIENT_SECRET", "ANYLIST_USERNAME", "ANYLIST_PASSWORD"];
const MIN_SECRET_LENGTH = 32;

export async function seed(env = process.env) {
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length > 0) throw new Error(`seed: missing ${missing.join(", ")}`);
  if (env.SEED_CLIENT_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(`seed: SEED_CLIENT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  // Every check comes before the first write, so a refusal leaves nothing behind.
  const existing = getUserByEmail(env.SEED_EMAIL);
  const client = getOAuthClientWithSecret(env.SEED_CLIENT_ID);
  if (client && client.user_id !== existing?.id) {
    throw new Error("seed: SEED_CLIENT_ID is already registered to a different user");
  }

  const user = existing || createUser({ id: randomUUID(), email: env.SEED_EMAIL });
  upsertAnyListCredentials(user.id, {
    username: env.ANYLIST_USERNAME,
    password: env.ANYLIST_PASSWORD,
    defaultListName: env.ANYLIST_LIST_NAME || null,
  });
  const secretHash = () => bcrypt.hash(env.SEED_CLIENT_SECRET, 12);
  if (!client) {
    createConfidentialClient({ clientId: env.SEED_CLIENT_ID, clientSecretHash: await secretHash(), userId: user.id, clientName: "seeded" });
  } else if (!client.client_secret_hash || !(await bcrypt.compare(env.SEED_CLIENT_SECRET, client.client_secret_hash))) {
    getDb().prepare("UPDATE oauth_clients SET client_secret_hash = ? WHERE client_id = ?").run(await secretHash(), env.SEED_CLIENT_ID);
  }
  return { userId: user.id };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seed();
    console.log("seed: done");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
