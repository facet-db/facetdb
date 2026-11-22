import type { AlertScope } from "@facetdb/core";
import { docsLink } from "./program.ts";

/**
 * Every link FacetDB sends, built in this one place.
 *
 * With a studio, a link opens the studio page where the thing is fixed: the config's `studioUrl`,
 * else the address this process serves the studio on. With none (`--no-http`, `facetdb backfill`,
 * a worker whose studio is not built) an alert keeps its docs fix page, and a link that has no docs
 * page (a record's, a list's) is absent.
 */

/** Where the studio is, as this process knows it. */
export type StudioBase = {
  /** The config's `studioUrl`, already judged by the loader: http or https, no credential, path, query or fragment. */
  readonly configured: string | undefined;
  /**
   * The address this process serves the studio on, once it listens (a port of 0 is only known then);
   * undefined before that, with `--no-http`, and when no studio build is served.
   */
  readonly served: () => string | undefined;
};

/**
 * The Decisions page's time choices (the studio's `TIME_CHOICES`), or a range of decision times (a
 * digest's records), `from` included and `to` not, as the page's `from` and `to`.
 */
export type ListTime =
  | "today"
  | "week"
  | "month"
  | "all"
  | { readonly from: Date; readonly to: Date };

export type Links = {
  /** The worker not running: Home, else the docs page. */
  readonly worker: () => string;
  /** The model failing: Home, else the worker's docs page, where a model outage is read. */
  readonly model: () => string;
  /** A backfill finished or failed: Sources, else the docs page. */
  readonly backfill: () => string;
  /** A source's connector lost access: Sources, else the docs page. */
  readonly access: () => string;
  /**
   * An action or a webhook that gave up: the Alerts page, which lists the event with its delivery
   * and last error (the studio shows no outbox of its own), else the docs page of that kind.
   */
  readonly gaveUp: (kind: "action" | "webhook") => string;
  /**
   * The summary of what a channel's quiet hours held, and a test message: the Alerts page, else the
   * docs page on alerts.
   */
  readonly alerts: () => string;
  /** The spending cap: Settings, else the docs page. */
  readonly spendingCap: () => string;
  /** A question set changed: Questions, on that source, else the docs page. */
  readonly questionSet: (source: string) => string;
  /**
   * A record's "why" page; absent with no studio. A key of `.` or `..` has no page of its own an
   * address can name (a browser resolves the segment, percent-encoded or not, to the page above),
   * so its link is the Decisions list of that one key, at any time.
   */
  readonly record: (source: string, key: string) => string | undefined;
  /** The Decisions page filtered to a source and a time range; absent with no studio. */
  readonly list: (source: string, time: ListTime) => string | undefined;
};

/** A host as an address writes it: an IPv6 one in brackets. */
export function hostInUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * The address a browser on this machine opens: the bound host, except an address that means
 * "every interface", which no browser can open; its loopback stands for it. `facetdb studio` prints
 * and opens it, and it is the base of every link when the config names no `studioUrl`.
 */
export function studioUrl(host: string, port: number): string {
  const browsable =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "::1" : host;
  return `http://${hostInUrl(browsable)}:${port}`;
}

/**
 * The address a link may name for the studio this process serves, or undefined when there is none
 * worth sending: a bind to every interface (`0.0.0.0`, `::`) has no address a reader's browser can
 * open, and the loopback that stands for it in `studioUrl` would open the reader's own machine. An
 * alert then keeps its docs fix page until `studioUrl` names the address people reach it at.
 */
export function servedStudioUrl(host: string, port: number): string | undefined {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return undefined;
  }
  const address = studioUrl(host, port);
  // A host name the command accepts but the URL standard refuses (`foo.123`: a last label of digits
  // is read as an IPv4 address) has no link a browser opens, and a link built from it must not throw
  // inside an alert's getter, which would stop the alert.
  return URL.canParse(address) ? address : undefined;
}

/** A path segment or a query value: every character that is not safe in a URL is percent-encoded. */
const encode = encodeURIComponent;

export function createLinks(base: StudioBase): Links {
  /**
   * The studio's address now: the configured one, else the one this process serves, in the parsed
   * URL's normalized form (scheme, lower-case host, port unless it is the scheme's own, no path), so
   * a path added to it never doubles a slash and no raw text of the file is sent as written.
   */
  const studio = (): string | undefined => {
    const address = base.configured ?? base.served();
    return address === undefined ? undefined : new URL(address).origin;
  };
  /** A studio page, or the docs fix page of `code` when there is no studio. */
  const page = (path: string, code: string): string => {
    const address = studio();
    return address === undefined ? docsLink(code) : `${address}${path}`;
  };
  return {
    worker: () => page("/", "worker"),
    model: () => page("/", "worker"),
    backfill: () => page("/sources", "backfill"),
    access: () => page("/sources", "worker-login"),
    gaveUp: (kind) => page("/alerts", kind === "action" ? "actions" : "webhooks"),
    alerts: () => page("/alerts", "alerts"),
    spendingCap: () => page("/settings", "spending-cap"),
    questionSet: (source) => page(`/questions?source=${encode(source)}`, "question-set"),
    record: (source, key) => {
      const address = studio();
      if (address === undefined) {
        return undefined;
      }
      return key === "." || key === ".."
        ? `${address}/decisions?source=${encode(source)}&q=${encode(key)}&time=all`
        : `${address}/decisions/${encode(source)}/${encode(key)}`;
    },
    list: (source, time) => {
      const address = studio();
      if (address === undefined) {
        return undefined;
      }
      // Today is the page's own default and has no key in its address; a range is two times the
      // page reads instead of a choice.
      const range =
        time === "today"
          ? ""
          : typeof time === "string"
            ? `&time=${time}`
            : `&from=${encode(time.from.toISOString())}&to=${encode(time.to.toISOString())}`;
      return `${address}/decisions?source=${encode(source)}${range}`;
    },
  };
}

/**
 * An alert's scope whose link is read each time an alert is raised, not once when the scope is
 * made: a loop's signals are made before the studio listens, and the address it listens on (a port
 * of 0, a reload that changes nothing here) is only known then. The alerts module spreads the
 * scope into the event it raises, which reads `link` at that moment.
 */
export function alertScope(project: string, source: string, link: () => string): AlertScope {
  return {
    project,
    source,
    get link() {
      return link();
    },
  };
}
