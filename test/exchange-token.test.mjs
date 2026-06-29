import assert from "node:assert/strict";
import test from "node:test";

import { claimEndpoint, exchange } from "../scripts/exchange-token.mjs";

const TOKEN_ENDPOINT = "https://act101.ai/api/scan/token";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status });
}

// Install a fetch stub that replays per-URL queues and records every call.
// Returns { calls } so a test can assert the exact request sequence.
function installFetch(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    calls.push({ url: u, body: options?.body, authorization: options?.headers?.Authorization });
    const queue = handlers[u];
    if (!queue || queue.length === 0) throw new Error(`unexpected fetch to ${u}`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("claimEndpoint swaps the trailing /token for /claim-free-scan on the same host", () => {
  assert.equal(claimEndpoint(TOKEN_ENDPOINT), "https://act101.ai/api/scan/claim-free-scan");
  assert.equal(claimEndpoint("https://stg.act101.ai/api/scan/token/"), "https://stg.act101.ai/api/scan/claim-free-scan");
  assert.equal(claimEndpoint(undefined), "https://act101.ai/api/scan/claim-free-scan");
});

test("uses the token directly when /token mints on the first call (entitled repo)", async () => {
  const fetchStub = installFetch({
    [TOKEN_ENDPOINT]: [jsonResponse(200, { token: "scan-jwt-direct" })],
  });
  try {
    const result = await exchange(TOKEN_ENDPOINT, "oidc-abc");
    assert.equal(result.token, "scan-jwt-direct");
    assert.equal(result.viaFreeScan, undefined);
    assert.equal(fetchStub.calls.length, 1, "must not claim a free scan when already entitled");
    assert.equal(fetchStub.calls[0].body, "{}");
  } finally {
    fetchStub.restore();
  }
});

test("on 402, claims the free scan and retries /token with the grant (the missing handshake)", async () => {
  const fetchStub = installFetch({
    [TOKEN_ENDPOINT]: [
      jsonResponse(402, { error: "over_cap", upsell_url: "https://github.com/apps/act101-online/installations/new" }),
      jsonResponse(200, { token: "scan-jwt-freescan" }),
    ],
    [claimEndpoint(TOKEN_ENDPOINT)]: [
      jsonResponse(200, { ok: true, token: "free-grant-uuid", exp: 1782778251 }),
    ],
  });
  try {
    const result = await exchange(TOKEN_ENDPOINT, "oidc-abc");
    assert.equal(result.token, "scan-jwt-freescan");
    assert.equal(result.viaFreeScan, true);
    // Sequence: POST /token {} -> 402, POST /claim-free-scan -> grant,
    // POST /token {free_scan_token} -> mint.
    assert.equal(fetchStub.calls.length, 3);
    assert.equal(fetchStub.calls[0].url, TOKEN_ENDPOINT);
    assert.equal(fetchStub.calls[0].body, "{}");
    assert.equal(fetchStub.calls[1].url, claimEndpoint(TOKEN_ENDPOINT));
    assert.equal(fetchStub.calls[1].authorization, "Bearer oidc-abc");
    assert.equal(fetchStub.calls[2].url, TOKEN_ENDPOINT);
    assert.deepEqual(JSON.parse(fetchStub.calls[2].body), { free_scan_token: "free-grant-uuid" });
  } finally {
    fetchStub.restore();
  }
});

test("no token when the free scan was already spent (402 free_scan_spent)", async () => {
  const fetchStub = installFetch({
    [TOKEN_ENDPOINT]: [jsonResponse(402, { error: "over_cap" })],
    [claimEndpoint(TOKEN_ENDPOINT)]: [jsonResponse(402, { error: "free_scan_spent" })],
  });
  try {
    const result = await exchange(TOKEN_ENDPOINT, "oidc-abc");
    assert.equal(result.token, "");
    assert.match(result.reason, /free_scan_spent/);
    assert.equal(fetchStub.calls.length, 2, "must not retry /token when the claim is refused");
  } finally {
    fetchStub.restore();
  }
});

test("no token when the grant redemption retry is itself refused", async () => {
  const fetchStub = installFetch({
    [TOKEN_ENDPOINT]: [
      jsonResponse(402, { error: "over_cap" }),
      jsonResponse(402, { error: "over_cap" }),
    ],
    [claimEndpoint(TOKEN_ENDPOINT)]: [jsonResponse(200, { ok: true, token: "free-grant-uuid" })],
  });
  try {
    const result = await exchange(TOKEN_ENDPOINT, "oidc-abc");
    assert.equal(result.token, "");
    assert.match(result.reason, /free-scan retry/);
    assert.equal(fetchStub.calls.length, 3);
  } finally {
    fetchStub.restore();
  }
});

test("a non-402 failure does not attempt a free-scan claim", async () => {
  const fetchStub = installFetch({
    [TOKEN_ENDPOINT]: [jsonResponse(401, { error: "unauthorized", reason: "bad_oidc" })],
  });
  try {
    const result = await exchange(TOKEN_ENDPOINT, "oidc-abc");
    assert.equal(result.token, "");
    assert.match(result.reason, /HTTP 401/);
    assert.equal(fetchStub.calls.length, 1, "a 401 is not a free-scan opportunity");
  } finally {
    fetchStub.restore();
  }
});
