import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  counterEndpoint,
  isPublicRepository,
  isQualifyingRef,
} from "../scripts/post-scan-counter.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const scriptPath = path.join(repoRoot, "scripts", "post-scan-counter.mjs");

test("counterEndpoint swaps the trailing /token for /counter on the same host", () => {
  assert.equal(
    counterEndpoint("https://act101.ai/api/scan/token"),
    "https://act101.ai/api/scan/counter",
  );
  assert.equal(
    counterEndpoint("https://stg.act101.ai/api/scan/token/"),
    "https://stg.act101.ai/api/scan/counter",
  );
  assert.equal(
    counterEndpoint(undefined),
    "https://act101.ai/api/scan/counter",
  );
});

test("isPublicRepository is true only when the event marks the repo public", () => {
  assert.equal(
    isPublicRepository({ repository: { private: false, visibility: "public" } }),
    true,
  );
  assert.equal(
    isPublicRepository({ repository: { private: true, visibility: "private" } }),
    false,
  );
  assert.equal(
    isPublicRepository({ repository: { private: false, visibility: "private" } }),
    false,
  );
  assert.equal(isPublicRepository({ repository: {} }), false);
  assert.equal(isPublicRepository({}), false);
});

test("isQualifyingRef accepts push to the default branch only (not pull_request)", () => {
  const event = { repository: { default_branch: "main" } };
  // The leaderboard reflects the default branch, not WIP pull requests.
  assert.equal(isQualifyingRef(event, { GITHUB_EVENT_NAME: "pull_request" }), false);
  assert.equal(
    isQualifyingRef(event, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
    }),
    true,
  );
  // Push to a non-default branch is rejected even though it is a push.
  assert.equal(
    isQualifyingRef(event, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/feature/x",
    }),
    false,
  );
  // schedule / workflow_dispatch never qualify.
  assert.equal(
    isQualifyingRef(event, { GITHUB_EVENT_NAME: "schedule" }),
    false,
  );
  // Custom default branch is honored.
  const trunkEvent = { repository: { default_branch: "trunk" } };
  assert.equal(
    isQualifyingRef(trunkEvent, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/trunk",
    }),
    true,
  );
});

// End-to-end exercise of the script via a child process: it must POST the
// expected payload to the derived counter endpoint and exit 0, and must
// suppress the POST (exit 0, no call) for every spec-forbidden condition.
function runScript(workdir, env) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workdir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function writeScan(workdir, overrides = {}) {
  const report = {
    schema_version: 2,
    score: { overall: 78, security: 80, architecture: 70 },
    findings: [],
    scale: { total_files: 50, total_lines: 5200, non_blank_lines: 4300, by_language: [] },
    ...overrides,
  };
  fs.writeFileSync(
    path.join(workdir, "act101-scan-raw.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function writeEvent(workdir, repository) {
  const eventPath = path.join(workdir, "event.json");
  fs.writeFileSync(
    eventPath,
    `${JSON.stringify({ repository })}\n`,
  );
  return eventPath;
}

test("posts the full-repo published score to the counter endpoint and exits 0", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir);
    const eventPath = writeEvent(workdir, {
      private: false,
      visibility: "public",
      default_branch: "main",
    });
    // Inject a fetch shim via NODE_OPTIONS preload so the child records the
    // exact URL + body + Authorization to a marker file, then returns 200.
    const shim = path.join(workdir, "shim.mjs");
    const postedPath = path.join(workdir, "posted.json");
    fs.writeFileSync(
      shim,
      `import fs from "node:fs";
       globalThis.fetch = async (url, options) => {
         fs.writeFileSync(${JSON.stringify(postedPath)}, JSON.stringify({ url: String(url), body: options && options.body, authorization: options && options.headers && options.headers.Authorization }));
         return new Response(JSON.stringify({ ok: true }), { status: 200 });
       };
      `,
    );
    const result = runScript(workdir, {
      ACT_OIDC_TOKEN: "oidc-jwt-abc",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
      TOKEN_ENDPOINT: "https://act101.ai/api/scan/token",
      NODE_OPTIONS: `--import ${fileURLToPath(new URL(`file://${shim}`))}`,
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /counter ingest accepted \(overall=78\)/);
    assert.ok(fs.existsSync(path.join(workdir, "posted.json")), "fetch was not invoked");
    const posted = JSON.parse(fs.readFileSync(path.join(workdir, "posted.json"), "utf8"));
    assert.equal(posted.url, "https://act101.ai/api/scan/counter");
    assert.equal(posted.authorization, "Bearer oidc-jwt-abc");
    const body = JSON.parse(posted.body);
    assert.equal(body.score, 78);
    assert.equal(body.scope, "full");
    assert.equal(body.arena, true);
    assert.equal(body.bucket, "scans_total");
    assert.equal(body.security, 80);
    assert.equal(body.architecture, 70);
    assert.equal(body.non_blank_lines, 4300);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("does not post on pull_request (leaderboard reflects the default branch only)", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir);
    const eventPath = writeEvent(workdir, {
      private: false,
      visibility: "public",
      default_branch: "main",
    });
    const result = runScript(workdir, {
      ACT_OIDC_TOKEN: "oidc-jwt-abc",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      GITHUB_EVENT_PATH: eventPath,
      TOKEN_ENDPOINT: "https://act101.ai/api/scan/token",
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /not a push to the default branch/);
    assert.ok(
      !fs.existsSync(path.join(workdir, "posted.json")),
      "counter must not post on pull_request",
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("suppresses the POST for a private repository", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir);
    const eventPath = writeEvent(workdir, {
      private: true,
      visibility: "private",
      default_branch: "main",
    });
    const result = runScript(workdir, {
      ACT_OIDC_TOKEN: "oidc-jwt-abc",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /repository is not public/);
    assert.ok(!fs.existsSync(path.join(workdir, "posted.json")));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("suppresses the POST for a diff-scoped report (only full-repo enters history)", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir, { scope: { mode: "diff", base_ref: "origin/main", merge_base: "abc", changed_files: 2, deleted_files: 0 } });
    const eventPath = writeEvent(workdir, {
      private: false,
      visibility: "public",
      default_branch: "main",
    });
    const result = runScript(workdir, {
      ACT_OIDC_TOKEN: "oidc-jwt-abc",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /diff-scoped/);
    assert.ok(!fs.existsSync(path.join(workdir, "posted.json")));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("suppresses the POST when the published score is null", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir, { score: { overall: null, security: null, architecture: null } });
    const eventPath = writeEvent(workdir, {
      private: false,
      visibility: "public",
      default_branch: "main",
    });
    const result = runScript(workdir, {
      ACT_OIDC_TOKEN: "oidc-jwt-abc",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /null\/non-finite/);
    assert.ok(!fs.existsSync(path.join(workdir, "posted.json")));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("suppresses the POST when no OIDC token is present (license-key scan)", () => {
  const workdir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-counter-"));
  try {
    writeScan(workdir);
    const eventPath = writeEvent(workdir, {
      private: false,
      visibility: "public",
      default_branch: "main",
    });
    const result = runScript(workdir, {
      // ACT_OIDC_TOKEN intentionally absent — a license-key scan has no OIDC.
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no GitHub OIDC token/);
    assert.ok(!fs.existsSync(path.join(workdir, "posted.json")));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
