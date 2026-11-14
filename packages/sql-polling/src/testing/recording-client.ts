import type { PollingClient, PollingConnect, PollingQuery, PollingRow } from "../dialect/index.ts";

/**
 * A `PollingClient` that runs nothing: it records every statement it is sent, with its parameters
 * and whether it came inside a transaction, and answers each with rows a test scripted. It proves
 * what SQL the polling connector and engine send through a dialect, never what a database does with
 * it (that is PGlite's for Postgres, the `*.db.test.ts` suites' for the others).
 */

export type RecordedStatement = {
  readonly text: string;
  readonly params: readonly unknown[];
  /** Whether it was sent inside `transaction`. */
  readonly inTransaction: boolean;
};

/**
 * Rows for a statement, or undefined to take the next scripted answer: lets a test answer by what
 * a statement is (a catalog read) rather than by its place in the order.
 */
export type Responder = (
  text: string,
  params: readonly unknown[],
) => readonly PollingRow[] | undefined;

export type RecordingClient = PollingClient & {
  /** Every statement in the order it was sent. */
  readonly statements: RecordedStatement[];
  /** Queues the rows the next statements answer, one array per statement; past them, none. */
  answer(...rows: readonly (readonly PollingRow[])[]): void;
  /** Makes the next statement fail with `error`, as the driver would. */
  failNext(error: Error): void;
  /** How many transactions committed, and how many rolled back. */
  readonly transactions: { committed: number; rolledBack: number };
  /** How many times `close` was called. */
  readonly closes: { count: number };
};

export function recordingClient(respond?: Responder): RecordingClient {
  const statements: RecordedStatement[] = [];
  const queued: (readonly PollingRow[])[] = [];
  const transactions = { committed: 0, rolledBack: 0 };
  const closes = { count: 0 };
  let failure: Error | undefined;

  const send =
    (inTransaction: boolean): PollingQuery =>
    (text, params = []) => {
      statements.push({ text, params: [...params], inTransaction });
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve(respond?.(text, params) ?? queued.shift() ?? []);
    };

  return {
    statements,
    transactions,
    closes,
    query: send(false),
    async transaction(work) {
      try {
        const result = await work(send(true));
        transactions.committed += 1;
        return result;
      } catch (error) {
        transactions.rolledBack += 1;
        throw error;
      }
    },
    answer(...rows) {
      queued.push(...rows);
    },
    failNext(error) {
      failure = error;
    },
    close() {
      closes.count += 1;
      return Promise.resolve();
    },
  };
}

/**
 * A `PollingConnect` handing out one recording client for every connection, and recording each
 * URL and pool size asked for: the engine's calls open and close their own, and a test reads every
 * statement in one place.
 */
export function recordingConnect(client: RecordingClient): PollingConnect & {
  readonly opened: { readonly url: string; readonly max?: number }[];
} {
  const opened: { url: string; max?: number }[] = [];
  const connect = (url: string, options?: { readonly max?: number }) => {
    opened.push({ url, ...(options?.max === undefined ? {} : { max: options.max }) });
    return client;
  };
  return Object.assign(connect, { opened });
}
