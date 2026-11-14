import type { MysqlConnect, MysqlRow } from "../sql/index.ts";

/**
 * The statement-recording driver: a `MysqlConnect` a unit test passes through the same parameter as
 * mysql2's, which records every statement with its parameters and answers from a script. No server,
 * no module patched: what the code under test sent is the record.
 */

/** One statement as the driver received it. */
export type Sent = {
  /** The URL of the client that sent it. */
  readonly url: string;
  readonly text: string;
  /** The values bound in place of its `?`s, or undefined for a statement sent as it is. */
  readonly params: readonly unknown[] | undefined;
};

/** How the driver answers a statement: its rows, or a thrown error for a failure of the server's. */
export type Answer = (text: string, params: readonly unknown[]) => readonly MysqlRow[];

export type RecordingDriver = {
  readonly connect: MysqlConnect;
  /** Every statement, in the order sent, across every client. */
  readonly sent: readonly Sent[];
  /** How many clients were opened, and how many closed. */
  readonly opened: number;
  readonly closed: number;
};

export function recordingDriver(answer: Answer = () => []): RecordingDriver {
  const sent: Sent[] = [];
  let opened = 0;
  let closed = 0;
  const connect: MysqlConnect = (url) => {
    opened += 1;
    return {
      query: async (text, params) => {
        sent.push({ url, text, params });
        return answer(text, params ?? []);
      },
      close: async () => {
        closed += 1;
      },
    };
  };
  return {
    connect,
    sent,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}

/** An error as mysql2 reports a server's: its number, its code and the server's words. */
export function mysqlError(errno: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { errno, code, sqlState: "HY000" });
}
