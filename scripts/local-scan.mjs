#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "vendor",
]);

const textExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".swift",
  ".md",
]);

const credentialPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\n]{16,}["']/gi,
];

function lineColumn(content, index) {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function findingId(finding) {
  return [
    finding.class,
    finding.file || "repo",
    finding.line || 0,
    finding.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  ].join(":");
}

function addFinding(findings, finding) {
  const withId = { id: finding.id || findingId(finding), ...finding };
  if (!findings.some((existing) => existing.id === withId.id)) {
    findings.push(withId);
  }
}

function scanCredentials(file, content, findings) {
  for (const pattern of credentialPatterns) {
    for (const match of content.matchAll(pattern)) {
      const { line, column } = lineColumn(content, match.index || 0);
      addFinding(findings, {
        class: "hardcoded_credential",
        half: "security",
        severity: "high",
        title: "Hardcoded credential-like value",
        detail: "A token, secret, password, or API-key-like value appears to be committed in source control.",
        file,
        line,
        column,
        end_line: line,
        end_column: column + match[0].length,
        remediation: "Move the value to a secret manager or CI secret, rotate the exposed credential, and read it from the environment at runtime.",
      });
    }
  }
}

function scanMcp(file, content, findings) {
  if (!/(^|\/)\.mcp\.json$|mcp.*\.json$/i.test(file)) return;
  if (!/curl\s+[^|;\n]+[|;]\s*(?:sh|bash)|\b(?:sh|bash|zsh|python|node)\b\s+-c\b/.test(content)) return;
  addFinding(findings, {
    class: "mcp_config_rce",
    half: "security",
    severity: "critical",
    title: "MCP configuration allows shell execution",
    detail: "An MCP server configuration invokes shell execution or pipes downloaded content into a shell, creating remote-code-execution risk for coding agents.",
    file,
    line: 1,
    column: 1,
    end_line: 1,
    end_column: 1,
    remediation: "Replace shell execution with a pinned, reviewed executable and arguments. Avoid curl-to-shell patterns and require explicit user approval for commands with side effects.",
  });
}

function scanWorkflow(file, content, findings) {
  if (!file.startsWith(".github/workflows/")) return;
  if (!/\bpull_request_target\s*:/.test(content)) return;
  addFinding(findings, {
    class: "risky_infra_ci",
    half: "security",
    severity: "high",
    title: "Workflow uses pull_request_target",
    detail: "`pull_request_target` runs with elevated repository permissions. If the workflow checks out or executes untrusted PR code, it can expose secrets or write tokens.",
    file,
    line: content.slice(0, content.search(/\bpull_request_target\s*:/)).split("\n").length,
    column: 1,
    end_line: content.slice(0, content.search(/\bpull_request_target\s*:/)).split("\n").length,
    end_column: 1,
    remediation: "Use `pull_request` for untrusted code, or strictly avoid checking out/running PR-controlled content under `pull_request_target`.",
  });
}

function score(findings) {
  const penalty = findings.reduce((sum, finding) => {
    if (finding.severity === "critical") return sum + 25;
    if (finding.severity === "high") return sum + 15;
    if (finding.severity === "medium") return sum + 8;
    if (finding.severity === "low") return sum + 3;
    return sum + 1;
  }, 0);
  const security = Math.max(0, 100 - penalty);
  return { overall: security, security, architecture: null };
}

export function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    scanCredentials(file.path, file.content, findings);
    scanMcp(file.path, file.content, findings);
    scanWorkflow(file.path, file.content, findings);
  }
  return {
    schema_version: 2,
    score: score(findings),
    findings,
    suppressed: [],
    bundle: {
      generated_by: "act101-scan-action",
      finding_count: findings.length,
      groups: [],
    },
    diagnostics: [],
    coverage: {},
    score_breakdown: {},
  };
}

function shouldRead(file) {
  const base = path.basename(file);
  if (base === ".env" || base.startsWith(".env.")) return true;
  const ext = path.extname(file);
  return textExtensions.has(ext) || file.startsWith(".github/workflows/");
}

function collectFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(root, full).replaceAll(path.sep, "/");
        if (!shouldRead(rel)) continue;
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        const content = fs.readFileSync(full, "utf8");
        if (content.includes("\0")) continue;
        files.push({ path: rel, content });
      }
    }
  }
  walk(root);
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] || ".";
  const report = scanFiles(collectFiles(root));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
