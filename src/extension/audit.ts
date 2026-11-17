import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** Two bounded local files; no tool arguments, URLs, results or credentials. */
export class Audit {
  private pending = Promise.resolve();
  constructor(readonly directory: string) {}
  write(
    event: string,
    fields: {
      client?: string;
      tool?: string;
      pageId?: number;
      outcome?: string;
    } = {},
  ) {
    const entry =
      JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n";
    const append = async () => {
      const path = join(this.directory, "audit.jsonl");
      try {
        if ((await stat(path)).size >= 1024 * 1024)
          await rename(path, path + ".1");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await appendFile(path, entry, { mode: 0o600 });
    };
    this.pending = this.pending.then(append);
    return this.pending;
  }
}
