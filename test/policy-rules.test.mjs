import { RuleTester } from "eslint";
import { describe, it } from "node:test";
import policy from "../tools/policy-rules.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});
tester.run("no-silent-catch", policy.rules["no-silent-catch"], {
  valid: [
    "try { task() } catch (e) { throw e }",
    "function readOptional() { try { task() } catch (e) { if (e.code !== 'ENOENT') throw e; return undefined } }",
    "task().catch(e => { report(e); process.exitCode = 1 })",
  ],
  invalid: [
    { code: "try { task() } catch {}", errors: [{ messageId: "silent" }] },
    {
      code: "try { task() } catch { /* intentionally ignored */ }",
      errors: [{ messageId: "silent" }],
    },
    { code: "task().catch(() => {})", errors: [{ messageId: "silent" }] },
    {
      code: "task()['catch'](function () { /* ignored */ })",
      errors: [{ messageId: "silent" }],
    },
  ],
});
tester.run(
  "default-context-download",
  policy.rules["default-context-download"],
  {
    valid: [
      "cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: root, eventsEnabled: true })",
      "cdp.send('Browser.cancelDownload', { guid })",
      "cdp.send('Target.createBrowserContext', {})",
    ],
    invalid: [
      {
        code: "cdp.send('Browser.setDownloadBehavior', { browserContextId: id })",
        errors: [{ messageId: "context" }],
      },
      {
        code: "cdp.send('Browser.cancelDownload', { ['browserContextId']: id, guid })",
        errors: [{ messageId: "context" }],
      },
      {
        code: "cdp.send('Browser.cancelDownload', { ...params, guid })",
        errors: [{ messageId: "explicit" }],
      },
      {
        code: "cdp.send('Browser.cancelDownload', params)",
        errors: [{ messageId: "explicit" }],
      },
      {
        code: "cdp.send('Browser.cancelDownload', { [key]: id })",
        errors: [{ messageId: "explicit" }],
      },
      {
        code: "try { await primary() } catch (e) { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath }) }",
        errors: [{ messageId: "single" }],
      },
    ],
  },
);

tester.run("no-empty-fallback", policy.rules["no-empty-fallback"], {
  valid: [
    "function readOptional() { try { return read() } catch(e) { if(e.code !== 'ENOENT') throw e; return undefined } }",
    "function readOptional() { try { return read() } catch(e) { if(e.code === 'ENOENT') return undefined; throw e } }",
    "read().catch(e => { if(e.code !== 'ENOENT') throw e; return undefined })",
    "read().catch(e => ({ error: String(e) }))",
  ],
  invalid: [
    {
      code: "function read() { try { task() } catch { return {} } }",
      errors: [{ messageId: "fallback" }],
    },
    {
      code: "function read() { try { task() } catch { return [] } }",
      errors: [{ messageId: "fallback" }],
    },
    {
      code: "function read() { try { task() } catch { return } }",
      errors: [{ messageId: "fallback" }],
    },
    {
      code: "task().catch(() => undefined)",
      errors: [{ messageId: "fallback" }],
    },
    { code: "task().catch(() => null)", errors: [{ messageId: "fallback" }] },
    { code: "task().catch(() => ({}))", errors: [{ messageId: "fallback" }] },
    {
      code: "function read() { try { task() } catch { const later = () => { throw Error() }; return {} } }",
      errors: [{ messageId: "fallback" }],
    },
  ],
});
