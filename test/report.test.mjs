import assert from "node:assert/strict";
import test from "node:test";

import {
  commentsForPullRequest,
  normalizeReport,
  renderMarkdown,
  renderSarif,
  renderSummary,
} from "../scripts/report.mjs";

test("renderMarkdown produces an agent-ready remediation report", () => {
  const report = normalizeReport({
    score: { overall: 82, security: 75, architecture: 90 },
    findings: [
      {
        id: "finding-1",
        class: "hardcoded_credential",
        half: "security",
        severity: "high",
        title: "Hardcoded token",
        detail: "A token-like string is committed.",
        file: "src/app.ts",
        line: 12,
        column: 5,
        end_line: 12,
        remediation: "Move the value to a secret manager.",
      },
    ],
  });

  const markdown = renderMarkdown(report, {
    repository: "acme/api",
    sha: "abc123",
    runUrl: "https://github.com/acme/api/actions/runs/1",
  });

  assert.match(markdown, /AI-Code Health Score: 82\/100/);
  assert.match(markdown, /src\/app\.ts:12/);
  assert.match(markdown, /Agent remediation brief/);
  assert.match(markdown, /Move the value to a secret manager/);
});

test("renderSummary links the attached report and keeps SARIF as optional", () => {
  const report = normalizeReport({
    score: { overall: null, security: null, architecture: null },
    findings: [],
  });

  const summary = renderSummary(report, {
    artifactName: "act101-report",
    sarifStatus: "skipped",
    sarifReason: "GitHub code scanning is not enabled for this private repository.",
  });

  assert.match(summary, /act101-report/);
  assert.match(summary, /SARIF upload: skipped/);
  assert.match(summary, /code scanning is not enabled/);
});

test("renderMarkdown collapses repeated non-production diagnostics", () => {
  const report = normalizeReport({
    score: { overall: 90, security: 100, architecture: 80 },
    findings: [],
    diagnostics: [
      { kind: "excluded_nonproduction", file: "docs/a.md", message: "path_segment:docs" },
      { kind: "excluded_nonproduction", file: "docs/b.md", message: "path_segment:docs" },
      { kind: "excluded_nonproduction", file: "tests/a.test.ts", message: "path_segment:tests" },
      { kind: "excluded_nonproduction", file: "README.md", message: "extension:documentation" },
      { kind: "ledger_invalid", file: ".act/refuted.json", message: "invalid refuted ledger" },
    ],
  });

  const markdown = renderMarkdown(report);

  assert.match(markdown, /## Diagnostics/);
  assert.match(markdown, /Skipped non-production files: 4/);
  assert.match(markdown, /path_segment:docs: 2; examples: `docs\/a.md`, `docs\/b.md`/);
  assert.match(markdown, /path_segment:tests: 1; examples: `tests\/a.test.ts`/);
  assert.match(markdown, /`.act\/refuted.json`: invalid refuted ledger/);
  assert.doesNotMatch(markdown, /- path_segment:docs\n- path_segment:docs/);
});

test("commentsForPullRequest creates one inline review comment per finding", () => {
  const report = normalizeReport({
    findings: [
      {
        id: "finding-1",
        severity: "high",
        title: "Hardcoded token",
        detail: "A token-like string is committed.",
        file: "src/app.ts",
        line: 12,
        remediation: "Move the value to a secret manager.",
      },
      {
        id: "finding-2",
        severity: "low",
        title: "Repo-wide issue",
        detail: "No precise line.",
        remediation: "Review the configuration.",
      },
    ],
  });

  const comments = commentsForPullRequest(report);

  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, "src/app.ts");
  assert.equal(comments[0].line, 12);
  assert.match(comments[0].body, /<!-- act101:finding:finding-1 -->/);
  assert.match(comments[0].body, /Hardcoded token/);
});

test("renderSarif projects the same finding ids into SARIF fingerprints", () => {
  const report = normalizeReport({
    findings: [
      {
        id: "finding-1",
        class: "hardcoded_credential",
        severity: "high",
        title: "Hardcoded token",
        detail: "A token-like string is committed.",
        file: "src/app.ts",
        line: 12,
        remediation: "Move the value to a secret manager.",
      },
    ],
  });

  const sarif = renderSarif(report);

  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results[0].ruleId, "hardcoded_credential");
  assert.equal(sarif.runs[0].results[0].partialFingerprints["act101FindingId/v2"], "finding-1");
});
