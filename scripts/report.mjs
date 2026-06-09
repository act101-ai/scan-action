const severityRank = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function valueOrUnknown(value) {
  return value === null || value === undefined ? "N/A" : String(value);
}

function normalizeFinding(finding) {
  return {
    id: String(finding.id || `${finding.file || "repo"}:${finding.line || 0}:${finding.title || "finding"}`),
    class: String(finding.class || "unknown"),
    half: String(finding.half || "security"),
    severity: String(finding.severity || "info").toLowerCase(),
    title: String(finding.title || "act101 finding"),
    detail: String(finding.detail || ""),
    file: finding.file ? String(finding.file) : "",
    line: Number.isInteger(finding.line) ? finding.line : Number(finding.line || 0),
    column: Number.isInteger(finding.column) ? finding.column : Number(finding.column || 1),
    end_line: Number.isInteger(finding.end_line) ? finding.end_line : Number(finding.endLine || finding.line || 0),
    end_column: Number.isInteger(finding.end_column) ? finding.end_column : Number(finding.endColumn || finding.column || 1),
    remediation: String(finding.remediation || "Review this finding and apply the smallest safe change that removes the risk."),
    score_impact: finding.score_impact || finding.scoreImpact || {},
  };
}

export function normalizeReport(input = {}) {
  const findings = Array.isArray(input.findings)
    ? input.findings.map(normalizeFinding)
    : [];
  findings.sort((a, b) => {
    const severity = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
    if (severity !== 0) return severity;
    return a.id.localeCompare(b.id);
  });

  return {
    schema_version: input.schema_version || input.schemaVersion || 2,
    score: {
      overall: input.score?.overall ?? null,
      security: input.score?.security ?? null,
      architecture: input.score?.architecture ?? null,
    },
    findings,
    suppressed: Array.isArray(input.suppressed) ? input.suppressed : [],
    bundle: input.bundle || {
      generated_by: "act101-scan-action",
      finding_count: findings.length,
      groups: [],
    },
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
    coverage: input.coverage || {},
    score_breakdown: input.score_breakdown || input.scoreBreakdown || {},
  };
}

export function fallbackReport({ reason, repository, sha }) {
  return normalizeReport({
    score: { overall: null, security: null, architecture: null },
    findings: [],
    diagnostics: [
      {
        kind: "analyzer_failed",
        file: null,
        message: reason,
      },
    ],
    bundle: {
      generated_by: "act101-scan-action",
      finding_count: 0,
      groups: [],
    },
    metadata: { repository, sha },
  });
}

export function renderMarkdown(report, context = {}) {
  const repo = context.repository || "unknown/unknown";
  const sha = context.sha || "unknown";
  const runUrl = context.runUrl || "";
  const topFindings = report.findings.slice(0, 25);
  const lines = [
    "# act101 report",
    "",
    `Repository: \`${repo}\``,
    `Commit: \`${sha}\``,
  ];
  if (runUrl) lines.push(`Workflow run: ${runUrl}`);
  lines.push(
    "",
    `AI-Code Health Score: ${valueOrUnknown(report.score.overall)}/100`,
    `Security: ${valueOrUnknown(report.score.security)}/100`,
    `Architecture: ${valueOrUnknown(report.score.architecture)}/100`,
    "",
    `Findings: ${report.findings.length}`,
    "",
  );

  if (topFindings.length === 0) {
    lines.push("No score-impacting findings were reported.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of topFindings) {
      const location = finding.file ? `${finding.file}:${finding.line || 1}` : "repository";
      lines.push(
        `### ${finding.severity.toUpperCase()} ${finding.title}`,
        "",
        `- ID: \`${finding.id}\``,
        `- Class: \`${finding.class}\``,
        `- Half: \`${finding.half}\``,
        `- Location: \`${location}\``,
        "",
        finding.detail,
        "",
        "**Remediation:**",
        "",
        finding.remediation,
        "",
      );
    }
  }

  lines.push(
    "## Agent remediation brief",
    "",
    "Give this report to your coding agent. Ask it to fix one finding at a time, keep changes minimal, and rerun the act101 scan after committing. For each finding, preserve behavior unless the remediation explicitly requires a behavior change.",
    "",
  );

  if (report.diagnostics.length > 0) {
    lines.push("## Diagnostics", "");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function renderSummary(report, context = {}) {
  const artifactName = context.artifactName || "act101-report";
  const sarifStatus = context.sarifStatus || "not requested";
  const sarifReason = context.sarifReason || "";
  const topFindings = report.findings.slice(0, 5);
  const lines = [
    "## act101 online scan",
    "",
    `AI-Code Health Score: **${valueOrUnknown(report.score.overall)}/100**`,
    `Security: **${valueOrUnknown(report.score.security)}/100**`,
    `Architecture: **${valueOrUnknown(report.score.architecture)}/100**`,
    "",
    `Findings: **${report.findings.length}**`,
    `Report artifact: \`${artifactName}\``,
    `SARIF upload: ${sarifStatus}${sarifReason ? ` — ${sarifReason}` : ""}`,
    "",
  ];

  if (topFindings.length > 0) {
    lines.push("### Top findings", "");
    for (const finding of topFindings) {
      const location = finding.file ? `${finding.file}:${finding.line || 1}` : "repository";
      lines.push(`- **${finding.severity.toUpperCase()}** ${finding.title} — \`${location}\``);
    }
    lines.push("");
  }

  lines.push(
    "Open the attached report files for the full agent-ready remediation bundle.",
    "",
  );
  return lines.join("\n");
}

export function renderHtml(report, context = {}) {
  const markdown = renderMarkdown(report, context)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>act101 report</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #171717; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body><pre>${markdown}</pre></body>
</html>
`;
}

function sarifLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "low") return "warning";
  return "note";
}

export function renderSarif(report) {
  const rules = new Map();
  for (const finding of report.findings) {
    if (!rules.has(finding.class)) {
      rules.set(finding.class, {
        id: finding.class,
        name: finding.class,
        shortDescription: { text: finding.class.replaceAll("_", " ") },
        helpUri: "https://act101.ai/online",
      });
    }
  }

  return {
    version: "2.1.0",
    "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "act101",
            informationUri: "https://act101.ai/online",
            rules: [...rules.values()],
          },
        },
        results: report.findings
          .filter((finding) => finding.file && finding.line > 0)
          .map((finding) => ({
            ruleId: finding.class,
            level: sarifLevel(finding.severity),
            message: { text: `${finding.title}: ${finding.detail}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: finding.file },
                  region: {
                    startLine: finding.line,
                    startColumn: Math.max(1, finding.column || 1),
                    endLine: finding.end_line || finding.line,
                    endColumn: Math.max(1, finding.end_column || finding.column || 1),
                  },
                },
              },
            ],
            partialFingerprints: { "act101FindingId/v2": finding.id },
            properties: {
              remediation: finding.remediation,
              half: finding.half,
              severity: finding.severity,
            },
          })),
      },
    ],
  };
}

export function commentsForPullRequest(report) {
  return report.findings
    .filter((finding) => finding.file && finding.line > 0)
    .map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: [
        `<!-- act101:finding:${finding.id} -->`,
        `**${finding.severity.toUpperCase()} ${finding.title}**`,
        "",
        finding.detail,
        "",
        "**Remediation:**",
        finding.remediation,
      ].join("\n"),
    }));
}
