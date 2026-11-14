# Deployment

## Linux

Install Node.js 22+ and Chrome/Chromium using your system's package manager. The tool does not install browsers or system dependencies. Linux uses `--headless=new` by default:

```sh
cdp-browser-mcp launch --headless --state-dir /srv/browser-data
cdp-browser-mcp status --state-dir /srv/browser-data
cdp-browser-mcp stop --state-dir /srv/browser-data
```

Run Chrome as a non-root user with its sandbox enabled. Set `--executable-path` if Chrome is installed outside the detected system paths.

For a graphical session or manual login, use `--headed`. If Xvfb is already installed, keep the service in the foreground so its display stays alive:

```sh
xvfb-run -a cdp-browser-mcp serve --headed --state-dir /srv/browser-data
```

Xvfb provides a display, not an interactive desktop; use an authenticated remote desktop/VNC session when a person needs to log in. Fonts, graphics, and site behavior may differ from a local macOS session.

## Remote MCP over SSH

Keep the MCP process on the browser host and forward its stdio over authenticated SSH:

```json
{
  "mcpServers": {
    "browser": {
      "command": "ssh",
      "args": [
        "-T",
        "browser-host",
        "cdp-browser-mcp",
        "mcp",
        "--agent",
        "agent-a",
        "--state-dir",
        "/srv/browser-data"
      ]
    }
  }
}
```

Use an absolute executable path if the remote non-interactive `PATH` does not include your npm bin directory. Downloads stay on the browser host and can be retrieved with SFTP/SCP.

CDP is restricted to loopback; the control plane has no TCP listener. If an administrator needs direct CDP debugging, use an SSH tunnel to a fixed `cdpPort` configured for that instance:

```sh
ssh -N -L 127.0.0.1:19229:127.0.0.1:9229 browser-host
```

CDP has no built-in user authentication. Never expose its port publicly or give raw CDP access to clients that should only own their tabs.

## Login state

The simplest approach is to log in once on the destination's dedicated profile. Stop the instance before changing the display mode.

Browser profiles contain host-bound encrypted data. Copying a macOS profile to Linux generally does not preserve usable cookies. Do not copy your everyday profile into this tool.

For a site that permits portable login state, an administrator can export Playwright `context.storageState()` from the dedicated default context and transfer it with SSH. Import cookies with `context.addCookies()` in the destination instance; localStorage must be restored on a managed tab at each matching origin. There is no built-in state import/export command. IndexedDB, sessionStorage, passkeys, client certificates, and device-bound logins may require separate handling or a new login. Do not migrate ServiceWorker registrations or CacheStorage.

Treat exports as credentials: keep them outside the repository, restrict permissions, and delete them when no longer needed.

## Data and logs

The data directory contains the persistent profile, completed downloads, protected control files, and rotating `events.jsonl` logs. `stop` cleans sockets and processes while preserving user data. To remove it permanently, stop the instance first and review the directory before deleting it.

Startup settings are recorded in `launch-config.json` after acquiring the service lock. Header values in configuration files and login data are sensitive even though request event logs omit their values.

## Remote browser providers

Connecting to an externally managed CDP service is not implemented. A future adapter must provide a shared default context, persistent profile, authenticated CDP, startup worker policy, disconnection shutdown, frame ownership, and authenticated download retrieval by context/download GUID. Local download paths cannot be used directly for a remote browser.

See [testing](testing.md) for the platforms and workflows currently validated.
