import type { spawn } from "node:child_process";
import type { CliDeps } from "./program.ts";

/**
 * How `facetdb add` runs the project's package manager: the program and its arguments as a list,
 * never a shell string, so nothing in a package name is read as a command. The program's output
 * goes to this process's standard error, which keeps standard output the command's own (and
 * parseable under `--json`) while the user still watches the install. The composition root wires it
 * with `node:child_process`; a test passes a recording fake as `CliDeps.runCommand` and never
 * starts a package manager.
 */
export function spawnProgram(start: typeof spawn): CliDeps["runCommand"] {
  return (command, args, { cwd }) =>
    new Promise((resolve, reject) => {
      const child = start(command, [...args], { cwd, stdio: ["ignore", 2, 2], shell: false });
      child.once("error", reject);
      // A program ended by a signal has no code: that is a failure all the same.
      child.once("close", (code) => resolve(code ?? 1));
    });
}
