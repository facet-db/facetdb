import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  facetdb,
  fromProjectJson,
  loadConfig,
  noul,
  parseProjectConfig,
  type SourceInput,
  toProjectJson,
} from "./index.ts";

/**
 * `lastChanged` is read only by the polling engine: a table source that names it, a column or
 * `false`, on a database watched by its trigger or by MongoDB's change stream is refused, at
 * `lastChanged`, with the reason and the fix, rather than silently ignored. It loads with
 * `connector: "polling"` and on a scheme whose engine polls (CockroachDB, Oracle). The main path is
 * a config file written as users write it, `database: env("LISTINGS_URL")`, through `loadConfig`:
 * the variable is read after the schema has run, and the source is judged once it is. That the
 * scheme set agrees with the engine table's `polls` is cli/engines-last-changed-refused.test.ts's.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The source's extra fields as the config file writes them, after `database: env("LISTINGS_URL")`. */
async function loadIssues(url: string, fields: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-last-changed-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(
    join(dir, "facetdb.config.ts"),
    `import { env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: env("LISTINGS_URL"),
      table: "listings",
      ${fields}
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});
`,
  );
  try {
    await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: { LISTINGS_URL: url },
      stderr: { write: () => true },
      quiet: true,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
  return [];
}

const trigger = (scheme: string, polling = "") =>
  `sources[0].lastChanged: only a polled table reads lastChanged, and FacetDB watches this ${scheme}: database by its trigger; remove lastChanged${polling}`;
const POLLING = ', or set connector: "polling" if the host forbids triggers';
const stream = (scheme: string) =>
  `sources[0].lastChanged: only a polled table reads lastChanged, and FacetDB watches this ${scheme}: database by its change stream; remove lastChanged`;

const REFUSED: readonly (readonly [string, string])[] = [
  ["postgres://app:s3cret@db.example.com:5432/shop", trigger("postgres", POLLING)],
  ["postgresql://app:s3cret@db.example.com:5432/shop", trigger("postgresql", POLLING)],
  ["mysql://app:s3cret@db.example.com:3306/shop", trigger("mysql")],
  ["mariadb://app:s3cret@db.example.com:3306/shop", trigger("mariadb")],
  ["mssql://app:s3cret@db.example.com:1433/shop", trigger("mssql")],
  ["sqlserver://app:s3cret@db.example.com:1433/shop", trigger("sqlserver")],
  ["sqlite:///srv/app/shop.db", trigger("sqlite")],
  ["libsql://shop-acme.turso.io", trigger("libsql")],
  ["mongodb://app:s3cret@db.example.com:27017/shop?replicaSet=rs0", stream("mongodb")],
  ["mongodb+srv://app:s3cret@cluster0.example.mongodb.net/shop", stream("mongodb+srv")],
];

describe("lastChanged in a config file whose source reads env()", () => {
  it("is refused once the variable is read, a column and false alike, on every database watched by its trigger or its change stream", async () => {
    for (const [url, refusal] of REFUSED) {
      for (const lastChanged of ['lastChanged: "changed_on",', "lastChanged: false,"]) {
        const issues = await loadIssues(url, lastChanged);
        expect(issues, `${url} ${lastChanged}`).toEqual([refusal]);
        // The words never echo the connection string: it may carry a password.
        expect(issues.join("\n")).not.toContain("s3cret");
      }
      expect(await loadIssues(url, ""), url).toEqual([]);
    }
  });

  it("names Change Tracking when a SQL Server source watches by it", async () => {
    expect(
      await loadIssues(
        "mssql://app:s3cret@db.example.com:1433/shop",
        'capture: "change-tracking", lastChanged: "changed_on",',
      ),
    ).toEqual([
      "sources[0].lastChanged: only a polled table reads lastChanged, and FacetDB watches this mssql: database by Change Tracking; remove lastChanged",
    ]);
  });

  it("keeps the scheme out of the words when it is no database's, and every other part of the string always", async () => {
    for (const url of ["https://s3cret.example.com/app", "C:\\data\\s3cret.db", "./s3cret.db"]) {
      expect(await loadIssues(url, 'lastChanged: "changed_on",'), url).toEqual([
        "sources[0].lastChanged: only a polled table reads lastChanged, and this source's database is not polled; remove lastChanged",
      ]);
    }
  });

  it('loads with connector: "polling" and on cockroachdb: and oracle:, whose engines poll', async () => {
    for (const lastChanged of ['lastChanged: "changed_on",', "lastChanged: false,"]) {
      expect(
        await loadIssues(
          "postgres://app:s3cret@db.example.com:5432/shop",
          `connector: "polling", ${lastChanged}`,
        ),
      ).toEqual([]);
      expect(
        await loadIssues("cockroachdb://app:s3cret@db.example.com:26257/shop", lastChanged),
      ).toEqual([]);
      expect(await loadIssues("oracle://app:s3cret@db.example.com:2484/shop", lastChanged)).toEqual(
        [],
      );
    }
  });

  it("leaves a variable that is not set to its own refusal", async () => {
    expect(await loadIssues("", 'lastChanged: "changed_on",')).toEqual([
      "sources[0].database: LISTINGS_URL is not set; set it to the source's connection string",
    ]);
  });

  it('refuses capture: "change-tracking" once the variable names a database other than SQL Server', async () => {
    expect(
      await loadIssues(
        "postgres://app:s3cret@db.example.com:5432/shop",
        'capture: "change-tracking",',
      ),
    ).toEqual([
      "sources[0].capture: capture: \"change-tracking\" is SQL Server's Change Tracking, and this source's connection string is a postgres: connection string; remove capture (that database is watched by its trigger), or point the source at a SQL Server with an mssql: or sqlserver: connection string",
    ]);
    expect(
      await loadIssues(
        "mssql://app:s3cret@db.example.com:1433/shop",
        'capture: "change-tracking",',
      ),
    ).toEqual([]);
  });
});

describe("lastChanged where the schema reads the connection string itself", () => {
  function issuesOf(overrides: Partial<SourceInput>): string[] {
    const parsed = parseProjectConfig(
      facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "listings",
            table: "listings",
            read: ["title"],
            questions: { is_scam: noul("Is this listing a scam?") },
            ...overrides,
          },
        ],
      }),
    );
    return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }

  it("refuses it on a string read straight from process.env, as the schema meets it", () => {
    for (const [database, refusal] of REFUSED) {
      expect(issuesOf({ database, lastChanged: false }), database).toEqual([refusal]);
    }
    expect(
      issuesOf({ database: "oracle://app@db.example.com:2484/shop", lastChanged: "changed_on" }),
    ).toEqual([]);
  });

  it("judges a source imported from the project JSON once its variable holds a connection string", () => {
    const polled = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "cockroachdb://app@db.example.com:26257/shop",
          table: "listings",
          lastChanged: "changed_on",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const source = polled.sources[0];
    if (source === undefined) throw new Error("fixture has a source");
    const parsed = parseProjectConfig({
      ...polled,
      sources: [{ ...source, databaseEnv: "LISTINGS_URL" }],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const json = toProjectJson(parsed.config);
    expect(json.sources[0]?.lastChanged).toBe("changed_on");
    // Before its variable is set the source has no connection string to judge yet.
    expect(toProjectJson(fromProjectJson(json, {}))).toEqual(json);
    expect(
      toProjectJson(
        fromProjectJson(json, { LISTINGS_URL: "oracle://app@db.example.com:2484/shop" }),
      ),
    ).toEqual(json);
    let refused: unknown;
    try {
      fromProjectJson(json, { LISTINGS_URL: "mysql://app:s3cret@db.example.com:3306/shop" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ConfigError);
    expect(
      (refused as ConfigError).issues.map((issue) => `${issue.path}: ${issue.message}`),
    ).toEqual([trigger("mysql")]);
  });

  it("leaves a plugin or API source to its own rule: one refusal at lastChanged, not two", () => {
    const parsed = parseProjectConfig({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          api: true,
          database: "mysql://app@db.example.com:3306/shop",
          lastChanged: "changed_on",
          read: ["title"],
          questions: [{ type: "noul", name: "q", instructions: "Is it?", stakes: "low" }],
        },
      ],
    });
    const onApi = parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path}: ${issue.message}`);
    expect(onApi.filter((issue) => issue.startsWith("sources[0].lastChanged"))).toEqual([
      "sources[0].lastChanged: an API source has no lastChanged: your code sends its records to /v1/check; remove lastChanged, or drop api: true to read a table",
    ]);
  });
});
