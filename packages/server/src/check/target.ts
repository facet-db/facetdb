import type { Connector, RecordKey } from "@facetdb/core";

/**
 * A connector for the worker that answers one `POST /v1/check`: it is the source's connector, but
 * its `claim` takes the caller's record and nothing else. `runOnce` would otherwise take the oldest
 * queued records of the source, and the caller would wait for answers it never asked for.
 */
export function onlyRecord(
  connector: Connector & { claimRecord(key: RecordKey): Promise<boolean> },
  key: RecordKey,
): Connector {
  return {
    capabilities: connector.capabilities,
    install: () => connector.install(),
    uninstall: () => connector.uninstall(),
    watch: () => connector.watch(),
    read: (keys) => connector.read(keys),
    write: (target, decision, expectedHash) => connector.write(target, decision, expectedHash),
    scan: (cursor) => connector.scan(cursor),
    enqueue: (keys) => connector.enqueue(keys),
    claim: async (limit) => (limit >= 1 && (await connector.claimRecord(key)) ? [key] : []),
    claimKey: (target) => connector.claimKey(target),
    ack: (keys) => connector.ack(keys),
    release: (keys) => connector.release(keys),
  };
}
