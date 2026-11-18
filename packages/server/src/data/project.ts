import { sourceIdOf } from "@facetdb/postgres";
import { ApiError } from "../errors.ts";
import type { DashboardDoor } from "./door.ts";

/** A key of a project this worker does not serve: the words the config routes answer with too. */
export function unknownProject(): ApiError {
  return new ApiError(
    404,
    "unknown_project",
    "This API key belongs to a project this worker does not serve.",
    "Use a key made by `facetdb keys add` in this project's directory.",
  );
}

/** The store's id of each of the project's sources: their log, queue and runs are keyed by it. */
export function sourceIds(door: DashboardDoor): readonly string[] {
  return door.sources.map((source) => sourceIdOf(door.projectId, source.name));
}
