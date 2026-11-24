import type { ProbeClaim, VersionHold } from "@facetdb/core";
import type { SqlQuery, SqlRow } from "../sql/index.ts";
import { flag, integer, text, textOrNull } from "./rows.ts";

/**
 * A question-set version's hold (store migration 12): `held_by`, the model the holding response
 * named, and `probe_at`, when the next probe may go (ms on the workers' clock), both null while the
 * version is not held. Each write is one statement on the version's row, never a read and then a
 * write, so two workers setting, clearing or claiming at once take turns on the row lock and
 * Postgres re-reads the row the first one wrote before the second's condition is applied.
 */

const WHERE = "where source_id = $1 and version = $2";

function missing(sourceId: string, version: number): Error {
  return new Error(`the FacetDB store keeps no question-set version ${version} of "${sourceId}"`);
}

/** The version's row, as read or returned: an error when the store does not keep the version. */
function only(rows: readonly SqlRow[], sourceId: string, version: number): SqlRow {
  const row = rows[0];
  if (row === undefined) {
    throw missing(sourceId, version);
  }
  return row;
}

/** The version's hold, or null while it is not held. */
export async function readVersionHold(
  query: SqlQuery,
  sourceId: string,
  version: number,
): Promise<VersionHold | null> {
  const row = only(
    await query(
      `select answered_by, held_by, probe_at::text as probe_at
         from facetdb.question_set_versions ${WHERE}`,
      [sourceId, version],
    ),
    sourceId,
    version,
  );
  const named = textOrNull(row, "held_by");
  if (named === null) {
    return null;
  }
  return { held: text(row, "answered_by"), named, probeAt: integer(row, "probe_at") };
}

/**
 * Holds the version under the name the response gave: `probeAt` is the next probe's time unless
 * the version is held already, whose time is kept (of two workers holding at once, the second keeps
 * the first's). Answers the probe time the row holds.
 */
export async function setVersionHold(
  query: SqlQuery,
  sourceId: string,
  version: number,
  named: string,
  probeAt: number,
): Promise<number> {
  const row = only(
    await query(
      `update facetdb.question_set_versions
          set held_by = $3,
              probe_at = coalesce(case when held_by is not null then probe_at end, $4::bigint)
        ${WHERE}
       returning probe_at::text as probe_at`,
      [sourceId, version, named, probeAt],
    ),
    sourceId,
    version,
  );
  return integer(row, "probe_at");
}

/** Lets the version go: a response named the held model again. A version not held is left as it is. */
export async function clearVersionHold(
  query: SqlQuery,
  sourceId: string,
  version: number,
): Promise<void> {
  await query(
    `update facetdb.question_set_versions set held_by = null, probe_at = null
      ${WHERE} and held_by is not null`,
    [sourceId, version],
  );
}

/**
 * Claims the held version's probe at `now`: the update moves `probe_at` to `next` only where it is
 * `now` or earlier, so of several workers one is answered `claimed`; a second waits on the first's
 * row lock and then finds the moved time. The select beside it reads the row as it stood when the
 * statement began (one snapshot for both), which tells a probe another worker took from a hold
 * another released.
 */
export async function claimVersionProbe(
  query: SqlQuery,
  sourceId: string,
  version: number,
  now: number,
  next: number,
): Promise<ProbeClaim> {
  const row = only(
    await query(
      `with claimed as (
         update facetdb.question_set_versions set probe_at = $4::bigint
          ${WHERE} and held_by is not null and probe_at <= $3::bigint
         returning 1
       )
       select exists (select 1 from claimed) as claimed, held_by, probe_at::text as probe_at
         from facetdb.question_set_versions ${WHERE}`,
      [sourceId, version, now, next],
    ),
    sourceId,
    version,
  );
  if (flag(row, "claimed")) {
    return { kind: "claimed" };
  }
  if (textOrNull(row, "held_by") === null) {
    return { kind: "released" };
  }
  return { kind: "taken", probeAt: integer(row, "probe_at") };
}
