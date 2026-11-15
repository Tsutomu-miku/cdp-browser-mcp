// Paired deterministic probes for evals.jsonl, not model-generated solutions.
export default [
  {
    id: "E01",
    bad: "await cdp.send('Browser.setDownloadBehavior', { browserContextId: target.browserContextId, behavior: 'allowAndName', downloadPath: staging });",
    good: "await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: staging, eventsEnabled: true });",
    rules: ["policy/default-context-download"],
    review:
      "GUID/frame/tab attribution and shared login require the browser suite.",
  },
  {
    id: "E02",
    bad: "const duration = media.durationSeconds ?? 1;",
    good: "const duration = measuredMedia.durationSeconds;",
    rules: [],
    review:
      "Review all three producers and persistence; syntax cannot prove that a duration was measured.",
  },
  {
    id: "E03",
    bad: "pending = save().catch(() => {}); await pending;",
    good: "const current = pending = save(); try { await current } finally { if(pending === current) pending = undefined }",
    rules: ["policy/no-silent-catch"],
    review:
      "Only the empty handler is caught; queue identity, serialization and non-replay need behavior review.",
  },
  {
    id: "E04",
    bad: "const fixed = [...new Map(rows.map(row => [row.id, row])).values()];",
    good: "const diagnosis = 'offset window shifted; deduplication is mitigation until the upstream contract changes';",
    rules: [],
    review:
      "Compare the supplied page responses and request sequence; do not claim deduplication fixes the server.",
  },
  {
    id: "E05",
    bad: "const processingRef = useRef(new Set()); const [processing, setProcessing] = useState(new Set());",
    good: "const [uploading, setUploading] = useState(false); const [saving, setSaving] = useState(false); const fileInput = useRef(null);",
    rules: [],
    review:
      "Independent operation ownership is semantic; a legitimate DOM ref must remain allowed.",
  },
  {
    id: "E06",
    bad: "// Mixed lifecycle and actions\n".repeat(450),
    good: "export const leaseDeadline = (now: number, leaseMs: number) => now + leaseMs;",
    rules: ["max-lines"],
    badDependencies: {
      "src/a.ts": "import { b } from './b.js'; export const a = () => b;",
      "src/b.ts": "import { a } from './a.js'; export const b = () => a;",
    },
    goodDependencies: {
      "src/domain/lease.ts": "export const lease = 1;",
      "src/session/tabs.ts":
        "import { lease } from '../domain/lease.js'; export { lease };",
    },
    dependencyRule: "no-cycles",
    review:
      "Also lint the real three-module split; single ownership and unchanged lifecycle need independent diff review.",
  },
  {
    id: "E07",
    bad: "ReadMultipartFileContent(opts.FileContent, 'FileContent', 'file_content');",
    good: "service.upload({ filename: transportFile.filename, bytes: transportFile.bytes });",
    rules: [],
    review:
      "This pilot freezes the CDP download protocol, not arbitrary IDL field names; review transport parsing and aliases.",
  },
  {
    id: "E08",
    bad: "async function optional() { try { return JSON.parse(await read(file)) } catch { return {} } }",
    good: "async function optional() { try { return JSON.parse(await read(file)) } catch(e) { if(e.code === 'ENOENT') return undefined; throw e } }",
    rules: ["policy/no-empty-fallback"],
    review:
      "Known absence is allowed; malformed JSON and EACCES still propagate via the final throw.",
  },
  {
    id: "E09",
    bad: "const audio = metadata.audio ?? { duration: 1, codec: 'made-up' };",
    good: "if (!metadata.audio) throw Error('Audio track required'); const audio = metadata.audio;",
    rules: [],
    review:
      "Validate untrusted input and parser guarantees; static gates must not reject the required boundary check.",
  },
  {
    id: "E10",
    bad: "async function run() { try { await task() } catch(e) { logger(e) } return { ok: true } }",
    good: "async function run() { try { await task(); return { ok: true } } catch(e) { return { error: String(e) } } }",
    rules: [],
    review:
      "Logging then success needs control-flow/contract review; a nonempty outer protocol error mapping is legitimate.",
  },
  {
    id: "E11",
    bad: "export const builtinActions = ['idle', 'walk', 'wave'];",
    good: "export const actions = (catalog) => catalog.listActions();",
    rules: [],
    badDependencies: {
      "examples/actions.ts": "export const actions = ['idle', 'walk', 'wave'];",
      "src/core.ts":
        "import { actions } from '../examples/actions.js'; export { actions };",
    },
    goodDependencies: {
      "src/core.ts":
        "export const actions = (catalog) => catalog.listActions();",
    },
    dependencyRule: "production-not-tests",
    review:
      "Fixture imports are caught; inline resource constants versus protocol enums still require review.",
  },
  {
    id: "E12",
    bad: "const list = manager.ListOfficialResources();",
    good: "const list = publicResources.list();",
    rules: [],
    badDependencies: {
      "src/adapters/manager.ts": "export const list = () => [];",
      "src/session/resources.ts":
        "import { list } from '../adapters/manager.js'; export { list };",
    },
    goodDependencies: {
      "src/domain/resources.ts":
        "export interface ResourceReader { list(): string[] }",
      "src/session/resources.ts":
        "import type { ResourceReader } from '../domain/resources.js'; export const list = (reader: ResourceReader) => reader.list();",
    },
    dependencyRule: "session-does-not-wire-adapters",
    review:
      "The import boundary is caught, not the meaning of a manager API; review auth/filtering and the retained write path.",
  },
];
