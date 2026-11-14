import type { Downloads } from "./downloads.js";

/** Browser/session ownership contract consumed by the local broker. */
export interface BrowserBackend {
  readonly downloads?: Pick<Downloads, "completed">;
  start(): Promise<void>;
  stop(): Promise<void>;
  recover(): Promise<void>;
  health(): Record<string, unknown>;
  list(agentId?: string): unknown;
  open(
    agentId: string,
    lane: string,
    headers?: Record<string, string>,
  ): Promise<unknown>;
  closeTab(agentId: string, tabId: string): Promise<unknown>;
  closeAgent(agentId: string): Promise<void>;
  renew(agentId: string, tabId: string): unknown;
  action(
    agentId: string,
    tabId: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  available?(): Promise<unknown>;
  attach?(
    agentId: string,
    chromeTabId: number,
    lane: string,
    headers: Record<string, string>,
  ): Promise<unknown>;
  setHeaders?(
    agentId: string,
    tabId: string,
    headers: Record<string, string>,
  ): Promise<unknown>;
}
