#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  fallbackReport,
  normalizeReport,
  renderHtml,
  renderMarkdown,
  renderSummary,
} from "./report.mjs";

function argValue(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

const input = argValue("--input", "act101-scan-raw.json");
const outDir = argValue("--out-dir", "act101-report");
const fallbackReason = argValue("--fallback-reason", "");
const sarifStatus = argValue("--sarif-status", "pending");
const sarifReason = argValue("--sarif-reason", "");

fs.mkdirSync(outDir, { recursive: true });

let report;
if (fs.existsSync(input)) {
  report = normalizeReport(JSON.parse(fs.readFileSync(input, "utf8")));
} else {
  report = fallbackReport({
    reason: fallbackReason || "act101 scan did not produce a report.",
    repository: process.env.GITHUB_REPOSITORY || "",
    sha: process.env.GITHUB_SHA || "",
  });
}

const context = {
  repository: process.env.GITHUB_REPOSITORY || "unknown/unknown",
  sha: process.env.GITHUB_SHA || "unknown",
  runUrl:
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "",
  artifactName: "act101-report",
  sarifStatus,
  sarifReason,
};

fs.writeFileSync(path.join(outDir, "act101-report.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "act101-report.md"), renderMarkdown(report, context));
fs.writeFileSync(path.join(outDir, "act101-report.html"), renderHtml(report, context));
fs.writeFileSync("act101-report.json", `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync("act101-report.md", renderMarkdown(report, context));
fs.writeFileSync("act101-report.html", renderHtml(report, context));

const summary = renderSummary(report, context);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
console.log(summary);
