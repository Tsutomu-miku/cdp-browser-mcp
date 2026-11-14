import type { CDPSession, Page } from "playwright";
import { mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { Log } from "./runtime.js";
export interface DownloadOwner {
  agentId: string;
  tabId: string;
}
export class Downloads {
  readonly contextGuid: string;
  readonly frameOwners = new Map<string, DownloadOwner>();
  readonly pending = new Map<string, { owner: DownloadOwner; name: string }>();
  readonly completed: {
    agentId: string;
    tabId: string;
    guid: string;
    path: string;
  }[] = [];
  readonly sessions = new Map<string, CDPSession>();
  private tasks = new Set<Promise<void>>();
  private blocked = false;
  readonly staging: string;
  constructor(
    readonly cdp: CDPSession,
    readonly root: string,
    readonly log: Log,
    readonly fatal: (e: unknown) => void,
  ) {
    // Local staging identity, not a CDP browserContextId. This service owns
    // the persistent default context, selected by omitting that CDP parameter.
    this.contextGuid = randomUUID();
    this.staging = join(root, "staging", this.contextGuid);
  }
  async start() {
    await mkdir(this.staging, { recursive: true, mode: 0o700 });
    this.cdp.on("Browser.downloadWillBegin", (e) => this.track(this.begin(e)));
    this.cdp.on("Browser.downloadProgress", (e) => {
      if (e.state !== "inProgress")
        this.track(this.finish(e.guid, e.state, e.filePath));
    });
    await this.setBlocked(false);
  }
  private track(task: Promise<void>) {
    this.tasks.add(task);
    void task.catch(this.fatal).finally(() => this.tasks.delete(task));
  }
  async setBlocked(blocked: boolean) {
    this.blocked = blocked;
    await this.cdp.send("Browser.setDownloadBehavior", {
      behavior: blocked ? "deny" : "allowAndName",
      downloadPath: this.staging,
      eventsEnabled: true,
    });
    if (blocked) await this.cancelAll();
  }
  async watch(page: Page, input: DownloadOwner) {
    const owner: DownloadOwner = { agentId: input.agentId, tabId: input.tabId };
    const s = await page.context().newCDPSession(page);
    this.sessions.set(owner.tabId, s);
    const assign = (id: string) => this.frameOwners.set(id, owner);
    s.on("Page.frameAttached", (e) => assign(e.frameId));
    s.on("Page.frameNavigated", (e) => assign(e.frame.id));
    s.on("Page.frameDetached", (e) => {
      // A renderer process swap keeps the same frame and its page ownership.
      if (e.reason !== "swap") this.frameOwners.delete(e.frameId);
    });
    await s.send("Page.enable");
    await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const { frameTree } = await s.send("Page.getFrameTree");
    const visit = (t: typeof frameTree) => {
      assign(t.frame.id);
      t.childFrames?.forEach(visit);
    };
    visit(frameTree);
  }
  private async begin(e: {
    frameId: string;
    guid: string;
    suggestedFilename: string;
  }) {
    const owner = this.frameOwners.get(e.frameId);
    if (this.blocked || !owner) {
      await this.cdp.send("Browser.cancelDownload", {
        guid: e.guid,
      });
      this.log("download.rejected", {
        guid: e.guid,
        reason: !owner ? "unowned-frame" : "disk-guard",
      });
      return;
    }
    const name =
      basename(e.suggestedFilename)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120) || "download";
    this.pending.set(e.guid, { owner, name });
    this.log("download.started", {
      ...owner,
      guid: e.guid,
      contextGuid: this.contextGuid,
    });
  }
  private async finish(guid: string, state: string, filePath?: string) {
    const item = this.pending.get(guid);
    this.pending.delete(guid);
    if (!item) {
      this.log("download.duplicate-or-unowned-terminal", { guid, state });
      return;
    }

    if (state !== "completed") {
      await rm(join(this.staging, guid), { force: true });
      return;
    }
    if (filePath && resolve(filePath) !== join(this.staging, guid))
      throw Error(
        "Chrome violated the GUID staging directory contract; download distribution stopped",
      );
    const dir = join(this.root, "agents", item.owner.agentId, item.owner.tabId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${guid}-${item.name}`);
    await rename(join(this.staging, guid), path);
    this.completed.push({ ...item.owner, guid, path });
    this.log("download.completed", { ...item.owner, guid });
  }
  async forget(tabId: string) {
    for (const [id, owner] of this.frameOwners)
      if (owner.tabId === tabId) this.frameOwners.delete(id);
    for (const [guid, p] of this.pending)
      if (p.owner.tabId === tabId)
        await this.cdp.send("Browser.cancelDownload", {
          guid,
        });
    const s = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if (s) await s.detach();
  }
  async cancelAll() {
    for (const guid of this.pending.keys())
      await this.cdp.send("Browser.cancelDownload", {
        guid,
      });
  }
  async abandon() {
    await Promise.allSettled([...this.tasks]);
    this.pending.clear();
    this.frameOwners.clear();
    this.sessions.clear();
    await rm(this.staging, { recursive: true, force: true });
  }
  async close() {
    await this.cancelAll();
    await Promise.allSettled([...this.tasks]);
    await rm(this.staging, { recursive: true, force: true });
  }
}
