import type { DoctorCheck } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { facetdb, noul } from "../../config/index.ts";
import { installRuns, installVerdict, unreadCheck } from "./install-check.ts";

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

describe("a reading the database did not answer", () => {
  it("is the reach check's words when the install check was skipped behind it", () => {
    expect(
      unreadCheck([
        fail("database", '"sellers" cannot connect to localhost/app: connect ECONNREFUSED'),
        skipped("pooler"),
        skipped("install"),
        skipped("worker"),
      ]),
    ).toBe('"sellers" cannot connect to localhost/app: connect ECONNREFUSED');
    expect(
      unreadCheck([
        fail("file", "listings.db is not writable"),
        skipped("wal"),
        skipped("install"),
      ]),
    ).toBe("listings.db is not writable");
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
    const checks = [fail("database", "cannot connect"), skipped("install")];
    // As the worker's `installed` orders it: the unread check first, `took` only for a verdict.
    expect(unreadCheck(checks)).toBe("cannot connect");
    expect(runs.took(source, config)).toBe(true);
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
