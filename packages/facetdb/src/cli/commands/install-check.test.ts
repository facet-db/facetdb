import type { DoctorCheck } from "@facetdb/core";
import { describe, expect, it, vi } from "vitest";
import { facetdb, noul } from "../../config/index.ts";
import { CliError } from "../program.ts";
import {
  installRuns,
  installVerdict,
  reachRefusal,
  readInstall,
  unreadCheck,
} from "./install-check.ts";

/**
 * A reading of the install that could not be made because the database did not answer: the doctor's
 * install check skipped behind a failed reach check is a read that failed, in the reach check's
 * words, never a verdict; so it is told before a finished install run is used up, and a reading
 * that did tell says whether the rights were read or stood in for.
 */

const ok = (name: string): DoctorCheck => ({ name, status: "ok", detail: `${name} is fine` });
const fail = (name: string, detail: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix: "check the connection",
});
const skipped = (name: string): DoctorCheck => ({
  name,
  status: "skip",
  detail: "not checked: the database check did not pass",
});
/** A reach check that got no answer at all, as the engines mark one. */
const unreachable = (name: string, detail: string): DoctorCheck => ({
  ...fail(name, detail),
  unreachable: true,
});

describe("a reading the database did not answer", () => {
  it("is the reach check's words when the install check was skipped behind it", () => {
    expect(
      unreadCheck([
        unreachable("database", '"sellers" cannot connect to localhost/app: connect ECONNREFUSED'),
        skipped("pooler"),
        skipped("install"),
        skipped("worker"),
      ]),
    ).toBe('"sellers" cannot connect to localhost/app: connect ECONNREFUSED');
    expect(
      unreadCheck([
        unreachable("file", "listings.db does not exist, or is not a file"),
        skipped("wal"),
        skipped("install"),
      ]),
    ).toBe("listings.db does not exist, or is not a file");
  });

  it("is not a database that answered and refused the string: that is the CLI's own refusal, with the fix and no Check again", () => {
    // Seen in a real run: a string logging in as postgres, not as the worker login, read as "could
    // not be read, Check again", which no reload could mend.
    const login = fail(
      "database",
      '"agents" logs in as postgres on 127.0.0.1:5432/facetdb_demo, not as the worker login facetdb_worker',
    );
    const checks = [login, skipped("pooler"), skipped("install")];
    expect(unreadCheck(checks)).toBeUndefined();
    const refusal = reachRefusal(checks);
    expect(refusal).toMatchObject({
      code: "doctor-database",
      message: login.detail,
      fix: "check the connection",
    });
    // A libSQL string the engine refuses before connecting (http to another machine) answered too.
    expect(
      reachRefusal([fail("server", "http://db.example.com is not https"), skipped("install")]),
    ).toMatchObject({ code: "doctor-server" });
    // Nothing to refuse when the database did not answer, or the install was looked at.
    expect(
      reachRefusal([unreachable("database", "cannot connect"), skipped("install")]),
    ).toBeUndefined();
    expect(reachRefusal([ok("database"), fail("install", "lacks is_fake")])).toBeUndefined();
  });

  it("is nothing when the install was checked, or skipped for another reason than the reach", () => {
    expect(unreadCheck([ok("database"), ok("install"), ok("worker")])).toBeUndefined();
    expect(
      unreadCheck([ok("database"), fail("install", "lacks the answer columns is_fake")]),
    ).toBeUndefined();
    // MongoDB's login failed with the database reached: the verdict stays missing.
    expect(
      unreadCheck([ok("database"), fail("login", "bad credentials"), skipped("install")]),
    ).toBeUndefined();
  });

  it("is told before the finished install run is used up, so the next reading may still take it", () => {
    const runs = installRuns();
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "sellers",
          database: "postgres://facetdb_worker:worker-password@localhost:5432/app",
          table: "sellers",
          read: ["bio"],
          questions: { is_fake: noul("Is this seller a fake account?") },
        },
      ],
    });
    // As the loader records it: the variable the connection string came from.
    const [declared] = config.sources;
    if (declared === undefined) {
      throw new Error("the config has a source");
    }
    const source = { ...declared, databaseEnv: "DATABASE_URL" };
    runs.ran(source, config);
    // The worker's `installed` reads in readInstall's order: the run is taken only on a verdict.
    const took = vi.fn(() => runs.took(source, config));
    expect(() =>
      readInstall(
        "PostgreSQL",
        [unreachable("database", "cannot connect"), skipped("install")],
        took,
      ),
    ).toThrow("cannot connect");
    expect(took).not.toHaveBeenCalled();
    expect(() =>
      readInstall(
        "PostgreSQL",
        [
          fail("database", '"sellers" logs in as postgres, not as the worker login'),
          skipped("install"),
        ],
        took,
      ),
    ).toThrow(CliError);
    expect(took).not.toHaveBeenCalled();
    // A reading that looked at the install takes the run, once.
    expect(readInstall("PostgreSQL", [ok("database"), ok("install")], took)).toEqual({
      kind: "holds",
      rightsRead: false,
    });
    expect(took).toHaveBeenCalledTimes(1);
    expect(readInstall("PostgreSQL", [ok("database"), ok("install")], took)).toEqual({
      kind: "cannot-tell",
      why: "the worker's checks of PostgreSQL cannot tell whether the worker login may write them",
    });
  });

  it("is taken whichever variable the loader names for the string, and not for a source changed since", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "agents",
          database: "postgres://facetdb_worker:worker-password@localhost:5432/app",
          table: "agents",
          read: ["name", "bio"],
          questions: { is_scam: noul("Is this seller running a scam?", { stakes: "high" }) },
        },
      ],
    });
    const [declared] = config.sources;
    if (declared === undefined) {
      throw new Error("the config has a source");
    }
    // The setup wrote `process.env.SELLERS_URL`; the loader, naming the variable by the string's
    // value, reads DATABASE_URL back when both hold it.
    const runs = installRuns();
    runs.ran({ ...declared, databaseEnv: "SELLERS_URL" }, config);
    expect(runs.took({ ...declared, databaseEnv: "DATABASE_URL" }, config)).toBe(true);
    // Given once: the next reading leans on no old run.
    expect(runs.took({ ...declared, databaseEnv: "DATABASE_URL" }, config)).toBe(false);
    // Any other change since the run is another source.
    runs.ran({ ...declared, databaseEnv: "SELLERS_URL" }, config);
    expect(runs.took({ ...declared, databaseEnv: "SELLERS_URL", read: ["bio"] }, config)).toBe(
      false,
    );
    // So is the same name moved to a variable holding another string: another database, where the
    // install never ran.
    runs.ran({ ...declared, databaseEnv: "SELLERS_URL" }, config);
    expect(
      runs.took(
        {
          ...declared,
          databaseEnv: "OTHER_URL",
          database: "postgres://facetdb_worker:worker-password@other.example.com:5432/app",
        },
        config,
      ),
    ).toBe(false);
  });
});

describe("whether the rights were read or stood in for", () => {
  it("is read where the doctor has a rights check, and stood in for where only the run did", () => {
    expect(installVerdict("MySQL", [ok("install"), ok("grants")])).toEqual({
      kind: "holds",
      rightsRead: true,
    });
    expect(installVerdict("PostgreSQL", [ok("database"), ok("install")], true)).toEqual({
      kind: "holds",
      rightsRead: false,
    });
    expect(
      installVerdict("PostgreSQL", [ok("database"), fail("install", "lacks is_fake")], true),
    ).toEqual({ kind: "missing", missing: "lacks is_fake", rightsRead: false });
  });
});
