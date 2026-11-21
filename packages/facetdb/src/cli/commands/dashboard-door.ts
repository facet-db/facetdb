import type { DatabaseEngine, DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import type { Capture, TableFacts, WorkerLogin } from "@facetdb/server";
import type { SourceConfig } from "../../config/index.ts";
import { databaseOf, schemeOf } from "../engines.ts";
import { loginOf } from "./migrate.ts";

/**
 * A table source as the dashboard's Home and Sources endpoints show it: its database and how it
 * notices a change, where its answers live, who the worker is on it and how far the install's
 * grants reach, and its doctor. Static words of each engine, read from the same table doctor and
 * init read (`databaseOf`); nothing connects until the doctor runs.
 */

/** The database as doctor names it, MySQL and MariaDB apart since their scheme says which. */
function databaseName(engine: DatabaseEngine, url: string): string {
  const known = databaseOf(url);
  if (known === undefined) {
    return engine.name;
  }
  if (known.key === "mysql") {
    return schemeOf(url) === "mariadb" ? "MariaDB" : "MySQL";
  }
  return known.name;
}

function captureOf(source: SourceConfig, url: string): Capture {
  const known = databaseOf(url);
  if (source.connector === "polling" || known?.polls === true) {
    return "polling";
  }
  if (source.capture === "change-tracking") {
    return "change-tracking";
  }
  return known?.key === "mongodb" ? "change-stream" : "trigger";
}

/**
 * What the install's grants let the worker touch (the connectors skill, Per engine): CockroachDB
 * refuses column grants and MongoDB grants per collection, so both reach the whole table; Oracle
 * reads the whole table and updates FacetDB's columns; the rest read the columns `read` names.
 */
const REACH: Readonly<Record<string, "reads-table" | "table">> = {
  cockroachdb: "table",
  mongodb: "table",
  oracle: "reads-table",
};

function loginFacts(engine: DatabaseEngine, target: EngineTarget, url: string): WorkerLogin {
  const key = databaseOf(url)?.key;
  if (key === "sqlite") {
    return { kind: "file" };
  }
  if (key === "libsql") {
    return { kind: "token", variable: `${target.urlVariable ?? "SOURCE_URL"}_AUTH_TOKEN` };
  }
  const user = loginOf(engine, url)?.user ?? "";
  return {
    kind: "user",
    user:
      user === "" ? `the login in ${target.urlVariable ?? "the source's connection string"}` : user,
    reach: (key === undefined ? undefined : REACH[key]) ?? "columns",
  };
}

export function tableFacts(options: {
  readonly engine: DatabaseEngine;
  readonly target: EngineTarget;
  /** The worker login's connection string: never part of a word the facts hold. */
  readonly url: string;
  readonly source: SourceConfig;
  readonly deps: EngineDeps;
}): TableFacts {
  const { engine, target, url, source, deps } = options;
  return {
    database: databaseName(engine, url),
    capture: captureOf(source, url),
    pushWakeup: engine.capabilities.pushWakeup,
    label: engine.label(target, url),
    storage: source.storage,
    answersIn: databaseOf(url)?.key === "mongodb" ? "fields" : "columns",
    login: loginFacts(engine, target, url),
    doctor: async () => (await engine.doctor(target, url, deps)).map(fromTheWorker),
    estimateRows: async () => {
      if (engine.estimateRows === undefined) {
        return null;
      }
      try {
        return await engine.estimateRows(target, url, deps);
      } catch {
        // The row count is a courtesy beside the source; the doctor's checks in the same row say
        // why the database could not be read.
        return null;
      }
    },
  };
}

/**
 * A check as the worker can make it. Its connections to a source's database borrow the pool its
 * connector holds open (cli/pools.ts), so the pooler check's two runs on one connection would run on
 * two of the pool's and read as a transaction-mode pooler: the worker leaves that check to
 * `facetdb doctor`, which opens a connection of its own.
 */
function fromTheWorker(check: DoctorCheck): DoctorCheck {
  return check.name === "pooler" && check.status !== "skip"
    ? {
        name: "pooler",
        status: "skip",
        detail:
          "not checked from the worker, whose own pool is open on this database; facetdb doctor checks it",
      }
    : check;
}
