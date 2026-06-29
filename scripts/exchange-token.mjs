#!/usr/bin/env node
// Scan-token exchange + free-once private-scan handshake.
//
// The GitHub OIDC token is the trust root. The worker mints a scan JWT in
// exchange for it at POST /api/scan/token. Three outcomes matter here:
//
//   1. 2xx with a token  → use it directly (public repos, or an entitled
//      private repo: an active paid band or an internal grant).
//   2. 402 (over_cap / no_entitlement) → the repo is a private repo with no
//      active entitlement. EVERY account gets ONE free private-repo scan, so we
//      redeem it: POST the OIDC token to /api/scan/claim-free-scan, which
//      atomically flips the abuse spine 0→1 and returns a single-use
//      free_scan_token, then RETRY /token with {"free_scan_token": "..."} so the
//      worker redeems the grant and mints the JWT.
//   3. anything else, or a spent free scan → no token; the caller falls back to
//      the bundled launch scanner.
//
// Without step 2 a free-account private repo can never obtain its one free scan
// through the Action — it 402s and silently degrades. This handshake is the
// piece that makes "one free scan per account" actually reachable from CI.
//
// Reads from env:  OIDC_TOKEN, TOKEN_ENDPOINT
// Writes (GitHub Actions step plumbing, when present):
//   $GITHUB_ENV     ACT_SCAN_TOKEN=<jwt>   (only on success)
//   $GITHUB_OUTPUT  token_available=true|false
// Always emits a `::add-mask::` for any minted JWT before it is exposed.

import fs from "node:fs";

const USER_AGENT = "act101-scan-action";

// Derive the claim endpoint from the token endpoint by swapping the trailing
// /token for /claim-free-scan (both live under /api/scan/* on the same worker).
export function claimEndpoint(tokenEndpoint) {
  const base = (tokenEndpoint || "https://act101.ai/api/scan/token").replace(/\/$/, "");
  return base.replace(/\/token$/, "/claim-free-scan");
}

// Best-effort body reader for diagnostics.
async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Parse a scan token out of a /token response body. Returns "" when absent.
function parseToken(text) {
  try {
    const data = JSON.parse(text);
    return typeof data.token === "string" ? data.token : "";
  } catch {
    return "";
  }
}

async function postToken(endpoint, oidcToken, freeScanToken) {
  const body = freeScanToken ? JSON.stringify({ free_scan_token: freeScanToken }) : "{}";
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body,
  });
}

// Run the full exchange. Returns { token } on success or { token: "", reason }.
// Pure of GitHub Actions plumbing so it is unit-testable; `main()` wires the
// result to $GITHUB_ENV/$GITHUB_OUTPUT.
export async function exchange(tokenEndpoint, oidcToken) {
  // 1. Initial mint attempt.
  let response;
  try {
    response = await postToken(tokenEndpoint, oidcToken, null);
  } catch (error) {
    return { token: "", reason: `token exchange request failed: ${error?.message || error}` };
  }

  if (response.ok) {
    const token = parseToken(await readBody(response));
    if (token) return { token };
    return { token: "", reason: "token response did not contain a scan token" };
  }

  // 2. Only a 402 is a free-scan opportunity. A public repo never 402s, so a 402
  //    here means a private repo with no active entitlement — redeem its one
  //    free scan. Any other status is a hard failure (caller falls back).
  if (response.status !== 402) {
    const body = await readBody(response);
    return { token: "", reason: `scan token exchange returned HTTP ${response.status}: ${body}` };
  }

  // 2a. Claim the one-time free scan.
  let claimResponse;
  try {
    claimResponse = await fetch(claimEndpoint(tokenEndpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: "{}",
    });
  } catch (error) {
    return { token: "", reason: `free-scan claim request failed: ${error?.message || error}` };
  }

  if (!claimResponse.ok) {
    const body = await readBody(claimResponse);
    // 402 free_scan_spent is the expected "already used your free scan" signal.
    return { token: "", reason: `free-scan claim returned HTTP ${claimResponse.status}: ${body}` };
  }

  let freeScanToken = "";
  try {
    const claim = JSON.parse(await readBody(claimResponse));
    freeScanToken = typeof claim.token === "string" ? claim.token : "";
  } catch {
    freeScanToken = "";
  }
  if (!freeScanToken) {
    return { token: "", reason: "free-scan claim did not return a grant token" };
  }

  // 2b. Retry the mint, presenting the grant for redemption.
  let retry;
  try {
    retry = await postToken(tokenEndpoint, oidcToken, freeScanToken);
  } catch (error) {
    return { token: "", reason: `token exchange retry failed: ${error?.message || error}` };
  }
  if (!retry.ok) {
    const body = await readBody(retry);
    return { token: "", reason: `scan token exchange (free-scan retry) returned HTTP ${retry.status}: ${body}` };
  }
  const token = parseToken(await readBody(retry));
  if (token) return { token, viaFreeScan: true };
  return { token: "", reason: "free-scan retry response did not contain a scan token" };
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

function exportEnv(name, value) {
  const file = process.env.GITHUB_ENV;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

async function main() {
  const oidcToken = process.env.OIDC_TOKEN || "";
  const tokenEndpoint = process.env.TOKEN_ENDPOINT || "https://act101.ai/api/scan/token";

  if (!oidcToken) {
    console.log("::warning::act101 scan token exchange skipped: no GitHub OIDC token.");
    setOutput("token_available", "false");
    return;
  }

  const result = await exchange(tokenEndpoint, oidcToken);
  if (result.token) {
    // Mask before the value can surface anywhere downstream.
    console.log(`::add-mask::${result.token}`);
    exportEnv("ACT_SCAN_TOKEN", result.token);
    setOutput("token_available", "true");
    if (result.viaFreeScan) {
      console.log("act101: entitled this run via the account's free private-repo scan.");
    }
    return;
  }

  console.log(`::warning::act101 ${result.reason}`);
  setOutput("token_available", "false");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    console.log(`::warning::act101 scan token exchange failed: ${error?.message || error}`);
    setOutput("token_available", "false");
    process.exit(0);
  }
}
