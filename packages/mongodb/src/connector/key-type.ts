import { EngineRefusal, type EngineTarget } from "@facetdb/core";
import {
  belowFloor,
  driverFloor,
  KEY_TYPE_FIELD,
  type KeyType,
  META_COLLECTION,
  markerId,
  recordedKeyType,
} from "../install/index.ts";
import { subjectOf, tlsVerdict } from "../urls/index.ts";
import { connectWorker, type WorkerConnect } from "./client.ts";
import { AWAIT_MS, workerDatabase, workerUrlRefusal } from "./connector.ts";

/**
 * The `_id` type a collection's marker records, read under the worker login, which may read
 * `facetdb_meta`: what the CLI reads a typed key and prints a stored one by, on every door
 * (explain, export, preview, the worker's log, the review). One `find` of the marker on a
 * connection of its own, closed after it. Undefined where the marker records none (an install from
 * an earlier version, a collection that had no document) or where there is no marker: an install
 * that has not run has no keys to print, and its keys are read by the untyped rule. A value FacetDB
 * does not know is read as none, with a warning (`recordedKeyType`).
 */
export async function readRecordedKeyType(
  target: EngineTarget,
  url: string,
  deps: {
    readonly allowInsecure: boolean;
    readonly connect?: WorkerConnect;
    readonly warn: (line: string) => void;
  },
): Promise<KeyType | undefined> {
  const refused = workerUrlRefusal(url, deps.allowInsecure, subjectOf(target));
  if (refused !== undefined) {
    throw new EngineRefusal(refused);
  }
  const database = workerDatabase(target, url);
  const verdict = tlsVerdict(url, deps.allowInsecure);
  const client = (deps.connect ?? connectWorker)(url, database, {
    forceTls: verdict.kind === "ok" && verdict.forceTls,
    maxConnections: 1,
    maxAwaitMs: AWAIT_MS,
  });
  try {
    const [marker] = await client.find(
      META_COLLECTION,
      { _id: markerId(target.table) },
      { projection: { [KEY_TYPE_FIELD]: 1 }, limit: 1 },
    );
    return marker === undefined
      ? undefined
      : recordedKeyType(
          marker[KEY_TYPE_FIELD],
          `the marker of ${database}.${target.table}`,
          deps.warn,
        );
  } catch (error) {
    // As the connector's open: a server below the driver's floor is a refusal in words.
    const floor = driverFloor(error);
    throw floor === undefined ? error : new EngineRefusal(belowFloor(url, floor));
  } finally {
    await client.close();
  }
}
