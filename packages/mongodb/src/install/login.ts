import type { PlanStatement, Refusal, StatementPurpose } from "@facetdb/core";
import type { HeldPrivilege, LoginInfo, RoleInfo, Seen } from "./catalog.ts";
import { type MongoshLine, PASSWORD_PROMPT, printLine } from "./mongosh.ts";
import { type Privilege, WORKER_USER, workerPrivileges, workerRole } from "./objects.ts";

/**
 * The worker login's part of an install (created at install with the least permission that works):
 * a role per collection with the rights `workerPrivileges` lists, and the one login holding it.
 * FacetDB makes both in the source's database, and the login only once: an existing one keeps its
 * password (other projects may share it) and is granted the role. Where the server will not let the
 * admin make them (Atlas, which keeps users and roles to its own pages), the operator does it by
 * hand, and these words say how; the next plan then finds the login in `admin` with every right it
 * needs, and has nothing left to do. A login that can do more than FacetDB needs (root, readWrite)
 * is said so in a note: FacetDB takes away no right it did not give.
 */

/** A statement of this part: every one serves the source's database. */
function statement(purpose: StatementPurpose, line: MongoshLine): PlanStatement {
  return { database: "source", purpose, text: printLine(line) };
}

/** Whether `held` gives every right of `needed`, through a role of any database or `anyResource`. */
export function covers(held: readonly HeldPrivilege[], needed: readonly Privilege[]): boolean {
  return needed.every(({ resource, actions }) =>
    actions.every((action) =>
      held.some(
        (privilege) =>
          privilege.actions.includes(action) &&
          (privilege.resource.anyResource === true ||
            ((privilege.resource.db === "" || privilege.resource.db === resource.db) &&
              (privilege.resource.collection === "" ||
                privilege.resource.collection === resource.collection))),
      ),
    ),
  );
}

/** Each right as one string: a database, a collection and an action. */
function rightsOf(privileges: readonly HeldPrivilege[]): ReadonlySet<string> {
  return new Set(
    privileges.flatMap(({ resource, actions }) =>
      actions.map((action) =>
        resource.anyResource === true
          ? `*\u0000${action}`
          : `${resource.db ?? "?"}\u0000${resource.collection ?? "?"}\u0000${action}`,
      ),
    ),
  );
}

/** Whether FacetDB's role gives exactly the rights it should, and inherits nothing. */
function exactly(role: RoleInfo, needed: readonly Privilege[]): boolean {
  const has = rightsOf(role.privileges);
  const wants = rightsOf(needed);
  return (
    role.roles.length === 0 && has.size === wants.size && [...wants].every((one) => has.has(one))
  );
}

/**
 * The note for a login that can do more than the database's FacetDB installs need (the rights of
 * every installed collection's role): a right on a whole database, a cluster or any resource, or
 * one on a collection no install asks for. None when it holds only what they need.
 */
function excessNotes(
  login: LoginInfo,
  database: string,
  collection: string,
  installed: readonly string[],
): readonly string[] {
  const allowed = rightsOf(
    [collection, ...installed].flatMap((each) => workerPrivileges(database, each)),
  );
  const beyond = login.privileges.some(
    ({ resource, actions }) =>
      resource.anyResource === true ||
      resource.db === undefined ||
      resource.db === "" ||
      resource.collection === undefined ||
      resource.collection === "" ||
      actions.some(
        (action) => !allowed.has(`${resource.db}\u0000${resource.collection}\u0000${action}`),
      ),
  );
  return beyond
    ? [
        `${WORKER_USER} (a user of ${login.db}) holds ${inWords(login.roles.map((ref) => `${ref.role}@${ref.db}`))}, more than FacetDB needs: the least it needs for ${database}.${collection} is ${rightsInWords(database, collection)}. FacetDB takes away no right it did not give.`,
      ]
    : [];
}

/** `a`, `a and b`, `a, b and c`. */
export function inWords(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** The worker's rights in words: `find, update and changeStream on app.listings; …`. */
export function rightsInWords(database: string, collection: string): string {
  const parts = workerPrivileges(database, collection).map(
    ({ resource, actions }) => `${inWords(actions)} on ${resource.db}.${resource.collection}`,
  );
  const last = parts.at(-1);
  return parts.length < 2 || last === undefined
    ? parts.join("")
    : `${parts.slice(0, -1).join("; ")}; and ${last}`;
}

/**
 * How to make the role and the login by hand, where MongoDB refuses them to the admin connection
 * string: Atlas's pages, the worker's connection string, and the way on another server.
 */
export function byHandSteps(database: string, collection: string): readonly string[] {
  const role = workerRole(collection);
  return [
    `On Atlas, open Database Access, then Custom Roles, Add New Custom Role: name it ${role} and give it ${rightsInWords(database, collection)}.`,
    `Then Database Users, Add New Database User: ${WORKER_USER}, password authentication with a long random password, and the custom role ${role} under Database User Privileges.`,
    `The worker's connection string is then mongodb+srv://${WORKER_USER}:<that password>@<your cluster's host>/${database}?authSource=admin (Atlas keeps every user in admin); run facetdb migrate again to finish the install.`,
    `On your own server, run facetdb migrate with an admin connection string whose user holds userAdmin on ${database} (or root) instead.`,
  ];
}

/**
 * The steps as one fix, for the refusal of a run MongoDB stopped at the role or the login: the CLI
 * prints a stopped run's refusal, code, message and fix, and not its notes.
 */
export function byHandFix(database: string, collection: string): string {
  return byHandSteps(database, collection).join(" ");
}

/** What the plan says when the server will not show its users and roles to the admin. */
export function unseenNotes(database: string, collection: string): readonly string[] {
  return [
    `MongoDB would not show the admin connection string its users and roles, so this plan makes no role or login: give ${WORKER_USER} the rights below yourself.`,
    ...byHandSteps(database, collection),
  ];
}

/**
 * The login part of a plan: its statements (none when all is in place) and what to say of the
 * login, a refusal, or unseen.
 */
export type LoginPart =
  | {
      readonly kind: "planned";
      readonly statements: readonly PlanStatement[];
      readonly notes: readonly string[];
    }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "unseen" };

export function loginPart(options: {
  readonly database: string;
  readonly collection: string;
  readonly role: Seen<RoleInfo>;
  readonly login: Seen<LoginInfo>;
  readonly workerPassword: string | undefined;
  /** How the words name the source's connection string (`subjectOf`). */
  readonly subject: string;
  /** The database's installed collections (its markers): their roles' rights are FacetDB's too. */
  readonly installed: readonly string[];
}): LoginPart {
  const { database, collection, role, login } = options;
  if (role.kind === "hidden" || login.kind === "hidden") {
    return { kind: "unseen" };
  }
  const needed = workerPrivileges(database, collection);
  const name = workerRole(collection);
  const notes =
    login.kind === "found" ? excessNotes(login.value, database, collection, options.installed) : [];
  // A login in admin, Atlas's place for every user, that already has every right through roles
  // FacetDB did not make (made by hand from `byHandSteps`) needs nothing more: making the role
  // there would only be refused. A login in the source's database gets FacetDB's role whatever
  // else it holds, so its rights never hang on a role FacetDB did not make.
  if (
    role.kind === "absent" &&
    login.kind === "found" &&
    login.value.db === "admin" &&
    covers(login.value.privileges, needed)
  ) {
    return { kind: "planned", statements: [], notes };
  }
  const roleStatements =
    role.kind === "absent"
      ? [
          statement("grants", {
            database,
            command: { createRole: name, privileges: needed, roles: [] },
          }),
        ]
      : exactly(role.value, needed)
        ? []
        : // FacetDB's own role, changed since: given exactly its rights again.
          [
            statement("grants", {
              database,
              command: { updateRole: name, privileges: needed, roles: [] },
            }),
          ];
  const grant = (userDatabase: string) =>
    statement("grants", {
      database: userDatabase,
      command: { grantRolesToUser: WORKER_USER, roles: [{ role: name, db: database }] },
    });
  if (login.kind === "found") {
    const holds = login.value.roles.some((ref) => ref.role === name && ref.db === database);
    return {
      kind: "planned",
      statements: [...roleStatements, ...(holds ? [] : [grant(login.value.db)])],
      notes,
    };
  }
  if (options.workerPassword === undefined) {
    return {
      kind: "refused",
      refusal: {
        code: "worker-login",
        message: `the worker login ${WORKER_USER} does not exist yet, and no password was given to create it with`,
        fix: `put the worker login and a long random password in ${options.subject}: mongodb://${WORKER_USER}:<a long random password>@<host>/${database}; the install creates the login with that password`,
      },
    };
  }
  return {
    kind: "planned",
    statements: [
      ...roleStatements,
      // The password is mongosh's to ask for and `run`'s to bind: no plan holds it. The role comes
      // from the grant after it, so the same plan run again, the login there by then, still ends
      // with the login holding the role.
      {
        ...statement("login", {
          database,
          command: { createUser: WORKER_USER, pwd: PASSWORD_PROMPT, roles: [] },
        }),
        secret: true,
      },
      grant(database),
    ],
    notes,
  };
}
