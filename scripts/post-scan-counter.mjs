#!/usr/bin/env node
// act101 post-scan counter.
//
// Reads act101-scan-raw.json and POSTs the published score + counters + scope
// to the worker scan-counter ingest (POST /api/scan/counter). Best-effort and
// droppable: any failure logs a ::warning and exits 0 — this step must never
// fail the check.
//
// What the worker does with the post: it increments an aggregate scan counter
// for every caller, and for a PUBLIC repository it also refreshes that
// repository's own badge score and appends a row to that repository's own
// score history. A private repository gets the counter only — no badge, no
// history row.
//
// Guard conditions (the action.yml `if` already enforces most of these; this
// script re-checks defensively so a mis-routed manual invocation can't post
// something it should not):
//   - push to the default branch only (pull_request does not qualify)
//   - repository is public
//   - the report scan was full-repo (scope.mode != "diff")
//   - the published overall score is finite (non-null)
//   - a GitHub OIDC token is present (the handler re-verifies it; a license-
//     entitled scan has no OIDC and must not post)
//
// Only full-repo published scores enter score_history server-side; diff-scoped
// PR scans never reach this script. We always send scope:"full" (the report
// step runs a full scan).

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
  // The badge and the repository's score history track the default branch
  // (canonical scores), not WIP pull requests, so only a push to the default
  // branch qualifies.
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
    console.log("act101 counter skipped: not a push to the default branch (the badge and score history track the default branch, not pull requests).");
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
  // Difficulty signal: the number of distinct grammars in the scan, recorded
  // with the score so the repository's own history carries how much ground the
  // score covered. Derived from the scan's ScaleMetrics.by_language; absent on
  // pre-ScaleMetrics reports.
  const grammarCount = Array.isArray(report?.scale?.by_language)
    ? report.scale.by_language.length
    : undefined;
  // The grammar names from ScaleMetrics.by_language (already sorted by line
  // count descending), stored alongside the repository's score history. Names
  // only — never paths or code. Capped at 16; the worker caps it again on
  // ingest. Absent on pre-ScaleMetrics reports.
  const languages = Array.isArray(report?.scale?.by_language)
    ? report.scale.by_language
        .map((entry) => entry?.language)
        .filter((name) => typeof name === "string" && name.length > 0)
        .slice(0, 16)
    : undefined;

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
  if (typeof grammarCount === "number" && Number.isFinite(grammarCount)) {
    payload.grammar_count = grammarCount;
  }
  if (Array.isArray(languages) && languages.length > 0) {
    payload.languages = languages;
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
