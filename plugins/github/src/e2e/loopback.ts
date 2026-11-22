import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeGithub, fakeGithub } from "../fake-github.ts";
import { DEFAULT_API_URL } from "../index.ts";

/** The API the scripted GitHub answers as: GitHub's own, the plugin's default. */
const GITHUB_API = new URL(DEFAULT_API_URL).origin;

/**
 * The triage example's outside world on this machine's loopback: GitHub, the model and Slack, each
 * a small HTTP server on a port the system picks, so the worker reaches them with its own `fetch`
 * as it would reach the real ones. Nothing here reaches the network. Each server tells `Changes`
 * when it took a request, and the test waits on that state, never on a sleep.
 */

/** Something that moved (a request taken, a line printed), and promises on what it should become. */
export type Changes = {
  /** Called whenever anything a waiter may read has changed. */
  changed(): void;
  /** Fails every waiter, now and later: the worker ended before it was asked to. */
  end(why: string): void;
  /**
   * Resolves once `holds` is true, checked now and after each change. The deadline never decides
   * a pass: it only bounds how long a failure takes to say what it waited for and what it saw.
   */
  until(what: string, holds: () => boolean, seen: () => string): Promise<void>;
};

/** How long a failing wait takes to say so: far past the seconds the whole run takes. */
export const WAIT_DEADLINE_MS = 30_000;

export function createChanges(): Changes {
  const waiters = new Set<() => void>();
  let ended: string | undefined;
  const changed = () => {
    for (const check of [...waiters]) {
      check();
    }
  };
  return {
    changed,
    end(why) {
      ended = why;
      changed();
    },
    until(what, holds, seen) {
      return new Promise<void>((resolve, reject) => {
        const settle = () => {
          clearTimeout(deadline);
          waiters.delete(check);
        };
        const check = () => {
          if (holds()) {
            settle();
            resolve();
          } else if (ended !== undefined) {
            settle();
            reject(new Error(`${what} never came: ${ended}. Seen: ${seen()}`));
          }
        };
        const deadline = setTimeout(() => {
          settle();
          reject(
            new Error(`${what} did not come within ${WAIT_DEADLINE_MS / 1000} s. Seen: ${seen()}`),
          );
        }, WAIT_DEADLINE_MS);
        waiters.add(check);
        check();
      });
    },
  };
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A server on 127.0.0.1, a port the system picks; its address, and a close that ends every connection. */
async function serve(
  handle: (request: IncomingMessage, body: Buffer, response: ServerResponse) => Promise<void>,
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    bodyOf(request)
      .then((body) => handle(request, body, response))
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : "the loopback server failed");
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return headers;
}

const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

/**
 * GitHub's REST API as the plugin's own tests fake it (fake-github.ts: its routes, its labels, its
 * request log), served over HTTP. It answers as `https://api.github.com` itself (its links and
 * URLs name that origin): the project's plugin (plugins/github.ts) carries each request for
 * GitHub's API here unchanged but for the host. Every request is in `fake.requests`.
 */
export async function githubOnLoopback(
  options: { readonly token: string; readonly login: string },
  changes: Changes,
): Promise<{ readonly origin: string; readonly fake: FakeGithub; close(): Promise<void> }> {
  const fake = fakeGithub({ ...options, origin: GITHUB_API, now: () => Date.now() });
  const served = await serve(async (request, body, response) => {
    const method = request.method ?? "GET";
    if (!METHODS.has(method)) {
      response.writeHead(405).end();
      return;
    }
    const answer = await fake.fetch(`${GITHUB_API}${request.url ?? "/"}`, {
      method: method as "GET" | "POST" | "PATCH" | "DELETE",
      headers: headersOf(request),
      ...(body.length === 0 ? {} : { body: body.toString("utf8") }),
      // What the client asked of a redirect is not on the wire; the fake only records it.
      redirect: "manual",
      signal: new AbortController().signal,
    });
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
    changes.changed();
  });
  return { origin: served.origin, fake, close: served.close };
}

/** One model request as the stand-in judged it. */
export type Asked = {
  readonly title: string;
  readonly state: Readonly<Record<string, string | null>>;
};

/** What the stand-in answers for one issue's title: each question's probability of yes. */
export type Scripted = { readonly not_priority: number; readonly impacts_only_oss: number };

const STATE_FIELDS = ["title", "body", "labels", "changed_files"];
const QUESTIONS = ["impacts_only_oss", "not_priority"];

/**
 * A stand-in TypeSafe System One server, for `facetdb dev
 * --model-url`: it answers the scripted probabilities of the issue whose title the request's state
 * holds, and counts every request it is sent, so "one request per issue" is counted where the
 * requests arrive. A request that is not the triage example's (another model, another question,
 * another state, an unknown title) is answered 400 and kept in `unexpected`.
 */
export async function systemOneOnLoopback(
  answers: ReadonlyMap<string, Scripted>,
  onAsk: (title: string) => void,
  changes: Changes,
): Promise<{
  readonly url: string;
  readonly asked: readonly Asked[];
  readonly unexpected: readonly string[];
  close(): Promise<void>;
}> {
  const asked: Asked[] = [];
  const unexpected: string[] = [];
  const refuse = (response: ServerResponse, why: string) => {
    unexpected.push(why);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: why } }));
    changes.changed();
  };
  const served = await serve(async (request, body, response) => {
    if (request.method !== "POST" || request.url !== "/v1/systemone") {
      refuse(response, `${request.method ?? "?"} ${request.url ?? "?"}`);
      return;
    }
    const sent = JSON.parse(body.toString("utf8")) as {
      readonly model?: unknown;
      readonly state?: Record<string, string | null>;
      readonly questions?: Record<string, { readonly type?: unknown }>;
    };
    const state = sent.state ?? {};
    const questions = sent.questions ?? {};
    const title = state["title"];
    const scripted = typeof title === "string" ? answers.get(title) : undefined;
    if (
      sent.model !== "jev-1.14.0" ||
      Object.keys(state).join() !== STATE_FIELDS.join() ||
      Object.keys(questions).sort().join() !== QUESTIONS.join() ||
      Object.values(questions).some((question) => question.type !== "noul") ||
      typeof title !== "string" ||
      scripted === undefined
    ) {
      refuse(response, `a request the example does not make: ${body.toString("utf8")}`);
      return;
    }
    // Counted as it arrives, before it is answered: the actions the answer leads to come after.
    onAsk(title);
    asked.push({ title, state });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "jev-1.14.0",
        answers: {
          not_priority: { noul: scripted.not_priority },
          impacts_only_oss: { noul: scripted.impacts_only_oss },
        },
        usage: { input_tokens: 180, output_tokens: 2 },
      }),
    );
    changes.changed();
  });
  return { url: served.origin, asked, unexpected, close: served.close };
}

/** One message as Slack's incoming webhook took it. */
export type SlackMessage = {
  readonly path: string;
  readonly contentType: string;
  readonly text: string;
};

/**
 * The receiver of Slack's incoming webhooks: it takes each POST, keeps its path (the webhook's
 * `/services/...`) and its text, and answers `ok` as Slack does.
 */
export async function slackOnLoopback(changes: Changes): Promise<{
  readonly origin: string;
  readonly messages: readonly SlackMessage[];
  close(): Promise<void>;
}> {
  const messages: SlackMessage[] = [];
  const served = await serve(async (request, body, response) => {
    const sent = JSON.parse(body.toString("utf8")) as { readonly text?: unknown };
    messages.push({
      path: `${request.method ?? "?"} ${request.url ?? "?"}`,
      contentType: request.headers["content-type"] ?? "",
      text: typeof sent.text === "string" ? sent.text : "",
    });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    changes.changed();
  });
  return { origin: served.origin, messages, close: served.close };
}
