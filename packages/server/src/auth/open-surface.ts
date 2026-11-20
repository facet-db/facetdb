import type { UsersStore } from "@facetdb/postgres";
import { isLoopbackHost } from "./loopback.ts";

/** A surface that would be open to other machines with nobody able to sign in to it. */
export class OpenSurfaceError extends Error {
  readonly fix: string;

  constructor(host: string) {
    super(
      `--host ${host} opens the review screen to other machines, and no reviewer account exists, so nobody could sign in; nothing was started`,
    );
    this.name = "OpenSurfaceError";
    this.fix =
      "run facetdb users add <name> to make an account, then start the worker again; or leave --host at 127.0.0.1 to open it on this machine only";
  }
}

/**
 * The surface binds a non-loopback address only once an account exists. Called before anything
 * starts, so a refusal leaves no claim, no listener and no half-started worker.
 */
export async function requireAccountToServe(
  host: string,
  users: Pick<UsersStore, "list">,
): Promise<void> {
  if (!isLoopbackHost(host) && (await users.list()).length === 0) {
    throw new OpenSurfaceError(host);
  }
}
