import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnProgram } from "./run-command.ts";

/** `spawnProgram` over a fake `spawn`: no program is ever started. */

type Call = { command: string; args: readonly string[]; options: unknown };

function fakeSpawn(finish: (child: EventEmitter) => void) {
  const calls: Call[] = [];
  const start = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => finish(child));
    return child;
  }) as unknown as typeof spawn;
  return { start, calls };
}

describe("run-command", () => {
  it("runs the program with its arguments as a list, no shell, in the directory, output on stderr", async () => {
    const { start, calls } = fakeSpawn((child) => child.emit("close", 0));
    const code = await spawnProgram(start)("pnpm", ["add", "@facetdb/github"], {
      cwd: "/work/shop",
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["add", "@facetdb/github"],
        options: { cwd: "/work/shop", stdio: ["ignore", 2, 2], shell: false },
      },
    ]);
  });

  it("resolves with the exit code, and with 1 for a program a signal ended", async () => {
    expect(
      await spawnProgram(fakeSpawn((child) => child.emit("close", 3)).start)("npm", [], {
        cwd: "/",
      }),
    ).toBe(3);
    expect(
      await spawnProgram(fakeSpawn((child) => child.emit("close", null)).start)("npm", [], {
        cwd: "/",
      }),
    ).toBe(1);
  });

  it("rejects when the program could not be started", async () => {
    const { start } = fakeSpawn((child) => child.emit("error", new Error("spawn pnpm ENOENT")));
    await expect(spawnProgram(start)("pnpm", [], { cwd: "/" })).rejects.toThrow("ENOENT");
  });
});
