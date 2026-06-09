#!/usr/bin/env node
import fs from "node:fs";

const reason = process.argv.slice(2).join(" ") || "act101 setup report";
const repo = process.env.GITHUB_REPOSITORY || "unknown/unknown";
const sha = process.env.GITHUB_SHA || "";

const sarif = {
  version: "2.1.0",
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: {
        driver: {
          name: "act101",
          informationUri: "https://act101.ai/online",
          rules: [],
        },
      },
      automationDetails: { id: "act101-online-setup" },
      invocations: [
        {
          executionSuccessful: false,
          properties: { repository: repo, sha, reason },
        },
      ],
      results: [],
    },
  ],
};

fs.writeFileSync("act101-results.sarif", `${JSON.stringify(sarif, null, 2)}\n`);
