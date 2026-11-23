import type { DoctorCheck } from "@facetdb/core";
import { FakeEngine } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceInput } from "../../config/index.ts";
import { type EngineEntry, runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb doctor`'s `engine:` line names `lastChanged` beside `connector` and `capture` when the
 * source sets it: the column the polling engine polls by, or `false` for the hourly scan, as the
 * config file writes it; a source without it has no such words.
 */

const PROJECT_DIR = "/work/listings-app";
const POSTGRES_URL = "postgres://facetdb_worker:s3cret-worker@localhost:5432/app";
const COCKROACH_URL = "cockroachdb://facetdb_worker:s3cret-worker@localhost:26257/app";
const CHECKS: readonly DoctorCheck[] = [
  { name: "database", status: "ok", detail: "listings on localhost: 1 ms away" },
];

/** An engine as main.ts registers it, over core's fake engine with a passing doctor report. */
function fakeEngine(key: string, schemes: readonly string[]): EngineEntry {
  return {
    key,
    load: () =>
      Promise.resolve(
        new FakeEngine({
          name: key,
          schemes,
          checks: CHECKS.map((check) => ({ name: check.name, looksAt: `checks ${check.name}` })),
          doctor: () => CHECKS,
        }),
      ),
  };
}

function configWith(source: Partial<SourceInput>): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
        ...source,
      },
    ],
  });
}

async function engineLineOf(config: ProjectConfig): Promise<string> {
  const result = await runInProcess(
    ["doctor", "--offline"],
    {
      projectDir: PROJECT_DIR,
      env: { FACETDB_SECRET: "a-long-random-secret-for-doctor-tests" },
      loadConfig: () => Promise.resolve(config),
      engines: [fakeEngine("polling", []), fakeEngine("cockroachdb", ["cockroachdb"])],
      connect: (url) => {
        throw new Error(`a connection was opened to ${url}`);
      },
    },
    COMMANDS,
  );
  const found = result.stdout.split("\n").find((text) => text.startsWith("      engine: "));
  if (found === undefined) {
    throw new Error(`no engine line in:\n${result.stdout}${result.stderr}`);
  }
  expect(result.stdout + result.stderr).not.toContain("s3cret");
  return found;
}

describe("doctor's engine line names lastChanged", () => {
  it("with a column, beside the connector", async () => {
    expect(
      await engineLineOf(
        configWith({ database: POSTGRES_URL, connector: "polling", lastChanged: "changed_on" }),
      ),
    ).toBe('      engine: polling, for Postgres (connector: "polling", lastChanged: "changed_on")');
  });

  it("with false, the hourly scan, on a database whose engine polls", async () => {
    expect(await engineLineOf(configWith({ database: COCKROACH_URL, lastChanged: false }))).toBe(
      "      engine: cockroachdb, for CockroachDB (lastChanged: false)",
    );
  });

  it("not at all when the source does not set it", async () => {
    expect(await engineLineOf(configWith({ database: POSTGRES_URL, connector: "polling" }))).toBe(
      '      engine: polling, for Postgres (connector: "polling")',
    );
    expect(await engineLineOf(configWith({ database: COCKROACH_URL }))).toBe(
      "      engine: cockroachdb, for CockroachDB",
    );
  });
});
