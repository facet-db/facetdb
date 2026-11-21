import type { InspectedTable, SetupDraft } from "../../api/index.ts";
import { draftOf, formHolds, type SourceForm } from "../questions/index.ts";

/**
 * What the setup flow's steps two and five choose: the table, the source's name, the columns the
 * model reads, an optional where filter, where the answers go and the variable the worker reads its
 * connection from; with the questions of steps three and four, the new source's draft. The admin
 * connection string is not here: it is the page's alone, sent with each request.
 */

export type Storage = SetupDraft["storage"];

export type SetupChoices = {
  readonly table: InspectedTable;
  readonly name: string;
  readonly read: readonly string[];
  readonly where: string;
  readonly storage: Storage;
  readonly variable: string;
  /** A source already reading this database, and its variable, which the page suggested. */
  readonly sharedWith: { readonly source: string; readonly variable: string } | null;
};

/** A source's name as the config takes one (packages/server, data/routes.ts). */
const SOURCE_NAME = /^[a-z][a-z0-9_]*$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The text types a model reads well: checked at first, the rest left to the person. */
const TEXT_TYPE = /^(text|character varying|varchar|character|char|citext|json|jsonb)\b/;

/** A source name from a table's: `sales.Orders` gives `orders`. */
export function nameFromTable(table: string): string {
  const bare = table.slice(table.lastIndexOf(".") + 1).toLowerCase();
  const plain = bare.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(plain) ? plain : `t_${plain}`;
}

/** The columns read at first: the table's text columns, its key left out. */
export function firstRead(table: InspectedTable): readonly string[] {
  return table.columns
    .filter((column) => column.name !== table.key && TEXT_TYPE.test(column.type))
    .map((column) => column.name);
}

/** Why the source's name cannot be used, or undefined when it can. */
export function sourceNameProblem(name: string, taken: readonly string[]): string | undefined {
  if (!SOURCE_NAME.test(name)) {
    return "A source's name is lowercase letters, digits and underscores, starting with a letter.";
  }
  return taken.includes(name)
    ? `facetdb.config.ts already has a source called ${name}: choose another name.`
    : undefined;
}

/** Why the variable cannot name the worker's connection, or undefined when it can. */
export function variableProblem(variable: string): string | undefined {
  return VARIABLE.test(variable)
    ? undefined
    : "An environment variable's name is letters, digits and underscores, not starting with a digit.";
}

/** Why the choices of step two do not make a source yet, or undefined when they do. */
export function tableProblem(choices: SetupChoices): string | undefined {
  if (choices.table.key === null) {
    return `${choices.table.name} has no single-column primary key, and FacetDB keeps each answer by one. Pick another table, or give this one a primary key (alter table … add primary key) and pick it again.`;
  }
  return choices.read.length === 0
    ? "Check at least one column: the model reads only the columns checked here."
    : undefined;
}

/** The fields of the draft that are not its questions: the table, how it is read and kept. */
export function sourcePart(
  choices: SetupChoices,
): Pick<SetupDraft, "table" | "database" | "read" | "where" | "storage"> {
  const where = choices.where.trim();
  return {
    table: choices.table.name,
    database: { env: choices.variable },
    read: choices.read,
    ...(where === "" ? {} : { where }),
    storage: choices.storage,
  };
}

/**
 * The new source's draft, or undefined while it cannot be sent: a name, a variable or a table that
 * cannot be used, or a question whose name or cut lines cannot be sent (draft.ts, `formHolds`).
 */
export function setupDraftOf(
  choices: SetupChoices,
  form: SourceForm,
  taken: readonly string[],
): SetupDraft | undefined {
  if (
    sourceNameProblem(choices.name, taken) !== undefined ||
    variableProblem(choices.variable) !== undefined ||
    tableProblem(choices) !== undefined ||
    !formHolds(form)
  ) {
    return undefined;
  }
  const questions = draftOf({ ...form, name: choices.name });
  return questions === undefined ? undefined : { ...questions, ...sourcePart(choices) };
}

/** A duration as the page says one: "about 40 seconds", "about 17 minutes", "about 3 hours". */
export function durationWords(seconds: number): string {
  if (seconds < 90) {
    return `about ${String(Math.max(1, Math.round(seconds)))} seconds`;
  }
  if (seconds < 90 * 60) {
    return `about ${String(Math.round(seconds / 60))} minutes`;
  }
  return `about ${String(Math.round(seconds / 3600))} hours`;
}
