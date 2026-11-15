import { CdpClosedError, type CdpConnection } from "../../cdp.js";
import type { Log } from "../../runtime.js";

export class CookieSnapshot {
  private cookies: Record<string, unknown>[] = [];
  constructor(private readonly log: Log) {}
  async restore(browser: CdpConnection) {
    if (this.cookies.length)
      await browser.send("Storage.setCookies", { cookies: this.cookies });
  }
  async remember(browser: CdpConnection) {
    try {
      const { cookies } = await browser.send("Storage.getCookies");
      // Storage.setCookies accepts CookieParam, not response-only Cookie metadata.
      this.cookies = cookies.map(
        ({
          name,
          value,
          domain,
          path,
          expires,
          httpOnly,
          secure,
          sameSite,
          priority,
          sameParty,
          sourceScheme,
          sourcePort,
          partitionKey,
        }: any) => ({
          name,
          value,
          domain,
          path,
          ...(expires > 0 ? { expires } : {}),
          httpOnly,
          secure,
          sameSite,
          priority,
          sameParty,
          sourceScheme,
          sourcePort,
          partitionKey,
        }),
      );
    } catch (e) {
      if (!(e instanceof CdpClosedError)) throw e;
      this.log("cookies.snapshot-unavailable");
    }
  }
}
