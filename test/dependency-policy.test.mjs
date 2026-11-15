import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDependencies as check } from "../tools/dependency-fixture.mjs";

test("allowed session-to-domain dependency passes", async () => {
  const result = await check({
    "src/domain/lease.ts": "export const lease = 1;",
    "src/session/service.ts":
      "import { lease } from '../domain/lease.js'; export { lease };",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test("session-to-concrete-adapter fails the CLI gate", async () => {
  const result = await check({
    "src/adapters/io.ts": "export const io = 1;",
    "src/session/service.ts":
      "import { io } from '../adapters/io.js'; export { io };",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /session-does-not-wire-adapters/);
});
test("production importing fixture fails the CLI gate", async () => {
  const result = await check({
    "test/fixture.ts": "export const fixture = 1;",
    "src/client.ts":
      "import { fixture } from '../test/fixture.js'; export { fixture };",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /production-not-tests/);
});
test("circular modules fail the CLI gate", async () => {
  const result = await check({
    "src/a.ts": "import { b } from './b.js'; export const a = () => b;",
    "src/b.ts": "import { a } from './a.js'; export const b = () => a;",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no-cycles/);
});

test("session cannot take filesystem ownership directly", async () => {
  const result = await check({
    "src/session/service.ts":
      "import { readFile } from 'node:fs/promises'; export { readFile };",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /session-no-concrete-io/);
});

test("transport cannot compose concrete adapters", async () => {
  const result = await check({
    "src/adapters/io.ts": "export const io = 1;",
    "src/transport/rpc.ts":
      "import { io } from '../adapters/io.js'; export { io };",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /transport-does-not-wire-adapters/,
  );
});
