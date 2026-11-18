/**
 * A closed pipe: `facetdb worker | head -1` closes the worker's stdout once `head` has its line,
 * and the next write fails with `EPIPE`. Node reports it as an `error` event on the stream (a write
 * that throws it is handled the same way), which, unheard, ends the process with a stack trace. The
 * reader is gone, so nobody is left to read anything: the process ends quietly with 0, the pending
 * print dropped, as `yes | head -1` does; the worker first stops as on Ctrl+C (`runEnding`). Any
 * other error on the streams is left to fail loudly.
 */

/**
 * How a run ends when its reader goes: a command that took a stop signal (`facetdb worker`) stops
 * the way SIGINT or SIGTERM stops it, finishing or releasing what it holds, and the run then ends
 * with 0; any other command ends at once with 0.
 */
export type RunEnding = {
  /**
   * A signal that aborts on the process's stop signals (`listen` wires them) and on a closed pipe:
   * `CliDeps.stopSignal`.
   */
  stopSignal(): AbortSignal;
  /** The closed pipe: aborts every signal handed out, or calls `exit` when none was. */
  end(): void;
  /** Whether the pipe closed: the run's exit code is then 0, whatever the command returned. */
  pipeClosed(): boolean;
};

export function runEnding(options: {
  /** Ends the process with 0 at once: `process.exit(0)`. */
  readonly exit: () => void;
  /** Calls `abort` on the process's stop signals (SIGINT, SIGTERM), once each. */
  readonly listen: (abort: () => void) => void;
}): RunEnding {
  const stops: AbortController[] = [];
  let closed = false;
  return {
    stopSignal: () => {
      const stop = new AbortController();
      options.listen(() => stop.abort());
      stops.push(stop);
      return stop.signal;
    },
    end: () => {
      closed = true;
      if (stops.length === 0) {
        options.exit();
        return;
      }
      for (const stop of stops) {
        stop.abort();
      }
    },
    pipeClosed: () => closed,
  };
}

/** The process's stdout or stderr, as the writers use it; a test passes a fake. */
export type OutputStream = {
  write(text: string): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

/** Writers for the process's two streams. */
export type OutputWriters = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/** Whether an error is a write to a pipe whose reader has gone. */
export function isClosedPipe(error: unknown): boolean {
  return error instanceof Error && (error as { readonly code?: unknown }).code === "EPIPE";
}

/**
 * Writers for `stdout` and `stderr` that call `end` once, and write nothing more, when either
 * stream's reader has gone, whether the write throws `EPIPE` or the stream reports it later as an
 * `error` event; listening on the streams also covers what is written to them directly (a prompt,
 * an engine's warning). The composition root's `end` exits the process with 0.
 */
export function quietOnClosedPipe(
  streams: { readonly stdout: OutputStream; readonly stderr: OutputStream },
  end: () => void,
): OutputWriters {
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      end();
    }
  };
  const writer = (stream: OutputStream) => {
    stream.on("error", (error) => {
      if (!isClosedPipe(error)) {
        throw error;
      }
      close();
    });
    return (text: string) => {
      if (closed) {
        return;
      }
      try {
        stream.write(text);
      } catch (error) {
        if (!isClosedPipe(error)) {
          throw error;
        }
        close();
      }
    };
  };
  return { stdout: writer(streams.stdout), stderr: writer(streams.stderr) };
}
