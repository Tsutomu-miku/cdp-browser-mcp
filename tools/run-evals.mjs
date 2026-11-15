import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ESLint } from "eslint";
import cases from "../quality/eval-probes.mjs";
import { checkDependencies } from "./dependency-fixture.mjs";

const originals = (
  await readFile(new URL("../quality/evals.jsonl", import.meta.url), "utf8")
)
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.deepEqual(
  cases.map((c) => c.id),
  originals.map((c) => c.id),
);
const eslint = new ESLint();
const lint = async (code) =>
  (await eslint.lintText(code, { filePath: "src/evaluation.ts" }))[0];
const results = [];
for (const probe of cases) {
  const bad = await lint(probe.bad);
  const good = await lint(probe.good);
  const hits = [...new Set(bad.messages.map((m) => m.ruleId))];
  assert.deepEqual(hits.sort(), [...probe.rules].sort(), probe.id);
  assert.equal(good.errorCount, 0, `${probe.id}: legal code rejected`);
  assert.equal(good.warningCount, 0, `${probe.id}: legal code warned`);
  if (probe.badDependencies) {
    const rejected = await checkDependencies(probe.badDependencies);
    assert.equal(
      rejected.status,
      1,
      probe.id + rejected.stdout + rejected.stderr,
    );
    assert.ok(
      (rejected.stdout + rejected.stderr).includes(probe.dependencyRule),
      probe.id,
    );
    const accepted = await checkDependencies(probe.goodDependencies);
    assert.equal(
      accepted.status,
      0,
      probe.id + accepted.stdout + accepted.stderr,
    );
    hits.push(probe.dependencyRule);
  }
  const result = {
    id: probe.id,
    hits,
    legalCodeAccepted: true,
    semanticReview: probe.review,
  };
  results.push(result);
  console.log(
    `${probe.id}: ${hits.join(", ") || "semantic review required"}; legal probe accepted`,
  );
}
const files = [
  "src/steward.ts",
  "src/session/owned-tabs.ts",
  "src/adapters/chrome/cookie-snapshot.ts",
];
for (const result of await eslint.lintFiles(files))
  assert.equal(result.errorCount, 0, result.filePath);
const measured = await Promise.all(
  files.map(async (file) => ({
    file,
    lines: (await readFile(file, "utf8")).trimEnd().split("\n").length,
  })),
);
assert.ok(measured.every((file) => file.lines <= 300));
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/quality-evals.json",
  JSON.stringify(
    {
      kind: "deterministic paired probes, not coding-agent success rates",
      cases: results.length,
      machineDetected: results.filter((r) => r.hits.length).length,
      semanticOnly: results.filter((r) => !r.hits.length).length,
      legalProbesAccepted: results.length,
      measured,
      results,
    },
    null,
    2,
  ) + "\n",
);
