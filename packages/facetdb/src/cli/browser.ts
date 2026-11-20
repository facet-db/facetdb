import type { spawn } from "node:child_process";

/**
 * How `facetdb studio` opens the user's browser: the platform's own opener, run with no shell, so
 * the address is one argument and nothing in it is read as a command. The composition root
 * (`main.ts`) wires it with `node:child_process`; a test passes a recording fake as
 * `CliDeps.openBrowser` and never starts a browser.
 */

/** The opener of each platform: `open` on macOS, `start` (a cmd builtin) on Windows, else xdg-open. */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: readonly string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `start`'s first quoted argument is a window title: an empty one, so the address is the target.
      // cmd reads & | ^ % as its own syntax; none can be in the address, since --host is refused
      // unless it is an IP address or a plain host name (parseHost, commands/worker.ts).
      return { command: "cmd", args: ["/c", "start", '""', url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Runs the opener detached and lets it go: resolves once it has started, rejects when it could not
 * start (no xdg-open on a server), so the command can say to open the address by hand.
 */
export function systemBrowser(
  platform: NodeJS.Platform,
  start: typeof spawn,
): (url: string) => Promise<void> {
  return (url) =>
    new Promise((resolve, reject) => {
      const { command, args } = browserCommand(platform, url);
      const child = start(command, [...args], {
        stdio: "ignore",
        detached: true,
        windowsVerbatimArguments: platform === "win32",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
}
