#!/usr/bin/env node
// A1 Arena post-scan counter (CG3, spec §5.1/§5.2/§5.4).
//
// Reads act101-scan-raw.json and POSTs the published score + counters + scope
// to the worker leaderboard ingest (POST /api/scan/counter). Best-effort and
// droppable: any failure logs a ::warning and exits 0 — this step must never
// fail the check.
//
// Guard conditions (the action.yml `if` already enforces most of these; this
// script re-checks defensively so a mis-routed manual invocation can't post
// something the spec forbids):
//   - pull_request OR push to the default branch
//   - repository is public
//   - the report scan was full-repo (scope.mode != "diff")
//   - the published overall score is finite (non-null)
//   - a GitHub OIDC token is present (the handler re-verifies it; a license-
//     entitled scan has no OIDC and must not post)
//
// Per §5.2 only full-repo published scores enter score_history server-side;
// diff-scoped PR scans never reach this script. We always send scope:"full"
// (the report step runs a full scan) plus the arena opt-in flag.

import fs from "node:fs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH || "";
  if (!eventPath || !fs.existsSync(eventPath)) return {};
  try {
    return readJson(eventPath);
  } catch {
    return {};
  }
}

export function isPublicRepository(event) {
  const repo = event.repository;
  return Boolean(repo && repo.private === false && repo.visibility !== "private");
}

export function isQualifyingRef(event, env) {
  const eventName = env.GITHUB_EVENT_NAME || event.event_name || "";
  const ref = env.GITHUB_REF || "";
  if (eventName === "pull_request") return true;
  if (eventName === "push") {
    const defaultBranch =
      event.repository?.default_branch || "main";
    return ref === `refs/heads/${defaultBranch}`;
  }
  return false;
}

// Derive the counter endpoint from the token endpoint by swapping the trailing
// /token for /counter (both live under /api/scan/* on the same worker).
export function counterEndpoint(tokenEndpoint) {
  const base = (tokenEndpoint || "https://act101.ai/api/scan/token").replace(/\/$/, "");
  return base.replace(/\/token$/, "/counter");
}

async function main() {
  const oidcToken = process.env.ACT_OIDC_TOKEN || "";
  const event = readEvent();

  if (!oidcToken) {
    console.log("act101 counter skipped: no GitHub OIDC token (license-key scan or OIDC unavailable).");
    return;
  }

  if (!isQualifyingRef(event, process.env)) {
    console.log("act101 counter skipped: not a pull_request or push to the default branch.");
    return;
  }

  if (!isPublicRepository(event)) {
    console.log("act101 counter skipped: repository is not public.");
    return;
  }

  if (!fs.existsSync("act101-scan-raw.json")) {
    console.log("act101 counter skipped: act101-scan-raw.json not found.");
    return;
  }

  let report;
  try {
    report = readJson("act101-scan-raw.json");
  } catch (error) {
    console.log(`::warning::act101 counter could not parse act101-scan-raw.json: ${error?.message || error}`);
    return;
  }

  const overall = report?.score?.overall;
  const scopeMode = report?.scope?.mode;
  const nonBlankLines = report?.scale?.non_blank_lines;

  // Full-repo guard: the report step always runs a full scan, but a future
  // caller could point this at a diff-scoped raw file. Reject it.
  if (scopeMode === "diff") {
    console.log("act101 counter skipped: report is diff-scoped (only full-repo scans enter score_history).");
    return;
  }

  if (typeof overall !== "number" || !Number.isFinite(overall)) {
    console.log("act101 counter skipped: published overall score is null/non-finite.");
    return;
  }

  const payload = {
    score: overall,
    scope: "full",
    arena: true,
    bucket: "scans_total",
  };
  if (typeof report?.score?.security === "number" && Number.isFinite(report.score.security)) {
    payload.security = report.score.security;
  }
  if (typeof report?.score?.architecture === "number" && Number.isFinite(report.score.architecture)) {
    payload.architecture = report.score.architecture;
  }
  if (typeof nonBlankLines === "number" && Number.isFinite(nonBlankLines)) {
    payload.non_blank_lines = nonBlankLines;
  }

  const endpoint = counterEndpoint(process.env.TOKEN_ENDPOINT);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
        "User-Agent": "act101-scan-action",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log(`::warning::act101 counter POST failed: ${error?.message || error}`);
    return;
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    console.log(`::warning::act101 counter ingest returned HTTP ${response.status}: ${body}`);
    return;
  }

  console.log(`act101 counter ingest accepted (overall=${overall}).`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    // Droppable: never fail the check over a best-effort ingest.
    console.log(`::warning::act101 counter failed: ${error?.message || error}`);
    process.exit(0);
  }
}
