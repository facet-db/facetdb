import type { UsersStore } from "@facetdb/postgres";
import { isLoopbackHost } from "./loopback.ts";
import { operatorKnownByAddress, studioUrlHost } from "./operator.ts";

/** A surface that would be open to other machines with nobody able to sign in to it. */
export class OpenSurfaceError extends Error {
  readonly fix: string;

  constructor(why: { readonly host: string } | { readonly studioUrl: string }) {
    super(
      "host" in why
        ? `--host ${why.host} opens the review screen to other machines, and no reviewer account exists, so nobody could sign in; nothing was started`
        : `studioUrl is ${studioUrlHost(why.studioUrl)}, so everyone must sign in, and no reviewer account exists; nothing was started`,
    );
    this.name = "OpenSurfaceError";
    this.fix =
      "host" in why
        ? "run facetdb users add <name> to make an account, then start the worker again; or leave --host at 127.0.0.1 to open it on this machine only"
        : "run facetdb users add <name> to make an account, then start again";
  }
}

/**
 * The surface binds a non-loopback address only once an account exists, and a studio whose
 * `studioUrl` names another host (no operator by address) starts only once one exists, whatever it
 * binds. Called before anything starts, so a refusal leaves no claim, no listener and no
 * half-started worker.
 */
export async function requireAccountToServe(
  surface: { readonly host: string; readonly studioUrl: string | undefined },
  users: Pick<UsersStore, "list">,
): Promise<void> {
  const { host, studioUrl } = surface;
  const opened = !isLoopbackHost(host);
  if (opened || !operatorKnownByAddress(studioUrl)) {
    if ((await users.list()).length === 0) {
      throw new OpenSurfaceError(opened || studioUrl === undefined ? { host } : { studioUrl });
    }
  }
}
