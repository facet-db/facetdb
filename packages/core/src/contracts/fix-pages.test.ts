import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DOCTOR_CHECKS_BY_AREA,
  FIX_AREAS,
  FIX_CODES,
  FIX_CODES_BY_AREA,
  type FixArea,
  OTHER_DOCS_PAGES,
} from "../index.ts";

/**
 * The table of docs pages, and a scan of the sources that make codes, so the table stays the list
 * of every code a docs link can print. The scan reads core's, the CLI's and each engine's sources
 * with TypeScript's parser (never an import: core depends on none of them) and collects each code
 * where one is made: the first argument of `new CliError(…)`, `new PluginHostError(…)` and
 * `docsLink(…)` under any name they are imported by, and of `super(…)` in a subclass of either, the
 * `PluginRefusal` union, every object literal's `code`, the `name` of an object with a `status`, a
 * `looksAt` or (in a file naming DoctorCheck) a spread, and the `id` of the CLI's doctor lines (an
 * object with a `label`). A literal is collected; a `const` is read; a parameter of a named
 * function or constructor is followed to its every call, in its file and in each file importing it;
 * and `doctor-${…}` is a check's code. Anything else, a helper or carrier handed on as a value, and
 * a namespace import of a module of the package, is a value the scan cannot read: it must be
 * counted in `PASSED_ON` with where its codes are made.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Who gives a code: the CLI (or core), Postgres (with the polling engine every dialect shares,
 * Postgres's polling among them), or one engine group.
 */
type Group = "cli" | "postgres" | "mysql-sqlserver" | "mongodb-sqlite-polling";

const SCANNED = [
  "packages/core/src",
  "packages/facetdb/src",
  "packages/postgres/src",
  "packages/mysql/src",
  "packages/mssql/src",
  "packages/mongodb/src",
  "packages/sqlite/src",
  "packages/sql-polling/src",
] as const;

function groupOf(path: string): Group {
  if (path.startsWith("packages/facetdb/") || path.startsWith("packages/core/")) return "cli";
  if (path.startsWith("packages/mysql/") || path.startsWith("packages/mssql/")) {
    return "mysql-sqlserver";
  }
  if (
    path.startsWith("packages/mongodb/") ||
    path.startsWith("packages/sqlite/") ||
    path.startsWith("packages/sql-polling/src/dialects/")
  ) {
    return "mongodb-sqlite-polling";
  }
  return "postgres";
}

/** The workspace packages that name a code-making type or function and are not scanned, and why. */
const NOT_SCANNED: Readonly<Record<string, string>> = {
  "packages/server/src":
    "hands the studio the refusals and checks the scanned engines made; its own ApiError codes are snake_case words with no page (suggestions.md)",
  "apps/studio/src":
    "shows the links the CLI made (an alert's `link`) and makes no code; its own `Refusal` is a form field's",
};

const WORDING = "a config wording warning, printed with no link";
const STUDIO =
  "a studio door's refusal (its `refusal` helper or a SetupRefused), which prints no docs link (243)";
const MIGRATE_DOOR = "packages/facetdb/src/cli/commands/migrate-door.ts";
const SETUP_DOOR = "packages/facetdb/src/cli/commands/setup-door.ts";

/** Words made where a code is, that no docs link prints: where each is made, and why. */
const NO_LINK: Readonly<Record<string, { readonly why: string; readonly in: readonly string[] }>> =
  {
    custom: {
      why: "zod's issue code",
      in: [
        "packages/core/src/questions/question-set.ts",
        "packages/facetdb/src/config/schema.ts",
        "packages/facetdb/src/plugin/builtin/webhook.ts",
        "packages/facetdb/src/plugin/registry.ts",
      ],
    },
    ERR_MODULE_NOT_FOUND: { why: "Node's error code", in: ["packages/facetdb/src/cli/program.ts"] },
    MODULE_NOT_FOUND: { why: "Node's error code", in: ["packages/facetdb/src/plugin/host.ts"] },
    "ORA-01017": {
      why: "Oracle's error code, quoted in an alert",
      in: ["packages/facetdb/src/cli/commands/alert-raisers.ts"],
    },
    unexpected_response: {
      why: "the SDK client's error code, the server's kind",
      in: ["packages/facetdb/src/sdk/client.ts"],
    },
    counting: { why: WORDING, in: ["packages/facetdb/src/config/warnings.ts"] },
    "date-comparison": { why: WORDING, in: ["packages/facetdb/src/config/warnings.ts"] },
    "double-negative": { why: WORDING, in: ["packages/facetdb/src/config/warnings.ts"] },
    "state-size": { why: WORDING, in: ["packages/facetdb/src/config/warnings.ts"] },
    config_unreadable: { why: STUDIO, in: [MIGRATE_DOOR, SETUP_DOOR] },
    "no-inspect": { why: STUDIO, in: [SETUP_DOOR] },
    "no-variable": { why: STUDIO, in: [SETUP_DOOR] },
    waits_for_restart: { why: STUDIO, in: [SETUP_DOOR] },
    "api-source": { why: STUDIO, in: [MIGRATE_DOOR] },
    "migrate-by-hand": { why: STUDIO, in: [MIGRATE_DOOR] },
    "not-running": { why: STUDIO, in: [MIGRATE_DOOR] },
    "nothing-to-install": { why: STUDIO, in: [MIGRATE_DOOR] },
    "plugin-source": { why: STUDIO, in: [MIGRATE_DOOR] },
    "unknown-source": { why: STUDIO, in: [MIGRATE_DOOR] },
  };

const PASSED_ON_CLI_ERROR = "a CliError's code, kept as a CliError is rebuilt or handed on";
const PASSED_ON_PLUGIN = "a PluginHostError's code: the PluginRefusal union, collected";
const PASSED_ON_CHECK = "a check's name, collected where the check or its engine's list is made";
const EXIT_CODE = "a process exit code (a number), not a docs code";

/**
 * Values the scan cannot read, by file and text, with the number of sites each is met at and where
 * the codes they carry are made. A new site, even behind a text already listed, fails the test
 * until it is counted here.
 */
const PASSED_ON: Readonly<Record<string, readonly [sites: number, why: string]>> = {
  "packages/facetdb/src/cli/commands/alert-raisers.ts code": [
    2,
    "a database's own error code read off a driver error, quoted in an alert",
  ],
  "packages/facetdb/src/cli/commands/alert-raisers.ts String(number)": [
    1,
    "SQL Server's error number, quoted in an alert",
  ],
  "packages/facetdb/src/cli/commands/backfill.ts error.code": [1, PASSED_ON_PLUGIN],
  "packages/facetdb/src/cli/commands/database.ts error.code": [3, PASSED_ON_PLUGIN],
  "packages/facetdb/src/cli/commands/worker.ts error.code": [1, PASSED_ON_PLUGIN],
  "packages/facetdb/src/cli/commands/doctor.ts entry.id": [2, PASSED_ON_CHECK],
  "packages/facetdb/src/cli/commands/doctor.ts check.name": [1, PASSED_ON_CHECK],
  "packages/facetdb/src/cli/commands/doctor.ts name": [2, PASSED_ON_CHECK],
  "packages/facetdb/src/cli/commands/doctor.ts id": [3, PASSED_ON_CHECK],
  "packages/facetdb/src/cli/commands/doctor.ts engine.name": [
    1,
    "the engine's own name in the `engine:` line's report, not a check",
  ],
  "packages/facetdb/src/cli/commands/migrate-door.ts error.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/setup-door.ts error.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/migrate.ts cause.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/migrate.ts error.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/uninstall.ts cliError.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/uninstall.ts cause.code": [2, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/commands/worker.ts worded.code": [1, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/program.ts error.code": [3, PASSED_ON_CLI_ERROR],
  "packages/facetdb/src/cli/engines.ts refusal.code": [
    1,
    "an engine's Refusal, collected in the engine",
  ],
  "packages/facetdb/src/cli/store-door.ts refused.code": [
    1,
    "storeUrlProblem's codes, collected from its returns",
  ],
  "packages/facetdb/src/cli/config-files.ts code": [1, EXIT_CODE],
  "packages/facetdb/src/cli/program.ts EXIT_OK": [1, EXIT_CODE],
  "packages/facetdb/src/cli/program.ts code": [1, EXIT_CODE],
  "packages/facetdb/src/sdk/client.ts z.string()": [1, "the schema of the server's error body"],
  "packages/mysql/src/engine/doctor.ts name": [1, PASSED_ON_CHECK],
  "packages/mssql/src/engine/doctor.ts name": [1, PASSED_ON_CHECK],
  "packages/mssql/src/engine/doctor.ts at": [1, PASSED_ON_CHECK],
  "packages/mssql/src/engine/doctor.ts CHANGE_TRACKING_CHECK.name": [1, PASSED_ON_CHECK],
  "packages/mssql/src/engine/change-tracking.ts name": [6, PASSED_ON_CHECK],
  "packages/mongodb/src/engine/doctor.ts name": [2, PASSED_ON_CHECK],
  "packages/sqlite/src/engine/doctor.ts name": [1, PASSED_ON_CHECK],
  "packages/sqlite/src/engine/engine.ts name": [1, PASSED_ON_CHECK],
  "packages/sqlite/src/libsql/doctor.ts name": [1, PASSED_ON_CHECK],
  "packages/sql-polling/src/engine/urls.ts refused.code": [
    1,
    "the polling URL check's codes, collected from its returns",
  ],
};

/** Codes one engine group gives today that are placed by name in a shared area, and why. */
const PLACED_BY_NAME: Readonly<Record<string, string>> = {
  "doctor-grants": "every engine's one name for the check of the worker's rights",
  "table-busy": "Oracle's today; Postgres, MySQL and SQL Server add it later",
};

type Source = { readonly path: string; readonly file: ts.SourceFile };
type Made = {
  readonly kind: "code" | "check";
  readonly value: string;
  readonly path: string;
  readonly line: number;
};

function sourcesUnder(dir: string): Source[] {
  const out: Source[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(join(ROOT, at)).sort()) {
      const path = `${at}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) {
        if (name !== "testing" && name !== "e2e" && name !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "testing.ts") {
        const text = readFileSync(join(ROOT, path), "utf8");
        out.push({ path, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) });
      }
    }
  };
  walk(dir);
  return out;
}

function namesOf(binding: ts.BindingName): string[] {
  return ts.isIdentifier(binding)
    ? [binding.text]
    : binding.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : namesOf(element.name),
      );
}

/** Where an identifier is declared, nearest scope first: a parameter, a variable, or neither. */
function declarationOf(
  identifier: ts.Identifier,
):
  | { readonly kind: "parameter"; readonly at: ts.SignatureDeclaration; readonly index: number }
  | { readonly kind: "variable"; readonly at: ts.VariableDeclaration }
  | { readonly kind: "other" }
  | undefined {
  const name = identifier.text;
  for (let at: ts.Node = identifier.parent; ; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      const index = at.parameters.findIndex((parameter) => namesOf(parameter.name).includes(name));
      if (index !== -1) {
        const parameter = at.parameters[index];
        return parameter !== undefined && ts.isIdentifier(parameter.name)
          ? { kind: "parameter", at, index }
          : { kind: "other" };
      }
    }
    if (ts.isForOfStatement(at) || ts.isForInStatement(at) || ts.isForStatement(at)) {
      const list = at.initializer;
      if (
        list !== undefined &&
        ts.isVariableDeclarationList(list) &&
        list.declarations.some((declaration) => namesOf(declaration.name).includes(name))
      ) {
        return { kind: "other" };
      }
    }
    if (
      ts.isCatchClause(at) &&
      at.variableDeclaration !== undefined &&
      namesOf(at.variableDeclaration.name).includes(name)
    ) {
      return { kind: "other" };
    }
    const statements =
      ts.isSourceFile(at) || ts.isBlock(at) || ts.isCaseClause(at) || ts.isDefaultClause(at)
        ? at.statements
        : [];
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (namesOf(declaration.name).includes(name)) {
          return ts.isIdentifier(declaration.name)
            ? { kind: "variable", at: declaration }
            : { kind: "other" };
        }
      }
    }
    if (ts.isSourceFile(at)) return undefined;
  }
}

/** The name a function is called by: its own, the `const` it is assigned to, or its class's. */
function helperName(at: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(at) && at.name !== undefined) return at.name.text;
  if (ts.isConstructorDeclaration(at) && at.parent.name !== undefined) return at.parent.name.text;
  if (
    (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
    ts.isVariableDeclaration(at.parent) &&
    ts.isIdentifier(at.parent.name)
  ) {
    return at.parent.name.text;
  }
  return undefined;
}

function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const element of object.properties) {
    if (
      ts.isPropertyAssignment(element) &&
      (ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)) &&
      element.name.text === name
    ) {
      return element.initializer;
    }
    if (ts.isShorthandPropertyAssignment(element) && element.name.text === name) {
      return element.name;
    }
  }
  return undefined;
}

/**
 * Whether a name is handed on as a value: not called or constructed, not declared, imported or
 * exported, not a type, not `instanceof`'s class and not a heritage clause's.
 */
function usedAsValue(identifier: ts.Identifier): boolean {
  const at = identifier.parent;
  if ((ts.isCallExpression(at) || ts.isNewExpression(at)) && at.expression === identifier) {
    return false;
  }
  if (
    ts.isImportSpecifier(at) ||
    ts.isExportSpecifier(at) ||
    ts.isImportClause(at) ||
    ts.isTypeReferenceNode(at) ||
    ts.isTypeQueryNode(at) ||
    ts.isQualifiedName(at) ||
    ts.isExpressionWithTypeArguments(at)
  ) {
    return false;
  }
  if (
    (ts.isFunctionDeclaration(at) ||
      ts.isClassDeclaration(at) ||
      ts.isVariableDeclaration(at) ||
      ts.isParameter(at) ||
      ts.isPropertyAccessExpression(at) ||
      ts.isPropertyAssignment(at) ||
      ts.isMethodDeclaration(at) ||
      ts.isPropertyDeclaration(at) ||
      ts.isBindingElement(at)) &&
    at.name === identifier
  ) {
    return false;
  }
  return !(
    ts.isBinaryExpression(at) &&
    at.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    at.right === identifier
  );
}

function scan() {
  const sources = SCANNED.flatMap(sourcesUnder);
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const made: Made[] = [];
  const unread: { readonly key: string; readonly at: string }[] = [];
  const pages: string[] = [];
  const lineOf = (source: Source, node: ts.Node) =>
    source.file.getLineAndCharacterOfPosition(node.getStart(source.file)).line + 1;

  /**
   * Each file that reaches `name` (declared in `home`, or anywhere when no home is given), by the
   * local name it uses: the name itself where it is declared, and every import of it, aliases and
   * re-exports under another name followed.
   */
  const reachersOf = (name: string, home?: Source) => {
    const exported = new Set([name]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const source of sources) {
        for (const statement of source.file.statements) {
          if (
            ts.isExportDeclaration(statement) &&
            statement.exportClause !== undefined &&
            ts.isNamedExports(statement.exportClause)
          ) {
            for (const element of statement.exportClause.elements) {
              const from = (element.propertyName ?? element.name).text;
              if (exported.has(from) && !exported.has(element.name.text)) {
                exported.add(element.name.text);
                grew = true;
              }
            }
          }
        }
      }
    }
    const declares = (source: Source) =>
      source.file.statements.some(
        (statement) =>
          ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
            statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((declaration) =>
              namesOf(declaration.name).includes(name),
            )),
      );
    const out: { readonly source: Source; readonly local: string }[] = [];
    for (const source of sources) {
      if (home === undefined ? declares(source) : source === home) {
        out.push({ source, local: name });
      }
      for (const statement of source.file.statements) {
        const bindings = ts.isImportDeclaration(statement)
          ? statement.importClause?.namedBindings
          : undefined;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          if (exported.has((element.propertyName ?? element.name).text)) {
            out.push({ source, local: element.name.text });
          }
        }
      }
    }
    return out;
  };
  /** The local names `name` goes by in `source`. */
  const localsIn = (reached: ReturnType<typeof reachersOf>, source: Source) =>
    new Set(reached.filter((entry) => entry.source === source).map((entry) => entry.local));

  /** A module constant's text: in the file, or exported by the file it is imported from. */
  const importedConstant = (source: Source, name: string): string | undefined => {
    for (const statement of source.file.statements) {
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : undefined;
      if (
        bindings === undefined ||
        !ts.isNamedImports(bindings) ||
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith(".")
      ) {
        continue;
      }
      const element = bindings.elements.find((candidate) => candidate.name.text === name);
      if (element === undefined) continue;
      const from = byPath.get(join(dirname(source.path), statement.moduleSpecifier.text));
      const exportedName = (element.propertyName ?? element.name).text;
      for (const declared of from?.file.statements ?? []) {
        if (!ts.isVariableStatement(declared)) continue;
        for (const declaration of declared.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === exportedName &&
            declaration.initializer !== undefined &&
            ts.isStringLiteralLike(declaration.initializer)
          ) {
            return declaration.initializer.text;
          }
        }
      }
    }
    return undefined;
  };

  const followed = new Set<string>();
  /** Every name a code is passed through (a helper, a carrier, `docsLink`): each use must be a call. */
  const watched: { readonly source: Source; readonly local: string }[] = [];
  const helpers = new Set<ts.Node>();
  const collect = (source: Source, expression: ts.Expression, kind: Made["kind"]): void => {
    let node = expression;
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression;
    }
    const keep = (value: string) =>
      made.push({ kind, value, path: source.path, line: lineOf(source, node) });
    if (ts.isStringLiteralLike(node)) {
      keep(node.text);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collect(source, node.whenTrue, kind);
      collect(source, node.whenFalse, kind);
      return;
    }
    if (
      kind === "code" &&
      ts.isTemplateExpression(node) &&
      node.head.text === "doctor-" &&
      node.templateSpans.length === 1 &&
      node.templateSpans[0]?.literal.text === ""
    ) {
      return;
    }
    if (ts.isIdentifier(node)) {
      const declared = declarationOf(node);
      if (declared?.kind === "parameter") {
        const helper = helperName(declared.at);
        if (helper !== undefined) {
          const key = `${source.path}#${helper}#${declared.index}`;
          if (!followed.has(key)) {
            followed.add(key);
            const reached = reachersOf(helper, source);
            watched.push(...reached);
            if (ts.isVariableDeclaration(declared.at.parent)) helpers.add(declared.at.parent);
            for (const { source: caller, local } of reached) {
              const visit = (call: ts.Node) => {
                if (
                  (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
                  ts.isIdentifier(call.expression) &&
                  call.expression.text === local
                ) {
                  const argument = call.arguments?.[declared.index];
                  if (argument !== undefined) collect(caller, argument, kind);
                }
                ts.forEachChild(call, visit);
              };
              visit(caller.file);
            }
          }
          return;
        }
      }
      if (
        declared?.kind === "variable" &&
        declared.at.initializer !== undefined &&
        ts.isStringLiteralLike(declared.at.initializer) &&
        ts.isVariableDeclarationList(declared.at.parent) &&
        (declared.at.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        keep(declared.at.initializer.text);
        return;
      }
      const imported = declared === undefined ? importedConstant(source, node.text) : undefined;
      if (imported !== undefined) {
        keep(imported);
        return;
      }
    }
    unread.push({
      key: `${source.path} ${node.getText(source.file)}`,
      at: `${source.path}:${lineOf(source, node)}`,
    });
  };

  // The classes whose first argument is a code, by every name they go by: CliError, PluginHostError,
  // and each subclass with no constructor of its own. A subclass with one makes its code in `super`.
  const carriers = [...reachersOf("CliError"), ...reachersOf("PluginHostError")];
  const heirs = [...carriers];
  const subclasses = new Set<ts.ClassDeclaration>();
  const classes = new Set<ts.ClassDeclaration>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const source of sources) {
      const bases = localsIn(heirs, source);
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) && node.name !== undefined && !classes.has(node)) {
          const extended = node.heritageClauses?.find(
            (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
          )?.types[0]?.expression;
          if (extended !== undefined && ts.isIdentifier(extended) && bases.has(extended.text)) {
            classes.add(node);
            grew = true;
            const reached = reachersOf(node.name.text, source);
            heirs.push(...reached);
            if (node.members.some(ts.isConstructorDeclaration)) {
              subclasses.add(node);
            } else {
              carriers.push(...reached);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source.file);
    }
  }
  const links = reachersOf("docsLink");
  watched.push(...heirs, ...links);

  for (const source of sources) {
    const constructs = localsIn(carriers, source);
    const linksHere = localsIn(links, source);
    const checksHere = /\bDoctorCheck\b/.test(source.file.text);
    const visit = (node: ts.Node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        constructs.has(node.expression.text)
      ) {
        const first = node.arguments?.[0];
        if (first !== undefined) collect(source, first, "code");
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        let at: ts.Node = node.parent;
        while (!ts.isClassDeclaration(at) && !ts.isSourceFile(at)) at = at.parent;
        const first = node.arguments[0];
        if (ts.isClassDeclaration(at) && subclasses.has(at) && first !== undefined) {
          collect(source, first, "code");
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        linksHere.has(node.expression.text)
      ) {
        const first = node.arguments[0];
        if (first !== undefined) collect(source, first, "code");
      }
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamespaceImport(node.importClause.namedBindings) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        unread.push({
          key: `${source.path} ${node.getText(source.file)}`,
          at: `${source.path}:${lineOf(source, node)}`,
        });
      }
      if (ts.isObjectLiteralExpression(node)) {
        const code = propertyOf(node, "code");
        if (code !== undefined) collect(source, code, "code");
        const name = propertyOf(node, "name");
        // A check may take its status from a spread: in a file that names DoctorCheck, a `name`
        // beside a spread is a check's too.
        if (
          name !== undefined &&
          (propertyOf(node, "status") !== undefined ||
            propertyOf(node, "looksAt") !== undefined ||
            (checksHere && node.properties.some(ts.isSpreadAssignment)))
        ) {
          collect(source, name, "check");
        }
        const id = propertyOf(node, "id");
        if (
          groupOf(source.path) === "cli" &&
          id !== undefined &&
          propertyOf(node, "label") !== undefined
        ) {
          collect(source, id, "check");
        }
      }
      if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === "PluginRefusal" &&
        ts.isUnionTypeNode(node.type)
      ) {
        for (const member of node.type.types) {
          if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
            made.push({
              kind: "code",
              value: member.literal.text,
              path: source.path,
              line: lineOf(source, member),
            });
          }
        }
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
        for (const match of node.text.matchAll(/https:\/\/docs\.facetdb\.dev\/([a-z0-9/-]*)/g)) {
          pages.push(match[1] ?? "");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.file);
  }

  // A helper, a carrier or `docsLink` handed on as a value (`.map(refusal)`, `const make = CliError`)
  // takes codes the scan never sees: each such use is a value it cannot read.
  for (const source of sources) {
    const names = localsIn(watched, source);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && names.has(node.text) && usedAsValue(node)) {
        const declared = declarationOf(node);
        if (
          declared === undefined ||
          (declared.kind === "variable" &&
            (helpers.has(declared.at) || ts.isSourceFile(declared.at.parent.parent.parent)))
        ) {
          unread.push({
            key: `${source.path} ${node.text} as a value`,
            at: `${source.path}:${lineOf(source, node)}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.file);
  }
  const linked = made.filter(
    (entry) => entry.kind === "check" || !(NO_LINK[entry.value]?.in.includes(entry.path) ?? false),
  );
  return { made, linked, unread, pages };
}

const OWN_AREAS: readonly FixArea[] = ["mysql-sqlserver", "mongodb-sqlite-polling"];
const SHARED_AREAS: readonly FixArea[] = ["doctor", "init", "install", "migrate", "uninstall"];

/**
 * What is wrong with a code's area given the groups that give it, or undefined: a code one engine
 * group alone gives is that group's; no other code is; a code an engine also gives is in a shared
 * area. A code in PLACED_BY_NAME is one engine group's today, put in a shared area ahead of the
 * others: once a second group gives it the rule above places it, and the entry must go.
 */
function placementProblem(
  code: string,
  groups: readonly Group[],
  area: FixArea | undefined,
  placedByName: boolean,
): string | undefined {
  const alone = groups.length === 1 ? groups[0] : undefined;
  const own = OWN_AREAS.find((candidate) => candidate === alone);
  const shared = area !== undefined && SHARED_AREAS.includes(area);
  if (placedByName) {
    if (own === undefined) {
      return `${code}: now given by ${groups.join(" and ")}, so the shared rule places it in ${area}: remove it from PLACED_BY_NAME`;
    }
    return shared
      ? undefined
      : `${code}: placed by name, so its area is a shared one (${SHARED_AREAS.slice(0, -1).join(", ")} or uninstall), not ${area}`;
  }
  if (own !== undefined) {
    return area === own
      ? undefined
      : `${code}: only ${own} gives it, so it goes in ${own}, not ${area}`;
  }
  if (area !== undefined && OWN_AREAS.includes(area)) {
    return `${code}: given by ${groups.join(" and ")}, so it is not ${area}'s alone: move it to a shared area`;
  }
  if (groups.some((group) => group !== "cli") && !shared) {
    return `${code}: an engine gives it (${groups.join(" and ")}), so its area is a shared one, not ${area}`;
  }
  return undefined;
}

const found = scan();
const codeOf = (entry: Made) => (entry.kind === "check" ? `doctor-${entry.value}` : entry.value);
const tableCodes = Object.keys(FIX_CODES);
const areaOf = (code: string): FixArea | undefined =>
  (FIX_CODES as Readonly<Record<string, FixArea>>)[code];

describe("the table of docs pages (fix-pages.ts)", () => {
  it("holds each code once, and writes no doctor code but by its check's name", () => {
    const listed = [
      ...Object.values(DOCTOR_CHECKS_BY_AREA).flatMap((names) =>
        names.map((name) => `doctor-${name}`),
      ),
      ...Object.values(FIX_CODES_BY_AREA).flat(),
    ];
    expect(listed.filter((code, index) => listed.indexOf(code) !== index)).toEqual([]);
    expect(tableCodes).toHaveLength(listed.length);
    expect(
      Object.values(FIX_CODES_BY_AREA)
        .flat()
        .filter((code) => code.startsWith("doctor-")),
    ).toEqual([]);
  });

  it("spells each code as lower-case words joined by hyphens", () => {
    expect(tableCodes.filter((code) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code))).toEqual([]);
  });

  it("puts each code and page in one of the sixteen areas, each with its number", () => {
    expect(Object.keys(FIX_AREAS)).toHaveLength(16);
    expect(Object.values(FIX_AREAS).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    const areas = Object.keys(FIX_AREAS);
    expect(
      [...Object.values(FIX_CODES), ...Object.values(OTHER_DOCS_PAGES)].filter(
        (area) => !areas.includes(area),
      ),
    ).toEqual([]);
  });

  it("derives doctor-<name> for every doctor check name, grants among them", () => {
    for (const [area, names] of Object.entries(DOCTOR_CHECKS_BY_AREA)) {
      for (const name of names) {
        expect(areaOf(`doctor-${name}`)).toBe(area);
      }
    }
    expect(areaOf("doctor-grants")).toBe("doctor");
  });

  it("holds the two other docs pages under engines and reference", () => {
    expect(OTHER_DOCS_PAGES).toEqual({ databases: "engines", config: "reference" });
  });

  it("holds no studio door's code", () => {
    expect(areaOf("config_unreadable")).toBeUndefined();
    expect(areaOf("nothing-to-install")).toBeUndefined();
  });

  it("is data with no import, exported through core's barrel", () => {
    const text = readFileSync(join(ROOT, "packages/core/src/contracts/fix-pages.ts"), "utf8");
    const file = ts.createSourceFile("fix-pages.ts", text, ts.ScriptTarget.Latest, true);
    const behaviour = file.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement),
    );
    expect(behaviour.map((statement) => statement.getText(file))).toEqual([]);
    for (const value of [
      FIX_AREAS,
      FIX_CODES,
      FIX_CODES_BY_AREA,
      DOCTOR_CHECKS_BY_AREA,
      OTHER_DOCS_PAGES,
    ]) {
      expect(typeof value).toBe("object");
      expect(Object.values(value).some((entry) => typeof entry === "function")).toBe(false);
    }
  });
});

describe("every code the CLI and the engines make (their sources, parsed)", () => {
  it("is in the table: a code a docs link can print, or a doctor check's name", () => {
    const missing = found.linked
      .filter((entry) => areaOf(codeOf(entry)) === undefined)
      .map((entry) =>
        entry.kind === "check"
          ? `${entry.path}:${entry.line} makes the doctor check ${entry.value}: add ${entry.value} to DOCTOR_CHECKS_BY_AREA in fix-pages.ts under its area, never as doctor-${entry.value}`
          : `${entry.path}:${entry.line} makes ${entry.value}: a code a fix link prints goes in FIX_CODES_BY_AREA in fix-pages.ts under its area; a code no link prints (a studio door's, a zod issue's, a driver's) goes in NO_LINK in fix-pages.test.ts with this file`,
      );
    expect(missing).toEqual([]);
  });

  it("leaves the table holding no code nothing makes", () => {
    const made = new Set(found.linked.map(codeOf));
    expect(tableCodes.filter((code) => !made.has(code))).toEqual([]);
  });

  it("passes on no value the scan cannot read but the ones listed, at the sites counted", () => {
    const sites = new Map<string, string[]>();
    for (const { key, at } of found.unread) sites.set(key, [...(sites.get(key) ?? []), at]);
    const wrong = [...new Set([...sites.keys(), ...Object.keys(PASSED_ON)])]
      .filter((key) => (sites.get(key) ?? []).length !== PASSED_ON[key]?.[0])
      .map(
        (key) =>
          `${key}: met at ${(sites.get(key) ?? []).length} (${(sites.get(key) ?? []).join(", ")}), counted ${PASSED_ON[key]?.[0] ?? "nowhere"} in PASSED_ON: make the value a literal or a const first; raise the count only when it truly cannot be read, and put the codes it carries in the table`,
      );
    expect(wrong).toEqual([]);
  });

  it("keeps out only the words listed as printed with no link, each where it is made", () => {
    const stale = Object.entries(NO_LINK).flatMap(([value, { in: paths }]) =>
      paths
        .filter(
          (path) =>
            !found.made.some(
              (entry) => entry.kind === "code" && entry.value === value && entry.path === path,
            ),
        )
        .map((path) => `${value} in ${path}`),
    );
    expect(stale).toEqual([]);
  });

  it("places a code one engine group alone gives in that group's area, and only such a code", () => {
    const givers = new Map<string, Set<Group>>();
    for (const entry of found.linked) {
      const code = codeOf(entry);
      givers.set(code, (givers.get(code) ?? new Set<Group>()).add(groupOf(entry.path)));
    }
    const wrong = tableCodes.flatMap((code) => {
      const problem = placementProblem(
        code,
        [...(givers.get(code) ?? [])],
        areaOf(code),
        PLACED_BY_NAME[code] !== undefined,
      );
      return problem === undefined ? [] : [problem];
    });
    expect(wrong).toEqual([]);
  });

  it("asks for a code placed by name to leave PLACED_BY_NAME once a second group gives it", () => {
    expect(placementProblem("table-busy", ["mongodb-sqlite-polling"], "install", true)).toBe(
      undefined,
    );
    expect(
      placementProblem("table-busy", ["mongodb-sqlite-polling", "postgres"], "install", true),
    ).toBe(
      "table-busy: now given by mongodb-sqlite-polling and postgres, so the shared rule places it in install: remove it from PLACED_BY_NAME",
    );
    expect(placementProblem("doctor-grants", ["mysql-sqlserver"], "mysql-sqlserver", true)).toBe(
      "doctor-grants: placed by name, so its area is a shared one (doctor, init, install, migrate or uninstall), not mysql-sqlserver",
    );
    expect(placementProblem("log-bin", ["mysql-sqlserver"], "install", false)).toBe(
      "log-bin: only mysql-sqlserver gives it, so it goes in mysql-sqlserver, not install",
    );
    expect(
      placementProblem("no-file", ["mongodb-sqlite-polling", "mysql-sqlserver"], "install", false),
    ).toBe(undefined);
  });

  it("links to the other pages the table holds and to no page else", () => {
    expect([...new Set(found.pages)].sort()).toEqual(
      [...Object.keys(OTHER_DOCS_PAGES), "fix/"].sort(),
    );
  });

  it("scans every package that makes or hands on a code, but the ones listed", () => {
    const names = /\b(CliError|PluginHostError|EngineRefusal|Refusal|DoctorCheck|docsLink)\b/;
    const dirs = ["packages", "plugins", "apps"].flatMap((top) =>
      readdirSync(join(ROOT, top))
        .map((name) => `${top}/${name}/src`)
        .filter((dir) => {
          try {
            return statSync(join(ROOT, dir)).isDirectory();
          } catch {
            return false;
          }
        }),
    );
    const naming = dirs.filter((dir) =>
      sourcesUnder(dir).some((source) => names.test(source.file.text)),
    );
    const listed = new Set<string>([...SCANNED, ...Object.keys(NOT_SCANNED)]);
    expect(naming.filter((dir) => !listed.has(dir))).toEqual([]);
    expect([...listed].filter((dir) => !naming.includes(dir))).toEqual([]);
  });
});
