import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const action = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");

test("action installs the latest stable act CLI by default", () => {
  assert.match(action, /act-channel:/);
  assert.match(action, /default: "stable"/);
  assert.match(action, /Install act CLI/);
  assert.match(action, /ACT_CHANNEL: \${{ inputs\.act-channel }}/);
  assert.match(action, /ACT_PREFIX: \${{ runner\.temp }}\/act101\/bin/);
  assert.match(action, /repos\/act101-ai\/act101\/releases\?per_page=20/);
  assert.match(action, /--output "\$releases_file"/);
  assert.match(action, /target="x86_64-unknown-linux-gnu"/);
  assert.match(action, /archive_url="https:\/\/github\.com\/act101-ai\/act101\/releases\/download\/\$\{ACT_VERSION\}\/act-\$\{target\}\.tar\.gz"/);
  assert.match(
    action,
    /!rel\.draft && \(channel === "stable" \? !rel\.prerelease : \(rel\.prerelease && rel\.tag_name\.includes\(channel\)\)\)/,
  );
  assert.match(action, /export ACT_VERSION/);
  assert.match(action, /tar -xzf "\$archive_path" -C "\$ACT_PREFIX"/);
  assert.match(action, /\$ACT_PREFIX\/act" --version/);
  assert.match(action, /\$ACT_PREFIX\/act" tos accept --yes/);
  assert.match(action, />> "\$GITHUB_PATH"/);
});

test("PR comment mode is sticky by default with a capability-detected diff scan", () => {
  assert.match(action, /pr-comment:[\s\S]*default: "sticky"/);
  assert.match(action, /id: pr-scan/);
  assert.match(action, /github\.event_name == 'pull_request' && inputs\.pr-comment != 'off'/);
  assert.match(action, /scan --help 2>\/dev\/null \| grep -q -- "--base-ref"/);
  assert.match(action, /--base-ref "origin\/\$\{BASE_REF\}" --format markdown/);
  assert.match(action, /\.act\/baseline\.json/);
  assert.match(action, /inputs\.pr-comment == 'sticky'/);
  assert.match(action, /scripts\/sticky-comment\.mjs/);
  assert.match(action, /inputs\.pr-comment == 'inline'/);
  assert.match(action, /scripts\/post-pr-comments\.mjs/);
  assert.match(action, /steps\.pr-scan\.outputs\.conclusion == 'failure'/);
});

test("SARIF upload is optional by default", () => {
  assert.match(action, /upload-sarif:[\s\S]*default: "false"/);
  assert.match(action, /sarif_status="not requested"/);
  assert.match(action, /if \[ "\${{ inputs\.upload-sarif }}" = "true" \]/);
  assert.match(action, /uses: github\/codeql-action\/upload-sarif@v4/);
});

test("license-key input entitles the scan instead of the OIDC scan token", () => {
  // A license-key input is declared and defaults to empty (opt-in via secret).
  assert.match(action, /license-key:[\s\S]*?default: ""/);
  // The GitHub-OIDC scan-token exchange is skipped when a license key is
  // present — the license, not the JWT, entitles the scan.
  assert.match(action, /if: \$\{\{ inputs\.license-key == '' \}\}/);
  // Both scan-running steps (diff-scoped PR scan + full report) receive the key
  // as ACT_LICENSE_KEY for the CLI gate to consume.
  assert.match(action, /ACT_LICENSE_KEY: \$\{\{ inputs\.license-key \}\}/);
});

test("arena input defaults on and gates the leaderboard counter step", () => {
  // An arena input is declared and defaults to "true" (opt-out via arena:false).
  assert.match(action, /arena:[\s\S]*?default: "true"/);
  // The raw GitHub OIDC JWT is retained for the counter ingest to re-present
  // (handleCounter re-verifies it via verifyGithubOidc). License-key scans have
  // no OIDC path, so the token must be retained inside the OIDC-gated step.
  assert.match(action, /ACT_OIDC_TOKEN=\$oidc_token/);
  // A dedicated counter step runs AFTER the report scan.
  assert.match(action, /name: Post act101 leaderboard counter/);
  assert.match(action, /scripts\/post-scan-counter\.mjs/);
  // The step is conditional on ALL of: arena opt-in, OIDC path (no license-key),
  // token available, report produced, and pull_request OR push to the default branch.
  assert.match(
    action,
    /inputs\.arena != 'false' && inputs\.license-key == '' && steps\.token\.outputs\.token_available == 'true'/,
  );
  assert.match(
    action,
    /steps\.report\.outputs\.scan_available == 'true'/,
  );
  assert.match(
    action,
    /github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\)/,
  );
  // The counter step never runs before the report (ordering lock).
  assert.ok(
    action.indexOf("name: Post act101 leaderboard counter") >
      action.indexOf("id: report"),
    "the counter step must come after the report step",
  );
});
