import { isLoopbackHost } from "../auth/loopback.ts";
import type { Reviewers } from "../auth/reviewers.ts";

/**
 * `GET /v1/studio`: who may open this studio, for the Settings page. The host the surface listens
 * on (`--host`), whether that is this machine alone, and how many reviewer accounts exist. Never a
 * name, a hash or a secret: the accounts themselves are `GET /v1/reviewers`.
 */

export type StudioAccessView = {
  /** The address the surface listens on, as `--host` was given: `127.0.0.1`, `0.0.0.0`, `::1`. */
  readonly host: string;
  /** True when only this machine can reach it: then nobody signs in and the OS user decides. */
  readonly loopback: boolean;
  readonly reviewers: number;
};

export type AccessService = {
  access(): Promise<StudioAccessView>;
};

export type AccessDeps = {
  /** The host the worker was told to listen on; this package never reads the command line. */
  readonly host: string;
  readonly reviewers: Pick<Reviewers, "list">;
};

export function createAccessService(deps: AccessDeps): AccessService {
  return {
    async access() {
      return {
        host: deps.host,
        loopback: isLoopbackHost(deps.host),
        reviewers: (await deps.reviewers.list()).length,
      };
    },
  };
}
