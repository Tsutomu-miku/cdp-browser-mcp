import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
export const headerSchema = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i),
    z
      .string()
      .max(8192)
      .refine((v) => !/[\r\n\0]/.test(v)),
  )
  .refine(
    (h) =>
      Object.keys(h).every(
        (k) =>
          ![
            "host",
            "connection",
            "content-length",
            "cookie",
            "authorization",
            "proxy-authorization",
          ].includes(k.toLowerCase()),
      ),
    "Identity and hop-by-hop headers are not lane headers",
  );
export const headerDomainsSchema = z.array(
  z
    .string()
    .toLowerCase()
    .refine((value) => {
      const host = value.startsWith("*.") ? value.slice(2) : value;
      return (
        /^[a-z0-9.-]+$/.test(host) &&
        !host.startsWith(".") &&
        !host.endsWith(".") &&
        !host.includes("..") &&
        new URL("https://" + host).hostname === host
      );
    }, "Use exact hostnames or *.example.com, without a scheme, path or port"),
);
export const configSchema = z
  .object({
    stateDir: z
      .string()
      .refine(
        (v) => Buffer.byteLength(join(v, "control.sock")) <= 100,
        "stateDir socket path exceeds 100 bytes",
      )
      .default(join(homedir(), ".local/state/cdp-browser-mcp")),
    headerDomains: headerDomainsSchema.default([]),
    executablePath: z.string().optional(),
    cdpPort: z.number().int().min(0).max(65535).default(0),
    headless: z.boolean().default(process.platform === "linux"),
    leaseMs: z.number().int().min(1000).default(300000),
    maxTabs: z.number().int().positive().default(20),
    minFreeBytes: z
      .number()
      .nonnegative()
      .default(512 * 1024 * 1024),
    maxDownloadBytes: z
      .number()
      .positive()
      .default(1024 * 1024 * 1024),
    maxLogBytes: z
      .number()
      .positive()
      .default(5 * 1024 * 1024),
    actionTimeoutMs: z.number().positive().default(15000),
    lanes: z.record(z.string(), headerSchema).default({ default: {} }),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(file?: string): Promise<Config> {
  const config = configSchema.parse(
    file ? JSON.parse(await readFile(file, "utf8")) : {},
  );
  config.stateDir = resolve(
    file ? dirname(resolve(file)) : process.cwd(),
    config.stateDir,
  );
  if (Buffer.byteLength(join(config.stateDir, "control.sock")) > 100)
    throw Error(
      "stateDir is too long for a Unix socket (maximum socket path: 100 bytes)",
    );
  if (config.executablePath)
    config.executablePath = resolve(config.executablePath);
  return config;
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export function normalizeHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headerSchema.parse(headers))
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
