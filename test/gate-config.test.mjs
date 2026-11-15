import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { checkDependencies as check } from "../tools/dependency-fixture.mjs";

const eslint = new ESLint();
async function lint(code, filePath = "src/evaluation.ts") {
  return (await eslint.lintText(code, { filePath }))[0];
}

test("platform reads fail outside the two reviewed boundaries", async () => {
  for (const code of [
    "process.platform",
    "process['platform']",
    "const { platform } = process",
    "import { platform } from 'node:os'; platform()",
    "import { platform as target } from 'node:process'; target",
  ]) {
    assert.ok((await lint(code)).errorCount > 0);
    assert.equal((await lint(code, "src/config.ts")).errorCount, 0);
    assert.equal((await lint(code, "src/runtime.ts")).errorCount, 0);
  }
});

test("physical line cap includes comments and cannot grow legacy debt", async () => {
  const code = "// physical line\n".repeat(301);
  assert.ok((await lint(code)).errorCount > 0);
  const debt = await lint(code, "src/cli.ts");
  assert.equal(debt.errorCount, 0);
  assert.equal(debt.warningCount, 1);
  const growth = await lint(code.repeat(2), "src/cli.ts");
  assert.ok(growth.messages.some((m) => m.ruleId === "policy/legacy-size-cap"));
});

test("frozen downloads reject legacy and Promise catch protocol alternatives", async () => {
  for (const code of [
    "cdp.send('Page.setDownloadBehavior', {})",
    "task().catch(() => cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName' }))",
  ]) {
    assert.ok(
      (await lint(code)).messages.some(
        (m) => m.ruleId === "policy/default-context-download",
      ),
    );
  }
});

test("unconditional empty fallback fails and known absence with rethrow passes", async () => {
  const bad = await lint(
    "async function read() { try { return await load() } catch { return {} } }",
  );
  assert.ok(bad.errorCount > 0);
  const good = await lint(
    "async function read() { try { return await load() } catch(e) { if((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e } }",
  );
  assert.equal(good.errorCount, 0);
});

test("domain cannot import filesystem I/O", async () => {
  const result = await check({
    "src/domain/lease.ts":
      "import { readFile } from 'node:fs/promises'; export { readFile };",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /domain-is-pure/);
});

test("session cannot wire legacy flat adapters", async () => {
  const result = await check({
    "src/runtime.ts": "export class ChromeProcess {}",
    "src/session/service.ts":
      "import { ChromeProcess } from '../runtime.js'; export const process = new ChromeProcess();",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /session-does-not-wire-adapters/);
});

test("session may consume a type-only adapter port", async () => {
  const result = await check({
    "src/adapters/io.ts":
      "export class IO { read(): string { return 'content' } }",
    "src/session/service.ts":
      "import type { IO } from '../adapters/io.js'; export const run = (port: Pick<IO, 'read'>) => port.read();",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
