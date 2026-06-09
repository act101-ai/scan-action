#!/usr/bin/env node
import fs from "node:fs";

import { commentsForPullRequest, normalizeReport } from "./report.mjs";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const eventPath = process.env.GITHUB_EVENT_PATH || "";
const repository = process.env.GITHUB_REPOSITORY || "";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function github(path, options = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "act101-scan-action",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

if (!token || !eventPath || !repository) {
  console.log("act101 PR comments skipped: missing token, event path, or repository context.");
  process.exit(0);
}

const event = readJson(eventPath);
const pullRequest = event.pull_request;
if (!pullRequest?.number) {
  console.log("act101 PR comments skipped: this is not a pull_request event.");
  process.exit(0);
}

const report = normalizeReport(readJson("act101-report.json"));
const comments = commentsForPullRequest(report);
if (comments.length === 0) {
  console.log("act101 PR comments skipped: no line-specific findings.");
  process.exit(0);
}

const [owner, repo] = repository.split("/");
const commitId = pullRequest.head?.sha || process.env.GITHUB_SHA;
let posted = 0;
let skipped = 0;

for (const comment of comments.slice(0, 25)) {
  const result = await github(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/comments`, {
    method: "POST",
    body: JSON.stringify({
      commit_id: commitId,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: `${comment.body}\n\n[Open workflow run](${serverUrl}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID})`,
    }),
  });
  if (result.ok) {
    posted += 1;
  } else {
    skipped += 1;
    console.log(`act101 PR comment skipped for ${comment.path}:${comment.line}: HTTP ${result.status}`);
  }
}

console.log(`act101 PR comments: posted=${posted} skipped=${skipped}`);
