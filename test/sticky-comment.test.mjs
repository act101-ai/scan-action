import assert from "node:assert/strict";
import test from "node:test";

import { STICKY_MARKER, buildStickyBody, findStickyComment } from "../scripts/sticky-comment.mjs";

test("buildStickyBody leads with the marker and appends the run link", () => {
  const body = buildStickyBody("# act101 scan — overall 71\n\nfindings…", {
    runUrl: "https://github.com/o/r/actions/runs/42",
  });
  assert.ok(body.startsWith(STICKY_MARKER), "marker must be the first line");
  assert.ok(body.includes("# act101 scan — overall 71"));
  assert.ok(body.includes("https://github.com/o/r/actions/runs/42"));
});

test("findStickyComment matches only the marker-keyed comment", () => {
  const comments = [
    { id: 1, body: "unrelated human comment" },
    { id: 2, body: `${STICKY_MARKER}\n# act101 scan — old run` },
    { id: 3, body: "another comment mentioning act101 scan" },
  ];
  assert.equal(findStickyComment(comments)?.id, 2);
  assert.equal(findStickyComment([{ id: 9, body: "no marker" }]), undefined);
  assert.equal(findStickyComment([]), undefined);
});

test("buildStickyBody truncates oversized markdown under the API limit", () => {
  const body = buildStickyBody("x".repeat(70000), { runUrl: "https://r" });
  assert.ok(body.length < 65536, "GitHub caps comment bodies at 65536 chars");
  assert.ok(body.includes("truncated"), "truncation must be disclosed");
});
