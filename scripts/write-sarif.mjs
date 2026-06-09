#!/usr/bin/env node
import fs from "node:fs";

import { normalizeReport, renderSarif } from "./report.mjs";

const input = process.argv[2] || "act101-report.json";
const output = process.argv[3] || "act101-results.sarif";

const report = normalizeReport(JSON.parse(fs.readFileSync(input, "utf8")));
fs.writeFileSync(output, `${JSON.stringify(renderSarif(report), null, 2)}\n`);
