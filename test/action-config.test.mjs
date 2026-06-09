import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const action = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");

test("action installs the latest beta act CLI before scanning", () => {
  assert.match(action, /act-channel:/);
  assert.match(action, /default: "beta"/);
  assert.match(action, /Install act CLI/);
  assert.match(action, /installer_url="https:\/\/github\.com\/act101-ai\/act101\/releases\/download\/\$\{ACT_VERSION\}\/install\.sh"/);
  assert.match(action, /ACT_CHANNEL: \${{ inputs\.act-channel }}/);
  assert.match(action, /ACT_PREFIX: \${{ runner\.temp }}\/act101\/bin/);
  assert.match(action, /repos\/act101-ai\/act101\/releases\?per_page=20/);
  assert.match(action, /rel\.prerelease && !rel\.draft && rel\.tag_name\.includes\(channel\)/);
  assert.match(action, /export ACT_VERSION/);
  assert.match(action, /sh "\$installer_path"/);
  assert.match(action, /\$ACT_PREFIX\/act" --version/);
  assert.match(action, />> "\$GITHUB_PATH"/);
});
