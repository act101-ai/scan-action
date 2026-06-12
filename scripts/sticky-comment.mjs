#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { normalizeReport, renderMarkdown } from "./report.mjs";

export const STICKY_MARKER = "<!-- act101-scan-report -->";

const BODY_LIMIT = 65536; // GitHub issue-comment hard cap

// Marker first (the update key), then the report, then provenance.
export function buildStickyBody(markdown, { runUrl } = {}) {
  const footer = runUrl ? `\n\n---\n[Open workflow run](${runUrl})` : "";
  let report = markdown.trimEnd();
  const overhead = STICKY_MARKER.length + footer.length + 64;
  if (report.length + overhead > BODY_LIMIT) {
    report = `${report.slice(0, BODY_LIMIT - overhead)}\n\n_…report truncated (full report in the run artifact)._`;
  }
  return `${STICKY_MARKER}\n${report}${footer}`;
}

export function findStickyComment(comments) {
  return comments.find((comment) => typeof comment.body === "string" && comment.body.startsWith(STICKY_MARKER));
}

async function main() {
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
    console.log("act101 sticky comment skipped: missing token, event path, or repository context.");
    process.exit(0);
  }

  const event = readJson(eventPath);
  const pullRequest = event.pull_request;
  if (!pullRequest?.number) {
    console.log("act101 sticky comment skipped: this is not a pull_request event.");
    process.exit(0);
  }

  const runUrl = process.env.GITHUB_RUN_ID
    ? `${serverUrl}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";

  let markdown;
  if (fs.existsSync("act101-comment.md")) {
    markdown = fs.readFileSync("act101-comment.md", "utf8");
  } else if (fs.existsSync("act101-report.json")) {
    const report = normalizeReport(readJson("act101-report.json"));
    markdown = renderMarkdown(report, {
      repository,
      sha: pullRequest.head?.sha || process.env.GITHUB_SHA || "unknown",
      runUrl,
    });
  } else {
    console.log("act101 sticky comment skipped: no act101-comment.md or act101-report.json found.");
    process.exit(0);
  }

  const body = buildStickyBody(markdown, { runUrl });
  const [owner, repo] = repository.split("/");

  const listing = await github(
    `/repos/${owner}/${repo}/issues/${pullRequest.number}/comments?per_page=100`,
  );
  if (!listing.ok) {
    console.log(`::warning::act101 sticky comment: failed to list PR comments (HTTP ${listing.status}).`);
    process.exit(0);
  }

  const existing = findStickyComment(Array.isArray(listing.body) ? listing.body : []);
  const result = existing
    ? await github(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      })
    : await github(`/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });

  if (!result.ok) {
    console.log(
      `::warning::act101 sticky comment: failed to ${existing ? "update" : "create"} comment (HTTP ${result.status}).`,
    );
    process.exit(0);
  }

  console.log(`act101 sticky comment: ${existing ? "updated" : "created"} id=${result.body?.id ?? existing?.id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // The comment is additive; a network failure posting it must not fail the check.
    console.log(`::warning::act101 sticky comment failed: ${error?.message || error}`);
    process.exit(0);
  }
}
