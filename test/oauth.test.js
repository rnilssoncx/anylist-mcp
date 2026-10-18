/**
 * OAuth authorization-code flow: redirect_uri binding, consent, and code binding.
 *
 * The attack these cover: anyone can POST /oauth/register, so an attacker can
 * register a client and send the owner an /oauth/authorize link that names their
 * own redirect_uri. Before these checks, the server accepted any redirect_uri and
 * a fresh login issued the code with no consent step — so logging in through the
 * link handed the owner's AnyList access to whoever built it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(tmpdir(), "anylist-mcp-oauth-"));
const allowed = path.join(dataDir, "allowed-emails.txt");
writeFileSync(allowed, "owner@example.com\n");
// db.js reads these at import time, so they are set before the dynamic imports.
process.env.DATA_DIR = dataDir;
process.env.ALLOWED_EMAILS_FILE = allowed;
process.env.SERVER_SECRET_KEY = "ab".repeat(32);

const { default: express } = await import("express");
const { default: session } = await import("express-session");
const { default: oauthRouter } = await import("../src/http/auth/oauth.js");
const { registerWithPassword } = await import("../src/http/auth/providers/password.js");
const { upsertAnyListCredentials } = await import("../src/http/db.js");

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const EVIL_CALLBACK = "https://evil.example/cb";
const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/http/views");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  // Render the template's options as JSON so tests can read what a page was given.
  app.engine("html", (_file, options, cb) => {
    const { settings, _locals, cache, ...rest } = options;
    cb(null, JSON.stringify(rest));
  });
  app.set("view engine", "html");
  app.set("views", viewsDir);
  app.use(oauthRouter);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const user = await registerWithPassword("owner@example.com", "correct horse");
  upsertAnyListCredentials(user.id, { username: "owner@example.com", password: "anylist-pw" });
});

after(() => server.close());

// ── helpers ───────────────────────────────────────────────────────────────────

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A browser: follows nothing, keeps its session cookie. */
function browser() {
  let cookie = "";
  return async function request(pathname, { method = "GET", form, json } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    } else if (json) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    }
    const res = await fetch(base + pathname, { method, headers, body, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
}

async function register(redirectUris) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(redirectUris === undefined ? {} : { redirect_uris: redirectUris }),
  });
  return (await res.json()).client_id;
}

function authorizeUrl(clientId, redirectUri, challenge) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `/oauth/authorize?${q}`;
}

/** Log in through an authorize link and approve consent; returns the code. */
async function codeFor(clientId, redirectUri, challenge) {
  const request = browser();
  await request(authorizeUrl(clientId, redirectUri, challenge));
  await request("/auth/login", { method: "POST", form: { email: "owner@example.com", password: "correct horse" } });
  const approved = await request("/oauth/consent", { method: "POST", form: { approve: "yes" } });
  return new URL(approved.headers.get("location")).searchParams.get("code");
}

// ── redirect_uri binding ──────────────────────────────────────────────────────

test("authorize refuses a redirect_uri the client did not register", async () => {
  const clientId = await register([CLAUDE_CALLBACK]);
  const res = await browser()(authorizeUrl(clientId, EVIL_CALLBACK, pkce().challenge));
  assert.equal(res.status, 400);
});

test("authorize refuses an unknown client_id", async () => {
  const res = await browser()(authorizeUrl("not-a-client", CLAUDE_CALLBACK, pkce().challenge));
  assert.equal(res.status, 400);
});

test("a public client registered without redirect URIs cannot name its own", async () => {
  // Otherwise the redirect check is bypassed by registering with none.
  const clientId = await register(undefined);
  const res = await browser()(authorizeUrl(clientId, EVIL_CALLBACK, pkce().challenge));
  assert.equal(res.status, 400);
});

test("authorize refuses a registered redirect_uri that is not a URL", async () => {
  // Registration accepts any string, and the consent page has to show a host.
  const clientId = await register(["not a url"]);
  const res = await browser()(authorizeUrl(clientId, "not a url", pkce().challenge));
  assert.equal(res.status, 400);
});

test("authorize accepts a registered redirect_uri, including one that is not first", async () => {
  // DCR may send several; storing only the first would break a client using another.
  const clientId = await register(["https://claude.com/api/mcp/auth_callback", CLAUDE_CALLBACK]);
  const res = await browser()(authorizeUrl(clientId, CLAUDE_CALLBACK, pkce().challenge));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

// ── consent ───────────────────────────────────────────────────────────────────

test("a fresh login goes to consent instead of straight back with a code", async () => {
  const clientId = await register([CLAUDE_CALLBACK]);
  const request = browser();
  await request(authorizeUrl(clientId, CLAUDE_CALLBACK, pkce().challenge));
  const res = await request("/auth/login", {
    method: "POST",
    form: { email: "owner@example.com", password: "correct horse" },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/oauth/consent");
});

test("the consent page names the host the code will be sent to", async () => {
  const clientId = await register([CLAUDE_CALLBACK]);
  const request = browser();
  await request(authorizeUrl(clientId, CLAUDE_CALLBACK, pkce().challenge));
  await request("/auth/login", { method: "POST", form: { email: "owner@example.com", password: "correct horse" } });
  const page = JSON.parse(await (await request("/oauth/consent")).text());
  assert.equal(page.redirectHost, "claude.ai");
});

// ── code binding at the token endpoint ───────────────────────────────────────

test("the token endpoint refuses a code issued to a different client", async () => {
  const { verifier, challenge } = pkce();
  const issuedTo = await register([CLAUDE_CALLBACK]);
  const other = await register([CLAUDE_CALLBACK]);
  const code = await codeFor(issuedTo, CLAUDE_CALLBACK, challenge);

  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: other }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("the full flow still issues a token to the client it began with", async () => {
  // Positive control: the checks above must not break the flow Claude uses.
  const { verifier, challenge } = pkce();
  const clientId = await register([CLAUDE_CALLBACK]);
  const code = await codeFor(clientId, CLAUDE_CALLBACK, challenge);

  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    }),
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).access_token);
});
