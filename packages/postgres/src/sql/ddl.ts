import { quoteLiteral } from "./identifier.ts";

/**
 * Idempotent DDL that takes no lock on an object it finds already there. Postgres's own `if not
 * exists` locks first and looks second: `create index if not exists` on an existing index takes a
 * share lock on its table, and `alter table … add column if not exists` on an existing column takes
 * access exclusive (both measured on Postgres 17). On `facetdb.jobs`, which every installed table's
 * trigger inserts into inside the application's transaction, either lock waits behind any
 * application transaction that has written one of those tables, while a later migrate already holds
 * its own table's lock: an application that then writes that table closes a cycle, and Postgres
 * ends one side as a deadlock. These look the object up by name first (`to_regclass` and the
 * catalog lock nothing) and run the statement only when it is missing, so a repeat run locks
 * nothing and a first run is what it always was. The names are FacetDB's own constants, never a
 * user's: they travel inside a `$$` body as SQL text.
 */

/**
 * Runs `statement` (a `create index` or another creation) only when no relation named `relation`
 * (schema-qualified, as `to_regclass` reads it) exists.
 */
export function unlessRelation(relation: string, statement: string): string {
  return `do $$
begin
  if to_regclass(${quoteLiteral(relation)}) is null then
    ${statement};
  end if;
end $$`;
}

/**
 * Runs `statement` (an `alter table … add column`) only when the table `table` (schema-qualified)
 * has no live column named `column`.
 */
export function unlessColumn(table: string, column: string, statement: string): string {
  return `do $$
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = to_regclass(${quoteLiteral(table)}) and attname = ${quoteLiteral(column)}
                    and attnum > 0 and not attisdropped) then
    ${statement};
  end if;
end $$`;
}
