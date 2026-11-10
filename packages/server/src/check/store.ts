import type { Store } from "@facetdb/postgres";
import type { ApiSource, CheckStore } from "./service.ts";

/** An API source of a project as the config declares it, and the id it has in `facetdb.sources`. */
export type DeclaredApiSource = {
  readonly projectId: string;
  /** The name callers send as `source` in `POST /v1/check`. */
  readonly name: string;
  readonly sourceId: string;
  /** The state fields the questions read (`read` in the config), in config order. */
  readonly fields: readonly string[];
};

/**
 * The production `CheckStore`: each declared API source is served by the store's connector over
 * `facetdb.records` and `facetdb.jobs`. A project sees only its own sources; a name the project did
 * not declare is no source, whatever another project has called its own.
 */
export function createCheckStore(
  store: Pick<Store, "connector">,
  declared: readonly DeclaredApiSource[],
  workerId: string,
): CheckStore {
  const sources = new Map<string, ApiSource>();
  for (const source of declared) {
    const id = sourceKey(source.projectId, source.name);
    if (sources.has(id)) {
      throw new Error(
        `the project ${source.projectId} declares the API source ${source.name} twice`,
      );
    }
    sources.set(id, {
      fields: source.fields,
      connector: store.connector({ sourceId: source.sourceId, fields: source.fields, workerId }),
    });
  }
  return { apiSource: (projectId, name) => sources.get(sourceKey(projectId, name)) };
}

function sourceKey(projectId: string, name: string): string {
  return `${projectId.length}:${projectId}:${name}`;
}
