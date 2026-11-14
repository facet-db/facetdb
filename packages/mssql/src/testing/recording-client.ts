import {
  type MssqlClient,
  type MssqlConnect,
  type MssqlQuery,
  type MssqlRow,
  serverFailure,
} from "../sql/index.ts";

/**
 * A fake SQL Server driver for unit tests (no server): it records every statement it is sent, with
 * its parameters and its transaction, answers each from the test's script, and fails one when the
 * script says, as the server would, delivering the error as `connectMssql` delivers tedious's (an
 * AggregateError of several server errors flattened by `serverFailure`). It is handed in through
 * the same `MssqlConnect` parameter as `connectMssql`, so no module is patched.
 */

/** One statement as a fake connection received it. */
export type RecordedStatement = {
  readonly text: string;
  readonly params: readonly unknown[];
  /** The connection string of the connection that ran it. */
  readonly url: string;
  /** The transaction it ran in, numbered from 1 in the order they began; undefined outside one. */
  readonly transaction: number | undefined;
};

/** How a transaction ended. */
export type TransactionEnd = "open" | "committed" | "rolled back";

export type RecordingScript = {
  /** The rows a statement returns: none when this answers undefined. */
  readonly answer?: (text: string, params: readonly unknown[]) => readonly MssqlRow[] | undefined;
  /** The error a statement fails with, as the server raises it; it succeeds when this answers undefined. */
  readonly fail?: (text: string, params: readonly unknown[]) => Error | undefined;
};

export type RecordingClient = {
  /** Opens a fake connection, through the same parameter as `connectMssql`. */
  readonly connect: MssqlConnect;
  /** The connection string of every connection opened, in order. */
  readonly connected: readonly string[];
  /** Every statement every connection ran, in order. */
  readonly statements: readonly RecordedStatement[];
  /** How each transaction ended, by its number. */
  readonly transactions: ReadonlyMap<number, TransactionEnd>;
  /** The statements run inside transaction `n`. */
  inTransaction(n: number): readonly RecordedStatement[];
  /** Connections opened and not closed yet. */
  openConnections(): number;
};

/** A server error as tedious reports one: its message, and its number (`throw 51000, …`). */
export function serverError(message: string, number: number): Error {
  return Object.assign(new Error(message), { number });
}

/**
 * Several server errors for one statement, as tedious reports them: an AggregateError with no
 * message of its own (a column drop an index depends on: 5074, then 4922).
 */
export function serverErrors(
  ...errors: readonly { readonly message: string; readonly number: number }[]
): AggregateError {
  return new AggregateError(errors.map(({ message, number }) => serverError(message, number)));
}

export function recordingClient(script: RecordingScript = {}): RecordingClient {
  const statements: RecordedStatement[] = [];
  const transactions = new Map<number, TransactionEnd>();
  const connected: string[] = [];
  let open = 0;
  const connect: MssqlConnect = (url): MssqlClient => {
    connected.push(url);
    open += 1;
    let current: number | undefined;
    const query: MssqlQuery = async (text, params = []) => {
      statements.push({ text, params, url, transaction: current });
      const error = script.fail?.(text, params);
      if (error !== undefined) {
        throw serverFailure(error);
      }
      return script.answer?.(text, params) ?? [];
    };
    return {
      query,
      async transaction(work) {
        if (current !== undefined) {
          throw new Error("the recording client runs one transaction at a time on a connection");
        }
        const n = transactions.size + 1;
        transactions.set(n, "open");
        current = n;
        try {
          const result = await work(query);
          transactions.set(n, "committed");
          return result;
        } catch (error) {
          transactions.set(n, "rolled back");
          throw error;
        } finally {
          current = undefined;
        }
      },
      async close() {
        open -= 1;
      },
    };
  };
  return {
    connect,
    connected,
    statements,
    transactions,
    inTransaction: (n) => statements.filter((statement) => statement.transaction === n),
    openConnections: () => open,
  };
}
